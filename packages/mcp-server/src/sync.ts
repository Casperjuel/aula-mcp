/**
 * Background sync: fetches each logged-in parent's Aula data into local
 * storage on a schedule, so it can be read without Aula and is kept after
 * Aula drops it.
 *
 * - Every parent is synced with their own Aula session only, one parent and
 *   one job at a time, so the server never runs many Aula requests at once.
 * - Parents without an Aula login are skipped until they log in.
 * - Read-only: sync never marks anything read and never writes to Aula.
 * - Each job has its own interval, with jitter so parents don't all hit Aula
 *   on the same minute, and backs off when it keeps failing.
 *
 * Env:
 *   AULA_MCP_SYNC=0  — turn background sync off (aula.sync.run still works)
 */

import { createHash } from 'node:crypto';
import { type Logger, silentLogger } from '@aula-mcp/aula-auth';
import {
  AulaApiError,
  type AulaClient,
  AulaStepUpRequiredError,
  type CalendarEvent,
} from '@aula-mcp/aula-client';
import { addDays, aulaTs, startOfDayCopenhagen } from './calendar-range.ts';
import { resolveFamilyProfileIds } from './family-profiles.ts';
import {
  GALLERY_DOWNLOADS_PER_RUN,
  type GalleryFiles,
  type ParentGallery,
  syncGallery,
} from './gallery.ts';
import type { ItemInput, ParentStorage, Storage } from './storage.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SYNC_JOBS = [
  'messages',
  'notifications',
  'posts',
  'presence',
  'calendar',
  'directory',
  'gallery',
] as const;
export type SyncJobName = (typeof SYNC_JOBS)[number];

export const SYNC_INTERVALS_MS: Record<SyncJobName, number> = {
  messages: 15 * MINUTE,
  notifications: 15 * MINUTE,
  posts: 30 * MINUTE,
  presence: 30 * MINUTE,
  calendar: HOUR,
  directory: 24 * HOUR,
  gallery: 6 * HOUR,
};

/** What each job fetches, for the status tool and the dashboard. */
export const SYNC_JOB_DESCRIPTIONS: Record<SyncJobName, string> = {
  messages: 'Message threads and the messages in threads that changed.',
  notifications: 'Notifications.',
  posts: 'Posts from schools and clubs.',
  presence: "Today's presence (check-in, pick-up) per child.",
  calendar: "Calendar events from a week back to eight weeks ahead, plus Aula's important dates.",
  directory: "The children's groups and their contact lists.",
  gallery:
    'Photo albums and their photos and videos, downloaded in original quality with a ' +
    `thumbnail, up to ${GALLERY_DOWNLOADS_PER_RUN} files per run.`,
};

/** The Aula calls sync makes. All of them read; none of them write. */
export type SyncClient = Pick<
  AulaClient,
  | 'getProfilesByLogin'
  | 'getThreadsPage'
  | 'getMessagesForThread'
  | 'getNotifications'
  | 'getPosts'
  | 'getDailyOverview'
  | 'getCalendarEvents'
  | 'getGroups'
  | 'getContactList'
  | 'getAlbums'
  | 'getAlbumMedia'
  | 'rawRequest'
>;

/** A parent's Aula session; an AulaContext. */
export interface SyncSession {
  getClient(): Promise<SyncClient>;
  getGuardianUserId(): Promise<string>;
}

export interface SyncJobResult {
  fetched: number;
  changed: number;
  /** Items Aula would not give out, e.g. sensitive threads that need MitID step-up. */
  skipped?: number;
  /** More is waiting: run again soon instead of after the interval. */
  more?: boolean;
}

export interface SyncJobInput {
  client: SyncClient;
  store: ParentStorage;
  /** The children's institution-profile ids. */
  childIds: () => Promise<number[]>;
  /** No earlier successful run: fetch further back. */
  firstRun: boolean;
  now: Date;
  /** The parent's gallery folder; the gallery job does nothing without it. */
  gallery?: ParentGallery;
}

export type SyncJob = (input: SyncJobInput) => Promise<SyncJobResult>;

// --- jobs -------------------------------------------------------------------

const syncMessages: SyncJob = async ({ client, store, firstRun }) => {
  let fetched = 0;
  let changed = 0;
  let skipped = 0;
  const maxPages = firstRun ? 10 : 3;
  for (let page = 0; page < maxPages; page++) {
    const { threads, hasMorePages } = await client.getThreadsPage({ page });
    let pageChanged = false;
    for (const thread of threads) {
      fetched++;
      const stored = await store.get('message_thread', String(thread.id));
      const latest = (t: unknown) => {
        const x = t as typeof thread | undefined;
        return x?.latestMessage?.id ?? x?.lastMessage?.sendDateTime ?? null;
      };
      const threadItem: ItemInput = {
        kind: 'message_thread',
        id: String(thread.id),
        occurredAt: thread.latestMessage?.sendDateTime ?? thread.lastMessage?.sendDateTime ?? null,
        data: thread,
      };
      if (stored && latest(stored.data) === latest(thread)) {
        // No new message; the thread itself (read flag, subject) may still change.
        changed += (await store.put([threadItem])).changed;
        continue;
      }
      pageChanged = true;
      let messages: Awaited<ReturnType<SyncClient['getMessagesForThread']>>['messages'];
      try {
        // Reading a thread does not move its read marker; only
        // setLastReadMessage does, and sync never calls it.
        ({ messages } = await client.getMessagesForThread(thread.id));
      } catch (err) {
        // Left unstored, so it is tried again after the next MitID login.
        if (err instanceof AulaStepUpRequiredError) {
          skipped++;
          continue;
        }
        throw err;
      }
      const items: ItemInput[] = messages.map((message) => ({
        kind: 'message',
        id: `${thread.id}:${(message as { id?: string }).id ?? stableId(message)}`,
        occurredAt: message.sendDateTime ?? null,
        data: { ...message, threadId: thread.id },
      }));
      items.push(threadItem);
      fetched += messages.length;
      changed += (await store.put(items)).changed;
    }
    // Threads come newest first: a page with nothing new means the rest is
    // already stored.
    if (!hasMorePages || (!firstRun && !pageChanged)) break;
  }
  return { fetched, changed, ...(skipped ? { skipped } : {}) };
};

const syncNotifications: SyncJob = async ({ client, store }) => {
  const notifications = findArray(await client.getNotifications(), ['notifications']);
  const result = await store.put(
    notifications.map((n) => ({
      kind: 'notification',
      id: stableId(n),
      occurredAt: firstString(n, ['triggered', 'createdAt', 'timestamp']),
      data: n,
    })),
  );
  return { fetched: notifications.length, changed: result.changed };
};

const syncPosts: SyncJob = async ({ client, store, firstRun }) => {
  const institutionProfileIds = await resolveFamilyProfileIds(client);
  let fetched = 0;
  let changed = 0;
  const maxPages = firstRun ? 10 : 3;
  for (let index = 0; index < maxPages; index++) {
    const data = await client.getPosts({ index, limit: 20, institutionProfileIds });
    const posts = (data?.posts ?? []).filter((post) => post.id !== undefined);
    fetched += posts.length;
    const result = await store.put(
      posts.map((post) => ({
        kind: 'post',
        id: String(post.id),
        occurredAt: post.publishAt ?? post.timestamp ?? null,
        data: post,
      })),
    );
    changed += result.changed;
    if (!data?.moreMessagesExist || posts.length === 0 || (!firstRun && result.changed === 0))
      break;
  }
  return { fetched, changed };
};

const syncPresence: SyncJob = async ({ client, store, childIds, now }) => {
  const ids = await childIds();
  if (ids.length === 0) return { fetched: 0, changed: 0 };
  const day = copenhagenDate(now);
  const entries = (await client.getDailyOverview(ids)).filter((e) => e.institutionProfile?.id);
  const result = await store.put(
    entries.map((entry) => ({
      kind: 'presence',
      // One row per child per day, updated as the day goes.
      id: `${entry.institutionProfile?.id}:${day}`,
      childId: String(entry.institutionProfile?.id),
      occurredAt: `${day}T00:00:00Z`,
      data: { ...entry, date: day },
    })),
  );
  return { fetched: entries.length, changed: result.changed };
};

const syncCalendar: SyncJob = async ({ client, store, now }) => {
  const profileIds = await resolveFamilyProfileIds(client);
  if (profileIds.length === 0) return { fetched: 0, changed: 0 };
  // Aula answers 403 to a window much past four weeks (63 days fails, 28
  // works on a live account), so read today−7d … +56d in 3-week chunks.
  const today = startOfDayCopenhagen(now);
  const events: CalendarEvent[] = [];
  for (let from = -7; from < 56; from += 21) {
    events.push(
      ...(await client.getCalendarEvents({
        profileIds,
        start: aulaTs(addDays(today, from)),
        end: aulaTs(addDays(today, Math.min(from + 21, 56))),
      })),
    );
  }
  // Aula's "important dates": upcoming events it highlights, same shape.
  const important = findArray(await client.rawRequest('calendar.getImportantDates', {}), [
    'events',
  ]).filter((e) => typeof e.startDateTime === 'string') as unknown as CalendarEvent[];
  events.push(...important);
  const byId = new Map<string, ItemInput>();
  for (const event of events) {
    const id = (event as { id?: number | string }).id;
    const key = id !== undefined ? String(id) : stableId(event);
    byId.set(key, {
      kind: 'calendar_event',
      id: key,
      occurredAt: event.startDateTime,
      data: event,
    });
  }
  const result = await store.put([...byId.values()]);
  return { fetched: events.length, changed: result.changed };
};

const syncDirectory: SyncJob = async ({ client, store, childIds }) => {
  const ids = await childIds();
  if (ids.length === 0) return { fetched: 0, changed: 0 };
  const groups = findArray(await client.getGroups(ids), ['groups']).filter((g) => idOf(g));
  let fetched = groups.length;
  let changed = (
    await store.put(groups.map((g) => ({ kind: 'group', id: idOf(g) as string, data: g })))
  ).changed;
  for (const group of groups) {
    const groupId = Number(idOf(group));
    if (!Number.isFinite(groupId)) continue;
    const seen = new Set<string>();
    // 1-based pages; stop at an empty page or one that repeats the last.
    for (let page = 1; page <= 20; page++) {
      let list: unknown;
      try {
        list = await client.getContactList({ groupId, page });
      } catch (err) {
        // Some groups have no contact list (Aula answers 404); skip just that group.
        if (err instanceof AulaApiError && err.status === 404) break;
        throw err;
      }
      const members = findArray(list, ['results', 'profiles', 'contacts']).filter(
        (m) => idOf(m) && !seen.has(idOf(m) as string),
      );
      if (members.length === 0) break;
      for (const member of members) seen.add(idOf(member) as string);
      fetched += members.length;
      changed += (
        await store.put(
          members.map((member) => ({
            kind: 'contact',
            id: `${groupId}:${idOf(member)}`,
            data: { ...member, groupId },
          })),
        )
      ).changed;
    }
  }
  return { fetched, changed };
};

export const SYNC_JOB_RUNNERS: Record<SyncJobName, SyncJob> = {
  messages: syncMessages,
  notifications: syncNotifications,
  posts: syncPosts,
  presence: syncPresence,
  calendar: syncCalendar,
  directory: syncDirectory,
  gallery: syncGallery,
};

// --- scheduler --------------------------------------------------------------

export interface SyncParent {
  parentId: string;
  session: SyncSession;
  /** Whether the parent has an Aula login to sync with. */
  loggedIn(): Promise<boolean>;
}

export interface SyncJobStatus {
  job: SyncJobName;
  description: string;
  intervalMinutes: number;
  running: boolean;
  /** ISO times, or null when it has not happened. */
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  ok: boolean | null;
  lastError: string | null;
  failuresInARow: number;
  fetched: number;
  changed: number;
}

export interface SyncRunReport {
  job: SyncJobName;
  ok: boolean;
  fetched: number;
  changed: number;
  skipped?: number;
  error?: string;
}

/** One parent's view of the scheduler, handed to their MCP session. */
export interface ParentSync {
  status(): Promise<SyncJobStatus[]>;
  run(jobs?: SyncJobName[]): Promise<SyncRunReport[]>;
}

export interface SyncSchedulerOptions {
  storage: Pick<Storage, 'forParent'>;
  /** Every parent to sync, looked up again on each check. */
  parents: () => Promise<SyncParent[]>;
  /** Where the gallery job saves files. */
  gallery?: Pick<GalleryFiles, 'forParent'>;
  logger?: Logger;
  intervals?: Partial<Record<SyncJobName, number>>;
  /** Tests replace the Aula jobs. */
  jobs?: Record<SyncJobName, SyncJob>;
  now?: () => number;
  random?: () => number;
  /** Starts the repeating check; tests leave it out and call tick(). */
  schedule?: (fn: () => void) => () => void;
}

export interface SyncScheduler {
  /** Run every job that is due, for every logged-in parent. */
  tick(): Promise<void>;
  forParent(parentId: string, session: SyncSession): ParentSync;
  stop(): void;
}

/** Longest wait after failures, so a broken job still retries a few times a day. */
const MAX_BACKOFF_MS = 6 * HOUR;
const FIRST_BACKOFF_MS = 5 * MINUTE;
/** Next run when a job said more is waiting. */
const SOON_MS = 5 * MINUTE;

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  const logger = options.logger ?? silentLogger;
  const jobs = options.jobs ?? SYNC_JOB_RUNNERS;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const interval = (job: SyncJobName) => options.intervals?.[job] ?? SYNC_INTERVALS_MS[job];
  const locks = new Map<string, Promise<unknown>>();
  const running = new Set<string>();
  let ticking = false;

  /** One run at a time per parent: tick and aula.sync.run wait for each other. */
  const withLock = <T>(parentId: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(parentId) ?? Promise.resolve()).then(fn, fn);
    const settled = next.catch(() => {});
    locks.set(parentId, settled);
    void settled.then(() => {
      if (locks.get(parentId) === settled) locks.delete(parentId);
    });
    return next;
  };

  const states = async (store: ParentStorage) =>
    new Map((await store.syncStates()).map((state) => [state.job, state]));

  async function runJobs(
    parentId: string,
    session: SyncSession,
    due: SyncJobName[],
  ): Promise<SyncRunReport[]> {
    const store = options.storage.forParent(parentId);
    const known = await states(store);
    const reports: SyncRunReport[] = [];
    let client: SyncClient | undefined;
    let children: Promise<number[]> | undefined;
    for (const job of due) {
      const started = now();
      const previous = known.get(job);
      const key = `${parentId}\n${job}`;
      running.add(key);
      try {
        if (!client) {
          client = await session.getClient();
          // Aula 403s profile-scoped endpoints until the guardian profile is primed.
          await session.getGuardianUserId();
        }
        const aula = client;
        const result = await jobs[job]({
          client: aula,
          store,
          childIds: () => {
            children ??= aula
              .getProfilesByLogin()
              .then((data) =>
                (data.profiles ?? []).flatMap((p) => (p.children ?? []).map((c) => c.id)),
              );
            return children;
          },
          firstRun: !previous?.lastSuccessAt,
          now: new Date(started),
          ...(options.gallery ? { gallery: options.gallery.forParent(parentId) } : {}),
        });
        await store.saveSyncState({
          job,
          lastRunAt: seconds(started),
          lastSuccessAt: seconds(now()),
          nextRunAt: seconds(
            now() + (result.more ? SOON_MS : interval(job)) * (0.9 + 0.2 * random()),
          ),
          failures: 0,
          lastError: null,
          fetched: result.fetched,
          changed: result.changed,
        });
        reports.push({ job, ok: true, ...result });
        logger.info('sync.job_done', { parent: parentId, job, ...result });
      } catch (err) {
        const failures = (previous?.failures ?? 0) + 1;
        const message = errorMessage(err);
        await store
          .saveSyncState({
            job,
            lastRunAt: seconds(started),
            lastSuccessAt: previous?.lastSuccessAt ?? null,
            nextRunAt: seconds(
              now() +
                Math.min(
                  FIRST_BACKOFF_MS * 2 ** (failures - 1),
                  Math.max(interval(job), MAX_BACKOFF_MS),
                ),
            ),
            failures,
            lastError: message,
            fetched: 0,
            changed: 0,
          })
          .catch(() => {});
        reports.push({ job, ok: false, fetched: 0, changed: 0, error: message });
        logger.warn('sync.job_failed', { parent: parentId, job, failures, error: message });
      } finally {
        running.delete(key);
      }
    }
    return reports;
  }

  async function tick(): Promise<void> {
    // A slow run is not started twice.
    if (ticking) return;
    ticking = true;
    try {
      for (const parent of await options.parents()) {
        try {
          if (!(await parent.loggedIn())) continue;
          const known = await states(options.storage.forParent(parent.parentId));
          const due = SYNC_JOBS.filter((job) => (known.get(job)?.nextRunAt ?? 0) * 1000 <= now());
          if (due.length > 0)
            await withLock(parent.parentId, () => runJobs(parent.parentId, parent.session, due));
        } catch (err) {
          logger.warn('sync.parent_failed', { parent: parent.parentId, error: errorMessage(err) });
        }
      }
    } catch (err) {
      logger.warn('sync.tick_failed', { error: errorMessage(err) });
    } finally {
      ticking = false;
    }
  }

  const stop = options.schedule?.(() => void tick()) ?? (() => {});

  return {
    tick,
    stop,
    forParent: (parentId, session) => ({
      status: async () => {
        const known = await states(options.storage.forParent(parentId));
        return SYNC_JOBS.map((job) => {
          const state = known.get(job);
          return {
            job,
            description: SYNC_JOB_DESCRIPTIONS[job],
            intervalMinutes: Math.round(interval(job) / MINUTE),
            running: running.has(`${parentId}\n${job}`),
            lastRunAt: iso(state?.lastRunAt),
            lastSuccessAt: iso(state?.lastSuccessAt),
            nextRunAt: iso(state?.nextRunAt),
            ok: state ? state.failures === 0 : null,
            lastError: state?.lastError ?? null,
            failuresInARow: state?.failures ?? 0,
            fetched: state?.fetched ?? 0,
            changed: state?.changed ?? 0,
          };
        });
      },
      run: (selected) =>
        withLock(parentId, () =>
          runJobs(parentId, session, selected?.length ? selected : [...SYNC_JOBS]),
        ),
    }),
  };
}

/** Background check every minute, starting a minute after boot. */
export function realSyncSchedule(fn: () => void): () => void {
  const first = setTimeout(fn, MINUTE);
  const timer = setInterval(fn, MINUTE);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// --- helpers ----------------------------------------------------------------

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function iso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

/** The error's message only: never a URL, which can carry the access token. */
function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function copenhagenDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(d);
}

/** Aula's untyped list responses: the array itself, or under `data` or one of `keys`. */
function findArray(raw: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  for (const holder of [obj, (obj.data ?? {}) as Record<string, unknown>]) {
    for (const key of keys) {
      if (Array.isArray(holder[key])) return holder[key] as Record<string, unknown>[];
    }
  }
  return [];
}

function idOf(item: Record<string, unknown>): string | null {
  const id = item.id ?? item.profileId ?? item.institutionProfileId;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** Aula's own id when there is one, else a hash of the content. */
function stableId(item: object): string {
  const record = item as Record<string, unknown>;
  const direct = record.notificationId ?? record.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (typeof direct === 'number') return String(direct);
  const canonical = JSON.stringify(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]),
  );
  return `sha:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function firstString(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof item[key] === 'string') return item[key] as string;
  return null;
}
