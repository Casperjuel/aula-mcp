import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage, openStorage, type Storage, StorageConfigError } from './storage.ts';
import { keyId, loadStorageKey, loadStorageKeys, StorageKeyError } from './storage-crypto.ts';
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
        await db.run(
          'DROP TABLE IF EXISTS items, sync_state, shares, audit_log, feed_tokens, schema_migrations',
        );
      storage = await createStorage(db, KEY, { type: name as 'sqlite', location: 'test' });
      return storage;
    };
    afterEach(() => storage?.close());

    test('a new key opens what the old one sealed, and reencrypt moves the rows to it', async () => {
      const db = driver();
      if (name === 'postgres')
        await db.run(
          'DROP TABLE IF EXISTS items, sync_state, shares, audit_log, feed_tokens, schema_migrations',
        );
      const old = await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      await old.forParent('p').put([
        { kind: 'message', id: '1', data: { text: 'en' } },
        { kind: 'post', id: '2', data: { title: 'to' } },
      ]);
      // A payload from before key ids still opens.
      await db.run("UPDATE items SET payload = 'v1.' || substr(payload, 13) WHERE kind = 'post'");
      const NEW = Buffer.alloc(32, 8);
      storage = await createStorage(db, { current: NEW, previous: [KEY] }, old.info);
      const store = storage.forParent('p');
      expect((await store.get('message', '1'))?.data).toEqual({ text: 'en' });
      expect((await store.get('post', '2'))?.data).toEqual({ title: 'to' });
      expect(await store.keyStatus()).toEqual({ keyId: keyId(NEW), previousKeys: 1, stale: 2 });

      expect(await storage.reencrypt()).toEqual({ parents: 1, reencrypted: 2, unreadable: 0 });
      expect((await store.keyStatus()).stale).toBe(0);
      const [event] = await store.auditLog({ category: 'storage' });
      expect(event).toMatchObject({ action: 'reencrypt', ok: true });
      expect(event?.details).toMatchObject({ keyId: keyId(NEW), reencrypted: 2 });

      // The old key is no longer needed.
      const onlyNew = await createStorage(db, NEW, old.info);
      expect((await onlyNew.forParent('p').get('post', '2'))?.data).toEqual({ title: 'to' });
      expect(await storage.reencrypt()).toEqual({ parents: 0, reencrypted: 0, unreadable: 0 });
    });

    test('the audit log is per parent, filters, drops old entries and is not shared', async () => {
      const store = await open();
      const a = store.forParent('a');
      await a.audit({ category: 'sync', action: 'messages', ok: true, details: { fetched: 3 } });
      await a.audit({
        category: 'sync',
        action: 'posts',
        ok: false,
        durationMs: 12.4,
        details: { error: 'x'.repeat(400) },
      });
      await a.audit({ category: 'aula', action: 'mark_read', ok: true, details: { threadId: 5 } });
      await store.forParent('b').audit({ category: 'sync', action: 'messages', ok: true });

      const all = await a.auditLog();
      expect(all.map((e) => e.action)).toEqual(['mark_read', 'posts', 'messages']);
      expect(all[1]?.durationMs).toBe(12);
      expect(String(all[1]?.details.error)).toHaveLength(300);
      expect((await a.auditLog({ ok: false })).map((e) => e.action)).toEqual(['posts']);
      expect((await a.auditLog({ category: 'aula' })).map((e) => e.action)).toEqual(['mark_read']);
      expect(await a.auditLog({ before: all[2]?.at ?? 0 })).toEqual([]);
      expect(await store.forParent('b').auditLog()).toHaveLength(1);
      // Numbered pages: an offset into the same order, and a count of the whole filter.
      expect((await a.auditLog({ limit: 2, offset: 1 })).map((e) => e.action)).toEqual([
        'posts',
        'messages',
      ]);
      expect(await a.auditLog({ offset: 3 })).toEqual([]);
      expect(await a.auditCount()).toBe(3);
      expect(await a.auditCount({ category: 'sync' })).toBe(2);
      expect(await a.auditCount({ ok: false })).toBe(1);

      await store.shares.grant('a', 'A', 'b@example.dk');
      await store.shares.claim('b', 'b@example.dk');
      const view = await store.sharedWith('b', 'a');
      expect(await view?.auditLog()).toEqual([]);
      expect(await view?.auditCount()).toBe(0);
      await expect(view?.audit({ category: 'sync', action: 'x', ok: true })).rejects.toThrow();
    });

    test('shares read-only, and only what the viewer lacks', async () => {
      const store = await open();
      const owner = store.forParent('owner-a');
      const viewer = store.forParent('viewer-b');
      await owner.put([
        { kind: 'message', id: '1', occurredAt: 1_700_000_000, data: { text: 'Til begge' } },
        { kind: 'message', id: '2', occurredAt: 1_700_000_100, data: { text: 'Kun til A' } },
        { kind: 'post', id: '9', occurredAt: 1_700_000_200, data: { title: 'Opslag' } },
      ]);
      await viewer.put([
        { kind: 'message', id: '1', occurredAt: 1_700_000_000, data: { text: 'Til begge' } },
      ]);

      // Nothing until the owner grants and the viewer has claimed it.
      expect(await store.sharedWith('viewer-b', 'owner-a')).toBeNull();
      await store.shares.grant('owner-a', 'Anne', ' B@Example.dk ');
      expect(await store.shares.granted('owner-a')).toEqual([
        { email: 'b@example.dk', active: false, since: expect.any(Number) },
      ]);
      expect(await store.sharedWith('viewer-b', 'owner-a')).toBeNull();
      // The owner cannot claim their own share.
      expect(await store.shares.claim('owner-a', 'b@example.dk')).toBe(0);
      expect(await store.shares.claim('viewer-b', 'B@example.dk')).toBe(1);
      expect((await store.shares.granted('owner-a'))[0]?.active).toBe(true);
      expect(await store.shares.owners('viewer-b')).toEqual([
        { ownerId: 'owner-a', ownerName: 'Anne', since: expect.any(Number) },
      ]);

      const shared = await store.sharedWith('viewer-b', 'owner-a');
      if (!shared) throw new Error('expected a shared view');
      expect(shared.shared).toBe(true);
      expect((await shared.list({})).map((i) => `${i.kind}:${i.id}`)).toEqual([
        'post:9',
        'message:2',
      ]);
      expect(await shared.get('message', '1')).toBeNull();
      expect((await shared.get('message', '2'))?.data).toEqual({ text: 'Kun til A' });
      const counts = Object.fromEntries((await shared.stats()).map((k) => [k.kind, k.count]));
      expect(counts).toEqual({ message: 1, post: 1 });
      expect(shared.put([{ kind: 'post', id: '1', data: {} }])).rejects.toThrow('read-only');
      expect(shared.delete()).rejects.toThrow('read-only');
      // Sharing is one way, and not with yourself.
      expect(await store.sharedWith('owner-a', 'viewer-b')).toBeNull();
      expect(await store.sharedWith('owner-a', 'owner-a')).toBeNull();

      expect(await store.shares.revoke('owner-a', 'b@example.dk')).toBe(true);
      expect(await store.shares.revoke('owner-a', 'b@example.dk')).toBe(false);
      expect(await store.sharedWith('viewer-b', 'owner-a')).toBeNull();
    });

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

    test('deletes one item by kind and id', async () => {
      const parent = (await open()).forParent('parent-a');
      await parent.put([
        { kind: 'calendar_event', id: '901', data: 1 },
        { kind: 'calendar_event', id: '902', data: 2 },
        { kind: 'message', id: '901', data: 3 },
      ]);
      expect(await parent.delete({ kind: 'calendar_event', id: '901' })).toBe(1);
      expect(await parent.get('calendar_event', '901')).toBeNull();
      expect(await parent.get('calendar_event', '902')).not.toBeNull();
      expect(await parent.get('message', '901')).not.toBeNull();
    });

    test('lists by id prefix, with LIKE wildcards taken literally', async () => {
      const parent = (await open()).forParent('parent-a');
      await parent.put([
        { kind: 'message', id: '7:1', occurredAt: 1, data: 1 },
        { kind: 'message', id: '7:2', occurredAt: 2, data: 2 },
        { kind: 'message', id: '70:1', occurredAt: 3, data: 3 },
        { kind: 'message', id: '7_1', occurredAt: 4, data: 4 },
        { kind: 'message', id: 'a%b', occurredAt: 5, data: 5 },
      ]);
      const ids = async (idPrefix: string) =>
        (await parent.list({ kind: 'message', idPrefix })).map((item) => item.id);
      expect(await ids('7:')).toEqual(['7:2', '7:1']);
      expect(await ids('7_')).toEqual(['7_1']);
      expect(await ids('a%')).toEqual(['a%b']);
      expect(await ids('%')).toEqual([]);
    });

    test('payloads are encrypted at rest and bound to their parent and id', async () => {
      const db = driver();
      if (name === 'postgres')
        await db.run(
          'DROP TABLE IF EXISTS items, sync_state, shares, audit_log, feed_tokens, schema_migrations',
        );
      storage = await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      await storage
        .forParent('parent-a')
        .put([{ kind: 'message', id: '1', data: { text: 'hemmelig' } }]);
      const [row] = await db.all<{ payload: string }>('SELECT payload FROM items');
      expect(row?.payload.startsWith(`v2.${keyId(KEY)}.`)).toBe(true);
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
        await db.run(
          'DROP TABLE IF EXISTS items, sync_state, shares, audit_log, feed_tokens, schema_migrations',
        );
      storage = await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      await createStorage(db, KEY, { type: 'sqlite', location: 'test' });
      expect(await db.all('SELECT version FROM schema_migrations')).toHaveLength(5);
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

  test('the key file and AULA_MCP_STORAGE_PREVIOUS_KEYS become previous keys', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-storage-'));
    const file = join(dir, 'storage.key');
    const fromFile = await loadStorageKey(undefined, file);
    const other = Buffer.alloc(32, 9).toString('base64');
    const keys = await loadStorageKeys(
      {
        AULA_MCP_STORAGE_KEY: KEY.toString('base64'),
        AULA_MCP_STORAGE_PREVIOUS_KEYS: `${other}, ${KEY.toString('base64')}`,
      },
      file,
    );
    expect(keys.current.equals(KEY)).toBe(true);
    expect(keys.previous.map((k) => k.toString('base64'))).toEqual([
      other,
      fromFile.toString('base64'),
    ]);
    // Without a key in the environment the file is the current key.
    const plain = await loadStorageKeys({}, file);
    expect(plain.current.equals(fromFile)).toBe(true);
    expect(plain.previous).toEqual([]);
  });

  test('a key in the environment wins over the key file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-storage-'));
    const fromEnv = await loadStorageKey(KEY.toString('base64'), join(dir, 'storage.key'));
    expect(fromEnv.equals(KEY)).toBe(true);
    await expect(readFile(join(dir, 'storage.key'))).rejects.toThrow();
  });
});
