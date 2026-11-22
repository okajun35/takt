import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { toRecord } from '../structured-cli-output.js';
import { execKiro } from './process.js';
import type { KiroCallOptions } from './types.js';

const log = createLogger('kiro-session-list');

const LIST_SESSIONS_TIMEOUT_MS = 10_000;

export interface KiroListedSession {
  sessionId: string;
  /** Session store the entry lives in; V3 sessions report `source: "v3"`. */
  source?: string;
}

/**
 * Parses `kiro-cli chat --list-sessions --format json` stdout. The command emits
 * one envelope `{ cwd, sessions, complete }` per workspace; callers get a flat
 * session list in listing order (most recent first).
 */
export function parseKiroSessionList(output: string): KiroListedSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const sessions: KiroListedSession[] = [];
  for (const envelope of parsed) {
    const list = toRecord(envelope)?.sessions;
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const session = toRecord(entry);
      const sessionId = session?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        continue;
      }
      const source = session?.source;
      sessions.push({
        sessionId,
        source: typeof source === 'string' ? source : undefined,
      });
    }
  }
  return sessions;
}

/**
 * Runs `kiro-cli chat --list-sessions --format json`. Returns undefined when the
 * listing cannot be established (non-zero exit, abort, missing binary, or
 * unparseable output) — callers treat that as "session state unknown", not as
 * an empty list.
 */
export async function listKiroSessions(
  options: KiroCallOptions,
): Promise<KiroListedSession[] | undefined> {
  if (options.abortSignal?.aborted) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_SESSIONS_TIMEOUT_MS);
  timer.unref?.();

  const parentAbortHandler = (): void => controller.abort();
  options.abortSignal?.addEventListener('abort', parentAbortHandler, { once: true });

  try {
    const { stdout } = await execKiro(['chat', '--list-sessions', '--format', 'json'], {
      ...options,
      abortSignal: controller.signal,
    });
    return parseKiroSessionList(stdout);
  } catch (rawError) {
    log.debug('kiro-cli --list-sessions failed', { error: getErrorMessage(rawError) });
    return undefined;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener('abort', parentAbortHandler);
  }
}
