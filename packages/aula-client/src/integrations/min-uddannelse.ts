/**
 * Min Uddannelse — provides "ugebrev" (weekly letters / parent-facing
 * summary) and "opgaveliste" (homework task list). Two widgets:
 *   0029 — ugebrev
 *   0030 — opgaveliste
 *
 * Both endpoints expect `Authorization: Bearer <widget-token>` and a long
 * query string with childFilter (comma-separated unilogin userIds) +
 * sessionUUID.
 *
 * The widget opgaveliste carries only titles — the teacher's description
 * ("Opgave 7+8 i opgavesættet") lives solely behind minuddannelse.net's own
 * web API. We reach it the way Aula's deep links do: the item's `url` is an
 * api.minuddannelse.net/aula/redirect link that trades the widget token for
 * a web session (302 → /AutoLogin/<guid> → session cookies), after which
 * /api/forloebsafvikling/opgaver/getOpgaveliste returns `indhold`.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import {
  decodeHtmlEntities,
  type IntegrationContext,
  type NormalisedWeekPlan,
  type NormalisedWeekPlanItem,
} from './types.ts';

const MU_OPGAVER = 'https://api.minuddannelse.net/aula/opgaveliste';
const MU_UGEBREV = 'https://api.minuddannelse.net/aula/ugebrev';
const MU_REDIRECT_PREFIX = 'https://api.minuddannelse.net/aula/redirect/';
const MU_WEB_OPGAVER = 'https://www.minuddannelse.net/api/forloebsafvikling/opgaver/getOpgaveliste';
const MAX_LOGIN_HOPS = 6;
const WIDGET_OPGAVER = '0030';
const WIDGET_UGEBREV = '0029';

interface MuOpgave {
  id?: string;
  kuvertnavn?: string;
  title?: string;
  ugedag?: string;
  opgaveType?: string;
  hold?: Array<{ navn?: string; fagNavn?: string }>;
  forloeb?: { navn?: string };
  url?: string;
}

interface MuOpgaverResponse {
  opgaver?: MuOpgave[];
}

/** minuddannelse.net web API shape — same ids as the widget, dashed GUIDs. */
interface MuWebOpgave {
  id?: string;
  indholdsType?: string;
  /** JSON-encoded `{"text": "<html>"}`. */
  indhold?: string | null;
}

interface MuWebOpgaverResponse {
  opgaver?: MuWebOpgave[];
}

interface MuUgebrevResponse {
  personer?: Array<{
    navn?: string;
    institutioner?: Array<{
      ugebreve?: Array<{ indhold?: string; tilknytningNavn?: string; uge?: string }>;
    }>;
  }>;
}

/**
 * Min Uddannelse keys `childFilter` on the child's unilogin userId (the
 * opaque `ctx.childUserIds` token), NOT the numeric Aula child profile id.
 * A numeric id is not rejected — MU answers HTTP 200 with empty
 * `personer`/`opgaver`, so the bug looks like "the school published
 * nothing" (issue #74). scaarup/aula sends `",".join(self._childuserids)`
 * for both widgets, same as here.
 *
 * Because a wrong filter fails silently there is no useful numeric
 * fallback: sending `childIds` just reproduces the empty-200. Children with
 * no resolved userId are dropped with a warning (as EasyIQ does), and if
 * that leaves nothing we fail loudly rather than return a confident `[]`.
 */
function resolveChildFilter(ctx: IntegrationContext): { childFilter: string; warnings: string[] } {
  const warnings: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < ctx.childIds.length; i++) {
    const userId = ctx.childUserIds?.[i];
    if (userId && userId.length > 0) ids.push(userId);
    else warnings.push(`child ${ctx.childIds[i]}: no unilogin userId resolved; skipped`);
  }
  if (ids.length === 0) {
    throw new Error(
      'Min Uddannelse needs the per-child unilogin userIds (childUserIds); none were resolved for the requested children',
    );
  }
  return { childFilter: ids.join(','), warnings };
}

export interface MinUddannelseOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetIdOpgaver?: string;
  widgetIdUgebrev?: string;
}

export class MinUddannelseClient {
  static readonly id = 'minuddannelse' as const;
  static readonly capabilities = ['opgaver', 'ugebrev'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetIdOpgaver: string;
  private readonly widgetIdUgebrev: string;

  constructor(opts: MinUddannelseOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetIdOpgaver = opts.widgetIdOpgaver ?? WIDGET_OPGAVER;
    this.widgetIdUgebrev = opts.widgetIdUgebrev ?? WIDGET_UGEBREV;
  }

  async getOpgaver(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const { childFilter, warnings } = resolveChildFilter(ctx);
    const result = await this.widgets.withRetry(this.widgetIdOpgaver, async (token) =>
      this.fetchMu<MuOpgaverResponse>(MU_OPGAVER, ctx, childFilter, token),
    );
    const opgaver = result.opgaver ?? [];
    const descriptions = await this.fetchDescriptions(ctx, opgaver, warnings);
    const items: NormalisedWeekPlanItem[] = [];
    for (const o of opgaver) {
      const item: NormalisedWeekPlanItem = { kind: o.opgaveType ?? 'opgave' };
      if (o.kuvertnavn) item.childName = o.kuvertnavn;
      if (o.title) item.title = o.title;
      if (o.ugedag) item.date = o.ugedag;
      const subjects = (o.hold ?? []).map((h) => h.fagNavn ?? h.navn).filter(Boolean);
      if (subjects.length) item.subject = subjects.join(', ');
      const description = o.id ? descriptions.get(normaliseId(o.id)) : undefined;
      const content = [o.forloeb?.navn, description].filter(Boolean).join('\n\n');
      if (content) item.content = content;
      if (o.url) item.url = o.url;
      items.push(item);
    }
    return { items, raw: result, ...(warnings.length ? { warnings } : {}) };
  }

  /**
   * Best-effort: descriptions are an enrichment, so any failure here becomes
   * a warning and the title-only items are still returned.
   */
  private async fetchDescriptions(
    ctx: IntegrationContext,
    opgaver: MuOpgave[],
    warnings: string[],
  ): Promise<Map<string, string>> {
    const descriptions = new Map<string, string>();
    const loginUrl = opgaver.find((o) => o.url?.startsWith(MU_REDIRECT_PREFIX))?.url;
    const elevIds = new Set<string>();
    for (const o of opgaver) {
      const elevId = o.url ? elevIdFromRedirectUrl(o.url) : undefined;
      if (elevId) elevIds.add(elevId);
    }
    if (!loginUrl || elevIds.size === 0) return descriptions;

    try {
      await this.openWebSession(ctx, loginUrl);
      for (const elevId of elevIds) {
        const params = new URLSearchParams({ tidspunkt: ctx.isoWeek, elevId });
        const res = await this.http.request(`${MU_WEB_OPGAVER}?${params.toString()}`, {
          headers: {
            accept: 'application/json; charset=utf-8',
            'x-requested-with': 'XMLHttpRequest',
          },
        });
        // An expired/missing session is a 200 with the bare string "Unauthorized".
        if (res.status !== 200 || !res.body.trimStart().startsWith('{')) {
          throw new Error(`getOpgaveliste for elev ${elevId} failed (status ${res.status})`);
        }
        const web = JSON.parse(res.body) as MuWebOpgaverResponse;
        for (const w of web.opgaver ?? []) {
          const text = w.id && w.indhold ? descriptionText(w.indhold) : '';
          if (w.id && text) descriptions.set(normaliseId(w.id), text);
        }
      }
    } catch (e) {
      warnings.push(
        `opgave descriptions unavailable (minuddannelse.net session): ${(e as Error).message}`,
      );
    }
    return descriptions;
  }

  /**
   * Walk the redirect link into a minuddannelse.net session. Without
   * `userProfile` the redirect 403s "Token is invalid (No user profile
   * supplied)". The bearer token only goes to the first hop; the AutoLogin
   * hops set the session cookies in the shared jar.
   */
  private async openWebSession(ctx: IntegrationContext, loginUrl: string): Promise<void> {
    const { childFilter } = resolveChildFilter(ctx);
    const params = new URLSearchParams({
      assuranceLevel: '2',
      childFilter,
      isMobileApp: 'false',
      placement: 'narrow',
      sessionUUID: ctx.guardianId,
      userProfile: 'guardian',
    });
    const first = await this.widgets.withRetry(this.widgetIdOpgaver, async (token) => {
      const res = await this.http.request(`${loginUrl}?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      return res;
    });
    let res = first;
    let url = loginUrl;
    for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
      const location = res.headers.get('location');
      if (!location || hop >= MAX_LOGIN_HOPS) break;
      url = new URL(location, url).toString();
      res = await this.http.request(url);
    }
    if (res.status !== 200) {
      throw new Error(`login redirect ended with status ${res.status}`);
    }
  }

  async getUgebrev(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const { childFilter, warnings } = resolveChildFilter(ctx);
    const result = await this.widgets.withRetry(this.widgetIdUgebrev, async (token) =>
      this.fetchMu<MuUgebrevResponse>(MU_UGEBREV, ctx, childFilter, token),
    );
    const items: NormalisedWeekPlanItem[] = [];
    for (const person of result.personer ?? []) {
      const childName = person.navn;
      for (const inst of person.institutioner ?? []) {
        for (const letter of inst.ugebreve ?? []) {
          if (!letter.indhold) continue;
          const item: NormalisedWeekPlanItem = { kind: 'ugebrev', content: letter.indhold };
          if (childName) item.childName = childName;
          // Which class the note belongs to ("4A", "2.B"). A guardian with two
          // children at the same school gets one note per class, and without
          // this they are distinguishable only by reading the prose.
          if (letter.tilknytningNavn) item.subject = letter.tilknytningNavn;
          if (letter.uge) item.date = letter.uge;
          items.push(item);
        }
      }
    }
    return { items, raw: result, ...(warnings.length ? { warnings } : {}) };
  }

  private async fetchMu<T>(
    base: string,
    ctx: IntegrationContext,
    childFilter: string,
    token: string,
  ): Promise<T | { _expired: true; status: number; bodySnippet: string }> {
    const params = new URLSearchParams({
      assuranceLevel: '2',
      childFilter,
      currentWeekNumber: ctx.isoWeek,
      isMobileApp: 'false',
      placement: 'narrow',
      sessionUUID: ctx.guardianId,
      userProfile: 'guardian',
    });
    const res = await this.http.request(`${base}?${params.toString()}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
    if (isWidgetTokenExpiredResponse(res.body, res.status)) {
      return { _expired: true, status: res.status, bodySnippet: res.body.slice(0, 200) };
    }
    if (res.status !== 200) {
      throw new Error(`Min Uddannelse ${base} failed (status ${res.status})`);
    }
    return JSON.parse(res.body) as T;
  }
}

/** The widget sends undashed GUIDs, the web API dashed ones. */
function normaliseId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/**
 * The redirect link's last path segment is base64 of the URL-encoded target
 * (www.minuddannelse.net/Node/minuge/<elevId>?opgave=…). The web API is keyed
 * on that MU person id, which Aula exposes nowhere else.
 */
export function elevIdFromRedirectUrl(url: string): string | undefined {
  if (!url.startsWith(MU_REDIRECT_PREFIX)) return undefined;
  const encoded = url.split('?')[0]?.split('/').pop();
  if (!encoded) return undefined;
  try {
    const target = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf8'));
    return /\/minuge\/(\d+)/.exec(target)?.[1];
  } catch {
    return undefined;
  }
}

function descriptionText(indhold: string): string {
  let html = indhold;
  try {
    const parsed = JSON.parse(indhold) as { text?: unknown };
    if (typeof parsed.text === 'string') html = parsed.text;
  } catch {
    // Not every indholdsType wraps the HTML in JSON; use it as-is.
  }
  // Text pasted from Word/browsers drags along inline styles that dwarf the
  // actual homework text; the markup itself is kept for the agent to format.
  const unstyled = html.replace(/\s(?:style|class)=(?:"[^"]*"|'[^']*')/g, '');
  return decodeHtmlEntities(unstyled).trim();
}
