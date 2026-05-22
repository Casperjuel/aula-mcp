/**
 * CLI-side wrapper that gives every command the same TokenStore + transcript
 * directory layout. `~/.config/aula-mcp/` for the file backend's tokens +
 * key + JSONL transcripts; macOS Keychain when available.
 *
 * Backend selection (in order):
 *   1. AULA_MCP_NO_KEYCHAIN=1 → file backend regardless of platform.
 *   2. macOS + `security` available → KeychainTokenStore.
 *   3. Everything else → EncryptedFileTokenStore at AULA_MCP_DIR.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { EncryptedFileTokenStore, KeychainTokenStore, type TokenStore } from '@aula-mcp/aula-auth';

/**
 * Resolve the config dir from `AULA_MCP_DIR` *every call* (not at module
 * load) so env-var overrides set after import — by tests, by `aula tokens
 * import` running with a different target, by long-running shells — are
 * actually picked up.
 */
export function aulaMcpDir(): string {
  return process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
}
export function tokenFile(): string {
  return join(aulaMcpDir(), 'tokens.json');
}
export function keyFile(): string {
  return join(aulaMcpDir(), '.key');
}
export function transcriptDir(): string {
  return join(aulaMcpDir(), 'transcripts');
}
export function loginLogPath(): string {
  return join(aulaMcpDir(), 'login-log.jsonl');
}
export function cookiesFile(): string {
  return join(aulaMcpDir(), 'cookies.json');
}

/** Display path that survives both backends — KeychainTokenStore.path
 *  returns "keychain://aula-mcp/tokens" so commands that print location
 *  can do so uniformly. */
export interface CliTokenStore extends TokenStore {
  readonly path: string;
}

export function defaultStore(): CliTokenStore {
  if (KeychainTokenStore.isSupported() && process.env.AULA_MCP_NO_KEYCHAIN !== '1') {
    return new KeychainTokenStore();
  }
  return new EncryptedFileTokenStore({
    filePath: tokenFile(),
    keyFilePath: keyFile(),
  });
}

export function transcriptPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return join(transcriptDir(), `login-${stamp}.jsonl`);
}
