/**
 * Token persistence. The MCP server / CLI both load tokens from here so we
 * don't make the user re-do MitID for every process.
 *
 * Design:
 *   - `TokenStore` is the pluggable interface (load / save / clear).
 *   - `MemoryTokenStore` for tests + ephemeral runs.
 *   - `EncryptedFileTokenStore` writes a JSON envelope (version + IV +
 *     ciphertext + tag) at `~/.config/aula-mcp/tokens.json` (override path
 *     via constructor). The encryption key comes from one of:
 *       1. an explicit Buffer passed to the constructor (keychain integration
 *          can read its key and pass it in),
 *       2. process.env.AULA_MCP_KEY (hex-encoded 32-byte key),
 *       3. a key file at `~/.config/aula-mcp/.key` (created with chmod 600
 *          on first use). We warn that 1 or 2 are stronger.
 *
 * The persisted record includes the active identity (so multi-child guardians
 * don't have to re-pick on every refresh) and a `version` to allow future
 * format changes without losing data.
 */

import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AulaOAuthConfig,
  type AulaTokens,
  DEFAULT_OAUTH_CONFIG,
  isTokenExpired,
  refreshAccessToken,
} from './aula-oauth.ts';
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, sha256 } from './crypto.ts';
import { hexToBytes } from './encoding.ts';
import { AulaAuthError } from './errors.ts';
import type { AulaHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';

export class TokenStoreError extends AulaAuthError {
  override readonly name: string = 'TokenStoreError';
}

/** Persisted record. The shape is bumped via `version` if we change anything. */
export interface StoredTokenRecord {
  version: 1;
  username: string;
  tokens: AulaTokens;
  /** The MitID identity index the user picked (1-based). Optional: unset when
   *  the user has only one identity / hasn't yet selected. */
  identityIndex?: number;
  /** Display name for the chosen identity (helpful for `aula status`). */
  identityName?: string;
  /** When the record was last written. Unix epoch seconds. */
  saved_at: number;
  /** Free-form metadata bag — debug only. */
  meta?: Record<string, unknown>;
}

export interface TokenStore {
  load(): Promise<StoredTokenRecord | null>;
  save(record: StoredTokenRecord): Promise<void>;
  clear(): Promise<void>;
}

// --------------------------------------------------------------------------
// MemoryTokenStore
// --------------------------------------------------------------------------

export class MemoryTokenStore implements TokenStore {
  private record: StoredTokenRecord | null = null;
  async load(): Promise<StoredTokenRecord | null> {
    return this.record;
  }
  async save(record: StoredTokenRecord): Promise<void> {
    this.record = record;
  }
  async clear(): Promise<void> {
    this.record = null;
  }
}

// --------------------------------------------------------------------------
// EncryptedFileTokenStore
// --------------------------------------------------------------------------

export interface EncryptedFileTokenStoreOptions {
  /** Defaults to `~/.config/aula-mcp/tokens.json`. */
  filePath?: string;
  /** Defaults to `~/.config/aula-mcp/.key`. */
  keyFilePath?: string;
  /** Force-supply the 32-byte AES-GCM key (e.g. from a keychain). Wins over
   *  env / file. */
  key?: Buffer;
  /** Override env var lookup. */
  envVarName?: string;
  logger?: Logger;
}

interface EncryptedEnvelope {
  version: 1;
  /** AES-256-GCM. */
  alg: 'aes-256-gcm';
  /** 16-byte IV, base64. */
  iv: string;
  /** Ciphertext, base64. */
  ct: string;
  /** Auth tag, base64. */
  tag: string;
}

const DEFAULT_DIR = join(homedir(), '.config', 'aula-mcp');
const DEFAULT_FILE = join(DEFAULT_DIR, 'tokens.json');
const DEFAULT_KEY_FILE = join(DEFAULT_DIR, '.key');
const DEFAULT_ENV = 'AULA_MCP_KEY';

export class EncryptedFileTokenStore implements TokenStore {
  /** Resolved on-disk path. Exposed (read-only) so long-lived consumers can
   *  watch it for external writes (e.g. `aula login` from another process
   *  rotating tokens beneath a running MCP server). */
  readonly filePath: string;
  private readonly keyFilePath: string;
  private readonly envVar: string;
  private readonly explicitKey?: Buffer;
  private readonly logger: Logger;
  private cachedKey?: Buffer;

  constructor(opts: EncryptedFileTokenStoreOptions = {}) {
    this.filePath = opts.filePath ?? DEFAULT_FILE;
    this.keyFilePath = opts.keyFilePath ?? DEFAULT_KEY_FILE;
    this.envVar = opts.envVarName ?? DEFAULT_ENV;
    if (opts.key) this.explicitKey = opts.key;
    this.logger = opts.logger ?? silentLogger;
  }

  async load(): Promise<StoredTokenRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if (isEnoent(e)) return null;
      throw new TokenStoreError(`Failed to read token file ${this.filePath}`, { cause: e });
    }
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(raw) as EncryptedEnvelope;
    } catch (e) {
      throw new TokenStoreError('Token file is not valid JSON', { cause: e });
    }
    if (envelope.version !== 1 || envelope.alg !== 'aes-256-gcm') {
      throw new TokenStoreError(
        `Unsupported token file envelope (version=${envelope.version}, alg=${envelope.alg})`,
      );
    }
    const key = await this.resolveKey();
    let plaintext: Buffer;
    try {
      plaintext = aesGcmDecrypt(
        key,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
      );
    } catch (e) {
      throw new TokenStoreError(
        'Failed to decrypt token file. Wrong AULA_MCP_KEY, or the key file is missing/corrupted.',
        { cause: e },
      );
    }
    let record: StoredTokenRecord;
    try {
      record = JSON.parse(plaintext.toString('utf8')) as StoredTokenRecord;
    } catch (e) {
      throw new TokenStoreError('Decrypted token blob is not valid JSON', { cause: e });
    }
    if (record.version !== 1) {
      throw new TokenStoreError(`Unsupported token record version ${record.version}`);
    }
    return record;
  }

  async save(record: StoredTokenRecord): Promise<void> {
    const key = await this.resolveKey();
    const iv = randomBytes(16);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, Buffer.from(JSON.stringify(record), 'utf8'));
    const envelope: EncryptedEnvelope = {
      version: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(envelope, null, 2), 'utf8');
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // chmod may fail on some filesystems (NTFS share, etc.) — non-fatal.
    }
  }

  async clear(): Promise<void> {
    // Delete the file outright. `load()` returns null for missing files, so a
    // post-clear `load()` rightly reports "no tokens" instead of throwing on
    // an empty-string parse. The .key file is intentionally left in place so
    // the next login can reuse the same encryption key.
    try {
      await unlink(this.filePath);
    } catch (e) {
      if (!isEnoent(e)) throw e;
    }
  }

  /** Where the encrypted JSON lives. Useful for `aula status`. */
  get path(): string {
    return this.filePath;
  }

  // ---- key resolution ------------------------------------------------------

  private async resolveKey(): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    if (this.explicitKey) {
      assertKeyLength(this.explicitKey);
      this.cachedKey = this.explicitKey;
      return this.cachedKey;
    }
    const envValue = process.env[this.envVar];
    if (envValue) {
      const buf = decodeKeyMaterial(envValue);
      this.cachedKey = buf;
      this.logger.debug('token-store.key.from_env', { envVar: this.envVar });
      return this.cachedKey;
    }
    // Fall back to a key file.
    let fileContents: string;
    try {
      fileContents = (await readFile(this.keyFilePath, 'utf8')).trim();
    } catch (e) {
      if (isEnoent(e)) {
        const fresh = randomBytes(32);
        await mkdir(dirname(this.keyFilePath), { recursive: true });
        await writeFile(this.keyFilePath, fresh.toString('hex'), 'utf8');
        try {
          await chmod(this.keyFilePath, 0o600);
        } catch {
          // best-effort
        }
        this.logger.warn('token-store.key.generated', {
          path: this.keyFilePath,
          note: `For better security, set ${this.envVar}=<hex> or pass a keychain-managed key.`,
        });
        this.cachedKey = fresh;
        return this.cachedKey;
      }
      throw new TokenStoreError(`Failed to read key file ${this.keyFilePath}`, { cause: e });
    }
    const buf = decodeKeyMaterial(fileContents);
    this.cachedKey = buf;
    return this.cachedKey;
  }
}

function decodeKeyMaterial(material: string): Buffer {
  const trimmed = material.trim();
  // Accept hex (64 chars) or base64 (44 chars including padding).
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  // Hash anything else with SHA-256 to derive a 32-byte key — works for
  // arbitrary passphrases and keeps the API forgiving.
  return sha256(trimmed);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== 32) {
    throw new TokenStoreError(`Token store key must be 32 bytes (got ${key.length})`);
  }
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';
}

// --------------------------------------------------------------------------
// Refresh-on-load helper
// --------------------------------------------------------------------------

export interface WithFreshTokensArgs {
  store: TokenStore;
  http: AulaHttpClient;
  /** Override OAuth config (defaults to production constants). */
  oauth?: AulaOAuthConfig;
  /** Buffer in seconds before expiry that triggers a refresh. Default 60. */
  refreshBufferSeconds?: number;
  logger?: Logger;
}

/**
 * Load the stored record and refresh the access token if it's near expiry.
 * Saves the new tokens back to the store. Returns the (possibly refreshed)
 * record. Throws if no record is present.
 */
export async function withFreshTokens(args: WithFreshTokensArgs): Promise<StoredTokenRecord> {
  const logger = args.logger ?? silentLogger;
  const oauth = args.oauth ?? DEFAULT_OAUTH_CONFIG;
  const record = await args.store.load();
  if (!record) {
    throw new TokenStoreError('No tokens on disk. Run `aula login` first.');
  }
  if (!isTokenExpired(record.tokens, args.refreshBufferSeconds ?? 60)) {
    return record;
  }
  logger.info('token-store.refresh.start');
  const refreshed = await refreshAccessToken(args.http, oauth, record.tokens.refresh_token, logger);
  const updated: StoredTokenRecord = {
    ...record,
    tokens: refreshed,
    saved_at: Math.floor(Date.now() / 1000),
  };
  await args.store.save(updated);
  return updated;
}
