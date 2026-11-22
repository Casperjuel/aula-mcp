/**
 * The dashboard's read, unread and pin routes for a message thread, against
 * a fake Aula client: the write goes to Aula, the stored copy follows, every
 * change is audited with ids only, nothing is sent when the thread is already
 * in that state, and the unread and marked filters read the stored copy.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const RECORD = {
  version: 1,
  username: 'demo',
  tokens: {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    obtained_at: Math.floor(Date.now() / 1000),
  },
  saved_at: Math.floor(Date.now() / 1000),
} as StoredTokenRecord;

const store: TokenStore = { load: async () => RECORD, save: async () => {}, clear: async () => {} };

async function setup() {
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 3), {
    type: 'sqlite',
    location: 'test',
  });
  const mine = storage.forParent('default');
  await mine.put([
    {
      kind: 'message_thread',
      id: '301',
      occurredAt: 1_700_000_300,
      data: {
        id: 301,
        subject: 'Tur',
        read: false,
        subscriptionId: 9301,
        latestMessage: { id: 'm.2' },
      },
    },
    {
      kind: 'message_thread',
      id: '302',
      occurredAt: 1_700_000_200,
      data: { id: 302, subject: 'Jakke', read: true, marked: true, subscriptionId: 9302 },
    },
    { kind: 'message', id: '301:m.2', occurredAt: 1_700_000_300, data: { text: 'Hej' } },
  ]);
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return {};
    };
  const client = {
    setLastReadMessage: record('setLastReadMessage'),
    setThreadsRead: record('setThreadsRead'),
    setThreadsMarked: record('setThreadsMarked'),
    replyToThread: record('replyToThread'),
  } as unknown as AulaClient;
  let primed = 0;
  const app = createSetupApp({
    store,
    myData: {
      contextFor: () =>
        ({
          getClient: async () => client,
          getGuardianUserId: async () => {
            primed++;
            return 'g1';
          },
        }) as unknown as AulaContext,
      storage: { info: storage.info, forParent: () => mine },
    },
  });
  const post = (path: string, body: unknown = {}) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const get = async (path: string) =>
    (await app.fetch(new Request(`http://test${path}`))).json() as Promise<Record<string, unknown>>;
  const thread = async (id: string) =>
    (await mine.get('message_thread', id))?.data as Record<string, unknown>;
  const audit = () => mine.auditLog({ category: 'aula' });
  return { post, get, thread, audit, calls, primed: () => primed };
}

afterEach(() => {
  delete process.env.AULA_MCP_MARK_READ;
});

describe('dashboard thread state', () => {
  test('mark read moves the read marker, sets the read flag and stores it', async () => {
    const { post, thread, audit, calls, primed } = await setup();
    const res = await post('/data/messages/301/read');
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: 'setLastReadMessage', args: [301, 'm.2'] },
      { method: 'setThreadsRead', args: [[9301], true] },
    ]);
    expect(primed()).toBe(1);
    expect((await thread('301')).read).toBe(true);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'mark_read', ok: true });
    expect(entry?.details).toEqual({ trigger: 'dashboard', threadId: 301 });
  });

  test('sends nothing when the thread is already in that state', async () => {
    const { post, calls, audit } = await setup();
    const body = (await (await post('/data/messages/302/read')).json()) as { unchanged?: boolean };
    expect(body.unchanged).toBe(true);
    expect(calls).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  test('mark unread uses the subscription id', async () => {
    const { post, thread, calls } = await setup();
    expect((await post('/data/messages/302/unread')).status).toBe(200);
    expect(calls).toEqual([{ method: 'setThreadsRead', args: [[9302], false] }]);
    expect((await thread('302')).read).toBe(false);
  });

  test('pin and unpin set Aula’s marked flag', async () => {
    const { post, thread, calls, audit } = await setup();
    expect((await post('/data/messages/301/marked', { marked: true })).status).toBe(200);
    expect((await post('/data/messages/302/marked', { marked: false })).status).toBe(200);
    expect(calls).toEqual([
      { method: 'setThreadsMarked', args: [[301], true] },
      { method: 'setThreadsMarked', args: [[302], false] },
    ]);
    expect((await thread('301')).marked).toBe(true);
    expect((await thread('302')).marked).toBe(false);
    expect((await audit()).map((e) => e.action).sort()).toEqual(['mark_thread', 'unmark_thread']);
    expect((await post('/data/messages/301/marked', { marked: 'yes' })).status).toBe(400);
  });

  test('refuses unknown threads, a missing body and AULA_MCP_MARK_READ=0', async () => {
    const { post, calls } = await setup();
    expect((await post('/data/messages/999/read')).status).toBe(404);
    expect((await post('/data/messages/abc/read')).status).toBe(400);
    const noBody = await post('/data/messages/301/read', 'x');
    expect(noBody.status).toBe(415);
    process.env.AULA_MCP_MARK_READ = '0';
    expect((await post('/data/messages/301/read')).status).toBe(403);
    expect(calls).toEqual([]);
  });

  test('a stored thread without the id Aula needs is refused before Aula', async () => {
    const { post, calls } = await setup();
    await post('/data/messages/301/marked', { marked: true });
    calls.length = 0;
    // 302 has no latestMessage.id; set it unread first so read has work to do.
    await post('/data/messages/302/unread');
    calls.length = 0;
    expect((await post('/data/messages/302/read')).status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('filters and counts unread and marked threads', async () => {
    const { get } = await setup();
    const unread = (await get('/data/items?kind=message_thread&flag=unread')) as {
      items: Array<{ id: string; unread?: boolean }>;
    };
    expect(unread.items.map((i) => i.id)).toEqual(['301']);
    const marked = (await get('/data/items?kind=message_thread&flag=marked')) as {
      items: Array<{ id: string; marked?: boolean }>;
    };
    expect(marked.items).toMatchObject([{ id: '302', marked: true }]);
    expect(await get('/data/items?kind=message&flag=unread')).toMatchObject({
      error: 'flag needs kind=message_thread',
    });
    expect(await get('/data/messages/roles')).toMatchObject({ flags: { unread: 1, marked: 1 } });
  });

  test('a message names its thread and whether it is unread', async () => {
    const { get } = await setup();
    expect(await get('/data/items/message/301:m.2')).toMatchObject({
      thread: { id: '301', unread: true },
      canChange: true,
    });
    expect(await get('/data/items/message_thread/301')).toMatchObject({ canChange: true });
  });

  test('a reply goes to Aula as HTML and the audit keeps only its length', async () => {
    const { post, audit, calls } = await setup();
    const res = await post('/data/messages/301/reply', { text: '  Tak <3\n\nVi kommer  ' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: 'replyToThread', args: [301, '<p>Tak &lt;3</p><p>Vi kommer</p>'] },
    ]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'reply', ok: true });
    expect(entry?.details).toEqual({ trigger: 'dashboard', threadId: 301, characters: 17 });
  });

  test('a reply needs text and a stored thread', async () => {
    const { post, calls } = await setup();
    expect((await post('/data/messages/301/reply', { text: '   ' })).status).toBe(400);
    expect((await post('/data/messages/301/reply', { text: 'x'.repeat(5001) })).status).toBe(400);
    expect((await post('/data/messages/999/reply', { text: 'Hej' })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('a thread offers a reply box', async () => {
    const { get } = await setup();
    expect(await get('/data/items/message_thread/301')).toMatchObject({ canReply: true });
    expect((await get('/data/items/message/301:m.2')).canReply).toBeUndefined();
  });
});
