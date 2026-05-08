/**
 * EasyIQ Lektier (widget `0142`).
 *
 * Same vendor and SaaS host as EasyIQ SkolePortal Ugeplan (`0128`,
 * `EasyIqSkoleportalClient`), but a distinct controller and a noticeably
 * different flow: Ugeplan auths per-child and the auth response carries the
 * loginId you query with. Lektier auths once at the session level, then
 * `/Aula/GetChildren` returns one `Id` per child — that per-child Id is the
 * `loginId` query parameter for `/AulaHuskeliste/GetWeekplanEvents`.
 *
 * Flow per call:
 *   1. Get a widget token for `0142` (via WidgetTokenManager).
 *   2. POST `/Aula/AuthenticateAulaUser` once. The response's `loginId` is
 *      a session id, NOT a per-child id; we ignore it.
 *   3. GET `/Aula/GetChildren` → `{ Children: [{ Id, Login, Name }] }`.
 *      `Login` matches `IntegrationContext.childUserIds[i]`; `Id` is the
 *      per-child loginId we need.
 *   4. For each requested child: GET `/AulaHuskeliste/GetWeekplanEvents
 *      ?loginId=<perChildId>&date=<YYYY-MM-DDT00:00:00.000Z>&activityFilter=null`
 *      with `x-child` set to that child's Login.
 *
 * Reusing the loginId from `AuthenticateAulaUser` (i.e. skipping step 3) does
 * NOT work — the server returns `200 OK []` for every child, with no error.
 * This was painful to debug: the empty response masks the wrong-loginId
 * condition and looks identical to "this kid genuinely has no lektier".
 *
 * Response shape mirrors SkolePortal Ugeplan (PascalCase calendar events:
 * `StartTimeISO`, `CoursesDisplay`, `ActivitiesDisplay`, `Description`,
 * etc.). Descriptions in Lektier often include HTML (`<p dir="ltr">…</p>`)
 * pasted from teachers' word processors; we keep markup intact and only
 * decode entities — the consumer can strip tags as it sees fit.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import {
  decodeHtmlEntities,
  type IntegrationContext,
  isoDate,
  isoWeekToMonday,
  type NormalisedWeekPlan,
  type NormalisedWeekPlanItem,
} from './types.ts';

const SP_BASE = 'https://skoleportal.easyiqcloud.dk';
const SP_AUTH_URL = `${SP_BASE}/Aula/AuthenticateAulaUser`;
const SP_GET_CHILDREN_URL = `${SP_BASE}/Aula/GetChildren`;
const SP_LEKTIER_URL = `${SP_BASE}/AulaHuskeliste/GetWeekplanEvents`;
const SP_WIDGET_ID = '0142';
// Match the desktop UA Ugeplan uses; SkolePortal's edge tier rate-limits
// requests that look like bots regardless of the auth header.
const SP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

interface SpAuthResponse {
  loginId?: string | number;
  child?: string;
  childName?: string;
  schoolName?: string;
  schoolId?: string | number;
}

interface SpChildRow {
  Id: number;
  Login: string;
  Name?: string;
}

interface SpChildrenResponse {
  Children?: SpChildRow[];
}

interface SpEvent {
  StartTime?: string;
  StartTimeISO?: string;
  EndTime?: string;
  CoursesDisplay?: string;
  ActivitiesDisplay?: string;
  ChapterTitle?: string;
  Title?: string;
  Description?: string;
}

export interface EasyIqLektierOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  /** Override the widget ID (Aula occasionally renames; making this
   *  configurable means a config tweak rather than a code patch). */
  widgetId?: string;
}

export class EasyIqLektierClient {
  static readonly id = 'easyiq_lektier' as const;
  static readonly capabilities = ['lektier'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: EasyIqLektierOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? SP_WIDGET_ID;
  }

  async getLektier(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const monday = isoWeekToMonday(ctx.isoWeek);
    const dateParam = `${isoDate(monday)}T00:00:00.000Z`;
    const items: NormalisedWeekPlanItem[] = [];
    const warnings: string[] = [];
    const rawByChild: Record<string, unknown> = {};

    if (ctx.childIds.length === 0) return { items, raw: rawByChild };

    // Auth uses the FIRST child's userId in x-child — matches the browser:
    // the iframe mounts with the first child selected, then JS calls
    // GetChildren to enumerate the rest.
    const firstChildUserId = ctx.childUserIds?.[0];
    if (!firstChildUserId) {
      throw new Error(
        'EasyIQ Lektier needs per-child userId tokens (opaque alphanumeric); none provided',
      );
    }

    let auth: SpAuthResponse;
    try {
      auth = await this.authenticate(ctx, firstChildUserId);
    } catch (e) {
      throw new Error(`Lektier authenticate failed: ${(e as Error).message}`);
    }

    let childRows: SpChildRow[];
    try {
      childRows = await this.getChildren(ctx, firstChildUserId);
    } catch (e) {
      throw new Error(`Lektier GetChildren failed: ${(e as Error).message}`);
    }
    rawByChild.__getChildren = { auth, children: childRows };

    const childRowByLogin = new Map<string, SpChildRow>();
    for (const row of childRows) childRowByLogin.set(row.Login, row);

    for (let i = 0; i < ctx.childIds.length; i++) {
      const childId = ctx.childIds[i];
      const childUserId = ctx.childUserIds?.[i];
      if (childId === undefined || !childUserId) continue;
      const row = childRowByLogin.get(childUserId);
      if (!row) {
        warnings.push(
          `child ${childId} (${childUserId}): not present in /Aula/GetChildren response`,
        );
        continue;
      }
      try {
        const events = await this.fetchEvents(ctx, childUserId, String(row.Id), dateParam);
        rawByChild[String(childId)] = events;
        const childName = decodeHtmlEntities(row.Name ?? '');
        for (const ev of events) items.push(this.toItem(ev, childName));
      } catch (e) {
        warnings.push(`child ${childId}: ${(e as Error).message}`);
      }
    }

    return { items, raw: rawByChild, ...(warnings.length ? { warnings } : {}) };
  }

  private toItem(ev: SpEvent, childName: string): NormalisedWeekPlanItem {
    const item: NormalisedWeekPlanItem = { kind: 'lektier' };
    if (childName) item.childName = childName;
    const dateStr = ev.StartTimeISO ?? ev.StartTime;
    if (dateStr) item.date = dateStr;
    const subject = decodeHtmlEntities(ev.CoursesDisplay ?? '');
    const cls = decodeHtmlEntities(ev.ActivitiesDisplay ?? '');
    if (subject || cls) item.subject = [subject, cls].filter(Boolean).join(' / ');
    // Lektier events typically have a blank `Title` (just whitespace);
    // `ChapterTitle` is more often populated. Prefer the latter.
    const titleSrc = ev.ChapterTitle ?? ev.Title ?? '';
    const title = decodeHtmlEntities(titleSrc).trim();
    if (title) item.title = title;
    const desc = decodeHtmlEntities(ev.Description ?? '');
    if (desc) item.content = desc;
    return item;
  }

  /**
   * Header set per upstream PR scaarup/aula#352 (SkolePortal Ugeplan), with
   * one Lektier-specific tweak: the `referer` points at `/LektierWidget`,
   * not `/UgeplanWidget`. Wrong referer → 302 to /Login.
   */
  private spHeaders(
    token: string,
    childLogin: string,
    childFilter: string,
    institutions: string,
    login: string,
  ): Record<string, string> {
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9,da;q=0.8',
      authorization: `Bearer ${token}`,
      origin: SP_BASE,
      referer: `${SP_BASE}/LektierWidget`,
      'user-agent': SP_USER_AGENT,
      'x-child': childLogin,
      'x-childfilter': childFilter,
      'x-institutionfilter': institutions,
      'x-login': login,
      'x-requested-with': 'Fetch',
      'x-userprofile': 'guardian',
    };
  }

  private async authenticate(
    ctx: IntegrationContext,
    firstChildUserId: string,
  ): Promise<SpAuthResponse> {
    const childFilter = (ctx.childUserIds ?? []).join(',');
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        firstChildUserId,
        childFilter,
        ctx.institutionCodes.join(','),
        ctx.guardianId,
      );
      const res = await this.http.request(SP_AUTH_URL, { method: 'POST', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `AuthenticateAulaUser failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as SpAuthResponse;
    });
  }

  private async getChildren(
    ctx: IntegrationContext,
    firstChildUserId: string,
  ): Promise<SpChildRow[]> {
    const childFilter = (ctx.childUserIds ?? []).join(',');
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        firstChildUserId,
        childFilter,
        ctx.institutionCodes.join(','),
        ctx.guardianId,
      );
      const res = await this.http.request(SP_GET_CHILDREN_URL, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(`GetChildren failed (status ${res.status}): ${res.body.slice(0, 200)}`);
      }
      const parsed = JSON.parse(res.body) as SpChildrenResponse;
      return parsed.Children ?? [];
    });
  }

  private async fetchEvents(
    ctx: IntegrationContext,
    childUserId: string,
    loginId: string,
    dateParam: string,
  ): Promise<SpEvent[]> {
    const childFilter = (ctx.childUserIds ?? []).join(',');
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const headers = this.spHeaders(
        token,
        childUserId,
        childFilter,
        ctx.institutionCodes.join(','),
        ctx.guardianId,
      );
      const url = `${SP_LEKTIER_URL}?loginId=${encodeURIComponent(loginId)}&date=${encodeURIComponent(dateParam)}&activityFilter=null`;
      const res = await this.http.request(url, { method: 'GET', headers });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `GetWeekplanEvents failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      const parsed = JSON.parse(res.body) as unknown;
      return Array.isArray(parsed) ? (parsed as SpEvent[]) : [];
    });
  }
}
