/**
 * One-time copy of the stored Aula data from a SQLite file into the
 * configured PostgreSQL database, for moving a server from sqlite to
 * postgres:
 *
 *   AULA_MCP_STORAGE=postgres AULA_MCP_DATABASE_URL=... \
 *     bun src/storage-copy.ts /data/aula.db
 *
 * Rows are copied as they are, still encrypted, so the target must use the
 * same storage key (AULA_MCP_STORAGE_KEY, or <AULA_MCP_DIR>/storage.key). The
 * key is checked against the source before anything is written. Rows the
 * target already has are kept: a sync that ran there first has the newer
 * copy. Running it twice copies nothing the second time. Prints counts only.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from './storage.ts';
import { loadStorageKey } from './storage-crypto.ts';
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

export interface CopyResult {
  parents: number;
  items: { read: number; copied: number };
  syncStates: { read: number; copied: number };
}

export class StorageKeyMismatchError extends Error {
  override name = 'StorageKeyMismatchError';
}

/** Copies every row of `from` into `to` that `to` does not have yet. */
export async function copyStorage(
  from: SqlDriver,
  to: SqlDriver,
  storageKey: Buffer,
): Promise<CopyResult> {
  // Both get the current schema; the source decodes with the key, or stops here.
  const source = await createStorage(from, storageKey, { type: from.dialect, location: '' });
  await createStorage(to, storageKey, { type: to.dialect, location: '' });
  const parents = await source.parents();
  for (const parent of parents) {
    try {
      await source.forParent(parent).list({ limit: 1 });
    } catch {
      throw new StorageKeyMismatchError(
        'The storage key does not decrypt the source data; copy the source storage.key first.',
      );
    }
  }
  return {
    parents: parents.length,
    items: await copyTable(from, to, 'items', ITEM_COLUMNS, 'parent_id, kind, id'),
    syncStates: await copyTable(from, to, 'sync_state', SYNC_COLUMNS, 'parent_id, job'),
  };
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
  const key = await loadStorageKey(env.AULA_MCP_STORAGE_KEY, join(dir, 'storage.key'));
  const from = sqliteDriver(path);
  const to = postgresDriver(env.AULA_MCP_DATABASE_URL);
  try {
    console.log(JSON.stringify(await copyStorage(from, to, key)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await from.close();
    await to.close();
  }
}
