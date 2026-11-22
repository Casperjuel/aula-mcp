/**
 * One-time copy of the stored Aula data from a SQLite file into the
 * configured PostgreSQL database, for moving a server from sqlite to
 * postgres:
 *
 *   AULA_MCP_STORAGE=postgres AULA_MCP_DATABASE_URL=... \
 *     bun src/storage-copy.ts /data/aula.db
 *
 * The server does this by itself when it starts on postgres and finds the
 * SQLite file (importSqlite, called from openStorage).
 *
 * Rows are copied as they are, still encrypted. One of the storage keys
 * (AULA_MCP_STORAGE_KEY, AULA_MCP_STORAGE_PREVIOUS_KEYS, or the key file)
 * must open the source; that is checked before anything is written, and
 * Storage.reencrypt seals the rows with the current key afterwards. Rows the
 * target already has are kept: a sync that ran there first has the newer
 * copy. Running it twice copies nothing the second time. Prints counts only.
 */

import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from './storage.ts';
import { loadStorageKeys, type StorageKeys } from './storage-crypto.ts';
import { postgresDriver, type SqlDriver, sqliteDriver } from './storage-sql.ts';

const PAGE = 500;

const ITEM_COLUMNS = [
  'parent_id',
  'kind',
  'id',
  'child_id',
  'occurred_at',
  'content_hash',
  'payload',
  'first_seen_at',
  'updated_at',
];

const SYNC_COLUMNS = [
  'parent_id',
  'job',
  'last_run_at',
  'last_success_at',
  'next_run_at',
  'failures',
  'last_error',
  'fetched',
  'changed',
];
const SHARE_COLUMNS = ['owner_id', 'email', 'owner_name', 'viewer_id', 'created_at'];
const AUDIT_COLUMNS = [
  'parent_id',
  'id',
  'at',
  'category',
  'action',
  'ok',
  'duration_ms',
  'details',
];

export interface CopyResult {
  parents: number;
  items: { read: number; copied: number };
  syncStates: { read: number; copied: number };
  shares: { read: number; copied: number };
  auditLog: { read: number; copied: number };
}

export class StorageKeyMismatchError extends Error {
  override name = 'StorageKeyMismatchError';
}

/** Copies every row of `from` into `to` that `to` does not have yet. */
export async function copyStorage(
  from: SqlDriver,
  to: SqlDriver,
  storageKeys: Buffer | StorageKeys,
): Promise<CopyResult> {
  // Both get the current schema; the source decodes with a key, or stops here.
  const source = await createStorage(from, storageKeys, { type: from.dialect, location: '' });
  await createStorage(to, storageKeys, { type: to.dialect, location: '' });
  const parents = await source.parents();
  for (const parent of parents) {
    try {
      await source.forParent(parent).list({ limit: 1 });
    } catch {
      throw new StorageKeyMismatchError(
        'No storage key decrypts the source data; give the key it was written with as AULA_MCP_STORAGE_PREVIOUS_KEYS.',
      );
    }
  }
  return {
    parents: parents.length,
    items: await copyTable(from, to, 'items', ITEM_COLUMNS, 'parent_id, kind, id'),
    syncStates: await copyTable(from, to, 'sync_state', SYNC_COLUMNS, 'parent_id, job'),
    shares: await copyTable(from, to, 'shares', SHARE_COLUMNS, 'owner_id, email'),
    auditLog: await copyTable(from, to, 'audit_log', AUDIT_COLUMNS, 'parent_id, id'),
  };
}

/**
 * Copies the SQLite file at `path` into `to`, then renames it to
 * <path>.imported (its -wal and -shm files go with it), so the next start
 * does not copy what a parent has deleted since. Each parent's audit log
 * gets an entry. Throws, and renames nothing, when no key opens the file.
 */
export async function importSqlite(
  path: string,
  to: SqlDriver,
  storageKeys: StorageKeys,
): Promise<CopyResult> {
  const started = Date.now();
  const from = sqliteDriver(path);
  let result: CopyResult;
  let parents: string[];
  try {
    result = await copyStorage(from, to, storageKeys);
    const source = await createStorage(from, storageKeys, { type: 'sqlite', location: '' });
    parents = await source.parents();
  } finally {
    await from.close();
  }
  let target = `${path}.imported`;
  if (existsSync(target)) target = `${path}.imported-${Math.floor(started / 1000)}`;
  await rename(path, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(path + suffix)) await rename(path + suffix, target + suffix);
  }
  const storage = await createStorage(to, storageKeys, { type: to.dialect, location: '' });
  for (const parent of parents) {
    await storage
      .forParent(parent)
      .audit({
        category: 'storage',
        action: 'import_sqlite',
        ok: true,
        durationMs: Date.now() - started,
        details: {
          parents: result.parents,
          itemsRead: result.items.read,
          itemsCopied: result.items.copied,
          renamedTo: target.split('/').at(-1) ?? null,
        },
      })
      .catch(() => {});
  }
  return result;
}

async function copyTable(
  from: SqlDriver,
  to: SqlDriver,
  table: string,
  columns: string[],
  key: string,
): Promise<{ read: number; copied: number }> {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${key}) DO NOTHING`;
  let read = 0;
  let copied = 0;
  for (;;) {
    const rows = await from.all(
      `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${key} LIMIT ${PAGE} OFFSET ${read}`,
    );
    read += rows.length;
    copied += await to.transaction(async (tx) => {
      let changed = 0;
      for (const row of rows)
        changed += await tx.run(
          insert,
          columns.map((c) => row[c] as never),
        );
      return changed;
    });
    if (rows.length < PAGE) return { read, copied };
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  const env = process.env;
  if (!path || !existsSync(path)) {
    console.error('usage: bun src/storage-copy.ts <existing sqlite file>');
    process.exit(2);
  }
  if (env.AULA_MCP_STORAGE !== 'postgres' || !env.AULA_MCP_DATABASE_URL) {
    console.error(
      'The target is the configured storage: set AULA_MCP_STORAGE=postgres and AULA_MCP_DATABASE_URL.',
    );
    process.exit(2);
  }
  const dir = env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  const keys = await loadStorageKeys(env, join(dir, 'storage.key'));
  const from = sqliteDriver(path);
  const to = postgresDriver(env.AULA_MCP_DATABASE_URL);
  try {
    console.log(JSON.stringify(await copyStorage(from, to, keys)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await from.close();
    await to.close();
  }
}
