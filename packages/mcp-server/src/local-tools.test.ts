/**
 * The aula.local.* tools over a real in-memory store, called through MCP.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseDate, registerLocalTools } from './local-tools.ts';
import { createStorage, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

let storage: Storage;
let client: Client;

const sender = (fullName: string, portalRole?: string) => ({
  fullName,
  mailBoxOwner: portalRole ? { portalRole } : {},
});

beforeEach(async () => {
  storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 3), {
    type: 'sqlite',
    location: 't',
  });
  await storage.forParent('a').put([
    {
      kind: 'message_thread',
      id: '10',
      occurredAt: '2026-11-20T10:00:00+01:00',
      data: { subject: 'Udflugt fredag', latestMessage: { sender: sender('Lærer', 'employee') } },
    },
    {
      kind: 'message',
      id: '10:1',
      occurredAt: '2026-11-20T10:00:00+01:00',
      data: { sender: sender('Lærer', 'employee'), text: { html: '<p>Husk madpakke</p>' } },
    },
    {
      kind: 'message',
      id: '10:2',
      occurredAt: '2026-11-20T11:00:00+01:00',
      data: { sender: sender('Mor', 'guardian'), text: { html: '<p>Tak</p>' } },
    },
    {
      kind: 'calendar_event',
      id: '7',
      occurredAt: '2026-11-25T08:00:00+01:00',
      data: {
        title: 'Forældremøde',
        type: 'parental_meeting',
        startDateTime: '2026-11-25T08:00:00+01:00',
        endDateTime: '2026-11-25T09:00:00+01:00',
      },
    },
    {
      kind: 'calendar_event',
      id: '8',
      occurredAt: '2026-11-24T00:00:00+01:00',
      data: {
        title: 'Fri',
        type: 'presence_holiday',
        allDay: true,
        startDateTime: '2026-11-24T00:00:00+01:00',
        endDateTime: '2026-11-24T23:59:00+01:00',
      },
    },
  ]);
  // Another parent's row must never show up.
  await storage.forParent('b').put([
    {
      kind: 'message',
      id: '99:1',
      data: { sender: sender('Anden', 'guardian'), text: 'madpakke' },
    },
  ]);
  const server = new McpServer({ name: 't', version: '0' });
  registerLocalTools(server, storage.forParent('a'));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await storage.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

describe('aula.local tools', () => {
  test('every tool is listed with a description', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'aula.local.activity',
      'aula.local.calendar',
      'aula.local.get',
      'aula.local.message_roles',
      'aula.local.overview',
      'aula.local.search',
    ]);
    for (const tool of tools) expect((tool.description ?? '').length).toBeGreaterThan(150);
  });

  test('overview counts this parent only', async () => {
    const { kinds } = (await call('aula.local.overview')).json();
    expect(kinds.find((k: { kind: string }) => k.kind === 'message').count).toBe(2);
  });

  test('search combines text and role, with ISO times', async () => {
    const all = (await call('aula.local.search', { q: 'MADPAKKE' })).json();
    expect(all.items.map((i: { id: string }) => i.id)).toEqual(['10:1']);
    expect(all.items[0].occurred).toBe('2026-11-20T09:00:00.000Z');
    const guardians = (
      await call('aula.local.search', { kind: 'message', role: 'guardian' })
    ).json();
    expect(guardians.items.map((i: { id: string }) => i.id)).toEqual(['10:2']);
    expect((await call('aula.local.search', { role: 'guardian' })).isError).toBe(true);
  });

  test('get returns a thread with its messages, raw only when asked', async () => {
    const thread = (await call('aula.local.get', { kind: 'message_thread', id: '10' })).json();
    expect(thread.title).toBe('Udflugt fredag');
    expect(thread.messages.map((m: { role: string }) => m.role)).toEqual(['employee', 'guardian']);
    expect(thread.raw).toBeUndefined();
    const raw = (await call('aula.local.get', { kind: 'message', id: '10:2', raw: true })).json();
    expect(raw.raw.sender.fullName).toBe('Mor');
    expect((await call('aula.local.get', { kind: 'message', id: '99:1' })).isError).toBe(true);
  });

  test('calendar is oldest first and filters by type', async () => {
    const all = (
      await call('aula.local.calendar', { since: '2026-11-23', until: '2026-11-30' })
    ).json();
    expect(all.events.map((e: { id: string }) => e.id)).toEqual(['8', '7']);
    const meetings = (
      await call('aula.local.calendar', {
        since: '2026-11-23',
        until: '2026-11-30',
        types: ['parental_meeting'],
      })
    ).json();
    expect(meetings.events).toHaveLength(1);
    expect(meetings.events[0].typeLabel).toBeTruthy();
  });

  test('activity counts per day, the month of since by default', async () => {
    const nov = (await call('aula.local.activity', { since: '2026-11-15' })).json();
    expect(nov.until).toBe('2026-11-30T22:59:59.000Z');
    expect(nov.days).toEqual([{ day: '2026-11-20', counts: { message: 2 } }]);
    expect(nov.totals).toEqual({ message: 2, gallery_media: 0, post: 0, notification: 0 });
    const posts = (
      await call('aula.local.activity', { since: '2026-11-01', kinds: ['post'] })
    ).json();
    expect(posts).toMatchObject({ totals: { post: 0 }, days: [] });
    expect(
      (await call('aula.local.activity', { since: '2026-01-01', until: '2027-06-01' })).isError,
    ).toBe(true);
  });

  test('message_roles counts by sender', async () => {
    const counts = (await call('aula.local.message_roles')).json();
    expect(counts.messages).toEqual({ guardian: 1, employee: 1, child: 0, other: 0 });
    expect(counts.threads.employee).toBe(1);
  });

  test('parseDate takes a date as Copenhagen midnight', () => {
    expect(parseDate('2026-11-21')).toBe(Date.parse('2026-11-20T23:00:00Z') / 1000);
    expect(parseDate('2026-07-01')).toBe(Date.parse('2026-06-30T22:00:00Z') / 1000);
    expect(parseDate('nope')).toBeNull();
  });
});

describe('aula.local tools with sharing', () => {
  const OWNER = 'b'.repeat(32);
  test('read what another parent shares by `owner`, only what the caller lacks', async () => {
    await storage.forParent(OWNER).put([
      { kind: 'message', id: '10:1', data: { sender: sender('Lærer', 'employee'), text: 'x' } },
      { kind: 'message', id: '99:1', data: { sender: sender('Pædagog', 'employee'), text: 'y' } },
    ]);
    await storage.shares.grant(OWNER, 'Far', 'a@example.dk');
    await storage.shares.claim('a', 'a@example.dk');
    const server = new McpServer({ name: 't', version: '0' });
    registerLocalTools(server, storage.forParent('a'), {
      owners: () => storage.shares.owners('a'),
      open: async (ownerId) => {
        const store = await storage.sharedWith('a', ownerId);
        return store ? { store, gallery: null } : null;
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const shared = new Client({ name: 'test', version: '0' });
    await shared.connect(clientSide);
    const callShared = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await shared.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      return { isError: result.isError === true, text };
    };

    const owners = JSON.parse((await callShared('aula.local.shared_with_me')).text);
    expect(owners.owners).toEqual([{ owner: OWNER, name: 'Far', since: expect.any(String) }]);
    const found = JSON.parse(
      (await callShared('aula.local.search', { kind: 'message', owner: OWNER })).text,
    );
    expect(found.items.map((i: { id: string }) => i.id)).toEqual(['99:1']);
    expect(
      (await callShared('aula.local.get', { kind: 'message', id: '10:1', owner: OWNER })).isError,
    ).toBe(true);
    const nobody = await callShared('aula.local.search', { owner: 'c'.repeat(32) });
    expect(nobody.isError).toBe(true);
    expect(nobody.text).toContain('does not share');
    await shared.close();
  });
});
