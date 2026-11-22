/**
 * Reading one parent's stored Aula data: search with text and sender-role
 * filters, role counts and a thread with its messages. Shared by the
 * dashboard routes and the aula.local.* tools so both answer the same. The
 * stored data is encrypted, so the filters run here and not in SQL.
 */

import { threadMessageItems } from './attachments.ts';
import { type SenderRole, searchText, senderRole, threadMessage } from './item-view.ts';
import type { ItemKind, ParentStorage, StoredItem } from './storage.ts';

/** Most stored items a search reads through before it stops. */
export const SEARCH_SCAN_LIMIT = 10_000;

const SCAN_PAGE = 500;

export interface ItemSearch {
  kind?: ItemKind;
  /** Unix seconds, inclusive. */
  since?: number;
  until?: number;
  /** Lowercased text to find in what the parent sees. */
  q?: string;
  /** Only messages or threads from this kind of sender. */
  role?: SenderRole;
  /** Only threads that are unread, or marked, in Aula (as of the last sync). */
  flag?: ThreadFlag;
  offset: number;
  limit: number;
}

export const THREAD_FLAGS = ['unread', 'marked'] as const;
export type ThreadFlag = (typeof THREAD_FLAGS)[number];

/** Whether a stored thread carries the flag; never true for other kinds. */
export function hasFlag(item: StoredItem, flag: ThreadFlag): boolean {
  if (item.kind !== 'message_thread' || typeof item.data !== 'object' || item.data === null) {
    return false;
  }
  const d = item.data as { read?: unknown; marked?: unknown };
  return flag === 'unread' ? d.read === false : d.marked === true;
}

export interface ItemPage {
  items: StoredItem[];
  more: boolean;
  /** The scan stopped at SEARCH_SCAN_LIMIT before the end. */
  truncated: boolean;
}

/** Newest first, a page at a time. */
export async function searchItems(store: ParentStorage, search: ItemSearch): Promise<ItemPage> {
  const { q, role, flag, offset, limit } = search;
  const query = {
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.since !== undefined ? { since: search.since } : {}),
    ...(search.until !== undefined ? { until: search.until } : {}),
  };
  if (!q && !role && !flag) {
    const rows = await store.list({ ...query, offset, limit: limit + 1 });
    return { items: rows.slice(0, limit), more: rows.length > limit, truncated: false };
  }
  const matches: StoredItem[] = [];
  let scanned = 0;
  let skip = offset;
  for (;;) {
    const rows = await store.list({ ...query, offset: scanned, limit: SCAN_PAGE });
    scanned += rows.length;
    for (const row of rows) {
      if (role && senderRole(row) !== role) continue;
      if (flag && !hasFlag(row, flag)) continue;
      if (q && !searchText(row).includes(q)) continue;
      if (skip > 0) skip--;
      else matches.push(row);
    }
    const exhausted = rows.length < SCAN_PAGE;
    if (matches.length > limit || exhausted || scanned >= SEARCH_SCAN_LIMIT) {
      return {
        items: matches.slice(0, limit),
        more: matches.length > limit,
        truncated: !exhausted && matches.length <= limit,
      };
    }
  }
}

export interface RoleCounts {
  threads: Record<SenderRole, number>;
  messages: Record<SenderRole, number>;
  /** Threads unread or marked in Aula. */
  flags: Record<ThreadFlag, number>;
  truncated: boolean;
}

/** How many threads and messages each kind of sender wrote. */
export async function roleCounts(store: ParentStorage): Promise<RoleCounts> {
  const count = async (kind: 'message' | 'message_thread') => {
    const counts: Record<SenderRole, number> = { guardian: 0, employee: 0, child: 0, other: 0 };
    const flags: Record<ThreadFlag, number> = { unread: 0, marked: 0 };
    let scanned = 0;
    for (;;) {
      const rows = await store.list({ kind, offset: scanned, limit: SCAN_PAGE });
      scanned += rows.length;
      for (const row of rows) {
        const role = senderRole(row);
        if (role) counts[role]++;
        for (const f of THREAD_FLAGS) if (hasFlag(row, f)) flags[f]++;
      }
      if (rows.length < SCAN_PAGE) return { counts, flags, truncated: false };
      if (scanned >= SEARCH_SCAN_LIMIT) return { counts, flags, truncated: true };
    }
  };
  const [threads, messages] = await Promise.all([count('message_thread'), count('message')]);
  return {
    threads: threads.counts,
    messages: messages.counts,
    flags: threads.flags,
    truncated: threads.truncated || messages.truncated,
  };
}

/** What is counted per day: what arrived in Aula, not calendar events. */
export const ACTIVITY_KINDS = ['message', 'gallery_media', 'post', 'notification'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Most days one activity request may span. */
export const ACTIVITY_MAX_DAYS = 400;

export interface DayActivity {
  /** YYYY-MM-DD, Danish time. */
  day: string;
  counts: Partial<Record<ActivityKind, number>>;
}

const CPH_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Copenhagen',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** How many messages, media, posts and notifications arrived each Danish day, oldest first. */
export async function activityByDay(
  store: ParentStorage,
  since: number,
  until: number,
  kinds: readonly ActivityKind[] = ACTIVITY_KINDS,
): Promise<DayActivity[]> {
  const days = new Map<string, Partial<Record<ActivityKind, number>>>();
  for (const { kind, at } of await store.occurrences(kinds, since, until)) {
    const day = CPH_DAY.format(new Date(at * 1000));
    const counts = days.get(day) ?? {};
    const k = kind as ActivityKind;
    counts[k] = (counts[k] ?? 0) + 1;
    days.set(day, counts);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, counts]) => ({ day, counts }));
}

/** The stored messages of a thread, oldest first. */
export async function threadMessages(store: ParentStorage, threadId: string) {
  return (await threadMessageItems(store, threadId)).map(threadMessage);
}
