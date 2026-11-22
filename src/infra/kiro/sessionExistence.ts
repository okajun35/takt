import { resolveKiroApiKey, resolveKiroCliPath } from '../config/index.js';
import { listKiroSessions } from './sessionList.js';

/** Returns undefined when the listing cannot establish the session's existence. */
export async function kiroSessionExists(cwd: string, sessionId: string): Promise<true | undefined> {
  const sessions = await listKiroSessions({
    cwd,
    kiroCliPath: resolveKiroCliPath(),
    kiroApiKey: resolveKiroApiKey(),
  });
  return sessions?.some(
    (session) => session.sessionId.toLowerCase() === sessionId.toLowerCase(),
  ) ? true : undefined;
}
