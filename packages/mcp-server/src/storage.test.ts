import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, openStorage, type Storage, StorageConfigError } from './storage.ts';
import { loadStorageKey, StorageKeyError } from './storage-crypto.ts';
import { postgresDriver, type SqlDriver, sqliteDriver } from './storage-sql.ts';

const KEY = Buffer.alloc(32, 7);

// Runs against SQLite always, and against PostgreSQL too when
// AULA_MCP_TEST_DATABASE_URL points at a throwaway database.
const backends: Array<[string, () => SqlDriver]> = [['sqlite', () => sqliteDriver(':memory:')]];
const pgUrl = process.env.AULA_MCP_TEST_DATABASE_URL;
if (pgUrl) backends.push(['postgres', () => postgresDriver(pgUrl)]);

for (const [name, driver] of backends) {
  describe(`storage on ${name}`, () => {
    let storage: Storage;
    const open = async () => {
      const db = driver();
      if (name === 'postgres')
        await db.run('DROP TABLE IF EXISTS items, sync_state, schema_migrations');
      storage = await createStorage(db, KEY, { type: name as 'sqlite', location: 'test' });
      return storage;
    };
    afterEach(() => storage?.close());

    test('stores, reads back and lists newest first', async () => {
      const parent = (await open()).forParent('parent-a');
      expect(
        await parent.put([
          {
            kind: 'message',
            id: '1',
            childId: '10',
            occurredAt: '2026-11-01T08:00:00Z',
            data: { text: 'Hej' },
          },
          {
            kind: 'message',
            id: '2',
            occurredAt: new Date('2026-11-02T08:00:00Z'),
            data: { text: 'Bålhytten' },
          },
          { kind: 'post', id: '1', occurredAt: 1_700_000_000, data: { title: 'Opslag' } },
        ]),
      ).toEqual({ changed: 3, unchanged: 0 });

      expect((await parent.get('message', '2'))?.data).toEqual({ text: 'Bålhytten' });
      expect(await parent.get('message', '3')).toBeNull();
      expect((await parent.list({ kind: 'message' })).map((item) => item.id)).toEqual(['2', '1']);
      expect((await parent.list({ childId: '10' })).map((item) => item.id)).toEqual(['1']);
      expect(
        (await parent.list({ since: Date.parse('2026-11-02T00:00:00Z') / 1000 })).map((i) => i.id),
      ).toEqual(['2']);
      expect((await parent.list({ limit: 1, offset: 1 })).map((i) => `${i.kind}:${i.id}`)).toEqual([
        'message:1',
      ]);
    });

    test('a re-put only counts real changes', async () => {
      const parent = (await open()).forParent('parent-a');
      await parent.put([{ kind: 'post', id: '1', data: { v: 1 } }]);
      const first = await parent.get('post', '1');
      expect(await parent.put([{ kind: 'post', id: '1', data: { v: 1 } }])).toEqual({
        changed: 0,
        unchanged: 1,
      });
      expect(await parent.put([{ kind: 'post', id: '1', data: { v: 2 } }])).toEqual({
        changed: 1,
        unchanged: 0,
      });
      const second = await parent.get('post', '1');
      expect(second?.data).toEqual({ v: 2 });
      expect(second?.firstSeenAt).toBe(first?.firstSeenAt as number);
    });

    test('parents never see each other', async () => {
      const store = await open();
      await store.forParent('parent-a').put([{ kind: 'message', id: '1', data: 'a' }]);
      await store.forParent('parent-b').put([{ kind: 'message', id: '1', data: 'b' }]);
      expect((await store.forParent('parent-a').get('message', '1'))?.data).toBe('a');
      expect((await store.forParent('parent-b').list()).map((i) => i.data)).toEqual(['b']);
      expect(await store.forParent('parent-c').list()).toEqual([]);
      expect(await store.parents()).toEqual(['parent-a', 'parent-b']);

      expect(await store.forParent('parent-a').delete()).toBe(1);
      expect(await store.forParent('parent-b').stats()).toHaveLength(1);
      expect(await store.parents()).toEqual(['parent-b']);
    });

    test('stats per kind and delete by kind', async () => {
      const parent = (await open()).forParent('parent-a');
      await parent.put([
        { kind: 'message', id: '1', occurredAt: 100, data: 1 },
        { kind: 'message', id: '2', occurredAt: 200, data: 2 },
        { kind: 'post', id: '1', data: 3 },
      ]);
      const stats = await parent.stats();
      expect(
        stats.map(({ kind, count, oldest, newest }) => ({ kind, count, oldest, newest })),
      ).toEqual([
        { kind: 'message', count: 2, oldest: 100, newest: 200 },
        { kind: 'post', count: 1, oldest: null, newest: null },
      ]);
      expect(await parent.delete({ kind: 'message' })).toBe(2);
      expect((await parent.stats()).map((s) => s.kind)).toEqual(['post']);
    });

    test('payloads are encrypted at rest and bound to their parent and id', async () => {
      const db = driver();
      if (name === 'postgres')
        await db.run('DROP TABLE IF EXISTS items, sync_state, schema_migrations');
      storage = await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      await storage
        .forParent('parent-a')
        .put([{ kind: 'message', id: '1', data: { text: 'hemmelig' } }]);
      const [row] = await db.all<{ payload: string }>('SELECT payload FROM items');
      expect(row?.payload.startsWith('v1.')).toBe(true);
      expect(row?.payload).not.toContain('hemmelig');

      // Moving the row to another parent does not make it readable there.
      await db.run("UPDATE items SET parent_id = 'parent-b'");
      await expect(storage.forParent('parent-b').get('message', '1')).rejects.toBeInstanceOf(
        StorageKeyError,
      );
    });

    test('migrations run once', async () => {
      const db = driver();
      if (name === 'postgres')
        await db.run('DROP TABLE IF EXISTS items, sync_state, schema_migrations');
      storage = await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      expect(await db.all('SELECT version FROM schema_migrations')).toHaveLength(2);
    });

    test('keeps sync state per parent', async () => {
      storage = await open();
      const state = {
        job: 'messages',
        lastRunAt: 100,
        lastSuccessAt: 100,
        nextRunAt: 1000,
        failures: 0,
        lastError: null,
        fetched: 3,
        changed: 2,
      };
      await storage.forParent('a').saveSyncState(state);
      await storage.forParent('a').saveSyncState({ ...state, failures: 1, lastError: 'boom' });
      expect(await storage.forParent('a').syncStates()).toEqual([
        { ...state, failures: 1, lastError: 'boom' },
      ]);
      expect(await storage.forParent('b').syncStates()).toEqual([]);
    });
  });
}

describe('openStorage', () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test('defaults to SQLite in AULA_MCP_DIR with a generated key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-storage-'));
    const storage = await openStorage({ AULA_MCP_DIR: dir });
    expect(storage?.info).toEqual({ type: 'sqlite', location: join(dir, 'aula.db') });
    await storage?.forParent('p').put([{ kind: 'post', id: '1', data: 1 }]);
    await storage?.close();
    expect((await stat(join(dir, 'storage.key'))).mode & 0o777).toBe(0o600);

    // Reopened with the same key file, the data is still readable.
    const again = await openStorage({ AULA_MCP_DIR: dir });
    expect((await again?.forParent('p').get('post', '1'))?.data).toBe(1);
    await again?.close();
  });

  test('none turns it off; bad settings are refused', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-storage-'));
    expect(await openStorage({ AULA_MCP_DIR: dir, AULA_MCP_STORAGE: 'none' })).toBeNull();
    await expect(
      openStorage({ AULA_MCP_DIR: dir, AULA_MCP_STORAGE: 'mysql' }),
    ).rejects.toBeInstanceOf(StorageConfigError);
    await expect(
      openStorage({ AULA_MCP_DIR: dir, AULA_MCP_STORAGE: 'postgres' }),
    ).rejects.toBeInstanceOf(StorageConfigError);
    await expect(
      openStorage({ AULA_MCP_DIR: dir, AULA_MCP_STORAGE_KEY: 'too-short' }),
    ).rejects.toBeInstanceOf(StorageKeyError);
  });

  test('a key in the environment wins over the key file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-storage-'));
    const fromEnv = await loadStorageKey(KEY.toString('base64'), join(dir, 'storage.key'));
    expect(fromEnv.equals(KEY)).toBe(true);
    await expect(readFile(join(dir, 'storage.key'))).rejects.toThrow();
  });
});
