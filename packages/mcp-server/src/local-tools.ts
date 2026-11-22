/**
 * MCP tools over the caller's locally stored Aula data: what is stored,
 * search, one item in full, the calendar and who wrote the messages. They
 * never call Aula, so they answer fast, work while Aula is down and go back
 * as far as the sync has kept; the aula.sync.* tools fill the store.
 *
 * In multi-parent mode each tool also takes `owner`: it then reads what that
 * parent shares with the caller, read-only and without what the caller has
 * stored themselves (storage.ts `sharedWith`).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { keptAttachments, keptThreadAttachments, threadMessageItems } from './attachments.ts';
import { addDays, startOfDayCopenhagen } from './calendar-range.ts';
import type { GalleryView } from './gallery.ts';
import { detail, type ItemSummary, summarize, threadMessage } from './item-view.ts';
import {
  ACTIVITY_KINDS,
  ACTIVITY_MAX_DAYS,
  activityByDay,
  roleCounts,
  searchItems,
} from './local-data.ts';
import {
  AUDIT_CATEGORIES,
  type FeedStatus,
  ITEM_KINDS,
  type ParentStorage,
  type SharedFrom,
} from './storage.ts';

/** Another parent's data as the caller may read it. */
export interface SharedView {
  store: ParentStorage;
  gallery: GalleryView | null;
}

/** What other parents share with the caller. */
export interface SharedAccess {
  owners(): Promise<SharedFrom[]>;
  /** Null unless `ownerId` shares with the caller. */
  open(ownerId: string): Promise<SharedView | null>;
}

export const OWNER_TEXT =
  'Set `owner` (an id from aula.local.shared_with_me) to read what another parent shares ' +
  'with you instead: read-only, and only what is not in your own data, such as messages ' +
  'sent to them alone.';

const OWNER = z
  .string()
  .regex(/^[0-9a-f]{32}$/, 'an owner id from aula.local.shared_with_me')
  .optional()
  .describe('Read what this parent shares with you. Id from aula.local.shared_with_me.');

/**
 * The `owner` argument, when anyone can share with the caller. Typed as
 * always there so the handlers' `args` keep their types; without sharing it
 * is left out of the schema and `args.owner` is never set.
 */
export function ownerArg(shared: SharedAccess | undefined): { owner: typeof OWNER } {
  return (shared ? { owner: OWNER } : {}) as { owner: typeof OWNER };
}

export const NOT_SHARED =
  'That parent does not share their data with you. See aula.local.shared_with_me.';

const KIND_TEXT =
  'Kinds: message_thread, message (one message of a thread), post, notification, ' +
  'calendar_event, presence, contact, group, gallery_album, gallery_media ' +
  '(weekly_plan and task are reserved and empty for now).';

const ROLE_TEXT =
  'Sender roles come from Aula: guardian (a parent), employee (school or daycare ' +
  'staff), child, other (system and automatic messages).';

const dateArg = (what: string) =>
  z
    .string()
    .refine((s) => parseDate(s) !== null, 'an ISO date (2026-11-21) or date-time')
    .optional()
    .describe(`${what}: an ISO date (Copenhagen midnight) or date-time.`);

export function registerLocalTools(
  server: McpServer,
  own: ParentStorage,
  shared?: SharedAccess,
  /** The caller's calendar feed link: whether it exists, never the link itself. */
  feedStatus?: () => Promise<FeedStatus | null>,
  /** The caller's own gallery, to tell which attachments are kept. */
  gallery?: GalleryView,
): void {
  const owner = ownerArg(shared);
  const sharedNote = shared ? ` ${OWNER_TEXT}` : '';
  /** The caller's own store, or the shared view `args.owner` asks for. */
  const storeFor = async (args: { owner?: string | undefined }): Promise<ParentStorage | null> =>
    args.owner ? ((await shared?.open(args.owner))?.store ?? null) : own;
  /** The gallery files that go with storeFor's store; null when none are kept. */
  const filesFor = async (args: { owner?: string | undefined }) =>
    (args.owner ? (await shared?.open(args.owner))?.gallery : gallery)?.files ?? null;

  if (shared) {
    server.registerTool(
      'aula.local.shared_with_me',
      {
        title: 'Parents who share with me',
        description:
          'The other parents who share their stored Aula data with the caller: owner id, ' +
          'name and since when. Pass the id as `owner` to the aula.local.* and ' +
          'aula.gallery.* read tools to read what they share: read-only, and only what ' +
          "is not in the caller's own data (messages, posts or photos sent to that parent " +
          'alone). A parent shares from the setup dashboard (Deling) by the email the ' +
          'other parent signs in with; it starts once that parent has signed in to the ' +
          'dashboard. Never calls Aula.',
        inputSchema: {},
      },
      async () =>
        jsonContent({
          owners: (await shared.owners()).map((o) => ({
            owner: o.ownerId,
            name: o.ownerName,
            since: iso(o.since),
          })),
        }),
    );
  }

  server.registerTool(
    'aula.local.overview',
    {
      title: 'What is stored locally',
      description:
        "What the local database holds of the caller's own Aula data: per kind the " +
        'number of items, the oldest and newest (when they happened in Aula) and when ' +
        'the kind was last updated, plus when each sync job last succeeded. Start here ' +
        'to see how far back aula.local.search can look. Never calls Aula. ' +
        KIND_TEXT +
        sharedNote,
      inputSchema: { ...owner },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      const [kinds, jobs] = await Promise.all([store.stats(), store.syncStates()]);
      return jsonContent({
        kinds: kinds.map((k) => ({
          kind: k.kind,
          count: k.count,
          oldest: iso(k.oldest),
          newest: iso(k.newest),
          lastUpdated: iso(k.lastUpdated),
        })),
        sync: jobs.map((j) => ({
          job: j.job,
          lastSuccess: iso(j.lastSuccessAt),
          failures: j.failures,
          ...(j.lastError ? { lastError: j.lastError } : {}),
        })),
      });
    },
  );

  server.registerTool(
    'aula.local.search',
    {
      title: 'Search stored Aula data',
      description:
        "Search the caller's own Aula data in the local database, newest first. Every " +
        'filter is optional and they combine: `kind`, `q` (case-insensitive text in what ' +
        'the parent sees: subject, sender, message text, fields), `role` (only messages ' +
        'and threads; needs kind message or message_thread), `since`/`until` (when it ' +
        'happened in Aula). Each result has kind, id, time, a Danish title and subtitle, ' +
        'unread for threads, senderRole for messages and the event details for calendar ' +
        'items; open one with aula.local.get. Text search reads at most 10 000 items and ' +
        'says `truncated` when it stopped early. Never calls Aula, so it is fast and goes ' +
        'back further than the live tools, but is only as fresh as the last sync ' +
        '(aula.sync.status). Example: kind "message", q "udflugt", role "employee". ' +
        `${KIND_TEXT} ${ROLE_TEXT}${sharedNote}`,
      inputSchema: {
        kind: z.enum(ITEM_KINDS).optional().describe('Only this kind.'),
        q: z.string().max(200).optional().describe('Text to find, e.g. "madpakke".'),
        role: z
          .enum(['guardian', 'employee', 'child', 'other'])
          .optional()
          .describe('Sender role: guardian, employee, child or other.'),
        since: dateArg('From'),
        until: dateArg('Until'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
        offset: z.number().int().min(0).optional().describe('Default 0.'),
        ...owner,
      },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      if (args.role && args.kind !== 'message' && args.kind !== 'message_thread') {
        return errorContent('role needs kind "message" or "message_thread".');
      }
      const since = parseDate(args.since);
      const until = parseDate(args.until);
      const q = (args.q ?? '').trim().toLocaleLowerCase('da-DK');
      const offset = args.offset ?? 0;
      const found = await searchItems(store, {
        ...(args.kind ? { kind: args.kind } : {}),
        ...(since !== null ? { since } : {}),
        ...(until !== null ? { until } : {}),
        ...(q ? { q } : {}),
        ...(args.role ? { role: args.role } : {}),
        offset,
        limit: args.limit ?? 20,
      });
      return jsonContent({
        offset,
        more: found.more,
        ...(found.truncated ? { truncated: true } : {}),
        items: found.items.map((item) => view(summarize(item))),
      });
    },
  );

  server.registerTool(
    'aula.local.get',
    {
      title: 'One stored item in full',
      description:
        'One item from the local database as the parent would read it: Danish title, ' +
        'the text as plain text (HTML removed), labelled fields (for a calendar event: ' +
        'type, start, end, place, who made it, invited, response) and the attachments ' +
        'of a post or message: `index`, `name`, `mediaType`, `size` (bytes, null when ' +
        'unknown) and `kept` (a copy is in the local store; open it with ' +
        'aula.gallery.attachment, which never calls Aula). ' +
        'A message_thread comes with all its stored messages, oldest first, each with ' +
        'id, sender, time, text, sender role and its attachments; a thread numbers its ' +
        'files across all its messages (index 0 is the first file of the oldest message), ' +
        'each with the `messageId` it belongs to, and opens them with kind ' +
        '"message_thread". The thread\'s own `attachments` list is empty. Set `raw` for ' +
        "Aula's own JSON as it was stored. Take `kind` and `id` from aula.local.search. " +
        'Never calls Aula and never marks anything read.' +
        sharedNote,
      inputSchema: {
        kind: z.enum(ITEM_KINDS).describe('Kind from aula.local.search.'),
        id: z.string().min(1).describe('Id from aula.local.search.'),
        raw: z.boolean().optional().describe("Also return Aula's stored JSON. Default false."),
        ...owner,
      },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      const item = await store.get(args.kind, args.id);
      if (!item) return errorContent(`No stored ${args.kind} with id ${args.id}.`);
      const files = await filesFor(args);
      const { occurredAt, updatedAt, ...rest } = detail(item);
      let messages: unknown[] | undefined;
      if (item.kind === 'message_thread') {
        const rows = await threadMessageItems(store, item.id);
        const kept = await keptThreadAttachments(files, rows);
        messages = rows.map((row) => {
          const { at, ...m } = threadMessage(row);
          return {
            ...m,
            at: iso(at),
            attachments: kept.filter((a) => a.messageId === row.id),
          };
        });
      }
      const attachments =
        item.kind === 'post' || item.kind === 'message'
          ? await keptAttachments(files, item.kind, item.id, item.data)
          : rest.attachments;
      return jsonContent({
        ...rest,
        attachments,
        occurred: iso(occurredAt),
        updated: iso(updatedAt),
        ...(messages ? { messages } : {}),
        ...(args.raw ? { raw: item.data } : {}),
      });
    },
  );

  server.registerTool(
    'aula.local.calendar',
    {
      title: 'Stored calendar',
      description:
        "The caller's stored Aula calendar events in a date range, oldest first, with " +
        'type (event, holiday, presence_holiday, vacation_registration, birthday, ' +
        'excursion, other, school_home_meeting, parental_meeting, performance_meeting, ' +
        'lesson) and its Danish label, start, end, all-day, place, the children it ' +
        'belongs to and whether an answer is asked for, with answer and deadline. ' +
        'Defaults to today and 14 days ahead. The calendar sync keeps a week back to ' +
        'eight weeks ahead, plus older events it has seen before. Use `types` to pick ' +
        'some, e.g. ["parental_meeting","excursion"]. For live data from Aula use ' +
        'aula.calendar.events instead. Never calls Aula.' +
        sharedNote,
      inputSchema: {
        since: dateArg('From, default today'),
        until: dateArg('Until, default 14 days after since'),
        types: z.array(z.string()).optional().describe('Only these event types.'),
        ...owner,
      },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      const since = parseDate(args.since) ?? epoch(startOfDayCopenhagen(new Date()));
      const until = parseDate(args.until) ?? epoch(addDays(new Date(since * 1000), 14));
      const rows = await store.list({ kind: 'calendar_event', since, until, limit: 1000 });
      const types = args.types?.length ? new Set(args.types) : null;
      const events = rows
        .map(summarize)
        .filter((s) => !types || (s.event && types.has(s.event.type)))
        .reverse()
        .map((s) => ({ id: s.id, title: s.title, ...s.event }));
      return jsonContent({ since: iso(since), until: iso(until), events });
    },
  );

  server.registerTool(
    'aula.local.activity',
    {
      title: 'What arrived each day',
      description:
        "How much arrived in the caller's Aula each day, from the local database: per " +
        'Danish day the number of messages (single messages, by send time), gallery_media ' +
        '(photos and videos, by upload time), posts (by publish time) and notifications. ' +
        'Only days with something are listed, oldest first, plus totals for the range. ' +
        'Defaults to the current month; at most 400 days. Use it for "what happened in ' +
        'November" or "which days had many photos", then aula.local.search with kind, ' +
        'since and until set to that day for the items themselves. Calendar events are ' +
        'in aula.local.calendar. Only as far back as the sync has stored. Never calls Aula.' +
        sharedNote,
      inputSchema: {
        since: dateArg('From, default the first of this month'),
        until: dateArg('Until, default the end of the month of since'),
        kinds: z
          .array(z.enum(ACTIVITY_KINDS))
          .optional()
          .describe('Only these: message, gallery_media, post, notification. Default all.'),
        ...owner,
      },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      const since = parseDate(args.since) ?? startOfMonthCopenhagen(new Date());
      const until =
        parseDate(args.until) ??
        startOfMonthCopenhagen(
          addDays(new Date(startOfMonthCopenhagen(new Date(since * 1000)) * 1000), 32),
        ) - 1;
      if (until < since || until - since > ACTIVITY_MAX_DAYS * 86400) {
        return errorContent(
          `until must be after since and at most ${ACTIVITY_MAX_DAYS} days later.`,
        );
      }
      const kinds = args.kinds?.length ? args.kinds : ACTIVITY_KINDS;
      const days = await activityByDay(store, since, until, kinds);
      const totals: Record<string, number> = Object.fromEntries(kinds.map((k) => [k, 0]));
      for (const d of days)
        for (const [k, n] of Object.entries(d.counts)) totals[k] = (totals[k] ?? 0) + n;
      return jsonContent({ since: iso(since), until: iso(until), totals, days });
    },
  );

  server.registerTool(
    'aula.local.audit_log',
    {
      title: 'Audit log of syncs and actions',
      description:
        "The caller's own audit log, newest first: every sync job run (scheduled or " +
        'started by hand) with how long it took, what it fetched and changed or why it ' +
        'failed; writes to Aula made through these tools (mark_read, mark_unread, reply, ' +
        'presence); Aula login and logout, sharing and deleted data from the dashboard; ' +
        'and storage events (sqlite import, re-encryption after a key change). Entries ' +
        'hold counts, ids and error messages, never message text. Kept 30 days by ' +
        'default. Use it to see why a sync failed or when something was done. Also ' +
        "returns which storage key seals the caller's rows and how many still wait for " +
        'it after a key change. Only your own log; it is never shared. Never calls Aula. ' +
        `Categories: ${AUDIT_CATEGORIES.join(', ')}.`,
      inputSchema: {
        category: z.enum(AUDIT_CATEGORIES).optional().describe('Only this kind of event.'),
        failedOnly: z.boolean().optional().describe('true: only what failed.'),
        before: z
          .string()
          .refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO date-time')
          .optional()
          .describe('Only events before this ISO date-time, for the next page.'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 50.'),
      },
    },
    async (args) => {
      const [events, key] = await Promise.all([
        own.auditLog({
          ...(args.category ? { category: args.category } : {}),
          ...(args.failedOnly ? { ok: false } : {}),
          ...(args.before ? { before: Date.parse(args.before) } : {}),
          limit: args.limit ?? 50,
        }),
        own.keyStatus(),
      ]);
      return jsonContent({
        events: events.map(({ at, ...rest }) => ({ at: new Date(at).toISOString(), ...rest })),
        storageKey: key,
      });
    },
  );

  if (feedStatus) {
    server.registerTool(
      'aula.local.calendar_feed_status',
      {
        title: 'Calendar subscription link',
        description:
          'Whether the caller has a calendar subscription link: a secret .ics link a ' +
          'phone or calendar app (Google, Outlook, Apple) subscribes to, so the stored ' +
          'Aula events, ferie and fridage (from 30 days back on, without the lesson ' +
          'schedule unless ?skema=1 is added) show up in that calendar, refreshed about ' +
          'hourly. Answers active, since and lastUsedAt (when a calendar app last fetched ' +
          'it). The link itself is never shown here: anyone holding it can read the ' +
          "parent's calendar without signing in, so it is made, shown once, replaced and " +
          'removed only in the setup dashboard (Kalender, "Abonnér i din egen kalender"). ' +
          'For the events themselves use aula.local.calendar. Never calls Aula.',
        inputSchema: {},
      },
      async () => {
        const status = await feedStatus();
        return jsonContent(
          status
            ? { active: true, since: iso(status.since), lastUsedAt: iso(status.lastUsedAt) }
            : {
                active: false,
                hint: 'Make one in the setup dashboard under Kalender.',
              },
        );
      },
    );
  }

  server.registerTool(
    'aula.local.message_roles',
    {
      title: 'Who writes the messages',
      description:
        'How many stored message threads and messages each kind of sender wrote, for ' +
        'the caller only: counts for guardian, employee, child and other. A thread ' +
        'counts by its latest sender. Filter the messages themselves with ' +
        `aula.local.search and \`role\`. ${ROLE_TEXT} Never calls Aula.${sharedNote}`,
      inputSchema: { ...owner },
    },
    async (args) => {
      const store = await storeFor(args);
      if (!store) return errorContent(NOT_SHARED);
      return jsonContent(await roleCounts(store));
    },
  );
}

/** Unix seconds of midnight, Danish time, on the first of the month `d` falls in there. */
function startOfMonthCopenhagen(d: Date): number {
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
  }).format(d);
  return parseDate(`${month}-01`) as number;
}

/** A summary for an agent: ISO times instead of unix seconds. */
function view({ occurredAt, updatedAt, ...rest }: ItemSummary) {
  return { ...rest, occurred: iso(occurredAt), updated: iso(updatedAt) };
}

/** Unix seconds from an ISO date (Copenhagen midnight) or date-time. */
export function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const noon = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(noon.getTime()) ? null : epoch(startOfDayCopenhagen(noon));
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function epoch(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

function iso(seconds: number | null | undefined): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorContent(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}
