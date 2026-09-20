/**
 * Common types used by every integration plugin (EasyIQ, Meebook, Min
 * Uddannelse, Systematic).
 *
 * Each plugin maps a third-party API into a normalised shape so the MCP
 * agent doesn't have to know which provider the school is on. The raw
 * response is also surfaced (under `raw`) for advanced use.
 */

export interface IntegrationContext {
  /** ISO week, e.g. "2026-W18". */
  isoWeek: string;
  /** MitID username — used by some integrations as a session id. */
  sessionId: string;
  /** Aula user/profile id for the active guardian (numeric, stringified). */
  guardianId: string;
  /** Children to query (numeric Aula child profile IDs). */
  childIds: number[];
  /** Per-child opaque user-id tokens (mix of letters and digits, e.g.
   *  `"abcd1234"`), aligned with `childIds` by index. SkolePortal's
   *  `x-childfilter` header takes this, NOT the numeric `childIds`.
   *  Optional — most integrations don't need it. */
  childUserIds?: string[];
  /** Institution codes (e.g. "G12345"). */
  institutionCodes: string[];
  /** Date range for plugins that take from/to instead of week (ISO YYYY-MM-DD). */
  fromDate?: string;
  /** ISO YYYY-MM-DD upper bound (inclusive). */
  toDate?: string;
  /**
   * Also fetch the week's free-text note, for providers that have one
   * (EasyIQ SkolePortal). Costs one extra request per child and adds a
   * failure mode, so it is off unless asked for: a poller that only compares
   * `items` neither pays for it nor gets a note warning read as a degraded plan.
   */
  includeNotes?: boolean;
}

export interface IntegrationPluginInfo {
  id: 'easyiq' | 'meebook' | 'minuddannelse' | 'systematic';
  /** Aula widget IDs this plugin uses (configurable to survive Aula renames). */
  widgetIds: string[];
  /** Capability tags this plugin claims to provide. */
  capabilities: ReadonlyArray<'ugeplan' | 'opgaver' | 'huskelisten' | 'ugebrev'>;
}

/** A normalised "weekly plan" entry — what every ugeplan provider produces. */
export interface NormalisedWeekPlanItem {
  childName?: string;
  /** Free-form date label, often Danish ("mandag 28. nov."). */
  date?: string;
  /** End of the item, in the same format as `date` (a lesson's length, for one). */
  endDate?: string;
  /** Subject / class / hold name. */
  subject?: string;
  title?: string;
  /** Plain text content; HTML entities decoded but markup kept (the agent
   *  can format as it likes). */
  content?: string;
  /** Item kind (e.g. comment, task, assignment). */
  kind?: string;
  /** When the upstream API gives us a deep link, surface it. */
  url?: string;
}

/**
 * A free-text note for a whole week rather than one day — e.g. the class
 * teacher's "Generelt om ugen" (trips, meetings, homework details).
 */
export interface NormalisedWeekNote {
  childName?: string;
  /** Class / hold the note is written for. */
  className?: string;
  /** The vendor's heading for the note. */
  title?: string;
  /** HTML entities decoded but markup kept, like `NormalisedWeekPlanItem.content`. */
  content: string;
}

export interface NormalisedWeekPlan {
  items: NormalisedWeekPlanItem[];
  /** Weekly notes, for providers that have them. */
  notes?: NormalisedWeekNote[];
  /** Raw upstream JSON for debugging / advanced use. */
  raw?: unknown;
  /** Soft errors per child (network ok, but parsing produced something off). */
  warnings?: string[];
}

/** Helper to build the ISO week string. */
export function isoWeekString(date: Date = new Date()): string {
  // Algorithm from RFC 8601 — Thursday-of-the-week trick.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Inverse of `isoWeekString`: given "YYYY-Www" return the Monday 00:00 UTC
 * of that ISO week. Used by integrations that take a date instead of a
 * week string (e.g. EasyIQ SkolePortal's CalendarGetWeekplanEvents).
 */
export function isoWeekToMonday(isoWeek: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) throw new Error(`isoWeekToMonday: invalid ISO week string: ${isoWeek}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Jan 4 is always in ISO week 1; back up to that week's Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monWeek1 = new Date(jan4);
  monWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(monWeek1);
  monday.setUTCDate(monWeek1.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** Format a Date as `YYYY-MM-DD` (UTC). */
export function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Decode the HTML entities Danish school content tends to leak
 * (`&aelig;` / `&oslash;` / `&aring;` + uppercase, the standard five, and the
 * German/French letters and punctuation that show up in language-class notes).
 * Cheap and predictable; no parser dependency. EasyIQ SkolePortal in
 * particular sends un-decoded entities in event titles and descriptions.
 *
 * Entity lookup is case-sensitive (HTML entities are case-sensitive per
 * spec — `&aelig;` ≠ `&AElig;`). Using `/.../gi` collapses the two and
 * silently lower-cases proper nouns; we hit that bug in test once already.
 */
const HTML_ENTITY_MAP: Readonly<Record<string, string>> = Object.freeze({
  '&aelig;': 'æ',
  '&AElig;': 'Æ',
  '&oslash;': 'ø',
  '&Oslash;': 'Ø',
  '&aring;': 'å',
  '&Aring;': 'Å',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  // German/French letters and typography that language-class notes still use.
  // An unmapped entity is left as-is, so a link text like "Deine sch&ouml;nsten
  // Ferien" used to reach the reader with the entity intact.
  '&auml;': 'ä',
  '&Auml;': 'Ä',
  '&ouml;': 'ö',
  '&Ouml;': 'Ö',
  '&uuml;': 'ü',
  '&Uuml;': 'Ü',
  '&szlig;': 'ß',
  '&eacute;': 'é',
  '&Eacute;': 'É',
  '&egrave;': 'è',
  '&agrave;': 'à',
  '&ccedil;': 'ç',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&bull;': '•',
  '&laquo;': '«',
  '&raquo;': '»',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&ldquo;': '“',
  '&rdquo;': '”',
});

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&[a-zA-Z]+;/g, (m) => HTML_ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}
