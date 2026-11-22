import type { AgentResponse } from '../../core/models/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { createLogger, getErrorMessage, stripAnsi } from '../../shared/utils/index.js';
import { execKiro, type KiroExecError } from './process.js';
import { isKiroV3SessionId, listKiroSessions } from './sessionList.js';
import type { KiroCallOptions } from './types.js';
import {
  emitStructuredEvents,
  extractStructuredText,
  firstNonEmptyString,
  parseValidJsonLines,
  toRecord,
} from '../structured-cli-output.js';

export type { KiroCallOptions } from './types.js';

const log = createLogger('kiro-client');

const KIRO_ABORTED_MESSAGE = 'Kiro execution aborted';
const KIRO_ERROR_DETAIL_MAX_LENGTH = 400;
const KIRO_AGENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
// Matches only a leading prompt-echo marker (absolute start of the cleaned
// output), so a Markdown blockquote ("> ") later in the body is left intact.
const KIRO_LEADING_PROMPT_PATTERN = /^\s*> /;
const KIRO_CONTEXT_COMPACTION_NOTICE =
  'The context window has overflowed, summarizing the history...';
const KIRO_CONTEXT_COMPACTION_ERROR =
  'kiro-cli compacted the context without returning a response';

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

// V3 tool IDs. V2 names are only accepted since Kiro CLI 3.3.0 and each name
// grants its whole permission capability — `write` would also trust
// delete_file and str_replace. `delete_file` is deliberately absent: V2's
// fs_write had no delete operation, so the previous edit scope never covered
// file deletion. `run_command`/`execute_pwsh` are the V3 shell ids;
// `execute_bash` is listed in the V3 catalog as well — unmatched names are
// ignored, so all three are safe to name.
const KIRO_V3_READONLY_TRUST_TOOLS = 'read_file,list_directory,file_search,grep_search';
const KIRO_V3_EDIT_TRUST_TOOLS = `${KIRO_V3_READONLY_TRUST_TOOLS},fs_write,fs_append,str_replace,run_command,execute_pwsh,execute_bash`;

function buildTrustArgs(options: KiroCallOptions): string[] {
  if (options.permissionMode === 'full') {
    return ['--trust-all-tools'];
  }
  if (options.permissionMode === 'edit') {
    return [`--trust-tools=${KIRO_V3_EDIT_TRUST_TOOLS}`];
  }
  if (options.permissionMode === 'readonly') {
    return [`--trust-tools=${KIRO_V3_READONLY_TRUST_TOOLS}`];
  }
  return [];
}

function validateSessionId(sessionId: string): void {
  if (!isKiroV3SessionId(sessionId)) {
    // V3 --resume-id accepts only `sess_` IDs; a bare UUID belongs to the V2
    // session store and would resume a different conversation.
    throw new Error('Invalid Kiro session ID. Expected a V3 session ID starting with "sess_".');
  }
}

function validateAgentName(agent: string): void {
  if (!KIRO_AGENT_NAME_PATTERN.test(agent)) {
    throw new Error('Invalid Kiro agent name. Only letters, numbers, dot, underscore, and hyphen are allowed.');
  }
}

function buildArgs(options: KiroCallOptions): string[] {
  const args = [
    'chat',
    '--no-interactive',
    '--agent-engine',
    'v3',
    // V3 only, per-launch and not persisted. Sent only when
    // provider_options.kiro.trust_workspace is explicitly true: the flag
    // trusts workspace-defined hooks/MCP servers, which start external
    // processes outside the tool sandbox, so granting it requires an explicit
    // opt-in — never a default. Without the flag, Kiro's own persisted
    // workspace trust (approved interactively, stored outside the checkout)
    // still governs whether .kiro hooks/agents/MCP load. Never sent under
    // readonly either way.
    ...(options.permissionMode !== 'readonly' && options.trustWorkspace === true
      ? ['--trust-workspace']
      : []),
    '--output-format',
    'stream-json',
    ...buildTrustArgs(options),
  ];

  if (options.mode) {
    args.push('--mode', options.mode);
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.agent) {
    validateAgentName(options.agent);
    args.push('--agent', options.agent);
  }

  if (options.sessionId) {
    validateSessionId(options.sessionId);
    args.push('--resume-id', options.sessionId);
  }

  return args;
}

function trimDetail(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > KIRO_ERROR_DETAIL_MAX_LENGTH
    ? `${normalized.slice(0, KIRO_ERROR_DETAIL_MAX_LENGTH)}...`
    : normalized;
}

function redactDetail(value: string, kiroApiKey: string | undefined): string {
  if (!kiroApiKey) {
    return value;
  }
  return value.split(kiroApiKey).join('[REDACTED]');
}

// Failure-path re-delivery: collected ACP events may carry the configured API
// key inside tool_call inputs or tool_call_update outputs. Redact every string
// payload before the events reach stream subscribers.
function redactEventValue(value: unknown, kiroApiKey: string): unknown {
  if (typeof value === 'string') {
    return redactDetail(value, kiroApiKey);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEventValue(entry, kiroApiKey));
  }
  const record = toRecord(value);
  if (record === undefined) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, redactEventValue(entry, kiroApiKey)]),
  );
}

function redactStreamEvent(event: StreamEvent, kiroApiKey: string | undefined): StreamEvent {
  if (!kiroApiKey || event.data === undefined) {
    return event;
  }
  return { ...event, data: redactEventValue(event.data, kiroApiKey) } as StreamEvent;
}

function redactedTrimmedDetail(value: string | undefined, kiroApiKey: string | undefined): string {
  return trimDetail(redactDetail(value ?? '', kiroApiKey));
}

function resolveEffectiveKiroApiKey(kiroApiKey: string | undefined): string | undefined {
  return kiroApiKey ?? process.env.KIRO_API_KEY;
}

function selectErrorDetail(error: KiroExecError): string {
  const stderr = trimDetail(error.stderr);
  if (stderr) {
    return error.stderr ?? '';
  }

  const stdout = trimDetail(error.stdout);
  if (stdout) {
    return error.stdout ?? '';
  }

  return getErrorMessage(error);
}

function isAuthenticationError(error: KiroExecError): boolean {
  const message = [
    trimDetail(error.message),
    trimDetail(error.stderr),
    trimDetail(error.stdout),
  ].join('\n').toLowerCase();

  const patterns = [
    'authentication',
    'unauthorized',
    'forbidden',
    'api key',
    'kiro_api_key',
    'kiro-api-key',
    'login required',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: KiroExecError, options: KiroCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return KIRO_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Kiro CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'kiro-cli binary not found. Install Kiro CLI and ensure `kiro-cli` is in PATH, or set TAKT_KIRO_CLI_PATH/kiro_cli_path.';
  }

  if (isAuthenticationError(error)) {
    return 'Kiro authentication failed. Set TAKT_KIRO_API_KEY, kiro_api_key, or KIRO_API_KEY.';
  }

  if (typeof error.code === 'number') {
    const detail = redactedTrimmedDetail(selectErrorDetail(error), options.kiroApiKey);
    return `Kiro CLI exited with code ${error.code}: ${detail}`;
  }

  return redactDetail(getErrorMessage(error), options.kiroApiKey);
}

// Shared cleanup used for `AgentResponse.content` (DRY: single place that
// strips ANSI escapes and the CLI's leading `> ` prompt-echo marker).
function cleanKiroOutput(raw: string): string {
  return stripAnsi(raw).replace(KIRO_LEADING_PROMPT_PATTERN, '').trim();
}

// Runs only for a brand-new session (no `options.sessionId` yet): the main
// turn already succeeded, so a failure here (non-zero exit, ENOENT, no session
// found) must not turn the overall result into an error — it just leaves the
// session ID unresolved for this turn.
async function resolveLatestSessionId(options: KiroCallOptions): Promise<string | undefined> {
  const sessions = await listKiroSessions(options);
  // The newest V3 session is the one this turn created. A v2-store entry names
  // a different conversation — resuming it under --agent-engine v3 would import
  // that old session instead of this turn's, so the ID stays unresolved when
  // no V3 candidate exists.
  return sessions?.find((session) => session.source === 'v3')?.sessionId;
}

interface KiroParsedOutput {
  readonly content: string;
  readonly sessionId?: string;
  readonly events: readonly StreamEvent[];
  /** Set when the output could not be parsed as JSONL and `events` is raw text. */
  readonly rawText?: true;
}

// V3 `sessionUpdate: "tool_call"` → tool_use. The update carries no tool `name`
// field: `title` is the display label (e.g. "Read File", "run_command ..."),
// `kind` is the permission capability (read/edit/execute/...).
function parseAcpToolCall(update: Record<string, unknown>): StreamEvent | undefined {
  const id = firstNonEmptyString([update.toolCallId, update.tool_call_id, update.id]);
  if (id === undefined) {
    return undefined;
  }
  const tool = firstNonEmptyString([update.title, update.kind, update.name]) ?? 'unknown';
  return {
    type: 'tool_use',
    data: {
      id,
      tool,
      input: toRecord(update.rawInput ?? update.input) ?? {},
    },
  };
}

// V3 `sessionUpdate: "tool_call_update"` → tool_result, emitted only on the
// terminal status (completed/failed) so pending/in_progress updates stay silent.
function parseAcpToolCallResult(update: Record<string, unknown>): StreamEvent | undefined {
  const status = normalizedEventKind(update.status);
  if (status !== 'completed' && status !== 'failed') {
    return undefined;
  }
  const id = firstNonEmptyString([update.toolCallId, update.tool_call_id, update.id]);
  if (id === undefined) {
    return undefined;
  }
  const content = firstNonEmptyString([toRecord(update.rawOutput)?.message])
    ?? extractStructuredText(update.content ?? update.output ?? update.result)
    ?? '';
  return {
    type: 'tool_result',
    data: {
      id,
      content,
      isError: status === 'failed',
    },
  };
}

function normalizedEventKind(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[\s_-]/gu, '')
    : undefined;
}

function extractKiroSessionId(value: unknown): string | undefined {
  const root = toRecord(value);
  if (root === undefined) {
    return undefined;
  }
  const nestedData = toRecord(root.data);
  const nestedMetadata = toRecord(root.metadata);
  const candidate = firstNonEmptyString([
    root.sessionId,
    root.session_id,
    root.sessionID,
    nestedData?.sessionId,
    nestedData?.session_id,
    nestedData?.sessionID,
    nestedMetadata?.sessionId,
    nestedMetadata?.session_id,
  ]);
  // A resolved ID is later passed back through --resume-id, so keep only the
  // V3 `sess_` shape here as well; anything else falls back to --list-sessions.
  return candidate !== undefined && isKiroV3SessionId(candidate) ? candidate : undefined;
}

/**
 * Text before a tool call is working text (progress notes, commentary); the answer follows the last
 * call. Without a usable terminal result, only the text after it becomes the content.
 */
function startNewAnswerSegment(assistantText: string[]): void {
  assistantText.length = 0;
}

/** Every assistant text, including working text before tool calls, reaches the stream in order. */
function recordAssistantText(text: string, events: StreamEvent[], assistantText: string[]): void {
  if (text.length === 0) return;
  assistantText.push(text);
  events.push({ type: 'text', data: { text } });
}

interface KiroTerminalState {
  value?: string;
  calledTool?: boolean;
  /** `runError` event payload — V3 reports run failures this way with exit code 0. */
  runError?: string;
  /** `runFinished.status`; anything but `success` is a failed run. */
  runStatus?: string;
}

function collectKiroStructuredEvents(
  value: unknown,
  events: StreamEvent[],
  assistantText: string[],
  terminalContent: KiroTerminalState,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKiroStructuredEvents(entry, events, assistantText, terminalContent);
    }
    return;
  }

  const record = toRecord(value);
  if (record === undefined) {
    return;
  }

  const data = toRecord(record.data);
  const kind = normalizedEventKind(record.kind ?? record.type ?? record.blockType);

  // V3 run-level failure (`{"type":"runError"}`): exit code stays 0, so the
  // process layer never sees it — the error must be surfaced here.
  if (kind === 'runerror') {
    terminalContent.runError = firstNonEmptyString([data?.message, record.message])
      ?? 'kiro-cli reported a run error';
    return;
  }

  if (kind === 'result' || kind === 'final' || kind === 'assistantmessagecomplete') {
    const content = extractStructuredText(
      record.result ?? record.content ?? data?.result ?? data?.content,
    );
    if (content !== undefined) {
      terminalContent.value = content;
    }
    return;
  }

  // ACP payload (`--output-format stream-json`) の終端イベント。最終テキストは
  // `data.finalText` に入る。truncated のときは欠落があるので、チャンクを繋いだ
  // assistantText 側を使わせるため terminalContent は設定しない。
  if (kind === 'runfinished') {
    const finalText = firstNonEmptyString([data?.finalText, data?.final_text]);
    if (finalText !== undefined && data?.finalTextTruncated !== true) {
      terminalContent.value = finalText;
    }
    const status = firstNonEmptyString([data?.status, record.status]);
    if (status !== undefined) {
      terminalContent.runStatus = status;
    }
    return;
  }

  if (typeof record.text === 'string' && kind === 'text') {
    recordAssistantText(record.text, events, assistantText);
    return;
  }

  // ACP sessionUpdate の本文チャンクは `data.update.content.text` に入るが、
  // 収集対象は `sessionUpdate: 'agent_message_chunk'` のみ。tool_call_update 等の
  // 他 update 種別にも text ブロックがあり得るため、判別なしに辿るとツール由来の
  // テキストが assistantText に混入する。
  const update = toRecord(record.update);
  if (update !== undefined) {
    const updateKind = normalizedEventKind(update.sessionUpdate);
    if (updateKind === 'agentmessagechunk') {
      collectKiroStructuredEvents(update, events, assistantText, terminalContent);
    }
    if (updateKind === 'toolcall') {
      terminalContent.calledTool = true;
      startNewAnswerSegment(assistantText);
      const event = parseAcpToolCall(update);
      if (event !== undefined) {
        events.push(event);
      }
    }
    if (updateKind === 'toolcallupdate') {
      const event = parseAcpToolCallResult(update);
      if (event !== undefined) {
        events.push(event);
      }
    }
  }

  for (const key of ['content', 'message', 'data', 'results']) {
    collectKiroStructuredEvents(record[key], events, assistantText, terminalContent);
  }
}

function parseKiroOutput(
  stdout: string,
): KiroParsedOutput | { error: string; events?: StreamEvent[]; terminal?: true; rawText?: true } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'kiro-cli returned empty output' };
  }

  const lines = parseValidJsonLines(stdout);
  if (lines.length === 0) {
    const content = cleanKiroOutput(stdout);
    // `rawText` marks un-parsed process output: on a failure path it is not a
    // streamable ACP event and may carry unredacted secrets, so the caller
    // must route it through the masked diagnostic instead.
    return content.length === 0
      ? { error: 'kiro-cli returned empty output' }
      : { content, events: [{ type: 'text', data: { text: content } }], rawText: true };
  }

  const events: StreamEvent[] = [];
  const assistantText: string[] = [];
  const terminalContent: KiroTerminalState = {};
  let sessionId: string | undefined;
  for (const line of lines) {
    sessionId = extractKiroSessionId(line) ?? sessionId;
    collectKiroStructuredEvents(line, events, assistantText, terminalContent);
  }

  // A failed run still reports the tool events it produced: the caller streams
  // them before the failure result so tool use stays visible and recorded.
  // `terminal` marks a diagnostic the run itself declared (runError / a
  // non-success runFinished) — unlike a parser extraction failure, it is
  // allowed to replace a process-level diagnostic on a non-zero exit.
  if (terminalContent.runError !== undefined) {
    return { error: terminalContent.runError, events, terminal: true };
  }
  if (terminalContent.runStatus !== undefined && terminalContent.runStatus !== 'success') {
    return {
      error: `kiro-cli run finished with status "${terminalContent.runStatus}"`,
      events,
      terminal: true,
    };
  }

  // Every assistant text reaches the events as text. The terminal result (finalText, result, final) may
  // be truncated and is not known to leave out the working text before tool calls, so it is the answer
  // only when the output carries no assistant text; otherwise the text after the last tool call is.
  const streamedText = events.some((event) => event.type === 'text');
  const content = streamedText ? assistantText.join('') : terminalContent.value ?? '';
  // A turn that ends with a tool call has an empty answer, not an unreadable output: the session
  // continues (empty continuation) instead of a fresh session repeating the tools' side effects.
  if (content.length === 0 && events.length === 0 && terminalContent.calledTool !== true) {
    return {
      error: `Failed to extract assistant content from kiro-cli JSONL output: ${trimDetail(trimmed)}`,
    };
  }
  // An output with only a terminal result has no text events; its result is the visible text.
  return {
    content,
    sessionId,
    events: streamedText || content.length === 0 ? events : [...events, { type: 'text', data: { text: content } }],
  };
}

function emitResult(
  options: KiroCallOptions,
  result: string,
  success: boolean,
  error: string | undefined,
  sessionId: string | undefined,
): void {
  options.onStream?.({
    type: 'result',
    data: {
      result,
      success,
      error,
      sessionId: sessionId ?? '',
    },
  });
}

export class KiroClient {
  async call(agentType: string, prompt: string, options: KiroCallOptions): Promise<AgentResponse> {
    const promptText = buildPrompt(prompt, options.systemPrompt);
    const effectiveKiroApiKey = resolveEffectiveKiroApiKey(options.kiroApiKey);
    const effectiveOptions = effectiveKiroApiKey === options.kiroApiKey
      ? options
      : { ...options, kiroApiKey: effectiveKiroApiKey };

    try {
      const args = buildArgs(effectiveOptions);
      options.onActivity?.({ kind: 'attempt_started' });
      const { stdout } = await execKiro(args, effectiveOptions, promptText);
      const parsed = parseKiroOutput(stdout);
      if ('error' in parsed) {
        // Structured failure diagnostics go through the same API-key masking
        // as process errors — a runError message can embed credential
        // material, and the stream and the response share the masked value.
        const errorMessage = redactedTrimmedDetail(parsed.error, effectiveKiroApiKey);
        emitStructuredEvents(options.onStream, parsed.events ?? []);
        emitResult(options, '', false, errorMessage, options.sessionId);
        return {
          persona: agentType,
          status: 'error',
          content: errorMessage,
          error: errorMessage,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      }
      const content = parsed.content;
      const outputError = content === KIRO_CONTEXT_COMPACTION_NOTICE
        ? KIRO_CONTEXT_COMPACTION_ERROR
        : undefined;

      if (outputError !== undefined) {
        emitResult(options, '', false, outputError, options.sessionId);
        return {
          persona: agentType,
          status: 'error',
          content: outputError,
          error: outputError,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      }

      // First turn (no session yet): resolve the real session ID now so the
      // caller can resume with `--resume-id` on the next turn. Resume turns
      // already know their session ID, so skip the extra process spawn.
      const resolvedSessionId = options.sessionId
        ?? parsed.sessionId
        ?? await resolveLatestSessionId(effectiveOptions);

      emitStructuredEvents(options.onStream, parsed.events);
      emitResult(options, content, true, undefined, resolvedSessionId);

      return {
        persona: agentType,
        status: 'done',
        content,
        timestamp: new Date(),
        sessionId: resolvedSessionId,
      };
    } catch (rawError) {
      const error = rawError as KiroExecError;
      let message = classifyExecutionError(error, effectiveOptions);
      // A non-zero exit can still carry the ACP stream on stdout — a
      // structured runError followed by exit 1. Deliver the events it
      // collected before the failure result, and prefer the run's own
      // diagnostic (masked) over the exit-code summary when one exists.
      // Spawn failures and aborts keep their classified message.
      const partial = typeof error.stdout === 'string' && error.stdout.length > 0
        ? parseKiroOutput(error.stdout)
        : undefined;
      if (partial !== undefined) {
        // Un-parsed stdout stays out of the stream: it may carry an
        // unredacted secret, and the masked process diagnostic already
        // reports it.
        if (partial.rawText !== true && partial.events !== undefined && partial.events.length > 0) {
          emitStructuredEvents(
            options.onStream,
            partial.events.map((event) => redactStreamEvent(event, effectiveKiroApiKey)),
          );
        }
        // Only a run-declared terminal diagnostic replaces the process
        // diagnostic — a parser extraction failure (e.g. stdout held only a
        // runStarted line) must not hide the exit code and stderr detail.
        if ('error' in partial && partial.terminal === true && !options.abortSignal?.aborted) {
          const detail = redactedTrimmedDetail(partial.error, effectiveKiroApiKey);
          if (detail.length > 0) {
            // The bare exit-code summary is generic enough to replace; specific
            // classifications (auth setup guidance, output-limit explanation)
            // keep their message and the run diagnostic is appended instead.
            message = typeof error.code === 'number' && !isAuthenticationError(error)
              ? detail
              : `${message} ${detail}`;
          }
        }
      }
      emitResult(options, '', false, message, options.sessionId);
      return {
        persona: agentType,
        status: 'error',
        content: message,
        error: message,
        timestamp: new Date(),
        sessionId: options.sessionId,
      };
    } finally {
      try {
        await options.preparedMcp?.dispose?.();
      } catch (error) {
        log.debug('Failed to clean up Kiro MCP config', { error: getErrorMessage(error) });
      }
    }
  }
}

const defaultClient = new KiroClient();

export async function callKiro(
  agentType: string,
  prompt: string,
  options: KiroCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}
