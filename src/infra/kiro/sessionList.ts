import { resolve } from 'node:path';
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
  /** Workspace the envelope belongs to; absent when the CLI omits it. */
  cwd?: string;
}

/**
 * Parses `kiro-cli chat --list-sessions --format json` stdout. The command emits
 * one envelope `{ cwd, sessions, complete }` per workspace; each session keeps
 * its envelope's cwd so callers can scope entries to their own workspace.
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
    const env = toRecord(envelope);
    const list = env?.sessions;
    if (!Array.isArray(list)) {
      continue;
    }
    const envelopeCwd = env?.cwd;
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
        cwd: typeof envelopeCwd === 'string' && envelopeCwd.length > 0 ? envelopeCwd : undefined,
      });
    }
  }
  return sessions;
}

/**
 * Sessions attributable to `cwd`. An envelope without a cwd cannot be
 * attributed to another workspace, so its sessions are kept.
 */
export function filterKiroSessionsByCwd(
  sessions: KiroListedSession[],
  cwd: string,
): KiroListedSession[] {
  const target = resolve(cwd);
  return sessions.filter(
    (session) => session.cwd === undefined || resolve(session.cwd) === target,
  );
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
    // Only this workspace's sessions may be resumed; a foreign `sess_*` would
    // restart in a different project under --resume-id.
    return filterKiroSessionsByCwd(parseKiroSessionList(stdout), options.cwd);
  } catch (rawError) {
    log.debug('kiro-cli --list-sessions failed', { error: getErrorMessage(rawError) });
    return undefined;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener('abort', parentAbortHandler);
  }
}
