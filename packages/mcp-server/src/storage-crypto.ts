/**
 * Encryption for stored Aula data. Everything a parent's data says (message
 * text, names, photos' metadata) is sealed with AES-256-GCM before it reaches
 * the database, so a database dump or backup holds only ciphertext.
 *
 * One storage key per server; each parent gets their own key derived from it
 * (HKDF over the parent id), and every row is bound to its parent, kind and
 * id as associated data, so a row copied to another parent or id fails to
 * open instead of showing up as theirs.
 *
 * Rotating: the current key seals, and earlier keys (`previous`) still open
 * what they sealed. Each payload names its key by a short id derived from
 * it, so the rows still sealed with an earlier key can be found and sealed
 * again (Storage.reencrypt). v1 payloads, from before key ids, name no key
 * and are tried with every key.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const KEY_BYTES = 32;

export class StorageKeyError extends Error {
  override name = 'StorageKeyError';
}

/** The key that seals, and the earlier ones that still open. */
export interface StorageKeys {
  current: Buffer;
  previous: Buffer[];
}

export interface ParentCipher {
  seal(aad: string, plaintext: string): string;
  open(aad: string, sealed: string): string;
  /** Keyed hash, to spot unchanged rows without storing plaintext. */
  hash(plaintext: string): string;
  /** How every payload sealed with the current key starts. */
  readonly currentPrefix: string;
}

/** A short public id for a key, so a payload can say which key sealed it. */
export function keyId(key: Buffer): string {
  return createHmac('sha256', key).update('aula-mcp-key-id').digest('hex').slice(0, 8);
}

export function parentCipher(keys: Buffer | StorageKeys, parentId: string): ParentCipher {
  const ring = Buffer.isBuffer(keys) ? { current: keys, previous: [] } : keys;
  const derived = [ring.current, ...ring.previous].map((storageKey) => {
    const derive = (purpose: string) =>
      Buffer.from(
        hkdfSync('sha256', storageKey, 'aula-mcp-storage', `${purpose}:${parentId}`, KEY_BYTES),
      );
    return { id: keyId(storageKey), seal: derive('seal'), hash: derive('hash') };
  });
  const current = derived[0] as (typeof derived)[number];
  const prefix = `${VERSION}.${current.id}.`;
  return {
    currentPrefix: prefix,
    seal(aad, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current.seal, iv);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${prefix}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    open(aad, sealed) {
      const parts = sealed.split('.');
      let candidates = derived;
      let data: string | undefined;
      if (parts[0] === VERSION && parts.length === 3) {
        // The named key first; another with the same short id after it.
        const named = derived.filter((k) => k.id === parts[1]);
        candidates = [...named, ...derived.filter((k) => k.id !== parts[1])];
        data = parts[2];
      } else if (parts[0] === LEGACY_VERSION && parts.length === 2) {
        data = parts[1];
      }
      if (!data) throw new StorageKeyError('Unknown payload format.');
      const raw = Buffer.from(data, 'base64');
      for (const key of candidates) {
        const decipher = createDecipheriv('aes-256-gcm', key.seal, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(raw.subarray(12, 28));
        try {
          return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
            'utf8',
          );
        } catch {}
      }
      throw new StorageKeyError(
        'A stored row could not be decrypted. None of the storage keys is the one it was written with.',
      );
    },
    hash(plaintext) {
      return createHmac('sha256', current.hash).update(plaintext).digest('base64url');
    },
  };
}

/**
 * The storage key: AULA_MCP_STORAGE_KEY (base64, 32 bytes) when set,
 * otherwise a key file created on first use. Losing the key makes the stored
 * data unreadable; back it up together with the database.
 */
export async function loadStorageKey(envKey: string | undefined, keyFile: string): Promise<Buffer> {
  if (envKey) return decodeKey(envKey, 'AULA_MCP_STORAGE_KEY');
  try {
    return decodeKey((await readFile(keyFile, 'utf8')).trim(), keyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(KEY_BYTES);
  await mkdir(dirname(keyFile), { recursive: true });
  // `wx`: if another process created it meanwhile, use theirs.
  try {
    await writeFile(keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return decodeKey((await readFile(keyFile, 'utf8')).trim(), keyFile);
  }
}

/**
 * The current key (as loadStorageKey picks it) and the earlier ones:
 * AULA_MCP_STORAGE_PREVIOUS_KEYS (base64 keys, separated by commas or
 * whitespace), and the key file when AULA_MCP_STORAGE_KEY is set, since that
 * file holds the key the server used before it was given one.
 */
export async function loadStorageKeys(
  env: NodeJS.ProcessEnv,
  keyFile: string,
): Promise<StorageKeys> {
  const current = await loadStorageKey(env.AULA_MCP_STORAGE_KEY, keyFile);
  const previous = (env.AULA_MCP_STORAGE_PREVIOUS_KEYS ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((encoded) => decodeKey(encoded, 'AULA_MCP_STORAGE_PREVIOUS_KEYS'));
  if (env.AULA_MCP_STORAGE_KEY) {
    try {
      previous.push(decodeKey((await readFile(keyFile, 'utf8')).trim(), keyFile));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const seen = new Set([current.toString('base64')]);
  return {
    current,
    previous: previous.filter((key) => {
      const encoded = key.toString('base64');
      if (seen.has(encoded)) return false;
      seen.add(encoded);
      return true;
    }),
  };
}

function decodeKey(encoded: string, source: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new StorageKeyError(`${source} must be ${KEY_BYTES} bytes, base64-encoded.`);
  }
  return key;
}
