/**
 * Shortcuts for one child: how the child stands today, the week's komme/gå
 * plan, and the sick report. Shared by the MCP tools and the dashboard, so
 * both refuse the same things: a child that is not the guardian's own, and
 * taking back a sick report for a child Aula does not report as sick.
 */

import type { AulaClient, PresenceActivityType } from '@aula-mcp/aula-client';
import { PRESENCE_ACTIVITY_TYPE, PRESENCE_STATUS_CODE } from '@aula-mcp/aula-client';

/** Danish names for Aula's presence status codes, as the Aula app words them. */
export const PRESENCE_LABEL: Record<number, string> = {
  0: 'Ikke kommet',
  1: 'Syg',
  2: 'Ferie/fri',
  3: 'Kommet',
  4: 'På tur',
  5: 'Sover',
  6: 'Fritidsaktivitet',
  7: 'Fysisk placering',
  8: 'Gået',
};

const ACTIVITY_NAME = Object.fromEntries(
  Object.entries(PRESENCE_ACTIVITY_TYPE).map(([name, code]) => [code, name]),
) as Record<number, PresenceActivityType>;

/** Aula sends the henteform as a number, sometimes as a numeric string. */
const activityName = (v: unknown): PresenceActivityType | null => {
  const code = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof code === 'number' ? (ACTIVITY_NAME[code] ?? null) : null;
};

/** The logged-in guardian's own children, by institution-profile id. */
export async function ownChildren(client: AulaClient): Promise<Map<number, string>> {
  const profilesData = await client.getProfilesByLogin();
  const children = new Map<number, string>();
  for (const profile of profilesData.profiles ?? []) {
    for (const child of profile.children ?? []) children.set(child.id, child.name);
  }
  return children;
}

export interface SickRefusal {
  error: 'unknown_child' | 'not_reported_sick';
  message: string;
  [k: string]: unknown;
}

/**
 * Why a sick report (or taking one back) must not be sent, or null when it
 * may.
 *
 * Aula accepts any institution-profile id the caller has rights to, so one
 * wrong number tells the wrong institution that someone else's child is ill:
 * only the guardian's own children pass. Taking a report back sets the child
 * to "ikke kommet" (0), which would silently undo a check-in, so it is only
 * allowed for a child Aula currently reports as sick, as in Aula's own UI.
 */
export async function sickReportRefusal(
  client: AulaClient,
  institutionProfileIds: number[],
  sick: boolean,
): Promise<SickRefusal | null> {
  const children = await ownChildren(client);
  const unknownIds = institutionProfileIds.filter((id) => !children.has(id));
  if (unknownIds.length > 0) {
    return {
      error: 'unknown_child',
      message:
        'Refusing to write: these institution-profile ids are not children of the ' +
        'logged-in guardian. Call aula.discover and use children[].id.',
      unknownIds,
      knownChildren: [...children].map(([id, name]) => ({ id, name })),
    };
  }
  if (sick) return null;
  const overview = await client.getDailyOverview(institutionProfileIds);
  const statusById = new Map<number, number>();
  for (const entry of overview) {
    const id = entry.institutionProfile?.id;
    if (id !== undefined) statusById.set(id, entry.status);
  }
  const notSick = institutionProfileIds.filter(
    (id) => statusById.get(id) !== PRESENCE_STATUS_CODE.SICK,
  );
  if (notSick.length === 0) return null;
  return {
    error: 'not_reported_sick',
    message:
      'Refusing to write: taking a sick report back sets the child to ' +
      '"ikke kommet" (0), so it is only safe for a child Aula currently reports ' +
      'as sick. These are not. Use aula.presence.today to see the current status.',
    children: notSick.map((id) => ({
      id,
      name: children.get(id),
      currentStatus: statusById.get(id) ?? null,
    })),
  };
}

/** Sends the sick report, or takes it back. Check sickReportRefusal first. */
export function sendSickReport(
  client: AulaClient,
  institutionProfileIds: number[],
  sick: boolean,
): Promise<unknown> {
  return client.updatePresenceStatus({
    institutionProfileIds,
    status: sick ? PRESENCE_STATUS_CODE.SICK : PRESENCE_STATUS_CODE.NOT_PRESENT,
  });
}

export interface ChildToday {
  id: number;
  name: string;
  status: number | null;
  label: string;
  entryTime: string | null;
  exitTime: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  activityType: PresenceActivityType | null;
  exitWith: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Each of the guardian's own children with Aula's presence for today. */
export async function childrenToday(client: AulaClient): Promise<ChildToday[]> {
  const children = await ownChildren(client);
  if (children.size === 0) return [];
  const overview = await client.getDailyOverview([...children.keys()]);
  return [...children].map(([id, name]) => {
    const entry = overview.find((e) => e.institutionProfile?.id === id);
    const status = entry?.status ?? null;
    return {
      id,
      name,
      status,
      label: status === null ? 'Ingen status' : (PRESENCE_LABEL[status] ?? `Status ${status}`),
      entryTime: str(entry?.entryTime),
      exitTime: str(entry?.exitTime),
      checkInTime: str(entry?.checkInTime),
      checkOutTime: str(entry?.checkOutTime),
      activityType: activityName(entry?.activityType),
      exitWith: str(entry?.exitWith),
    };
  });
}

export interface PlanDay {
  date: string;
  entryTime: string | null;
  exitTime: string | null;
  activityType: PresenceActivityType | null;
  exitWith: string | null;
  selfDeciderStartTime: string | null;
  selfDeciderEndTime: string | null;
  comment: string | null;
  onVacation: boolean;
}

/** One child's komme/gå plan, one entry per registered day in the window. */
export async function childPlan(
  client: AulaClient,
  institutionProfileId: number,
  fromDate: string,
  toDate: string,
): Promise<PlanDay[]> {
  const data = await client.getPresenceTemplates({
    institutionProfileIds: [institutionProfileId],
    fromDate,
    toDate,
  });
  const week = (data.presenceWeekTemplates ?? []).find(
    (t) => t.institutionProfile?.id === institutionProfileId,
  );
  return (week?.dayTemplates ?? [])
    .filter((d) => typeof d.byDate === 'string')
    .map((d) => ({
      date: String(d.byDate).slice(0, 10),
      entryTime: str(d.entryTime),
      exitTime: str(d.exitTime),
      activityType: activityName(d.activityType),
      exitWith: str(d.exitWith),
      selfDeciderStartTime: str(d.selfDeciderStartTime),
      selfDeciderEndTime: str(d.selfDeciderEndTime),
      comment: str(d.comment),
      onVacation: d.isOnVacation === true,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Longest comment the guardian portal's absence form takes. */
export const VACATION_COMMENT_MAX = 250;

/** Today in Copenhagen, `YYYY-MM-DD`. */
export function copenhagenToday(now = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' });
}

/**
 * What is wrong with a ferie/fri registration, empty when nothing is. The
 * guardian portal's form rules: from today on, the end not before the start
 * and within a year of it, and a comment of at most 250 characters.
 */
export function vacationProblems(
  args: { startDate: string; endDate: string; comment?: string | undefined },
  today = copenhagenToday(),
): string[] {
  const problems: string[] = [];
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(args.startDate) || !day.test(args.endDate)) {
    return ['startDate and endDate must be YYYY-MM-DD.'];
  }
  if (args.startDate < today) problems.push('startDate must be today or later.');
  if (args.endDate < args.startDate) problems.push('endDate must not be before startDate.');
  const [y, m, d] = args.startDate.split('-');
  // 29 February counts to 28 February of the next year.
  const yearLater = `${Number(y) + 1}-${m}-${m === '02' && d === '29' ? '28' : d}`;
  if (args.endDate > yearLater) problems.push('endDate must be within a year of startDate.');
  if ((args.comment ?? '').length > VACATION_COMMENT_MAX) {
    problems.push(`comment must be at most ${VACATION_COMMENT_MAX} characters.`);
  }
  return problems;
}

/** Days from startDate to endDate, both included. */
export function vacationDays(startDate: string, endDate: string): number {
  return Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
}

export interface VacationRequest {
  childId: number;
  childName: string;
  /** The request (vacationRegistrationId). */
  registrationId: number;
  /** What an answer is sent to (responseId). */
  responseId: number;
  title: string;
  startDate: string | null;
  endDate: string | null;
  deadline: string | null;
  noteToGuardian: string | null;
  /** Aula still waits for an answer. */
  missingAnswer: boolean;
  /** Aula lets the guardian answer or change the answer. */
  editable: boolean;
  /** Days the child comes need komme/gå times. */
  timesRequired: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const day = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

/**
 * The institution's ferie requests for the guardian's own children, open ones
 * first. Rows Aula sends for other children, or without ids, are dropped.
 */
export async function vacationRequests(client: AulaClient): Promise<VacationRequest[]> {
  const children = await ownChildren(client);
  if (children.size === 0) return [];
  const groups = await client.getVacationRegistrations([...children.keys()]);
  const out: VacationRequest[] = [];
  for (const group of groups) {
    const g = (group ?? {}) as { child?: { id?: unknown }; vacationRegistrations?: unknown };
    const childId = num(g.child?.id);
    if (childId === null || !children.has(childId) || !Array.isArray(g.vacationRegistrations)) {
      continue;
    }
    for (const row of g.vacationRegistrations as Record<string, unknown>[]) {
      const registrationId = num(row?.vacationRegistrationId);
      const responseId = num(row?.responseId);
      if (registrationId === null || responseId === null) continue;
      out.push({
        childId,
        childName: children.get(childId) ?? '',
        registrationId,
        responseId,
        title: str(row.title) ?? '',
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        deadline: str(row.responseDeadline),
        noteToGuardian: str(row.noteToGuardian),
        missingAnswer: row.isMissingAnswer === true,
        editable: row.isEditable === true,
        timesRequired: row.isPresenceTimesRequired === true,
      });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.missingAnswer) - Number(a.missingAnswer) ||
      (a.startDate ?? '').localeCompare(b.startDate ?? ''),
  );
}

export interface VacationAnswerDay {
  date: string;
  isComing: boolean;
  entryTime?: string;
  exitTime?: string;
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What is wrong with an answer to `request`, empty when nothing is: Aula must
 * still allow answering, each day must lie in the request's period and appear
 * once, and a day the child comes needs drop-off before pickup (both when
 * the institution asks for times).
 */
export function vacationAnswerProblems(
  request: VacationRequest,
  days: VacationAnswerDay[],
  comment = '',
): string[] {
  const problems: string[] = [];
  if (!request.editable) problems.push('Aula does not allow answering this request (any more).');
  if (days.length === 0) problems.push('days must name at least one day.');
  const seen = new Set<string>();
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) {
      problems.push(`${d.date}: date must be YYYY-MM-DD.`);
      continue;
    }
    if (seen.has(d.date)) problems.push(`${d.date}: named twice.`);
    seen.add(d.date);
    if (
      (request.startDate && d.date < request.startDate) ||
      (request.endDate && d.date > request.endDate)
    ) {
      problems.push(`${d.date}: outside the request (${request.startDate} – ${request.endDate}).`);
    }
    if (!d.isComing) continue;
    for (const t of [d.entryTime, d.exitTime]) {
      if (t !== undefined && !HH_MM.test(t)) problems.push(`${d.date}: times must be HH:MM.`);
    }
    if (request.timesRequired && (!d.entryTime || !d.exitTime)) {
      problems.push(`${d.date}: the institution asks for entryTime and exitTime.`);
    }
    if (d.entryTime && d.exitTime && d.entryTime >= d.exitTime) {
      problems.push(`${d.date}: entryTime must be before exitTime.`);
    }
  }
  if (comment.length > VACATION_COMMENT_MAX) {
    problems.push(`comment must be at most ${VACATION_COMMENT_MAX} characters.`);
  }
  return problems;
}

export interface AnnouncedVacation {
  childId: number;
  childName: string;
  /** What calendar.deleteVacation takes. */
  vacationId: number;
  startDate: string | null;
  endDate: string | null;
  comment: string | null;
  /** Aula lets the guardian remove it. */
  editable: boolean;
}

/**
 * The ferie/fri the guardian announced for their own children, soonest
 * first. Rows Aula sends for other children, or without an id, are dropped.
 */
export async function announcedVacations(client: AulaClient): Promise<AnnouncedVacation[]> {
  const children = await ownChildren(client);
  if (children.size === 0) return [];
  const groups = await client.getVacationAnnouncements([...children.keys()]);
  const out: AnnouncedVacation[] = [];
  for (const group of groups) {
    const g = (group ?? {}) as { child?: { id?: unknown }; vacationAnnouncements?: unknown };
    const childId = num(g.child?.id);
    if (childId === null || !children.has(childId) || !Array.isArray(g.vacationAnnouncements)) {
      continue;
    }
    for (const row of g.vacationAnnouncements as Record<string, unknown>[]) {
      const vacationId = num(row?.vacationId);
      if (vacationId === null) continue;
      out.push({
        childId,
        childName: children.get(childId) ?? '',
        vacationId,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        comment: str(row.description),
        editable: row.isEditable === true,
      });
    }
  }
  return out.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
}
