/**
 * Meebook — another major DK schools vendor. Two Aula widgets, same API host:
 *
 * Widget 0004 ("Ugeplan forældre"):
 * GET https://app.meebook.com/aulaapi/relatedweekplan/all
 *   Returns: array of person objects, each with weekPlan: [{ date, tasks }],
 *            tasks have { type: comment|task|assignment, title|content, ... }
 *
 * Widget 0003 ("Ugens forløb - Meebook Forældre"):
 * GET https://app.meebook.com/aulaapi/relatedweeklybook/all
 *   Returns: array of person objects, each with books: [{ id, title, category }]
 *            — the forløb (teaching units) currently running, no dates.
 *
 * Both: headers authorization Bearer, sessionuuid: <mitid username>,
 *       x-version: 1.0, origin / referer aula.dk.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import type { IntegrationContext, NormalisedWeekPlan, NormalisedWeekPlanItem } from './types.ts';

const MEEBOOK_API = 'https://app.meebook.com/aulaapi';
const MEEBOOK_WIDGET_ID = '0004';
const MEEBOOK_WEEKLYBOOK_WIDGET_ID = '0003';

interface MeebookTask {
  id?: number;
  type?: string;
  author?: string;
  group?: string;
  pill?: string;
  title?: string;
  content?: string;
  editUrl?: string;
}

interface MeebookDay {
  date?: string;
  tasks?: MeebookTask[];
}

interface MeebookBook {
  id?: number;
  title?: string;
  category?: string;
}

interface MeebookPerson {
  id?: number;
  name?: string;
  unilogin?: string;
  weekPlan?: MeebookDay[];
  books?: MeebookBook[];
  exceptionMessage?: string;
}

/** One running forløb (teaching unit) for a child. */
export interface MeebookForloebItem {
  childName?: string;
  title?: string;
  /** Meebook's `category` — the subject, e.g. "Matematik". */
  subject?: string;
  id?: number;
}

export interface MeebookForloeb {
  items: MeebookForloebItem[];
  raw?: unknown;
  warnings?: string[];
}

export interface MeebookOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
  weeklyBookWidgetId?: string;
}

export class MeebookClient {
  static readonly id = 'meebook' as const;
  static readonly capabilities = ['ugeplan'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;
  private readonly weeklyBookWidgetId: string;

  constructor(opts: MeebookOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? MEEBOOK_WIDGET_ID;
    this.weeklyBookWidgetId = opts.weeklyBookWidgetId ?? MEEBOOK_WEEKLYBOOK_WIDGET_ID;
  }

  async getWeekPlan(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const result = await this.fetchRelated(this.widgetId, 'relatedweekplan', ctx, 'ugeplan', {
      userProfile: 'guardian',
    });

    const items: NormalisedWeekPlanItem[] = [];
    const warnings: string[] = [];
    for (const person of result) {
      if (person.exceptionMessage) {
        warnings.push(`${person.name ?? 'unknown'}: ${person.exceptionMessage}`);
        continue;
      }
      for (const day of person.weekPlan ?? []) {
        for (const task of day.tasks ?? []) {
          const item: NormalisedWeekPlanItem = { kind: task.type ?? 'task' };
          if (person.name) item.childName = person.name;
          if (day.date) item.date = day.date;
          if (task.pill) item.subject = task.pill;
          if (task.title) item.title = task.title;
          if (task.content) item.content = task.content;
          if (task.editUrl) item.url = task.editUrl;
          items.push(item);
        }
      }
    }
    return { items, raw: result, ...(warnings.length ? { warnings } : {}) };
  }

  /** Forløb (teaching units) currently running, from the "Ugens forløb" widget. */
  async getWeeklyBooks(ctx: IntegrationContext): Promise<MeebookForloeb> {
    const result = await this.fetchRelated(
      this.weeklyBookWidgetId,
      'relatedweeklybook',
      ctx,
      'forløb',
    );

    const items: MeebookForloebItem[] = [];
    const warnings: string[] = [];
    for (const person of result) {
      if (person.exceptionMessage) {
        warnings.push(`${person.name ?? 'unknown'}: ${person.exceptionMessage}`);
        continue;
      }
      for (const book of person.books ?? []) {
        const item: MeebookForloebItem = {};
        if (person.name) item.childName = person.name;
        if (book.title) item.title = book.title;
        if (book.category) item.subject = book.category;
        if (book.id !== undefined) item.id = book.id;
        items.push(item);
      }
    }
    return { items, raw: result, ...(warnings.length ? { warnings } : {}) };
  }

  private async fetchRelated(
    widgetId: string,
    path: string,
    ctx: IntegrationContext,
    label: string,
    extraParams: Record<string, string> = {},
  ): Promise<MeebookPerson[]> {
    return this.widgets.withRetry(widgetId, async (token) => {
      const params = new URLSearchParams();
      params.set('currentWeekNumber', ctx.isoWeek);
      for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
      // Meebook keys `childFilter[]` on the child's unilogin (e.g. "thit0305"),
      // NOT the numeric Aula child profile id — passing the number yields a
      // 400 "Fandt et unilogin i child filter med et ugyldigt format". Prefer
      // the per-child opaque userId (aligned by index); fall back to the
      // numeric id only when no userId was resolved for that child.
      for (let i = 0; i < ctx.childIds.length; i++) {
        const userId = ctx.childUserIds?.[i];
        const filter = userId && userId.length > 0 ? userId : String(ctx.childIds[i]);
        params.append('childFilter[]', filter);
      }
      for (const code of ctx.institutionCodes) params.append('institutionFilter[]', code);
      const url = `${MEEBOOK_API}/${path}/all?${params.toString()}`;
      const res = await this.http.request(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          sessionuuid: ctx.sessionId,
          'x-version': '1.0',
          origin: 'https://www.aula.dk',
          referer: 'https://www.aula.dk/',
        },
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `Meebook ${label} failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as MeebookPerson[];
    });
  }
}
