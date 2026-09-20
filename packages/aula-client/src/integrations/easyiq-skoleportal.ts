/**
 * EasyIQ SkolePortal (widget `0128`).
 *
 * NOTE: this is a *different* product from the existing EasyIQ Ugeplan
 * widget (`0001` → EasyIqClient). Same vendor, distinct SaaS backend
 * (`skoleportal.easyiqcloud.dk` vs `api.easyiqcloud.dk`), different auth
 * flow, different (PascalCase) event JSON.
 *
 * Bake-in for upstream PR scaarup/aula#352 ("Add EasyIQ SkolePortal support").
 *
 * Flow per call:
 *   1. Get a widget token for 0128 (via WidgetTokenManager).
 *   2. POST /Aula/AuthenticateAulaUser per-child with x-childfilter +
 *      x-institutionfilter + x-login headers; receive `{ loginId, ... }`.
 *   3. GET /Calendar/CalendarGetWeekplanEvents?loginId=…&date=YYYY-MM-DD;
 *      receive an array of events with PascalCase fields.
 *   4. GET /Calendar/WeekPlan?loginId=…&date=YYYY-MM-DDT00:00:00 — the week's
 *      free-text note ("Generelt om ugen"), shown above the plan in the
 *      widget: `{ WeekPlans: [{ ActivityName, Text (HTML), IsVisible,
 *      Beskrivelse }] }`. The child is picked by the x-childfilter header and
 *      the week by `date`; the loginId from step 2 is reused, so it costs no
 *      extra authentication. Observed by recording the widget's own calls.
 *
 * Multi-child: the PR iterates per child because each child's loginId is
 * tied to that child's filters. We do the same.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import {
  decodeHtmlEntities,
  type IntegrationContext,
  isoDate,
  isoWeekToMonday,
  type NormalisedWeekNote,
  type NormalisedWeekPlan,
  type NormalisedWeekPlanItem,
} from './types.ts';

const SP_BASE = 'https://skoleportal.easyiqcloud.dk';
const SP_AUTH_URL = `${SP_BASE}/Aula/AuthenticateAulaUser`;
const SP_WEEKPLAN_URL = `${SP_BASE}/Calendar/CalendarGetWeekplanEvents`;
const SP_WEEKNOTE_URL = `${SP_BASE}/Calendar/WeekPlan`;
const SP_WIDGET_ID = '0128';
// Match PR #352's UA — SkolePortal's edge tier 302s requests it doesn't
// recognise as a desktop browser, regardless of the auth header.
const SP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

interface SpAuthResponse {
  loginId?: string;
  child?: string;
  childName?: string;
  schoolName?: string;
  schoolId?: string | number;
}

interface SpEvent {
  StartTime?: string;
  StartTimeISO?: string;
  EndTime?: string;
  EndTimeISO?: string;
  CoursesDisplay?: string;
  ActivitiesDisplay?: string;
  ChapterTitle?: string;
  Description?: string;
}

interface SpWeekNote {
  ActivityName?: string;
  Text?: string;
  IsVisible?: boolean;
  Beskrivelse?: string;
}

interface SpWeekNoteResponse extends SpWeekNote {
  /** Governs the top-level note; the per-class notes in `WeekPlans` use `IsVisible`. */
  Show?: boolean;
  WeekPlans?: SpWeekNote[];
}

export interface EasyIqSkoleportalOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class EasyIqSkoleportalClient {
  static readonly id = 'easyiq_skoleportal' as const;
  static readonly capabilities = ['ugeplan'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: EasyIqSkoleportalOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? SP_WIDGET_ID;
  }

  async getWeekPlan(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const monday = isoWeekToMonday(ctx.isoWeek);
    // SkolePortal expects the date as `YYYY-MM-DDT00:00:00.000Z`, NOT plain
    // `YYYY-MM-DD`. The plain form silently returns no events.
    const dateParam = `${isoDate(monday)}T00:00:00.000Z`;
    // The note endpoint takes the same instant without the milliseconds / Z.
    const noteDateParam = `${isoDate(monday)}T00:00:00`;
    const items: NormalisedWeekPlanItem[] = [];
    const notes: NormalisedWeekNote[] = [];
    const warnings: string[] = [];
    const rawByChild: Record<string, unknown> = {};

    for (let i = 0; i < ctx.childIds.length; i++) {
      const childId = ctx.childIds[i];
      const childUserId = ctx.childUserIds?.[i];
      if (childId === undefined) continue;
      try {
        if (!childUserId) {
          throw new Error(
            'SkolePortal needs the per-child userId (opaque alphanumeric token); none was provided',
          );
        }
        const childResult = await this.fetchOneChild(ctx, childUserId, dateParam, noteDateParam);
        rawByChild[String(childId)] = childResult.raw;
        for (const item of childResult.items) items.push(item);
        for (const note of childResult.notes) notes.push(note);
        if (childResult.noteWarning) warnings.push(`child ${childId}: ${childResult.noteWarning}`);
      } catch (e) {
        warnings.push(`child ${childId}: ${(e as Error).message}`);
      }
    }

    return {
      items,
      ...(notes.length ? { notes } : {}),
      raw: rawByChild,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async fetchOneChild(
    ctx: IntegrationContext,
    childUserId: string,
    dateParam: string,
    noteDateParam: string,
  ): Promise<{
    items: NormalisedWeekPlanItem[];
    notes: NormalisedWeekNote[];
    /** The note is a bonus: when only it fails the events are still returned. */
    noteWarning?: string;
    raw: { auth: SpAuthResponse; events: SpEvent[]; weekNote?: SpWeekNoteResponse };
  }> {
    const auth = await this.authenticate(ctx, childUserId);
    if (!auth.loginId) {
      throw new Error('SkolePortal authentication response missing loginId');
    }
    const events = await this.fetchEvents(ctx, childUserId, auth.loginId, dateParam);
    const childName = decodeHtmlEntities(auth.childName ?? '');
    const items: NormalisedWeekPlanItem[] = [];
    for (const ev of events) {
      const item: NormalisedWeekPlanItem = { kind: 'event' };
      if (childName) item.childName = childName;
      const dateStr = ev.StartTimeISO ?? ev.StartTime;
      if (dateStr) item.date = dateStr;
      const endStr = ev.EndTimeISO ?? ev.EndTime;
      if (endStr) item.endDate = endStr;
      const subject = decodeHtmlEntities(ev.CoursesDisplay ?? '');
      const cls = decodeHtmlEntities(ev.ActivitiesDisplay ?? '');
      if (subject || cls) item.subject = [subject, cls].filter(Boolean).join(' / ');
      const title = decodeHtmlEntities(ev.ChapterTitle ?? '');
      if (title) item.title = title;
      const desc = decodeHtmlEntities(ev.Description ?? '');
      if (desc) item.content = desc;
      items.push(item);
    }

    let weekNote: SpWeekNoteResponse | undefined;
    let noteWarning: string | undefined;
    try {
      weekNote = await this.fetchWeekNote(ctx, childUserId, auth.loginId, noteDateParam);
    } catch (e) {
      noteWarning = `week note: ${(e as Error).message}`;
    }
    return {
      items,
      notes: weekNote ? toWeekNotes(weekNote, childName) : [],
      ...(noteWarning ? { noteWarning } : {}),
      raw: { auth, events, ...(weekNote ? { weekNote } : {}) },
    };
  }

  /**
   * Header set per upstream PR scaarup/aula#352. Bugs we got wrong before:
   *   • `authorization` needs the literal `Bearer ` prefix. PR #352 looks
   *     like `authorization: token`, but their `get_token` helper stores
   *     `"Bearer " + jwt`, so the on-the-wire header still has the prefix.
   *     Ours stores the raw JWT, so we have to prepend it ourselves.
   *   • origin/referer point at `skoleportal.easyiqcloud.dk`, not aula.dk —
   *     SkolePortal's CORS-ish guard rejects the wrong origin with a
   *     302→/Login that masquerades as an auth failure.
   *   • A desktop user-agent + `x-requested-with: XMLHttpRequest`. The edge
   *     tier rate-limits / bounces requests that look like bots.
   *   • `x-childfilter` is the per-child opaque userId token, NOT the
   *     numeric Aula child id.
   */
  private spHeaders(
    token: string,
    childUserId: string,
    institutions: string,
    login: string,
  ): Record<string, string> {
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9,da;q=0.8',
      authorization: `Bearer ${token}`,
      origin: SP_BASE,
      referer: `${SP_BASE}/UgeplanWidget`,
      'user-agent': SP_USER_AGENT,
      'x-childfilter': childUserId,
      'x-institutionfilter': institutions,
      'x-login': login,
      'x-requested-with': 'XMLHttpRequest',
      'x-userprofile': 'guardian',
    };
  }

  private async authenticate(
    ctx: IntegrationContext,
    childUserId: string,
  ): Promise<SpAuthResponse> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const res = await this.http.request(SP_AUTH_URL, { method: 'POST', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal AuthenticateAulaUser failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as SpAuthResponse;
    });
  }

  private async fetchEvents(
    ctx: IntegrationContext,
    childUserId: string,
    loginId: string,
    dateParam: string,
  ): Promise<SpEvent[]> {
    // Re-use the same widget token; calendar GET uses the same header set
    // (PR #352 reuses `headers` directly between auth and calendar calls).
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const url = `${SP_WEEKPLAN_URL}?loginId=${encodeURIComponent(loginId)}&date=${encodeURIComponent(dateParam)}`;
      const res = await this.http.request(url, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal CalendarGetWeekplanEvents failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      const parsed = JSON.parse(res.body) as unknown;
      return Array.isArray(parsed) ? (parsed as SpEvent[]) : [];
    });
  }

  private async fetchWeekNote(
    ctx: IntegrationContext,
    childUserId: string,
    loginId: string,
    noteDateParam: string,
  ): Promise<SpWeekNoteResponse> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        ctx.institutionCodes.join(','),
        ctx.sessionId,
      );
      const url = `${SP_WEEKNOTE_URL}?loginId=${encodeURIComponent(loginId)}&date=${encodeURIComponent(noteDateParam)}`;
      const res = await this.http.request(url, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal WeekPlan failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as SpWeekNoteResponse;
    });
  }
}

/** Notes with text only: an empty or hidden note is "no note", not an empty entry. */
function toWeekNotes(response: SpWeekNoteResponse, childName: string): NormalisedWeekNote[] {
  const candidates: SpWeekNote[] = [
    ...(response.Show ? [response] : []),
    ...(response.WeekPlans ?? []).filter((note) => note.IsVisible !== false),
  ];
  return candidates.flatMap((candidate) => {
    // The widget sends whitespace-only markup (`<p>&nbsp;</p>`) for a cleared note.
    const content = decodeHtmlEntities(candidate.Text ?? '');
    if (!content.replace(/<[^>]*>/g, '').trim()) return [];
    const className = decodeHtmlEntities(candidate.ActivityName ?? response.ActivityName ?? '');
    const title = decodeHtmlEntities(candidate.Beskrivelse ?? response.Beskrivelse ?? '');
    return [
      {
        ...(childName ? { childName } : {}),
        ...(className ? { className } : {}),
        ...(title ? { title } : {}),
        content,
      },
    ];
  });
}
