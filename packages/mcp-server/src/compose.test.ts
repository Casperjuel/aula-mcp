/**
 * A new message from the dashboard: contacts from the stored threads, search
 * hits from Aula, and the send route, against a fake Aula client. The send
 * starts from the parent's own mailbox at the recipients' institution and the
 * audit keeps counts only.
 */

import { describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import { contactsFrom, contactsFromSearch, mailboxOf } from './compose.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage, type StoredItem } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const box = (id: number, portalRole: string, extra: Record<string, unknown> = {}) => ({
  id,
  profileId: id + 1000,
  portalRole,
  mailBoxOwnerType: 'institutionProfile',
  isDeactivated: false,
  ...extra,
});
const person = (name: string, mailBoxOwner: unknown, metadata?: string) => ({
  fullName: name,
  mailBoxOwner,
  ...(metadata ? { metadata } : {}),
});

const threadData = [
  {
    id: 1,
    subject: 'Tur',
    institutionCode: 'A',
    mailBoxOwner: box(10, 'guardian'),
    creator: person('Lærer Lis', box(20, 'employee')),
    recipients: [
      person('Mig', box(10, 'guardian')),
      person('Far til Bo', box(30, 'guardian'), 'Far til Bo'),
      person('Gammel', box(40, 'employee', { isDeactivated: true })),
    ],
  },
  {
    id: 2,
    subject: 'Jakke',
    institutionCode: 'B',
    mailBoxOwner: box(11, 'guardian'),
    creator: person('Pædagog Per', box(21, 'employee')),
    recipients: [person('Lærer Lis', box(20, 'employee'))],
  },
];

const stored = (data: unknown, i: number): StoredItem => ({
  kind: 'message_thread',
  id: String(i + 1),
  childId: null,
  occurredAt: 100 + i,
  firstSeenAt: 1,
  updatedAt: 1,
  data,
});

describe('contacts', () => {
  test('come from stored threads, newest first, without yourself or deactivated mailboxes', () => {
    const { contacts, own } = contactsFrom(threadData.map(stored));
    expect(contacts.map((c) => c.name)).toEqual(['Lærer Lis', 'Pædagog Per', 'Far til Bo']);
    // Lærer Lis is newest in thread 2, so she is listed with school B.
    expect(contacts[0]).toMatchObject({ key: 'institutionProfile:20', institutionCode: 'B' });
    expect(contacts[2]).toMatchObject({ role: 'guardian', note: 'Far til Bo' });
    expect([...own]).toEqual([
      [
        'A',
        { id: 10, mailBoxOwnerType: 'institutionProfile', profileId: 1010, portalRole: 'guardian' },
      ],
      [
        'B',
        { id: 11, mailBoxOwnerType: 'institutionProfile', profileId: 1011, portalRole: 'guardian' },
      ],
    ]);
  });

  test('a mailbox needs a positive id and a plain type', () => {
    expect(mailboxOf({ id: 5, mailBoxOwnerType: 'institutionProfile' })).toEqual({
      id: 5,
      mailBoxOwnerType: 'institutionProfile',
    });
    expect(mailboxOf({ id: -1, mailBoxOwnerType: 'x' })).toBeNull();
    expect(mailboxOf({ id: 5, mailBoxOwnerType: 'a b' })).toBeNull();
    expect(mailboxOf('5')).toBeNull();
  });

  test('search hits become contacts; groups and hits without an id are left out', () => {
    const out = contactsFromSearch([
      {
        id: 50,
        profileId: 1050,
        name: 'Ny Lærer',
        portalRole: 'Employee',
        institutionCode: 'A',
        institutionName: 'Skolen',
        docType: 'Profile',
      },
      { docId: 'g1', docType: 'Group', name: '5.B' },
      { name: 'Uden id' },
    ]);
    expect(out).toEqual([
      {
        key: 'institutionProfile:50',
        name: 'Ny Lærer',
        role: 'employee',
        institutionCode: 'A',
        institutionName: 'Skolen',
        mailbox: {
          id: 50,
          mailBoxOwnerType: 'institutionProfile',
          profileId: 1050,
          portalRole: 'employee',
        },
      },
    ]);
  });
});

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
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 4), {
    type: 'sqlite',
    location: 'test',
  });
  const mine = storage.forParent('default');
  await mine.put(
    threadData.map((data, i) => ({
      kind: 'message_thread' as const,
      id: String(i + 1),
      occurredAt: 100 + i,
      data,
    })),
  );
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    findRecipients: async (...args: unknown[]) => {
      calls.push({ method: 'findRecipients', args });
      return {
        results: [{ id: 50, name: 'Ny Lærer', portalRole: 'employee', institutionCode: 'A' }],
      };
    },
    startNewThread: async (...args: unknown[]) => {
      calls.push({ method: 'startNewThread', args });
      return {};
    },
  } as unknown as AulaClient;
  const app = createSetupApp({
    store,
    myData: {
      contextFor: () =>
        ({
          getClient: async () => client,
          getGuardianUserId: async () => 'g1',
        }) as unknown as AulaContext,
      storage: { info: storage.info, forParent: () => mine },
    },
  });
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const get = async (path: string) => app.fetch(new Request(`http://test${path}`));
  return { post, get, calls, audit: () => mine.auditLog({ category: 'aula' }) };
}

const lis = {
  id: 20,
  mailBoxOwnerType: 'institutionProfile',
  profileId: 1020,
  portalRole: 'employee',
};

describe('dashboard new message', () => {
  test('contacts and search', async () => {
    const { get, calls } = await setup();
    const contacts = (await (await get('/data/messages/contacts')).json()) as Record<
      string,
      unknown
    >;
    expect(contacts).toMatchObject({ canSend: true });
    expect((contacts.institutions as string[]).sort()).toEqual(['A', 'B']);
    const found = (await (await get('/data/messages/recipients?q=ny')).json()) as {
      contacts: Array<{ key: string }>;
    };
    expect(found.contacts.map((c) => c.key)).toEqual(['institutionProfile:50']);
    expect(calls).toEqual([{ method: 'findRecipients', args: ['ny', 20] }]);
    expect((await get('/data/messages/recipients?q=n')).status).toBe(400);
  });

  test('sends from your own mailbox at that school and audits counts only', async () => {
    const { post, calls, audit } = await setup();
    const res = await post('/data/messages/new', {
      subject: ' Tur ',
      text: 'Hej <b>\n\nTak',
      institutionCode: 'B',
      recipients: [lis],
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        method: 'startNewThread',
        args: [
          {
            subject: 'Tur',
            html: '<p>Hej &lt;b&gt;</p><p>Tak</p>',
            recipients: [lis],
            creator: {
              id: 11,
              mailBoxOwnerType: 'institutionProfile',
              profileId: 1011,
              portalRole: 'guardian',
            },
          },
        ],
      },
    ]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'new_thread', ok: true });
    expect(entry?.details).toEqual({ trigger: 'dashboard', recipients: 1, characters: 12 });
  });

  test('refuses bad input and an unknown school before Aula', async () => {
    const { post, calls } = await setup();
    const ok = { subject: 'Tur', text: 'Hej', institutionCode: 'A', recipients: [lis] };
    expect((await post('/data/messages/new', { ...ok, subject: '' })).status).toBe(400);
    expect((await post('/data/messages/new', { ...ok, text: 'x'.repeat(5001) })).status).toBe(400);
    expect((await post('/data/messages/new', { ...ok, recipients: [] })).status).toBe(400);
    expect((await post('/data/messages/new', { ...ok, recipients: [{ id: 'x' }] })).status).toBe(
      400,
    );
    // Two schools stored, so the school must be named.
    expect((await post('/data/messages/new', { ...ok, institutionCode: undefined })).status).toBe(
      409,
    );
    expect((await post('/data/messages/new', { ...ok, institutionCode: 'Z' })).status).toBe(409);
    expect(calls).toEqual([]);
  });
});
