/**
 * Turns stored Aula items into what the dashboard shows: a title, a line
 * under it, and the text. Aula's shapes vary by kind and over time, so every
 * field is optional and a kind we do not know still gets a title. The result
 * is plain text; the page puts it in with textContent, never as HTML.
 */

import { PRESENCE_STATUS_CODE } from '@aula-mcp/aula-client';
import type { ItemKind, StoredItem } from './storage.ts';

export interface ItemSummary {
  kind: ItemKind;
  id: string;
  childId: string | null;
  /** Unix seconds. */
  occurredAt: number | null;
  updatedAt: number;
  title: string;
  subtitle: string;
  /** A message thread not read in Aula. */
  unread?: boolean;
  /** What the calendar page needs to place and badge an event. */
  event?: EventSummary;
}

export interface EventSummary {
  /** Aula's event type, e.g. `event`, `lesson`, `presence_holiday`. */
  type: string;
  /** Danish label for the type. */
  typeLabel: string;
  /** Aula's own ISO times, Danish offset. */
  start: string;
  end: string;
  allDay: boolean;
  place: string;
  /** Institution profile ids of the children the event belongs to. */
  profiles: number[];
  responseRequired: boolean;
  /** Danish text for the parent's answer, empty when none is asked for. */
  response: string;
  responseDeadline: string;
}

export interface ItemDetail extends ItemSummary {
  body: string;
  fields: Array<[string, string]>;
  attachments: string[];
}

export interface ThreadMessageView {
  id: string;
  from: string;
  /** Unix seconds. */
  at: number | null;
  body: string;
  attachments: string[];
}

type Data = Record<string, unknown>;

const PRESENCE_LABELS: Record<number, string> = {
  [PRESENCE_STATUS_CODE.NOT_PRESENT]: 'Ikke kommet',
  [PRESENCE_STATUS_CODE.SICK]: 'Syg',
  [PRESENCE_STATUS_CODE.REPORTED_ABSENT]: 'Fri eller ferie',
  [PRESENCE_STATUS_CODE.PRESENT]: 'Kommet',
  [PRESENCE_STATUS_CODE.FIELDTRIP]: 'På tur',
  [PRESENCE_STATUS_CODE.SLEEPING]: 'Sover',
  [PRESENCE_STATUS_CODE.SPARE_TIME_ACTIVITY]: 'Fritidsaktivitet',
  [PRESENCE_STATUS_CODE.PHYSICAL_PLACEMENT]: 'Fysisk placering',
  [PRESENCE_STATUS_CODE.CHECKED_OUT]: 'Gået',
};

export function summarize(item: StoredItem): ItemSummary {
  const d = asData(item.data);
  const base = {
    kind: item.kind,
    id: item.id,
    childId: item.childId,
    occurredAt: item.occurredAt,
    updatedAt: item.updatedAt,
  };
  switch (item.kind) {
    case 'message_thread': {
      const last = asData(d.lastMessage);
      return {
        ...base,
        title: str(d.subject) || 'Uden emne',
        subtitle: str(asData(last.sender).fullName),
        ...(d.read === false ? { unread: true } : {}),
      };
    }
    case 'message':
      return {
        ...base,
        title: str(asData(d.sender).fullName) || 'Besked',
        subtitle: clip(messageText(d)),
      };
    case 'post':
      return {
        ...base,
        title: str(d.title) || 'Opslag',
        subtitle: [
          str(asData(d.ownerProfile).fullName),
          str(asData(asData(d.ownerProfile).institution).institutionName),
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'calendar_event': {
      const time =
        d.allDay === true
          ? 'Hele dagen'
          : [hhmm(d.startDateTime), hhmm(d.endDateTime)].filter(Boolean).join(' til ');
      return {
        ...base,
        title: str(d.title) || 'Begivenhed',
        subtitle: [time, eventPlace(d)].filter(Boolean).join(' · '),
        event: eventSummary(d),
      };
    }
    case 'presence': {
      const status = typeof d.status === 'number' ? PRESENCE_LABELS[d.status] : undefined;
      const times = [
        str(d.checkInTime) && `kommet ${str(d.checkInTime).slice(0, 5)}`,
        str(d.checkOutTime) && `gået ${str(d.checkOutTime).slice(0, 5)}`,
      ].filter(Boolean);
      return {
        ...base,
        title: str(asData(d.institutionProfile).name) || 'Fremmøde',
        subtitle: [status ?? 'Ukendt status', ...times].join(' · '),
      };
    }
    case 'contact':
      return {
        ...base,
        title: firstStr(d, ['name', 'fullName', 'displayName']) || 'Kontakt',
        subtitle: firstStr(d, ['role', 'portalRole', 'relation', 'metadata']),
      };
    case 'group':
      return {
        ...base,
        title: firstStr(d, ['name', 'displayName', 'title']) || 'Gruppe',
        subtitle: firstStr(d, ['type', 'groupType', 'institutionName', 'description']),
      };
    default:
      return {
        ...base,
        title:
          firstStr(d, ['title', 'subject', 'messageText', 'postTitle', 'eventTitle', 'name']) ||
          item.kind,
        subtitle: firstStr(d, ['notificationArea', 'notificationType', 'institutionName', 'type']),
      };
  }
}

export function detail(item: StoredItem): ItemDetail {
  const d = asData(item.data);
  const summary = summarize(item);
  const fields: Array<[string, string]> = [];
  const field = (label: string, value: unknown) => {
    const text = typeof value === 'number' ? String(value) : str(value);
    if (text) fields.push([label, text]);
  };
  let body = '';
  let attachments: string[] = [];
  switch (item.kind) {
    case 'message':
      body = messageText(d);
      attachments = attachmentNames(d.attachments);
      break;
    case 'post':
      body = htmlToText(str(asData(d.content).html));
      attachments = attachmentNames(d.attachments);
      if (d.isImportant === true) field('Vigtigt', 'Ja');
      break;
    case 'calendar_event': {
      const event = eventSummary(d);
      field('Type', event.typeLabel);
      field('Starter', d.startDateTime);
      field('Slutter', d.endDateTime);
      if (event.allDay) field('Hele dagen', 'Ja');
      field('Sted', event.place);
      for (const p of asArray(asData(d.lesson).participants)) {
        field('Lærer', asData(p).teacherName);
      }
      field('Oprettet af', firstStr(d, ['creatorName']) || str(asData(d.creator).name));
      field('Institution', d.institutionName);
      field('Inviterede', names(d.invitedGroups));
      if (event.responseRequired) field('Svar', event.response);
      field('Svarfrist', d.responseDeadline);
      if (d.repeating && typeof d.repeating === 'object') field('Gentages', 'Ja');
      if (d.private === true) field('Privat', 'Ja');
      body = htmlToText(firstStr(d, ['description', 'text']));
      break;
    }
    case 'presence':
      field('Dato', d.date);
      field('Status', summary.subtitle.split(' · ')[0]);
      field('Kommet', d.checkInTime);
      field('Gået', d.checkOutTime);
      field('Afleveres', d.entryTime);
      field('Hentes', d.exitTime);
      field('Går med', d.exitWith);
      field('Sted', d.location);
      field('Bemærkning', d.comment);
      break;
    case 'contact':
      field('Rolle', firstStr(d, ['role', 'portalRole']));
      field('Relation', d.relation);
      field('Telefon', firstStr(d, ['mobilePhoneNumber', 'homePhoneNumber', 'workPhoneNumber']));
      field('E-mail', d.email);
      break;
    default:
      body = htmlToText(firstStr(d, ['messageText', 'text', 'description', 'content']));
  }
  return { ...summary, body, fields, attachments };
}

export function threadMessage(item: StoredItem): ThreadMessageView {
  const d = asData(item.data);
  return {
    id: item.id,
    from: str(asData(d.sender).fullName),
    at: item.occurredAt,
    body: messageText(d),
    attachments: attachmentNames(d.attachments),
  };
}

export const EVENT_TYPE_LABELS: Record<string, string> = {
  event: 'Begivenhed',
  holiday: 'Helligdag/fridag',
  presence_holiday: 'Ferie/fri (fremmøde)',
  vacation_registration: 'Ferieregistrering',
  birthday: 'Fødselsdag',
  excursion: 'Udflugt',
  other: 'Andet',
  school_home_meeting: 'Skole-hjem-samtale',
  parental_meeting: 'Forældremøde',
  performance_meeting: 'Udviklingssamtale',
  lesson: 'Lektion',
};

const RESPONSE_LABELS: Record<string, string> = {
  accepted: 'Deltager',
  declined: 'Deltager ikke',
  tentative: 'Måske',
  waiting: 'Ikke besvaret',
};

function eventSummary(d: Data): EventSummary {
  const type = str(d.type) || 'event';
  const status = str(d.responseStatus).toLowerCase();
  return {
    type,
    typeLabel: EVENT_TYPE_LABELS[type] ?? type,
    start: str(d.startDateTime),
    end: str(d.endDateTime),
    allDay: d.allDay === true,
    place: eventPlace(d),
    profiles: asArray(d.belongsToProfiles)
      .map((p) => (typeof p === 'string' && p.trim() ? Number(p) : p))
      .filter((p): p is number => typeof p === 'number' && Number.isFinite(p)),
    responseRequired: d.responseRequired === true,
    response: status ? (RESPONSE_LABELS[status] ?? status) : 'Ikke besvaret',
    responseDeadline: str(d.responseDeadline),
  };
}

function eventPlace(d: Data): string {
  return str(d.primaryResourceText) || str(asData(d.primaryResource).name);
}

/** Names from a list of strings or `{ name }` objects. */
function names(value: unknown): string {
  return asArray(value)
    .map((v) => (typeof v === 'string' ? v.trim() : firstStr(asData(v), ['name', 'displayName'])))
    .filter(Boolean)
    .join(', ');
}

/** What a search matches against: the text the parent sees. */
export function searchText(item: StoredItem): string {
  const view = detail(item);
  return [view.title, view.subtitle, view.body, ...view.fields.map(([, v]) => v)]
    .join('\n')
    .toLocaleLowerCase('da-DK');
}

/** Aula's message and post HTML as plain text. Never rendered as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith('#x')) return codePoint(Number.parseInt(lower.slice(2), 16), entity);
      if (lower.startsWith('#')) return codePoint(Number.parseInt(lower.slice(1), 10), entity);
      return ENTITIES[lower] ?? entity;
    })
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  aelig: 'æ',
  oslash: 'ø',
  aring: 'å',
};

function codePoint(n: number, fallback: string): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

function messageText(d: Data): string {
  const text = asData(d.text);
  return (
    str(text.plain) || htmlToText(str(text.html)) || (typeof d.text === 'string' ? d.text : '')
  );
}

function attachmentNames(value: unknown): string[] {
  return asArray(value)
    .map((a) => {
      const x = asData(a);
      return (
        str(x.name) ||
        str(asData(x.file).name) ||
        str(asData(asData(x.media).file).name) ||
        'Vedhæftet fil'
      );
    })
    .slice(0, 20);
}

function asData(value: unknown): Data {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstStr(d: Data, keys: string[]): string {
  for (const key of keys) {
    const value = str(d[key]);
    if (value) return value;
  }
  return '';
}

function hhmm(value: unknown): string {
  const match = /T(\d{2}:\d{2})/.exec(str(value));
  return match?.[1] ?? '';
}

function clip(text: string, max = 140): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
