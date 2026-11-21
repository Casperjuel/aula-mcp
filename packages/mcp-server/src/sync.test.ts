import { beforeEach, describe, expect, test } from 'bun:test';
import { AulaStepUpRequiredError } from '@aula-mcp/aula-client';
import { createStorage, type Storage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';
import {
  createSyncScheduler,
  SYNC_JOB_RUNNERS,
  SYNC_JOBS,
  type SyncClient,
  type SyncJob,
  type SyncJobName,
  type SyncSession,
} from './sync.ts';

const KEY = Buffer.alloc(32, 3);
const MINUTE = 60_000;

let storage: Storage;
beforeEach(async () => {
  storage = await createStorage(sqliteDriver(':memory:'), KEY, { type: 'sqlite', location: 't' });
});

/** A client that only has the given read methods; touching anything else throws. */
function fakeClient(methods: Partial<SyncClient>): SyncClient & { calls: string[] } {
  const calls: string[] = [];
  return new Proxy({ calls } as unknown as SyncClient & { calls: string[] }, {
    get(_target, prop) {
      if (prop === 'calls') return calls;
      // Not a thenable: it is resolved from getClient().
      if (prop === 'then') return undefined;
      const method = (methods as Record<string | symbol, unknown>)[prop];
      if (typeof method !== 'function') throw new Error(`sync called ${String(prop)}`);
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return method(...args);
      };
    },
  });
}

const session = (client: SyncClient): SyncSession => ({
  getClient: async () => client,
  getGuardianUserId: async () => 'guardian',
});

const input = (client: SyncClient, firstRun = true) => ({
  client,
  store: storage.forParent('p'),
  childIds: async () => [11],
  firstRun,
  now: new Date('2026-11-20T10:00:00Z'),
});

describe('messages job', () => {
  test('stores threads and their messages, and refetches only changed threads', async () => {
    let latest = 'm2';
    const client = fakeClient({
      getThreadsPage: async () => ({
        threads: [
          {
            id: 1,
            read: false,
            latestMessage: { id: latest, sendDateTime: '2026-11-20T09:00:00Z' },
          },
          { id: 2, read: true, latestMessage: { id: 'x1', sendDateTime: '2026-11-19T09:00:00Z' } },
        ],
        page: 0,
        hasMorePages: false,
      }),
      getMessagesForThread: async (id) =>
        ({
          messages: [
            { id: `${id}-a`, sendDateTime: '2026-11-19T08:00:00Z', text: { plain: 'hej' } },
          ],
        }) as never,
    });

    const first = await SYNC_JOB_RUNNERS.messages(input(client));
    expect(first).toEqual({ fetched: 4, changed: 4 });
    const store = storage.forParent('p');
    expect((await store.list({ kind: 'message' })).map((m) => m.id).sort()).toEqual([
      '1:1-a',
      '2:2-a',
    ]);

    client.calls.length = 0;
    expect(await SYNC_JOB_RUNNERS.messages(input(client, false))).toEqual({
      fetched: 2,
      changed: 0,
    });
    expect(client.calls).toEqual(['getThreadsPage']);

    latest = 'm3';
    client.calls.length = 0;
    await SYNC_JOB_RUNNERS.messages(input(client, false));
    expect(client.calls).toEqual(['getThreadsPage', 'getMessagesForThread']);
  });

  test('skips sensitive threads and tries them again next time', async () => {
    const client = fakeClient({
      getThreadsPage: async () => ({
        threads: [{ id: 9, read: false, latestMessage: { id: 'z' } }],
        page: 0,
        hasMorePages: false,
      }),
      getMessagesForThread: async () => {
        throw new AulaStepUpRequiredError('step up');
      },
    });
    expect(await SYNC_JOB_RUNNERS.messages(input(client))).toEqual({
      fetched: 1,
      changed: 0,
      skipped: 1,
    });
    expect(await storage.forParent('p').get('message_thread', '9')).toBeNull();
  });
});

describe('other jobs', () => {
  test('posts, notifications, presence, calendar and directory store their items', async () => {
    const client = fakeClient({
      rawRequest: async () => [{ institutionProfile: { id: 5, role: 'guardian' } }],
      getPosts: async () => ({
        posts: [{ id: 7, title: 'Tur', publishAt: '2026-11-18T08:00:00Z' }],
        moreMessagesExist: false,
      }),
      getNotifications: async () => ({
        notifications: [{ notificationId: 'n1', triggered: '2026-11-20T07:00:00Z' }],
      }),
      getDailyOverview: async () => [{ status: 1, institutionProfile: { id: 11 } }],
      getCalendarEvents: async () =>
        [
          { id: 3, type: 'event', startDateTime: '2026-11-21T08:00:00Z', endDateTime: 'x' },
          { id: 3, type: 'event', startDateTime: '2026-11-21T08:00:00Z', endDateTime: 'x' },
        ] as never,
      getGroups: async () => [{ id: 40, name: '3.A' }],
      getContactList: async ({ page }) =>
        page === 1 ? { results: [{ id: 1 }, { id: 2 }] } : { results: [] },
    });
    for (const job of ['posts', 'notifications', 'presence', 'calendar', 'directory'] as const) {
      await SYNC_JOB_RUNNERS[job](input(client));
    }
    const stats = Object.fromEntries(
      (await storage.forParent('p').stats()).map((s) => [s.kind, s.count]),
    );
    expect(stats).toEqual({
      calendar_event: 1,
      contact: 2,
      group: 1,
      notification: 1,
      post: 1,
      presence: 1,
    });
    const presence = await storage.forParent('p').get('presence', '11:2026-11-20');
    expect(presence?.childId).toBe('11');
  });
});

describe('scheduler', () => {
  const okJobs = (log: string[]): Record<SyncJobName, SyncJob> =>
    Object.fromEntries(
      SYNC_JOBS.map((job) => [
        job,
        (async ({ store }) => {
          log.push(`${store.parentId}:${job}`);
          return { fetched: 1, changed: 1 };
        }) satisfies SyncJob,
      ]),
    ) as Record<SyncJobName, SyncJob>;

  test('runs due jobs per parent with their own session, skips parents without login', async () => {
    let clock = 1_000_000_000_000;
    const log: string[] = [];
    const sessions: string[] = [];
    const sessionFor = (name: string): SyncSession => ({
      getClient: async () => {
        sessions.push(name);
        return fakeClient({});
      },
      getGuardianUserId: async () => name,
    });
    const scheduler = createSyncScheduler({
      storage,
      parents: async () => [
        { parentId: 'a', session: sessionFor('a'), loggedIn: async () => true },
        { parentId: 'b', session: sessionFor('b'), loggedIn: async () => false },
      ],
      jobs: okJobs(log),
      now: () => clock,
      random: () => 0.5,
    });

    await scheduler.tick();
    expect(log).toEqual(SYNC_JOBS.map((job) => `a:${job}`));
    expect(sessions).toEqual(['a']);

    log.length = 0;
    await scheduler.tick();
    expect(log).toEqual([]);

    clock += 16 * MINUTE;
    await scheduler.tick();
    expect(log).toEqual(['a:messages', 'a:notifications']);
    expect(await storage.forParent('b').syncStates()).toEqual([]);
  });

  test('backs off after a failure and reports it in status', async () => {
    const clock = 1_000_000_000_000;
    const jobs = okJobs([]);
    jobs.calendar = async () => {
      throw new Error('Aula said no');
    };
    const scheduler = createSyncScheduler({
      storage,
      parents: async () => [],
      jobs,
      now: () => clock,
      random: () => 0.5,
    });
    const parent = scheduler.forParent('a', session(fakeClient({})));
    const reports = await parent.run(['calendar', 'posts']);
    expect(reports).toEqual([
      { job: 'calendar', ok: false, fetched: 0, changed: 0, error: 'Aula said no' },
      { job: 'posts', ok: true, fetched: 1, changed: 1 },
    ]);
    const status = Object.fromEntries((await parent.status()).map((s) => [s.job, s]));
    expect(status.calendar?.ok).toBe(false);
    expect(status.calendar?.lastError).toBe('Aula said no');
    expect(status.calendar?.nextRunAt).toBe(new Date(clock + 5 * MINUTE).toISOString());
    expect(status.posts?.ok).toBe(true);
    expect(status.posts?.nextRunAt).toBe(new Date(clock + 30 * MINUTE).toISOString());
    expect(status.messages?.lastRunAt).toBeNull();
  });
});
