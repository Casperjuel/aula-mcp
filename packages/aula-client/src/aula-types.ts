/**
 * Aula API response shapes — only the fields we actually consume. Names mirror
 * the JSON keys exactly so future drift is easy to spot.
 *
 * Aula's response envelope is `{ status: { code: 0, message: "OK" }, data: ... }`.
 * We unwrap `data` and surface non-zero status as an AulaApiError.
 */

/** Common envelope. */
export interface AulaEnvelope<T = unknown> {
  status?: { code: number; message?: string };
  data?: T;
  /** Some endpoints return a free-form `data` array — keep both possibilities open. */
  [k: string]: unknown;
}

// --------------------------------------------------------------------------
// profiles.getProfilesByLogin
// --------------------------------------------------------------------------

export interface AulaProfileChild {
  id: number;
  name: string;
  /** Aula returns this as either a number or an opaque string token (mix
   *  of letters and digits — looks like `"abcd1234"`); upstream Python
   *  stringifies it (`str(child["userId"])`). Treat as opaque, don't parse. */
  userId?: string | number;
  institutionProfile?: AulaInstitutionProfile;
}

export interface AulaInstitutionProfile {
  id: number;
  name?: string;
  /** Aula's institution code, e.g. "G12345". */
  institutionCode?: string;
  institutionName?: string;
  role?: string;
  shortName?: string;
  profilePicture?: { url?: string };
}

export interface AulaProfile {
  /** Aula names this `profileId`, not `id`. */
  profileId: number;
  /** Aula names this `displayName`, not `name`. */
  displayName: string;
  portalRole?: string;
  children?: AulaProfileChild[];
  institutionProfiles?: AulaInstitutionProfile[];
}

export interface ProfilesByLoginData {
  profiles: AulaProfile[];
}

// --------------------------------------------------------------------------
// profiles.getProfileContext
// --------------------------------------------------------------------------

/**
 * Aula nests the actual widget metadata under `widget`. Python reads
 * `widget["widget"]["widgetId"]` (BrowserClient.py-style helper code in the
 * scaarup reference does the same). Top-level `widgetId` was an earlier
 * shape — keep both fields optional so we tolerate either if the API
 * mutates again.
 */
export interface AulaWidgetMeta {
  widgetId: string;
  name?: string;
}

export interface AulaWidgetConfiguration {
  /** Modern (nested) shape — what production currently returns. */
  widget?: AulaWidgetMeta;
  /** Legacy / hypothetical flat shape — read as a fallback. */
  widgetId?: string;
  placement?: string;
  weight?: number;
}

export interface AulaPageConfiguration {
  widgetConfigurations?: AulaWidgetConfiguration[];
}

export interface AulaInstitutionRelation {
  institutionCode: string;
  institutionName?: string;
  /** Maps to a list of children belonging to this institution. */
  children?: AulaProfileChild[];
}

export interface AulaInstitutionProfileContext {
  id: number;
  /** Top-level relations the API surfaces for the active profile. */
  relations?: AulaInstitutionRelation[];
}

export interface ProfileContextData {
  /** Aula returns this as either a number or an opaque string token. */
  userId: string | number;
  institutionProfile?: AulaInstitutionProfileContext;
  institutionProfiles?: AulaInstitutionProfileContext[];
  pageConfiguration?: AulaPageConfiguration;
}

// --------------------------------------------------------------------------
// presence.getDailyOverview
// --------------------------------------------------------------------------

/**
 * Aula's presence status codes — one enum, used by both `getDailyOverview`
 * (read) and `presence.updateStatusByInstitutionProfileIds` (write).
 *
 * Two independent sources agree on this numbering:
 *
 *  - The Python reference reads `daily_info["status"]` and indexes it into
 *    `["Ikke kommet", "Syg", "Ferie/Fri", "Kommet/Til stede", "På tur",
 *    "Sover", …, "Gået"]`, with a docstring spelling out 0/1/2/3/4/5/8
 *    (`custom_components/aula/sensor.py`).
 *  - The presence frontend bundle compiles the write path as
 *    `e[e.NOT_PRESENT=0]="NOT_PRESENT",e[e.SICK=1]="SICK",…`.
 *
 * An earlier version of this file carried a second, conflicting table that
 * claimed 1=KOMMET and 7=SYG, sourced to `binary_sensor.py` — which contains
 * no such mapping. It was wrong: a child reported sick comes back as status
 * 1, and the old table named that "arrived". Do not reintroduce a separate
 * read enum without evidence from the live API.
 */
export const PRESENCE_STATUS_CODE = {
  NOT_PRESENT: 0,
  SICK: 1,
  REPORTED_ABSENT: 2,
  PRESENT: 3,
  FIELDTRIP: 4,
  SLEEPING: 5,
  SPARE_TIME_ACTIVITY: 6,
  PHYSICAL_PLACEMENT: 7,
  CHECKED_OUT: 8,
} as const;

export type PresenceStatusCode = (typeof PRESENCE_STATUS_CODE)[keyof typeof PRESENCE_STATUS_CODE];

/**
 * Danish-facing names for the codes above, in the wording the Python
 * reference uses. 6 and 7 are the two the reference never resolved (it
 * renders them as the bare numbers), so they carry the frontend's names.
 */
export const PRESENCE_STATUS = {
  0: 'IKKE_KOMMET', // not yet at school/daycare
  1: 'SYG', // reported sick
  2: 'FERIE_FRI', // holiday / not enrolled today
  3: 'KOMMET', // arrived / present
  4: 'PAA_TUR', // on a trip
  5: 'SOVER', // sleeping
  6: 'FRITIDSAKTIVITET', // spare-time activity
  7: 'FYSISK_PLACERING', // physical placement
  8: 'GAAET', // picked up / left
} as const;

export type PresenceStatusName = (typeof PRESENCE_STATUS)[keyof typeof PRESENCE_STATUS];

export interface DailyOverviewEntry {
  status: number;
  location?: string;
  checkInTime?: string;
  checkOutTime?: string;
  entryTime?: string;
  exitTime?: string;
  exitWith?: string;
  comment?: string;
  activityType?: string;
  spareTimeActivity?: string;
  selfDeciderStartTime?: string;
  selfDeciderEndTime?: string;
  sleepIntervals?: Array<{ startTime?: string; endTime?: string }>;
  institutionProfile?: { id: number; profilePicture?: { url?: string } };
}

// --------------------------------------------------------------------------
// presence.getPresenceTemplates / presence.updatePresenceTemplate
//   — the "Komme/gå" parent registration: drop-off and pickup times.
// --------------------------------------------------------------------------

/**
 * Aula's komme/gå "henteform" — how a child leaves the institution. The
 * names are ours; the numeric values are the `activityType` enum the Aula
 * presence frontend posts (Vue bundle, presence-template module). The
 * numbers are wire constants — don't renumber them.
 */
export const PRESENCE_ACTIVITY_TYPE = {
  picked_up_by: 0, // "Hentes af" — collected by a named person
  self_decider: 1, // "Selvbestemmer" — may leave on its own within a window
  send_home: 2, // "Sendes hjem" — leaves alone at exitTime
  go_home_with: 3, // "Går hjem med" — leaves with a named person
} as const;

export type PresenceActivityType = keyof typeof PRESENCE_ACTIVITY_TYPE;

/** Repeat cadence of a presence template — Aula's `repeatPattern` strings. */
export type PresenceRepeatPattern = 'never' | 'weekly' | 'every_2_weeks';

/** Input to {@link AulaClient.updatePresenceTemplate} — one child, one day. */
export interface UpdatePresenceTemplateArgs {
  /** Child institution-profile id — the same id `getDailyOverview` takes as
   *  `childIds`, and the `institutionProfile.id` returned by
   *  `getPresenceTemplates`. */
  institutionProfileId: number;
  /** The day the template applies to, `YYYY-MM-DD`. With a repeatPattern set
   *  this is the first occurrence and fixes the weekday that repeats. */
  date: string;
  /** How the child leaves — selects which nested time block Aula expects. */
  activityType: PresenceActivityType;
  /** Drop-off time `HH:mm`. Omit if the institution has no drop-off module. */
  entryTime?: string;
  /** Pickup / go-home time `HH:mm` (picked_up_by, send_home, go_home_with). */
  exitTime?: string;
  /** Name of the person collecting the child (picked_up_by, go_home_with). */
  pickedUpBy?: string;
  /** Start of the self-decider window `HH:mm` (self_decider only). */
  selfDeciderStartTime?: string;
  /** End of the self-decider window `HH:mm` (self_decider only). */
  selfDeciderEndTime?: string;
  /** Free-text note shown to staff. */
  comment?: string;
  /** Repeat cadence. Defaults to a one-off (`never`). */
  repeatPattern?: PresenceRepeatPattern;
  /** Last date the repeat applies, `YYYY-MM-DD`. Required when repeatPattern
   *  is not `never`; ignored for a one-off. */
  repeatUntil?: string;
}

/** Input to {@link AulaClient.getPresenceTemplates}. */
export interface GetPresenceTemplatesArgs {
  /** Child institution-profile ids to fetch templates for. */
  institutionProfileIds: number[];
  /** Inclusive window start, `YYYY-MM-DD`. */
  fromDate: string;
  /** Inclusive window end, `YYYY-MM-DD`. */
  toDate: string;
}

/**
 * One day inside a returned weekly template. Aula's wire shape carries more
 * fields than this; the index signature keeps them rather than dropping them.
 */
export interface PresenceDayTemplate {
  byDate?: string;
  entryTime?: string | null;
  exitTime?: string | null;
  activityType?: number | null;
  selfDeciderStartTime?: string | null;
  selfDeciderEndTime?: string | null;
  isOnVacation?: boolean;
  [k: string]: unknown;
}

export interface PresenceWeekTemplate {
  /** The child this template belongs to. `id` is the institution-profile id
   *  to pass back to `updatePresenceTemplate`. */
  institutionProfile: { id: number; name?: string };
  dayTemplates?: PresenceDayTemplate[];
  [k: string]: unknown;
}

export interface PresenceTemplatesData {
  presenceWeekTemplates?: PresenceWeekTemplate[];
  [k: string]: unknown;
}

// --------------------------------------------------------------------------
// calendar.getEventsByProfileIdsAndResourceIds
// --------------------------------------------------------------------------

export interface CalendarLessonParticipant {
  teacherName?: string;
  teacherInitials?: string;
  participantRole?: string;
}

export interface CalendarEvent {
  type: 'lesson' | 'event' | string;
  title?: string;
  startDateTime: string;
  endDateTime: string;
  belongsToProfiles?: number[];
  primaryResource?: { name?: string };
  lesson?: { participants?: CalendarLessonParticipant[] };
}

export interface GetCalendarEventsArgs {
  profileIds: number[];
  resourceIds?: number[];
  /** ISO timestamp `YYYY-MM-DD HH:MM:SS.0000+TZ`. */
  start: string;
  end: string;
}

// --------------------------------------------------------------------------
// messaging.*
// --------------------------------------------------------------------------

export interface MessageThread {
  id: number;
  read: boolean;
  subject?: string;
  /** Latest message's preview, when included. */
  lastMessage?: { sendDateTime?: string; sender?: { fullName?: string } };
  /** Latest message, when included in the threads list response. Distinct
   *  from `lastMessage` (preview-only): `latestMessage.id` is what scripts
   *  need to detect "is there a new message in this thread" without
   *  fetching the full thread content via `messaging.getMessagesForThread`. */
  latestMessage?: { id?: string; sendDateTime?: string };
}

export interface ThreadsData {
  threads: MessageThread[];
  /** Echo of the requested page. */
  page?: number;
  /** True when further pages exist. Aula's own name for it — see ThreadsPage
   *  for the shape callers should prefer. */
  moreMessagesExist?: boolean;
}

/**
 * One page of threads, with the pagination signal kept.
 *
 * Aula serves threads 20 at a time and **ignores `pageSize` entirely** — ask
 * for 50 and you still get 20. A caller that reads page 0 and stops therefore
 * sees a fraction of the mailbox while believing it has seen all of it, which
 * is a silent wrong answer rather than an error. Keep requesting pages while
 * `hasMorePages` is true.
 */
export interface ThreadsPage {
  threads: MessageThread[];
  page: number;
  hasMorePages: boolean;
}

/** One file attached to a thread message. Aula wraps each entry in a `file`
 *  envelope; the URL is a short-lived CloudFront presigned link (~1h TTL). */
export interface ThreadMessageAttachment {
  file?: {
    name?: string;
    url?: string;
    mediaType?: string | null;
    size?: number | null;
  };
}

export interface ThreadMessage {
  messageType?: string;
  text?: { html?: string; plain?: string };
  sender?: { fullName?: string };
  subject?: string;
  sendDateTime?: string;
  hasAttachments?: boolean;
  attachments?: ThreadMessageAttachment[];
}

export interface ThreadMessagesData {
  messages: ThreadMessage[];
  subject?: string;
}

// --------------------------------------------------------------------------
// aulaToken.getAulaToken
// --------------------------------------------------------------------------

/** Widget token responses are just strings: `{ data: "<bearer>" }`. */
export type AulaTokenResponse = string;
