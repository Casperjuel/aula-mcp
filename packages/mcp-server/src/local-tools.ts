/**
 * MCP tools over the caller's locally stored Aula data: what is stored,
 * search, one item in full, the calendar and who wrote the messages. They
 * never call Aula, so they answer fast, work while Aula is down and go back
 * as far as the sync has kept; the aula.sync.* tools fill the store.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addDays, startOfDayCopenhagen } from './calendar-range.ts';
import { detail, type ItemSummary, summarize } from './item-view.ts';
import { roleCounts, searchItems, threadMessages } from './local-data.ts';
import { ITEM_KINDS, type ParentStorage } from './storage.ts';

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

export function registerLocalTools(server: McpServer, store: ParentStorage): void {
  server.registerTool(
    'aula.local.overview',
    {
      title: 'What is stored locally',
      description:
        "What the local database holds of the caller's own Aula data: per kind the " +
        'number of items, the oldest and newest (when they happened in Aula) and when ' +
        'the kind was last updated, plus when each sync job last succeeded. Start here ' +
        'to see how far back aula.local.search can look. Never calls Aula. ' +
        KIND_TEXT,
      inputSchema: {},
    },
    async () => {
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
        `${KIND_TEXT} ${ROLE_TEXT}`,
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
      },
    },
    async (args) => {
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
        'type, start, end, place, who made it, invited, response) and attachment names. ' +
        'A message_thread comes with all its stored messages, oldest first, each with ' +
        "sender, time, text and sender role. Set `raw` for Aula's own JSON as it was " +
        'stored. Take `kind` and `id` from aula.local.search. Never calls Aula and never ' +
        'marks anything read.',
      inputSchema: {
        kind: z.enum(ITEM_KINDS).describe('Kind from aula.local.search.'),
        id: z.string().min(1).describe('Id from aula.local.search.'),
        raw: z.boolean().optional().describe("Also return Aula's stored JSON. Default false."),
      },
    },
    async (args) => {
      const item = await store.get(args.kind, args.id);
      if (!item) return errorContent(`No stored ${args.kind} with id ${args.id}.`);
      const { occurredAt, updatedAt, ...rest } = detail(item);
      return jsonContent({
        ...rest,
        occurred: iso(occurredAt),
        updated: iso(updatedAt),
        ...(args.kind === 'message_thread'
          ? {
              messages: (await threadMessages(store, item.id)).map(({ at, ...m }) => ({
                ...m,
                at: iso(at),
              })),
            }
          : {}),
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
        'aula.calendar.events instead. Never calls Aula.',
      inputSchema: {
        since: dateArg('From, default today'),
        until: dateArg('Until, default 14 days after since'),
        types: z.array(z.string()).optional().describe('Only these event types.'),
      },
    },
    async (args) => {
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
    'aula.local.message_roles',
    {
      title: 'Who writes the messages',
      description:
        'How many stored message threads and messages each kind of sender wrote, for ' +
        'the caller only: counts for guardian, employee, child and other. A thread ' +
        'counts by its latest sender. Filter the messages themselves with ' +
        `aula.local.search and \`role\`. ${ROLE_TEXT} Never calls Aula.`,
      inputSchema: {},
    },
    async () => jsonContent(await roleCounts(store)),
  );
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
