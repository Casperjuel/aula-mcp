/**
 * The sqlite-to-postgres copy, between two in-memory SQLite stores.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from './storage.ts';
import { copyStorage, importSqlite, StorageKeyMismatchError } from './storage-copy.ts';
import { sqliteDriver } from './storage-sql.ts';

const KEY = Buffer.alloc(32, 5);
const info = { type: 'sqlite' as const, location: 't' };

describe('copyStorage', () => {
  test('copies items and sync state, keeps what the target has, and is safe to rerun', async () => {
    const from = sqliteDriver(':memory:');
    const to = sqliteDriver(':memory:');
    const source = await createStorage(from, KEY, info);
    await source.forParent('a').put([
      { kind: 'message', id: '1:1', occurredAt: 1_700_000_000, data: { text: 'gammel' } },
      { kind: 'post', id: '2', data: { title: 'Opslag' } },
    ]);
    await source.forParent('b').put([{ kind: 'message', id: '9:1', data: { text: 'b' } }]);
    await source.forParent('a').saveSyncState({
      job: 'messages',
      lastRunAt: 1,
      lastSuccessAt: 1,
      nextRunAt: 2,
      failures: 0,
      lastError: null,
      fetched: 2,
      changed: 2,
    });
    const target = await createStorage(to, KEY, info);
    // The target synced this one already and has a newer copy.
    await target.forParent('a').put([{ kind: 'message', id: '1:1', data: { text: 'ny' } }]);

    const result = await copyStorage(from, to, KEY);
    expect(result).toEqual({
      parents: 2,
      items: { read: 3, copied: 2 },
      syncStates: { read: 1, copied: 1 },
      shares: { read: 0, copied: 0 },
      auditLog: { read: 0, copied: 0 },
    });
    expect((await target.forParent('a').get('message', '1:1'))?.data).toEqual({ text: 'ny' });
    expect((await target.forParent('a').get('post', '2'))?.data).toEqual({ title: 'Opslag' });
    expect((await target.forParent('b').get('message', '9:1'))?.data).toEqual({ text: 'b' });
    expect(await target.forParent('a').syncStates()).toHaveLength(1);

    expect((await copyStorage(from, to, KEY)).items.copied).toBe(0);
  });

  test('refuses to copy with a key that does not decrypt the source', async () => {
    const from = sqliteDriver(':memory:');
    const to = sqliteDriver(':memory:');
    await (await createStorage(from, KEY, info))
      .forParent('a')
      .put([{ kind: 'post', id: '1', data: {} }]);
    await expect(copyStorage(from, to, Buffer.alloc(32, 6))).rejects.toBeInstanceOf(
      StorageKeyMismatchError,
    );
    expect(await (await createStorage(to, KEY, info)).parents()).toEqual([]);
  });
});

describe('importSqlite', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  test('imports the file once under a new key, renames it and logs it per parent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-import-'));
    const path = join(dir, 'aula.db');
    const file = sqliteDriver(path);
    await (await createStorage(file, KEY, info))
      .forParent('a')
      .put([{ kind: 'post', id: '1', data: { title: 'gammel nøgle' } }]);
    await file.close();

    const NEW = Buffer.alloc(32, 6);
    const to = sqliteDriver(':memory:');
    const result = await importSqlite(path, to, { current: NEW, previous: [KEY] });
    expect(result.items).toEqual({ read: 1, copied: 1 });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.imported`)).toBe(true);

    const target = await createStorage(to, { current: NEW, previous: [KEY] }, info);
    expect((await target.forParent('a').get('post', '1'))?.data).toEqual({
      title: 'gammel nøgle',
    });
    const [event] = await target.forParent('a').auditLog({ category: 'storage' });
    expect(event).toMatchObject({ action: 'import_sqlite', ok: true });
    expect(event?.details).toMatchObject({ itemsCopied: 1, renamedTo: 'aula.db.imported' });
    expect(await target.reencrypt()).toMatchObject({ reencrypted: 1 });
  });

  test('stops, and leaves the file, when no key opens it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-import-'));
    const path = join(dir, 'aula.db');
    const file = sqliteDriver(path);
    await (await createStorage(file, KEY, info))
      .forParent('a')
      .put([{ kind: 'post', id: '1', data: {} }]);
    await file.close();
    await expect(
      importSqlite(path, sqliteDriver(':memory:'), { current: Buffer.alloc(32, 6), previous: [] }),
    ).rejects.toBeInstanceOf(StorageKeyMismatchError);
    expect(existsSync(path)).toBe(true);
  });
});
