/**
 * The dashboard's own JSON routes in single-parent mode: paging and search
 * over the stored items, an item with its thread, deleting and starting a
 * sync. Parent isolation in multi-parent mode is in setup-login.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Logger, StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { renderDashboard } from './setup-dashboard.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';
import type { ParentSync, SyncJobName, SyncJobStatus } from './sync.ts';

class MemoryStore implements TokenStore {
  record: StoredTokenRecord | null = null;
  async load() {
    return this.record;
  }
  async save(record: StoredTokenRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const LOGIN: StoredTokenRecord = {
  version: 1,
  username: 'demo',
  tokens: {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: now() + 3600,
    obtained_at: now(),
  },
  saved_at: now(),
};

/** A sync that records what it was asked to run and finishes when told. */
function fakeSync() {
  const runs: SyncJobName[][] = [];
  let finish = () => {};
  const sync: ParentSync = {
    async status() {
      return [
        {
          job: 'messages',
          description: 'Beskeder',
          intervalMinutes: 15,
          running: false,
          lastRunAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          ok: null,
          lastError: null,
          failuresInARow: 0,
          fetched: 0,
          changed: 0,
        } satisfies SyncJobStatus,
      ];
    },
    run(jobs) {
      runs.push(jobs ?? []);
      return new Promise((resolve) => {
        finish = () => resolve([]);
      });
    },
  };
  return { sync, runs, finish: () => finish() };
}

let storage: Storage | undefined;
afterEach(async () => {
  await storage?.close();
  storage = undefined;
});

async function setup(options: { login?: boolean; logger?: Logger } = {}) {
  storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 3), {
    type: 'sqlite',
    location: ':memory:',
  });
  const mine = storage.forParent('default');
  await mine.put([
    {
      kind: 'message_thread',
      id: '7',
      occurredAt: 300,
      data: {
        subject: 'Skovtur fredag',
        read: false,
        lastMessage: { sender: { fullName: 'Lærer Lis' } },
      },
    },
    {
      kind: 'message',
      id: '7:1',
      occurredAt: 100,
      data: { sender: { fullName: 'Lærer Lis' }, text: { plain: 'Husk madpakke' } },
    },
    {
      kind: 'message',
      id: '7:2',
      occurredAt: 200,
      data: { sender: { fullName: 'Far' }, text: { plain: 'Tak, vi husker gummistøvler' } },
    },
    { kind: 'message', id: '70:1', occurredAt: 150, data: { text: { plain: 'en anden tråd' } } },
    ...Array.from({ length: 5 }, (_, i) => ({
      kind: 'post' as const,
      id: `p${i}`,
      occurredAt: 400 + i,
      data: { title: `Opslag nummer ${i}` },
    })),
  ]);
  const store = new MemoryStore();
  if (options.login !== false) await store.save(LOGIN);
  const sync = fakeSync();
  const app = createSetupApp({
    store,
    ...(options.logger ? { logger: options.logger } : {}),
    myData: {
      contextFor: () => {
        throw new Error('unused');
      },
      storage: { info: storage.info, forParent: () => mine },
      sync: { forParent: () => sync.sync },
    },
  });
  return { app, mine, sync };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

type Page = { items: Array<{ kind: string; id: string; title: string }>; more: boolean };

describe('dashboard page', () => {
  test('has no external resources and escapes the signed-in name', () => {
    const html = renderDashboard('Anna <b>Hansen</b>');
    expect(html).not.toContain('<b>Hansen');
    expect(html).toContain('Anna &lt;b&gt;Hansen');
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(script ?? '')).not.toThrow();
    }
  });
});

describe('dashboard data routes', () => {
  test('lists items newest first, a page at a time', async () => {
    const { app } = await setup();
    const first = (await (await app.request('/data/items?kind=post&limit=2')).json()) as Page;
    expect(first.items.map((item) => item.id)).toEqual(['p4', 'p3']);
    expect(first.more).toBe(true);
    const last = (await (
      await app.request('/data/items?kind=post&limit=2&offset=4')
    ).json()) as Page;
    expect(last.items.map((item) => item.id)).toEqual(['p0']);
    expect(last.more).toBe(false);
  });

  test('searches the text the parent sees', async () => {
    const { app } = await setup();
    const hits = (await (await app.request('/data/items?q=GUMMISTØVLER')).json()) as Page;
    expect(hits.items.map((item) => `${item.kind}:${item.id}`)).toEqual(['message:7:2']);
    const none = (await (await app.request('/data/items?q=ingen%20s%C3%A5dan')).json()) as Page;
    expect(none.items).toEqual([]);
  });

  test('refuses an unknown kind and odd numbers', async () => {
    const { app } = await setup();
    expect((await app.request('/data/items?kind=secrets')).status).toBe(400);
    expect((await app.request('/data/items?limit=ten')).status).toBe(400);
    expect((await app.request('/data/items/secrets/1')).status).toBe(400);
  });

  test('shows a thread with its own messages, oldest first', async () => {
    const { app } = await setup();
    const res = await app.request('/data/items/message_thread/7');
    const body = (await res.json()) as {
      item: { title: string; unread?: boolean };
      messages: Array<{ id: string; from: string; body: string }>;
    };
    expect(body.item).toMatchObject({ title: 'Skovtur fredag', unread: true });
    // 70:1 shares the leading digits but belongs to another thread.
    expect(body.messages.map((m) => m.id)).toEqual(['7:1', '7:2']);
    expect(body.messages[0]).toMatchObject({ from: 'Lærer Lis', body: 'Husk madpakke' });
    expect((await app.request('/data/items/message_thread/8')).status).toBe(404);
  });

  test('deletes one kind or everything, only with a JSON SLET', async () => {
    const { app, mine } = await setup();
    const form = await app.request('/data/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'confirm=SLET&all=true',
    });
    expect(form.status).toBe(415);
    expect((await app.request('/data/delete', json({ all: true }))).status).toBe(400);
    expect((await app.request('/data/delete', json({ confirm: 'SLET', kind: 'x' }))).status).toBe(
      400,
    );

    const posts = await app.request('/data/delete', json({ confirm: 'SLET', kind: 'post' }));
    expect(await posts.json()).toEqual({ deleted: 5 });
    expect((await mine.stats()).map((s) => s.kind).sort()).toEqual(['message', 'message_thread']);

    const all = await app.request('/data/delete', json({ confirm: 'SLET', all: true }));
    expect(await all.json()).toEqual({ deleted: 4 });
    expect(await mine.stats()).toEqual([]);
  });

  test('starts a sync in the background and shows it queued', async () => {
    const { app, sync } = await setup();
    expect((await app.request('/data/sync/run', json({ jobs: ['nope'] }))).status).toBe(400);
    expect((await app.request('/data/sync/run', { method: 'POST', body: '{}' })).status).toBe(415);

    const res = await app.request('/data/sync/run', json({ jobs: ['messages'] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: ['messages'] });
    expect(sync.runs).toEqual([['messages']]);

    const status = (await (await app.request('/data/sync')).json()) as {
      available: boolean;
      logged_in: boolean;
      jobs: Array<{ job: string; queued: boolean }>;
    };
    expect(status).toMatchObject({ available: true, logged_in: true });
    expect(status.jobs[0]).toMatchObject({ job: 'messages', queued: true });

    sync.finish();
    await Bun.sleep(0);
    const after = (await (await app.request('/data/sync')).json()) as {
      jobs: Array<{ queued: boolean }>;
    };
    expect(after.jobs[0]?.queued).toBe(false);
  });

  test('does not start a sync without an Aula login', async () => {
    const { app, sync } = await setup({ login: false });
    expect((await app.request('/data/sync/run', json({}))).status).toBe(409);
    expect(sync.runs).toEqual([]);
  });

  test('refuses a cross-site POST from the browser', async () => {
    const { app, mine } = await setup();
    const res = await app.request(
      '/data/delete',
      json({ confirm: 'SLET', all: true }, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(res.status).toBe(403);
    expect((await mine.stats()).length).toBeGreaterThan(0);
    const run = await app.request('/data/sync/run', json({}, { 'sec-fetch-site': 'same-site' }));
    expect(run.status).toBe(403);
  });

  test('never logs the Aula content it serves', async () => {
    const lines: string[] = [];
    const record = (message: string, meta?: Record<string, unknown>) => {
      lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record };
    const { app } = await setup({ logger });
    await app.request('/data/items?q=madpakke');
    await app.request('/data/items/message_thread/7');
    await app.request('/data/items');
    const logged = lines.join('\n');
    expect(logged).not.toContain('madpakke');
    expect(logged).not.toContain('Skovtur');
    expect(logged).not.toContain('Lærer Lis');
  });
});
