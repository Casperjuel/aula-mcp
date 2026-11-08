import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLoginLog, type LoginLogEntry, readLoginLog } from './login-log.ts';

let dir: string;
let previousDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aula-login-log-'));
  previousDir = process.env.AULA_MCP_DIR;
  process.env.AULA_MCP_DIR = dir;
});

afterEach(async () => {
  if (previousDir === undefined) delete process.env.AULA_MCP_DIR;
  else process.env.AULA_MCP_DIR = previousDir;
  await rm(dir, { recursive: true, force: true });
});

const ENTRY: LoginLogEntry = {
  ts: '2026-01-01T00:00:00.000Z',
  username: 'demo',
  method: 'APP',
  success: true,
};

// POSIX permission bits don't restrict access on Windows.
describe.skipIf(process.platform === 'win32')('appendLoginLog permissions', () => {
  test('creates the log 0600', async () => {
    await appendLoginLog(ENTRY);
    expect((await stat(join(dir, 'login-log.jsonl'))).mode & 0o777).toBe(0o600);
  });

  test('tightens a log that already exists with looser permissions', async () => {
    await writeFile(join(dir, 'login-log.jsonl'), '', { mode: 0o644 });
    await appendLoginLog(ENTRY);
    expect((await stat(join(dir, 'login-log.jsonl'))).mode & 0o777).toBe(0o600);
  });
});

describe('appendLoginLog', () => {
  test('entries round-trip through readLoginLog', async () => {
    await appendLoginLog(ENTRY);
    expect(await readLoginLog()).toEqual([ENTRY]);
  });
});
