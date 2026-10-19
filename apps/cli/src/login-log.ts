/**
 * Append-only audit trail of login attempts.
 *
 * Lives at ~/.config/aula-mcp/login-log.jsonl. Each line is a JSON object;
 * surface via `aula log [--last N]`. Used to answer "when did I last log
 * in?" and "did the previous login fail?" without correlating wire
 * transcripts.
 *
 * No tokens are written — only metadata about the attempt.
 */

import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loginLogPath } from './store.ts';

export interface LoginLogEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  username: string;
  method: 'APP' | 'CODE_TOKEN';
  success: boolean;
  identityName?: string;
  errorKind?: string;
  errorMessage?: string;
}

export async function appendLoginLog(entry: LoginLogEntry): Promise<void> {
  const path = loginLogPath();
  await mkdir(dirname(path), { recursive: true });
  // 0600 like the token files next to it: entries carry the MitID username.
  // `mode` only applies when appendFile creates the file, so a log written
  // with the old default is tightened explicitly.
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function readLoginLog(): Promise<LoginLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(loginLogPath(), 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
  const out: LoginLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoginLogEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}
