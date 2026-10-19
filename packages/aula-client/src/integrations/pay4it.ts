/**
 * Pay4it Skolemad (widget 0118) — school-lunch orders for Københavns
 * Kommune's EAT scheme. The widget only appears in the Aula mobile app; the
 * web portal doesn't render it, so this flow was captured from the iOS app.
 *
 * POST https://kkapi.pay4it.dk/V2/Wallet/AulaSchoolInfoV2
 *   Body: { aulaToken: <widget token>, childs: [<unilogin>...],
 *           date: "YYYY-MM-DDT00:00:00+HH:MM" }   (Monday of the week)
 *   Returns: { CanLogin, Wallets: [{ ID, WalletID, Name,
 *              Dates: { "YYYY-MM-DDT00:00:00": [<meal name>...] } }] }
 *
 * The aulaToken in the body is the only credential — no Authorization
 * header or cookie. One call covers one week.
 *
 * Read-only by design: Pay4it is a payment platform, and this client never
 * calls anything that orders or pays.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import { type IntegrationContext, isoDate, isoWeekToMonday } from './types.ts';

const PAY4IT_SCHOOL_INFO_URL = 'https://kkapi.pay4it.dk/V2/Wallet/AulaSchoolInfoV2';
const PAY4IT_WIDGET_ID = '0118';

interface Pay4itWallet {
  ID?: number;
  WalletID?: string;
  Name?: string;
  Dates?: Record<string, string[] | null>;
}

interface Pay4itSchoolInfo {
  CanLogin?: boolean;
  Wallets?: Pay4itWallet[];
}

export interface SkolemadDay {
  childName?: string;
  /** YYYY-MM-DD. */
  date: string;
  meals: string[];
}

export interface SkolemadOrders {
  /** Ordered meals per child per day. */
  days: SkolemadDay[];
  /** School days (Mon–Fri) in the requested weeks with no order. Holidays
   *  show up here too — Pay4it doesn't say which days the school is closed. */
  daysWithoutOrder: { childName?: string; date: string }[];
  warnings?: string[];
}

export interface Pay4itOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class Pay4itClient {
  static readonly id = 'pay4it' as const;
  static readonly capabilities = ['skolemad'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: Pay4itOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? PAY4IT_WIDGET_ID;
  }

  /**
   * Orders for `weeks` consecutive weeks starting at `ctx.isoWeek`.
   * Raw responses are not surfaced: they carry wallet and customer ids that
   * the agent has no use for.
   */
  async getOrders(ctx: IntegrationContext, weeks = 1): Promise<SkolemadOrders> {
    const childs = ctx.childIds.map((id, i) => {
      const userId = ctx.childUserIds?.[i];
      return userId && userId.length > 0 ? userId : String(id);
    });
    const firstMonday = isoWeekToMonday(ctx.isoWeek);

    const days: SkolemadDay[] = [];
    const daysWithoutOrder: SkolemadOrders['daysWithoutOrder'] = [];
    const warnings: string[] = [];
    for (let w = 0; w < weeks; w++) {
      const monday = new Date(firstMonday);
      monday.setUTCDate(firstMonday.getUTCDate() + w * 7);
      const info = await this.fetchWeek(childs, isoDate(monday));
      if (info.CanLogin === false)
        warnings.push(`${isoDate(monday)}: Pay4it reports CanLogin=false`);

      const schoolDays = [0, 1, 2, 3, 4].map((offset) => {
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + offset);
        return isoDate(d);
      });
      for (const wallet of info.Wallets ?? []) {
        const mealsByDate = new Map<string, string[]>();
        for (const [key, meals] of Object.entries(wallet.Dates ?? {})) {
          const list = (meals ?? []).filter((m) => typeof m === 'string' && m.length > 0);
          if (list.length > 0) mealsByDate.set(key.slice(0, 10), list);
        }
        for (const date of schoolDays) {
          const meals = mealsByDate.get(date);
          const entry = wallet.Name ? { childName: wallet.Name, date } : { date };
          if (meals) days.push({ ...entry, meals });
          else daysWithoutOrder.push(entry);
        }
      }
    }
    return { days, daysWithoutOrder, ...(warnings.length ? { warnings } : {}) };
  }

  private async fetchWeek(childs: string[], monday: string): Promise<Pay4itSchoolInfo> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const res = await this.http.request(PAY4IT_SCHOOL_INFO_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          origin: 'https://www.aula.dk',
          referer: 'https://www.aula.dk/',
        },
        body: JSON.stringify({ aulaToken: token, childs, date: copenhagenMidnight(monday) }),
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(`Pay4it skolemad failed (status ${res.status}): ${res.body.slice(0, 200)}`);
      }
      return JSON.parse(res.body) as Pay4itSchoolInfo;
    });
  }
}

/** "YYYY-MM-DD" → "YYYY-MM-DDT00:00:00+01:00"/"+02:00", as the app sends it. */
export function copenhagenMidnight(ymd: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Copenhagen',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(`${ymd}T12:00:00Z`));
  const offset = parts.find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00';
  return `${ymd}T00:00:00${offset}`;
}
