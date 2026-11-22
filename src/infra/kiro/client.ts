import type { AgentResponse } from '../../core/models/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { createLogger, getErrorMessage, stripAnsi } from '../../shared/utils/index.js';
import { execKiro, type KiroExecError } from './process.js';
import { listKiroSessions } from './sessionList.js';
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
const KIRO_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
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

function buildTrustArgs(options: KiroCallOptions): string[] {
  if (options.permissionMode === 'full') {
    return ['--trust-all-tools'];
  }
  if (options.permissionMode === 'edit') {
    return ['--trust-tools=read,grep,write,shell'];
  }
  if (options.permissionMode === 'readonly') {
    return ['--trust-tools=read,grep'];
  }
  return [];
}

function validateSessionId(sessionId: string): void {
  if (!KIRO_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Invalid Kiro session ID. Only letters, numbers, dot, underscore, colon, and hyphen are allowed.');
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
    // V3 only, per-launch and not persisted: without it the run still proceeds
    // but hooks/agents/MCP from cwd's .kiro silently do not load.
    '--trust-workspace',
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
  // The newest V3 session is the one this turn created; a v2-store entry cannot
  // be resumed under --agent-engine v3, so prefer `source: "v3"` entries.
  return sessions?.find((session) => session.source === 'v3')?.sessionId
    ?? sessions?.[0]?.sessionId;
}

interface KiroParsedOutput {
  readonly content: string;
  readonly sessionId?: string;
  readonly events: readonly StreamEvent[];
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

function isKiroToolUse(record: Record<string, unknown>): boolean {
  const kind = normalizedEventKind(record.kind ?? record.type ?? record.blockType);
  return kind === 'tooluse' || kind === 'toolcall' || kind === 'toolrequest';
}

function isKiroToolResult(record: Record<string, unknown>): boolean {
  const kind = normalizedEventKind(record.kind ?? record.type ?? record.blockType);
  return kind === 'toolresult' || kind === 'tooloutput';
}

function extractKiroSessionId(value: unknown): string | undefined {
  const root = toRecord(value);
  if (root === undefined) {
    return undefined;
  }
  const nestedData = toRecord(root.data);
  const nestedMetadata = toRecord(root.metadata);
  return firstNonEmptyString([
    root.sessionId,
    root.session_id,
    root.sessionID,
    nestedData?.sessionId,
    nestedData?.session_id,
    nestedData?.sessionID,
    nestedMetadata?.sessionId,
    nestedMetadata?.session_id,
  ]);
}

function parseKiroToolUse(record: Record<string, unknown>): StreamEvent | undefined {
  const id = firstNonEmptyString([record.toolUseId, record.toolCallId, record.tool_call_id, record.id]);
  const tool = firstNonEmptyString([record.toolName, record.tool_name, record.name]);
  if (id === undefined || tool === undefined) {
    return undefined;
  }
  return {
    type: 'tool_use',
    data: {
      id,
      tool,
      input: toRecord(record.input ?? record.arguments ?? record.args) ?? {},
    },
  };
}

function parseKiroToolResult(record: Record<string, unknown>): StreamEvent | undefined {
  const id = firstNonEmptyString([record.toolUseId, record.toolCallId, record.tool_call_id, record.id]);
  if (id === undefined) {
    return undefined;
  }
  const content = extractStructuredText(
    record.content
      ?? record.output
      ?? record.result
      ?? record.data
      ?? record.text,
  ) ?? '';
  const status = normalizedEventKind(record.status);
  return {
    type: 'tool_result',
    data: {
      id,
      content,
      isError: record.isError === true
        || record.is_error === true
        || record.success === false
        || status === 'error'
        || status === 'failed',
    },
  };
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

  if (isKiroToolUse(record)) {
    startNewAnswerSegment(assistantText);
    const event = parseKiroToolUse(record);
    if (event !== undefined) {
      events.push(event);
    }
    return;
  }
  if (isKiroToolResult(record)) {
    const event = parseKiroToolResult(record);
    if (event !== undefined) {
      events.push(event);
    }
    return;
  }

  if (kind === 'assistantmessage' || kind === 'assistant') {
    const content = record.content ?? record.message ?? data?.content ?? data?.message;
    collectKiroStructuredEvents(
      content,
      events,
      assistantText,
      terminalContent,
    );
    if (typeof content === 'string') {
      recordAssistantText(content, events, assistantText);
    }
    return;
  }
  if (kind === 'toolresults' || kind === 'toolresultmessage') {
    collectKiroStructuredEvents(
      record.content ?? record.results ?? record.toolResults ?? data?.content ?? data?.results,
      events,
      assistantText,
      terminalContent,
    );
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

function parseKiroOutput(stdout: string): KiroParsedOutput | { error: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'kiro-cli returned empty output' };
  }

  const lines = parseValidJsonLines(stdout);
  if (lines.length === 0) {
    const content = cleanKiroOutput(stdout);
    return content.length === 0
      ? { error: 'kiro-cli returned empty output' }
      : { content, events: [{ type: 'text', data: { text: content } }] };
  }

  const events: StreamEvent[] = [];
  const assistantText: string[] = [];
  const terminalContent: KiroTerminalState = {};
  let sessionId: string | undefined;
  for (const line of lines) {
    sessionId = extractKiroSessionId(line) ?? sessionId;
    collectKiroStructuredEvents(line, events, assistantText, terminalContent);
  }

  if (terminalContent.runError !== undefined) {
    return { error: terminalContent.runError };
  }
  if (terminalContent.runStatus !== undefined && terminalContent.runStatus !== 'success') {
    return { error: `kiro-cli run finished with status "${terminalContent.runStatus}"` };
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
        emitResult(options, '', false, parsed.error, options.sessionId);
        return {
          persona: agentType,
          status: 'error',
          content: parsed.error,
          error: parsed.error,
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
      const message = classifyExecutionError(error, effectiveOptions);
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
