/**
 * macOS Keychain-backed TokenStore.
 *
 * Uses the platform `security` CLI rather than a native binding so we don't
 * pull in node-keytar (Electron-era pain) or any compiled module. The
 * tradeoff: each operation forks a process. Fine for the few-times-per-hour
 * pattern this store sees.
 *
 * Service name: `aula-mcp`, account name: `tokens`. Both overridable so
 * tests can isolate.
 *
 * On non-macOS platforms `KeychainTokenStore.isSupported()` returns false
 * and every operation throws TokenStoreError. The CLI's defaultStore()
 * picks the file backend when this isn't available.
 */

import { spawn } from 'node:child_process';
import type { StoredTokenRecord, TokenStore } from './token-store.ts';
import { TokenStoreError } from './token-store.ts';

export interface KeychainTokenStoreOptions {
  service?: string;
  account?: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runSecurity(args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

export class KeychainTokenStore implements TokenStore {
  private readonly service: string;
  private readonly account: string;

  constructor(opts: KeychainTokenStoreOptions = {}) {
    this.service = opts.service ?? 'aula-mcp';
    this.account = opts.account ?? 'tokens';
  }

  /** True on macOS. The `security` CLI is otherwise absent. */
  static isSupported(): boolean {
    return process.platform === 'darwin';
  }

  async load(): Promise<StoredTokenRecord | null> {
    this.assertSupported();
    const r = await runSecurity([
      'find-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
      '-w', // -w prints the password (= our JSON blob) on stdout
    ]);
    if (r.exitCode !== 0) {
      // exit 44 = item not found → no record stored yet.
      if (
        r.exitCode === 44 ||
        /could not be found in the keychain/i.test(r.stderr) ||
        /SecKeychainSearchCopyNext.+-25300/.test(r.stderr)
      ) {
        return null;
      }
      throw new TokenStoreError(
        `Keychain load failed (exit ${r.exitCode}): ${r.stderr.trim() || '<no stderr>'}`,
      );
    }
    let blob = r.stdout.trim();
    if (!blob) return null;
    // `security -w` prints the password hex-encoded when it contains non-ASCII
    // bytes (e.g. "Sørensen" in identityName). JSON always starts with `{`,
    // which isn't a hex digit, so an all-hex blob is unambiguously encoded.
    if (/^(?:[0-9a-f]{2})+$/i.test(blob)) {
      blob = Buffer.from(blob, 'hex').toString('utf8');
    }
    try {
      const parsed = JSON.parse(blob) as StoredTokenRecord;
      if (parsed.version !== 1) {
        throw new TokenStoreError(`Unsupported token record version ${parsed.version}`);
      }
      return parsed;
    } catch (e) {
      throw new TokenStoreError('Keychain blob is not a valid token record', { cause: e });
    }
  }

  async save(record: StoredTokenRecord): Promise<void> {
    this.assertSupported();
    const json = JSON.stringify(record);
    const r = await runSecurity([
      'add-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
      '-w',
      json,
      '-U', // update if exists (otherwise add fails with errSecDuplicateItem)
    ]);
    if (r.exitCode !== 0) {
      throw new TokenStoreError(
        `Keychain save failed (exit ${r.exitCode}): ${r.stderr.trim() || '<no stderr>'}`,
      );
    }
  }

  async clear(): Promise<void> {
    this.assertSupported();
    const r = await runSecurity([
      'delete-generic-password',
      '-s',
      this.service,
      '-a',
      this.account,
    ]);
    // exit 44 / "could not be found" → already gone; treat as success.
    if (
      r.exitCode !== 0 &&
      r.exitCode !== 44 &&
      !/could not be found/i.test(r.stderr) &&
      !/-25300/.test(r.stderr)
    ) {
      throw new TokenStoreError(
        `Keychain clear failed (exit ${r.exitCode}): ${r.stderr.trim() || '<no stderr>'}`,
      );
    }
  }

  /** Display string for `aula status`. */
  get path(): string {
    return `keychain://${this.service}/${this.account}`;
  }

  private assertSupported(): void {
    if (!KeychainTokenStore.isSupported()) {
      throw new TokenStoreError(
        `KeychainTokenStore requires macOS (process.platform = ${process.platform})`,
      );
    }
  }
}
