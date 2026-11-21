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
