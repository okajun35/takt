import { resolveKiroApiKey, resolveKiroCliPath } from '../config/index.js';
import { isKiroV3SessionId, listKiroSessions } from './sessionList.js';

/**
 * Returns true only for a session listed as `source: "v3"` in this workspace,
 * false when the ID is definitively unresumable (a V2-store ID), and undefined
 * when existence cannot be established (listing failed, or the ID is not — or
 * not only-v3 — listed yet).
 */
export async function kiroSessionExists(cwd: string, sessionId: string): Promise<boolean | undefined> {
  if (!isKiroV3SessionId(sessionId)) {
    // Non-`sess_` IDs belong to the V2 session store; the V3 engine cannot
    // resume them, so this is a definitive "not resumable", not "unknown".
    return false;
  }
  const sessions = await listKiroSessions({
    cwd,
    kiroCliPath: resolveKiroCliPath(),
    kiroApiKey: resolveKiroApiKey(),
  });
  if (sessions === undefined) {
    return undefined;
  }
  const id = sessionId.toLowerCase();
  const matching = sessions.filter(
    (session) => session.sessionId.toLowerCase() === id,
  );
  if (matching.some((session) => session.source === 'v3')) {
    return true;
  }
  return matching.length > 0 && matching.every((session) => session.source !== undefined)
    ? false
    : undefined;
}
