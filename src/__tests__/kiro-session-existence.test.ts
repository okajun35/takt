import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn(), path: vi.fn(), key: vi.fn() }));
vi.mock('../infra/kiro/process.js', () => ({ execKiro: mocks.exec }));
vi.mock('../infra/config/index.js', () => ({ resolveKiroCliPath: mocks.path, resolveKiroApiKey: mocks.key }));

import { kiroSessionExists } from '../infra/kiro/sessionExistence.js';

const first = 'sess_123e4567-e89b-12d3-a456-426614174000';
const second = 'sess_123e4567-e89b-12d3-a456-426614174001';
const sessionListJson = (ids: string[]) => JSON.stringify([
  { cwd: '/project', sessions: ids.map((sessionId) => ({ sessionId, source: 'v3' })), complete: true },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.path.mockReturnValue('/custom/kiro');
  mocks.key.mockReturnValue('key');
});
afterEach(() => vi.useRealTimers());

it('recognizes the first and subsequent session entries using the configured CLI and project', async () => {
  mocks.exec.mockResolvedValue({ stdout: sessionListJson([first, second]), stderr: '' });
  expect(await kiroSessionExists('/project', first)).toBe(true);
  expect(await kiroSessionExists('/project', second)).toBe(true);
  expect(mocks.exec).toHaveBeenCalledWith(['chat', '--list-sessions', '--format', 'json'], expect.objectContaining({ cwd: '/project', kiroCliPath: '/custom/kiro', kiroApiKey: 'key', abortSignal: expect.any(AbortSignal) }));
  expect(await kiroSessionExists('/project', 'sess_123e4567-e89b-12d3-a456-426614174002')).toBeUndefined();
});

it('matches session IDs case-insensitively', async () => {
  mocks.exec.mockResolvedValue({ stdout: sessionListJson([first.toUpperCase()]), stderr: '' });
  expect(await kiroSessionExists('/project', first)).toBe(true);
});

it('does not match sessions listed under another workspace cwd', async () => {
  mocks.exec.mockResolvedValue({
    stdout: JSON.stringify([
      { cwd: '/other', sessions: [{ sessionId: first, source: 'v3' }], complete: true },
      { cwd: '/project', sessions: [{ sessionId: second, source: 'v3' }], complete: true },
    ]),
    stderr: '',
  });
  expect(await kiroSessionExists('/project', first)).toBeUndefined();
  expect(await kiroSessionExists('/project', second)).toBe(true);
});

it('does not treat stderr text or a failed command as a session', async () => {
  mocks.exec.mockResolvedValueOnce({ stdout: '', stderr: `diagnostic ${first}` }).mockRejectedValueOnce(new Error('failed'));
  expect(await kiroSessionExists('/project', first)).toBeUndefined();
  expect(await kiroSessionExists('/project', first)).toBeUndefined();
});

it('aborts a timed out command and returns unknown', async () => {
  vi.useFakeTimers();
  mocks.exec.mockImplementation((_args, options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
    options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const result = kiroSessionExists('/project', first);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBeUndefined();
});
