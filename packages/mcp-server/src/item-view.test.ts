/**
 * Sender roles on messages and threads, the calendar summary, and the
 * dashboard routes that filter and count by role.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { detail, senderRole, summarize, threadMessage } from './item-view.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage, type ItemKind, type Storage, type StoredItem } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const item = (kind: ItemKind, data: unknown, id = '1'): StoredItem => ({
  kind,
  id,
  childId: null,
  occurredAt: 100,
  firstSeenAt: 100,
  updatedAt: 100,
  data,
});

const sender = (portalRole?: string) => ({
  fullName: 'Nogen',
  mailBoxOwner: portalRole ? { portalRole } : {},
});

describe('senderRole', () => {
  test('a message takes its sender’s portalRole', () => {
    expect(senderRole(item('message', { sender: sender('employee') }))).toBe('employee');
    expect(senderRole(item('message', { sender: sender('guardian') }))).toBe('guardian');
    expect(senderRole(item('message', { sender: sender('child') }))).toBe('child');
    expect(senderRole(item('message', { sender: { portalRole: 'Employee' } }))).toBe('employee');
  });

  test('a message without a role, or with an unknown one, is other', () => {
    expect(senderRole(item('message', { sender: sender() }))).toBe('other');
    expect(senderRole(item('message', {}))).toBe('other');
    expect(senderRole(item('message', { sender: sender('otp') }))).toBe('other');
  });

  test('a thread takes the latest sender, then the creator', () => {
    expect(
      senderRole(
        item('message_thread', {
          latestMessage: { sender: sender('guardian') },
          creator: { portalRole: 'employee' },
        }),
      ),
    ).toBe('guardian');
    expect(
      senderRole(
        item('message_thread', { latestMessage: { sender: {} }, creator: sender('child') }),
      ),
    ).toBe('child');
    expect(
      senderRole(
        item('message_thread', { latestMessage: {}, creator: { portalRole: 'employee' } }),
      ),
    ).toBe('employee');
    expect(
      senderRole(item('message_thread', { lastMessage: { sender: sender('guardian') } })),
    ).toBe('guardian');
    expect(senderRole(item('message_thread', { subject: 'Fra systemet' }))).toBe('other');
  });

  test('other kinds have no role', () => {
    expect(senderRole(item('post', { title: 'x' }))).toBeNull();
  });

  test('summaries and thread messages carry the role', () => {
    expect(summarize(item('message', { sender: sender('employee') })).senderRole).toBe('employee');
    expect(summarize(item('message_thread', { creator: sender('guardian') })).senderRole).toBe(
      'guardian',
    );
    expect(summarize(item('post', {})).senderRole).toBeUndefined();
    expect(summarize(item('post', { isImportant: true })).important).toBe(true);
    expect('important' in summarize(item('post', { isImportant: false }))).toBe(false);
    expect(threadMessage(item('message', { sender: sender('child') })).role).toBe('child');
  });
});

describe('calendar events', () => {
  const event = {
    id: 5,
    title: 'Forældremøde 3.B',
    type: 'parental_meeting',
    startDateTime: '2026-11-24T17:00:00+01:00',
    endDateTime: '2026-11-24T18:30:00+01:00',
    allDay: false,
    primaryResourceText: 'Aula 2',
    belongsToProfiles: [11, '12', 'x'],
    responseRequired: true,
    responseStatus: 'accepted',
    responseDeadline: '2026-11-22T12:00:00+01:00',
    creatorName: 'Lærer Lis',
    invitedGroups: [{ name: '3.B' }, 'Forældre'],
    institutionName: 'Skolen',
  };

  test('the summary has what the calendar places and badges', () => {
    const s = summarize(item('calendar_event', event));
    expect(s.subtitle).toBe('17:00 til 18:30 · Aula 2');
    expect(s.event).toEqual({
      type: 'parental_meeting',
      typeLabel: 'Forældremøde',
      start: '2026-11-24T17:00:00+01:00',
      end: '2026-11-24T18:30:00+01:00',
      allDay: false,
      place: 'Aula 2',
      profiles: [11, 12],
      responseRequired: true,
      response: 'Deltager',
      responseDeadline: '2026-11-22T12:00:00+01:00',
    });
  });

  test('the detail lists the event in Danish', () => {
    const fields = Object.fromEntries(detail(item('calendar_event', event)).fields);
    expect(fields).toMatchObject({
      Type: 'Forældremøde',
      Sted: 'Aula 2',
      'Oprettet af': 'Lærer Lis',
      Inviterede: '3.B, Forældre',
      Svar: 'Deltager',
      Institution: 'Skolen',
    });
  });

  test('a bare event still gets a summary', () => {
    const s = summarize(item('calendar_event', { type: 'something_new' }));
    expect(s.title).toBe('Begivenhed');
    expect(s.event).toMatchObject({ typeLabel: 'something_new', profiles: [], allDay: false });
  });
});

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

let storage: Storage | undefined;
afterEach(async () => {
  await storage?.close();
  storage = undefined;
});

async function app() {
  storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 5), {
    type: 'sqlite',
    location: ':memory:',
  });
  const mine = storage.forParent('default');
  const roles = ['employee', 'guardian', 'employee', undefined, 'child', 'employee', 'guardian'];
  await mine.put([
    ...roles.map((role, i) => ({
      kind: 'message' as const,
      id: `9:${i}`,
      occurredAt: 100 + i,
      data: { sender: sender(role), text: { plain: `besked ${i}` } },
    })),
    {
      kind: 'message_thread',
      id: '9',
      occurredAt: 200,
      data: { subject: 'Tråd', latestMessage: { sender: sender('guardian') } },
    },
    {
      kind: 'message_thread',
      id: '10',
      occurredAt: 201,
      data: { subject: 'System', creator: {} },
    },
  ]);
  // Another parent's messages never count here.
  await storage
    .forParent('other')
    .put([{ kind: 'message', id: '1:1', occurredAt: 1, data: { sender: sender('employee') } }]);
  const store = new MemoryStore();
  const own = storage.forParent('default');
  return createSetupApp({
    store,
    myData: {
      contextFor: () => {
        throw new Error('unused');
      },
      storage: { info: storage.info, forParent: () => own },
    },
  });
}

type Page = {
  items: Array<{ id: string; senderRole?: string }>;
  more: boolean;
  offset: number;
};

describe('GET /data/items?role', () => {
  test('filters messages by sender role, newest first', async () => {
    const a = await app();
    const page = (await (await a.request('/data/items?kind=message&role=employee')).json()) as Page;
    expect(page.items.map((i) => i.id)).toEqual(['9:5', '9:2', '9:0']);
    expect(page.items.every((i) => i.senderRole === 'employee')).toBe(true);
    const other = (await (await a.request('/data/items?kind=message&role=other')).json()) as Page;
    expect(other.items.map((i) => i.id)).toEqual(['9:3']);
  });

  test('pages through the matches only', async () => {
    const a = await app();
    const first = (await (
      await a.request('/data/items?kind=message&role=employee&limit=2')
    ).json()) as Page;
    expect(first.items.map((i) => i.id)).toEqual(['9:5', '9:2']);
    expect(first.more).toBe(true);
    const next = (await (
      await a.request('/data/items?kind=message&role=employee&limit=2&offset=2')
    ).json()) as Page;
    expect(next.items.map((i) => i.id)).toEqual(['9:0']);
    expect(next.more).toBe(false);
  });

  test('combines with q', async () => {
    const a = await app();
    const page = (await (
      await a.request('/data/items?kind=message&role=guardian&q=besked%206')
    ).json()) as Page;
    expect(page.items.map((i) => i.id)).toEqual(['9:6']);
  });

  test('filters threads by their latest sender', async () => {
    const a = await app();
    const g = (await (
      await a.request('/data/items?kind=message_thread&role=guardian')
    ).json()) as Page;
    expect(g.items.map((i) => i.id)).toEqual(['9']);
    const o = (await (
      await a.request('/data/items?kind=message_thread&role=other')
    ).json()) as Page;
    expect(o.items.map((i) => i.id)).toEqual(['10']);
  });

  test('refuses an unknown role, or a role on another kind', async () => {
    const a = await app();
    expect((await a.request('/data/items?kind=message&role=boss')).status).toBe(400);
    expect((await a.request('/data/items?kind=post&role=employee')).status).toBe(400);
    expect((await a.request('/data/items?role=employee')).status).toBe(400);
  });
});

describe('GET /data/messages/roles', () => {
  test('counts threads and messages per role for this parent', async () => {
    const a = await app();
    const body = await (await a.request('/data/messages/roles')).json();
    expect(body).toEqual({
      threads: { guardian: 1, employee: 0, child: 0, other: 1 },
      messages: { guardian: 2, employee: 3, child: 1, other: 1 },
      flags: { unread: 0, marked: 0 },
    });
  });
});

describe('GET /data/activity', () => {
  const nov = `since=${Date.parse('2026-11-01T00:00:00+01:00') / 1000}&until=${Date.parse('2026-12-01T00:00:00+01:00') / 1000 - 1}`;

  test('counts per Danish day and kind, for this parent only', async () => {
    const a = await app();
    await storage?.forParent('default').put([
      // 23:30 and 00:30 in Copenhagen: two different days.
      { kind: 'post', id: 'p', occurredAt: '2026-11-20T22:30:00Z', data: {} },
      { kind: 'gallery_media', id: 'm1', occurredAt: '2026-11-20T23:30:00Z', data: {} },
      { kind: 'gallery_media', id: 'm2', occurredAt: '2026-11-21T10:00:00Z', data: {} },
      { kind: 'calendar_event', id: 'e', occurredAt: '2026-11-21T10:00:00Z', data: {} },
      { kind: 'gallery_media', id: 'old', occurredAt: '2026-10-31T10:00:00Z', data: {} },
    ]);
    await storage
      ?.forParent('other')
      .put([{ kind: 'post', id: 'x', occurredAt: '2026-11-20T10:00:00Z', data: {} }]);
    const body = await (await a.request(`/data/activity?${nov}`)).json();
    expect(body).toEqual({
      days: [
        { day: '2026-11-20', counts: { post: 1 } },
        { day: '2026-11-21', counts: { gallery_media: 2 } },
      ],
    });
  });

  test('needs a range of at most 400 days', async () => {
    const a = await app();
    expect((await a.request('/data/activity')).status).toBe(400);
    expect((await a.request('/data/activity?since=10&until=5')).status).toBe(400);
    expect((await a.request(`/data/activity?since=0&until=${401 * 86400}`)).status).toBe(400);
  });
});

describe('gallery summaries', () => {
  test('albums and media get a readable title, not the kind name', () => {
    const album = summarize(
      item('gallery_album', { album: { title: 'Skovtur' }, child: 'Alma', mediaCount: 3 }),
    );
    expect(album.title).toBe('Skovtur');
    expect(album.subtitle).toBe('Alma · 3 medier');
    const media = summarize(
      item('gallery_media', { albumId: 1, media: { mediaType: 'video', file: { name: 'a.mp4' } } }),
    );
    expect(media.title).toBe('a.mp4');
    expect(media.subtitle).toBe('Video');
  });
});
