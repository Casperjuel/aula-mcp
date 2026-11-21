/**
 * The calendar feed: valid iCalendar from stored events, and a secret link
 * that is stored only as a hash, replaced by a new one and removable.
 */

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { feedEvents, toIcs } from './calendar-feed.ts';
import { registerLocalTools } from './local-tools.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const NOW = new Date('2026-11-21T10:00:00Z');

async function store() {
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 5), {
    type: 'sqlite',
    location: 'test',
  });
  const mine = storage.forParent('default');
  await mine.put([
    {
      kind: 'calendar_event',
      id: '1',
      occurredAt: '2026-11-24T17:00:00+01:00',
      data: {
        id: 1,
        type: 'event',
        title: 'Forældremøde; 3.a, alle',
        startDateTime: '2026-11-24T17:00:00+01:00',
        endDateTime: '2026-11-24T18:30:00+01:00',
        primaryResource: { name: 'Lokale 12' },
      },
    },
    {
      kind: 'calendar_event',
      id: '2',
      occurredAt: '2026-12-21T00:00:00+01:00',
      data: {
        id: 2,
        type: 'presence_holiday',
        title: 'Juleferie',
        allDay: true,
        startDateTime: '2026-12-21T00:00:00+01:00',
        endDateTime: '2027-01-01T00:00:00+01:00',
      },
    },
    {
      kind: 'calendar_event',
      id: '3',
      occurredAt: '2026-11-23T08:00:00+01:00',
      data: {
        id: 3,
        type: 'lesson',
        title: 'Dansk',
        startDateTime: '2026-11-23T08:00:00+01:00',
        endDateTime: '2026-11-23T08:45:00+01:00',
      },
    },
    {
      kind: 'calendar_event',
      id: '4',
      occurredAt: '2026-09-01T08:00:00+02:00',
      data: {
        id: 4,
        type: 'event',
        title: 'Gammel',
        startDateTime: '2026-09-01T08:00:00+02:00',
        endDateTime: '2026-09-01T09:00:00+02:00',
      },
    },
  ]);
  return { storage, mine };
}

describe('toIcs', () => {
  test('timed and all-day events, escaped, without lessons or old events', async () => {
    const { mine } = await store();
    const ics = toIcs(await feedEvents(mine, { now: NOW }), NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:aula-1@aula-mcp');
    expect(ics).toContain('SUMMARY:Forældremøde\\; 3.a\\, alle');
    expect(ics).toContain('DTSTART:20261124T160000Z');
    expect(ics).toContain('DTEND:20261124T173000Z');
    // All day: the end is the day after the last day.
    expect(ics).toContain('DTSTART;VALUE=DATE:20261221');
    expect(ics).toContain('DTEND;VALUE=DATE:20270102');
    expect(ics).not.toContain('Dansk');
    expect(ics).not.toContain('Gammel');
  });

  test('lessons on request', async () => {
    const { mine } = await store();
    expect(toIcs(await feedEvents(mine, { now: NOW, lessons: true }), NOW)).toContain(
      'SUMMARY:Dansk',
    );
  });

  test('folds long lines at 75 octets without splitting a character', () => {
    const ics = toIcs(
      [
        {
          kind: 'calendar_event',
          id: '9',
          childId: null,
          occurredAt: null,
          firstSeenAt: 0,
          updatedAt: 0,
          data: {
            type: 'event',
            title: 'æ'.repeat(100),
            startDateTime: '2026-11-24T17:00:00+01:00',
            endDateTime: '2026-11-24T18:00:00+01:00',
          },
        },
      ],
      NOW,
    );
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'æ'.repeat(100)}`);
  });
});

describe('calendar feed link', () => {
  async function app() {
    const { storage } = await store();
    const setup = createSetupApp({
      store: { load: async () => null, save: async () => {}, clear: async () => {} },
      myData: {
        contextFor: () => {
          throw new Error('the feed must not ask Aula');
        },
        storage: { info: storage.info, forParent: () => storage.forParent('default') },
        feeds: {
          tokens: storage.feeds,
          parentIdOf: () => 'default',
          storageFor: (id) => storage.forParent(id),
          publicUrl: 'https://aula.example',
        },
      },
    });
    const call = (path: string, method = 'GET') =>
      setup.fetch(
        new Request(`http://test${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        }),
      );
    return { storage, call };
  }

  test('is made once, works, is replaced and removed, and is audited', async () => {
    const { storage, call } = await app();
    expect(await (await call('/data/calendar-feed')).json()).toEqual({ active: false });

    const { url } = (await (await call('/data/calendar-feed', 'POST')).json()) as { url: string };
    expect(url).toMatch(/^https:\/\/aula\.example\/feed\/[\w-]{43}\/calendar\.ics$/);
    const path = new URL(url).pathname;
    const feed = await call(path);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    expect(feed.headers.get('cache-control')).toBe('private, no-store');
    expect(await feed.text()).toContain('BEGIN:VEVENT');

    // Only a hash is stored, never the secret itself.
    const token = path.split('/')[2] as string;
    const status = (await (await call('/data/calendar-feed')).json()) as Record<string, unknown>;
    expect(status.active).toBe(true);
    expect(typeof status.lastUsedAt).toBe('number');
    expect(JSON.stringify(status)).not.toContain(token);

    const { url: next } = (await (await call('/data/calendar-feed', 'POST')).json()) as {
      url: string;
    };
    expect((await call(path)).status).toBe(404);
    expect((await call(new URL(next).pathname)).status).toBe(200);

    expect((await call('/data/calendar-feed/remove', 'POST')).status).toBe(200);
    expect((await call(new URL(next).pathname)).status).toBe(404);

    const log = await storage.forParent('default').auditLog({ category: 'sharing' });
    expect(log.map((e) => e.action).sort()).toEqual([
      'calendar_feed_created',
      'calendar_feed_created',
      'calendar_feed_removed',
    ]);
    expect(JSON.stringify(log)).not.toContain(token);
  });

  test('a wrong or malformed link is a plain 404', async () => {
    const { call } = await app();
    expect((await call(`/feed/${'a'.repeat(43)}/calendar.ics`)).status).toBe(404);
    expect((await call('/feed/x/calendar.ics')).status).toBe(404);
  });
});

describe('aula.local.calendar_feed_status', () => {
  test('tells whether the link exists, never the link', async () => {
    const { storage, mine } = await store();
    const server = new McpServer({ name: 't', version: '0' });
    registerLocalTools(server, mine, undefined, () => storage.feeds.status('default'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    const status = async () => {
      const result = await client.callTool({ name: 'aula.local.calendar_feed_status' });
      return (result.content as Array<{ text: string }>)[0]?.text ?? '';
    };
    expect(JSON.parse(await status()).active).toBe(false);
    const token = await storage.feeds.create('default');
    const text = await status();
    expect(JSON.parse(text).active).toBe(true);
    expect(text).not.toContain(token);
    await client.close();
  });
});
