/**
 * Min Uddannelse — provides "ugebrev" (weekly letters / parent-facing
 * summary) and "opgaveliste" (homework task list). Two widgets:
 *   0029 — ugebrev
 *   0030 — opgaveliste
 *
 * Both endpoints expect `Authorization: Bearer <widget-token>` and a long
 * query string with childFilter (comma-separated unilogin userIds) +
 * sessionUUID.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import type { IntegrationContext, NormalisedWeekPlan, NormalisedWeekPlanItem } from './types.ts';

const MU_OPGAVER = 'https://api.minuddannelse.net/aula/opgaveliste';
const MU_UGEBREV = 'https://api.minuddannelse.net/aula/ugebrev';
const WIDGET_OPGAVER = '0030';
const WIDGET_UGEBREV = '0029';

interface MuOpgave {
  kuvertnavn?: string;
  title?: string;
  ugedag?: string;
  opgaveType?: string;
  hold?: Array<{ name?: string }>;
  forloeb?: { navn?: string };
}

interface MuOpgaverResponse {
  opgaver?: MuOpgave[];
}

interface MuUgebrevResponse {
  personer?: Array<{
    navn?: string;
    institutioner?: Array<{
      ugebreve?: Array<{ indhold?: string }>;
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
    const items: NormalisedWeekPlanItem[] = [];
    for (const o of result.opgaver ?? []) {
      const item: NormalisedWeekPlanItem = { kind: o.opgaveType ?? 'opgave' };
      if (o.kuvertnavn) item.childName = o.kuvertnavn;
      if (o.title) item.title = o.title;
      if (o.ugedag) item.date = o.ugedag;
      const subjects = (o.hold ?? []).map((h) => h.name).filter(Boolean);
      if (subjects.length) item.subject = subjects.join(', ');
      if (o.forloeb?.navn) item.content = o.forloeb.navn;
      items.push(item);
    }
    return { items, raw: result, ...(warnings.length ? { warnings } : {}) };
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
