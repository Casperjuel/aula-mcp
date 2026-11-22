/**
 * The parent's stored Aula calendar as an iCalendar (RFC 5545) feed, for a
 * calendar app to subscribe to through a secret link (see FeedTokens). It
 * reads only what the sync has stored; it never asks Aula.
 */

import { summarize } from './item-view.ts';
import type { ParentStorage, StoredItem } from './storage.ts';

/** How far back the feed reaches; later events are all included. */
export const FEED_DAYS_BACK = 30;
/** At most this many events, newest first, so a feed stays small. */
export const FEED_MAX_EVENTS = 2000;

const DAY_S = 24 * 60 * 60;

/**
 * Stored calendar events from FEED_DAYS_BACK days ago on. Lessons
 * (skoleskema) are left out unless `lessons` is set, since a week of them
 * buries everything else in a phone's calendar.
 */
export async function feedEvents(
  store: ParentStorage,
  opts: { lessons?: boolean; now?: Date } = {},
): Promise<StoredItem[]> {
  const since = Math.floor((opts.now ?? new Date()).getTime() / 1000) - FEED_DAYS_BACK * DAY_S;
  const events: StoredItem[] = [];
  for (let offset = 0; offset < FEED_MAX_EVENTS; offset += 500) {
    const page = await store.list({ kind: 'calendar_event', since, limit: 500, offset });
    events.push(...page);
    if (page.length < 500) break;
  }
  return opts.lessons
    ? events
    : events.filter((item) => (item.data as { type?: unknown } | null)?.type !== 'lesson');
}

/** Text escaped for an iCalendar value. */
const text = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** A UTC timestamp, `YYYYMMDDTHHMMSSZ`. */
const utc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** `YYYY-MM-DD` as `YYYYMMDD`, plus `days`. */
const dateValue = (day: string, days = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_S * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

/** Splits a line into 75-octet pieces, as RFC 5545 asks, without cutting a character. */
function fold(line: string): string {
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += ch;
    bytes += size;
  }
  parts.push(part);
  return parts.join('\r\n ');
}

function vevent(item: StoredItem, stamp: string): string[] | null {
  const view = summarize(item);
  const event = view.event;
  if (!event) return null;
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start)) return null;
  const lines = [
    'BEGIN:VEVENT',
    `UID:aula-${item.id}@aula-mcp`,
    `DTSTAMP:${stamp}`,
    `SUMMARY:${text(view.title)}`,
  ];
  if (event.allDay) {
    // Aula's times carry the Danish offset, so the first ten characters are the Danish day.
    const first = event.start.slice(0, 10);
    // An end before the start counts as a one-day event.
    const last = [first, Number.isFinite(end) ? event.end.slice(0, 10) : first].sort()[1];
    lines.push(
      `DTSTART;VALUE=DATE:${dateValue(first)}`,
      `DTEND;VALUE=DATE:${dateValue(last ?? first, 1)}`,
    );
  } else {
    lines.push(
      `DTSTART:${utc(start)}`,
      `DTEND:${utc(Number.isFinite(end) ? Math.max(start, end) : start)}`,
    );
  }
  if (event.place) lines.push(`LOCATION:${text(event.place)}`);
  if (event.typeLabel) lines.push(`CATEGORIES:${text(event.typeLabel)}`);
  lines.push('END:VEVENT');
  return lines;
}

/** The events as one VCALENDAR, CRLF line endings. */
export function toIcs(items: StoredItem[], now = new Date()): string {
  const stamp = utc(now.getTime());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//aula-mcp//calendar feed//DA',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Aula',
    'X-WR-TIMEZONE:Europe/Copenhagen',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const item of items) lines.push(...(vevent(item, stamp) ?? []));
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
