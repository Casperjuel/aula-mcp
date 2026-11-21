/**
 * Encryption for stored Aula data. Everything a parent's data says (message
 * text, names, photos' metadata) is sealed with AES-256-GCM before it reaches
 * the database, so a database dump or backup holds only ciphertext.
 *
 * One storage key per server; each parent gets their own key derived from it
 * (HKDF over the parent id), and every row is bound to its parent, kind and
 * id as associated data, so a row copied to another parent or id fails to
 * open instead of showing up as theirs.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;

export class StorageKeyError extends Error {
  override name = 'StorageKeyError';
}

export interface ParentCipher {
  seal(aad: string, plaintext: string): string;
  open(aad: string, sealed: string): string;
  /** Keyed hash, to spot unchanged rows without storing plaintext. */
  hash(plaintext: string): string;
}

export function parentCipher(storageKey: Buffer, parentId: string): ParentCipher {
  const derive = (purpose: string) =>
    Buffer.from(
      hkdfSync('sha256', storageKey, 'aula-mcp-storage', `${purpose}:${parentId}`, KEY_BYTES),
    );
  const key = derive('seal');
  const hashKey = derive('hash');
  return {
    seal(aad, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    open(aad, sealed) {
      const [version, data] = sealed.split('.', 2);
      if (version !== VERSION || !data) throw new StorageKeyError('Unknown payload format.');
      const raw = Buffer.from(data, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(raw.subarray(12, 28));
      try {
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
          'utf8',
        );
      } catch {
        throw new StorageKeyError(
          'A stored row could not be decrypted. The storage key does not match the one it was written with.',
        );
      }
    },
    hash(plaintext) {
      return createHmac('sha256', hashKey).update(plaintext).digest('base64url');
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

function decodeKey(encoded: string, source: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new StorageKeyError(`${source} must be ${KEY_BYTES} bytes, base64-encoded.`);
  }
  return key;
}
