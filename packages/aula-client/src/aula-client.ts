/**
 * AulaClient — typed wrapper around `https://www.aula.dk/api/v{N}/`.
 *
 * Two upstream-issue bake-ins live here:
 *   - **API version probing (#246, #248, log in #311)**: the version constant
 *     drifts. We probe v{start..end} on first use and cache the answer. An
 *     `onApiVersionChanged` callback fires when the active version changes
 *     mid-session (e.g. server returns 410 and we bump).
 *   - **CSRF token from cookie (`Csrfp-Token`)**: lifted from the cookie jar
 *     and sent as `csrfp-token` header on POSTs. Aula returns 403 otherwise.
 */

import {
  AulaCookieJar,
  AulaHttpClient,
  type AulaTokens,
  type Logger,
  silentLogger,
} from '@aula-mcp/aula-auth';
import type {
  AulaEnvelope,
  CalendarEvent,
  DailyOverviewEntry,
  GetCalendarEventsArgs,
  GetPresenceTemplatesArgs,
  MessageThread,
  PresenceTemplatesData,
  ProfileContextData,
  ProfilesByLoginData,
  ThreadMessage,
  ThreadMessagesData,
  ThreadsData,
  UpdatePresenceTemplateArgs,
} from './aula-types.ts';
import { PRESENCE_ACTIVITY_TYPE } from './aula-types.ts';
import { AulaApiError, AulaApiVersionError, AulaStepUpRequiredError } from './errors.ts';

export interface AulaClientOptions {
  /** Tokens issued by AulaLoginClient. The access token is added as a query
   *  parameter (Aula's API quirk — they don't accept Bearer headers). */
  tokens: AulaTokens;
  http?: AulaHttpClient;
  logger?: Logger;
  /** Default v22; the probe will bump if needed. */
  initialApiVersion?: number;
  /** Inclusive bound for probing. Default 50. */
  maxApiVersion?: number;
  /** Override the API host. */
  apiBaseHost?: string;
  /** Notified when the probe lands on a different version than expected. */
  onApiVersionChanged?: (from: number, to: number) => void;
}

const DEFAULT_API_BASE_HOST = 'https://www.aula.dk';

export class AulaClient {
  readonly http: AulaHttpClient;
  private readonly logger: Logger;
  private tokens: AulaTokens;
  private apiVersion: number;
  private readonly maxApiVersion: number;
  private readonly apiBaseHost: string;
  private readonly onVersionChanged?: (from: number, to: number) => void;
  private versionVerified = false;

  constructor(options: AulaClientOptions) {
    this.tokens = options.tokens;
    this.logger = options.logger ?? silentLogger;
    this.http = options.http ?? new AulaHttpClient({ logger: this.logger });
    this.apiVersion = options.initialApiVersion ?? 22;
    this.maxApiVersion = options.maxApiVersion ?? 50;
    this.apiBaseHost = options.apiBaseHost ?? DEFAULT_API_BASE_HOST;
    if (options.onApiVersionChanged) this.onVersionChanged = options.onApiVersionChanged;
  }

  /** Update tokens after a refresh. */
  setTokens(tokens: AulaTokens): void {
    this.tokens = tokens;
  }

  /** Currently-active API version. Useful for diagnostics. */
  get currentApiVersion(): number {
    return this.apiVersion;
  }

  // --- Probing --------------------------------------------------------------

  /**
   * Probe the API to find a working version. Lazily called by every API
   * method on first invocation, but exposed publicly so callers can do it
   * eagerly (e.g. before a batch of requests).
   */
  async ensureApiVersion(): Promise<number> {
    if (this.versionVerified) return this.apiVersion;
    const tried: number[] = [];
    for (let v = this.apiVersion; v <= this.maxApiVersion; v++) {
      tried.push(v);
      const url = this.apiUrl(v, { method: 'profiles.getProfilesByLogin' });
      const res = await this.http.request(url, { method: 'GET' });
      // 200 → working; 410 → bump; anything else stops probing.
      if (res.status === 200) {
        if (v !== this.apiVersion) {
          const from = this.apiVersion;
          this.apiVersion = v;
          this.logger.info('aula.api.version_changed', { from, to: v });
          this.onVersionChanged?.(from, v);
        }
        this.versionVerified = true;
        return v;
      }
      if (res.status === 410) {
        this.logger.warn('aula.api.version_gone', { version: v });
        continue;
      }
      throw new AulaApiError(
        `Unexpected status ${res.status} probing API version ${v}`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    throw new AulaApiVersionError(
      `Could not find a working API version in v${this.apiVersion}..v${this.maxApiVersion}`,
      tried,
    );
  }

  // --- Methods --------------------------------------------------------------

  async getProfilesByLogin(): Promise<ProfilesByLoginData> {
    return this.getJson<ProfilesByLoginData>('profiles.getProfilesByLogin');
  }

  async getProfileContext(role: 'guardian' | 'employee' = 'guardian'): Promise<ProfileContextData> {
    return this.getJson<ProfileContextData>('profiles.getProfileContext', { portalrole: role });
  }

  async getDailyOverview(childIds: readonly number[]): Promise<DailyOverviewEntry[]> {
    if (childIds.length === 0) return [];
    const params = new URLSearchParams();
    params.set('method', 'presence.getDailyOverview');
    for (const id of childIds) params.append('childIds[]', String(id));
    const data = await this.getJsonRaw<DailyOverviewEntry[]>(params);
    return data ?? [];
  }

  /**
   * `presence.getPresenceTemplates` — the recurring komme/gå templates
   * (drop-off + pickup times parents register per day). Returns the raw
   * `presenceWeekTemplates` envelope; each entry carries the
   * `institutionProfile.id` that {@link updatePresenceTemplate} needs.
   */
  async getPresenceTemplates(args: GetPresenceTemplatesArgs): Promise<PresenceTemplatesData> {
    if (args.institutionProfileIds.length === 0) return {};
    const params = new URLSearchParams();
    params.set('method', 'presence.getPresenceTemplates');
    // Array params take the `[]` suffix, same as childIds[] above.
    for (const id of args.institutionProfileIds) {
      params.append('filterInstitutionProfileIds[]', String(id));
    }
    params.set('fromDate', args.fromDate);
    params.set('toDate', args.toDate);
    const data = await this.getJsonRaw<PresenceTemplatesData>(params);
    return data ?? {};
  }

  /**
   * `presence.updatePresenceTemplate` — register or overwrite a komme/gå
   * template for one child on one day. A non-`never` `repeatPattern` makes
   * it recur on that weekday until `repeatUntil`.
   *
   * This is a write to the live Aula platform — the MCP server gates the
   * tool that calls it behind `AULA_MCP_WRITE=1`.
   */
  async updatePresenceTemplate(args: UpdatePresenceTemplateArgs): Promise<unknown> {
    return this.postJson<unknown>(
      'presence.updatePresenceTemplate',
      JSON.stringify(buildPresenceTemplateBody(args)),
    );
  }

  async getCalendarEvents(args: GetCalendarEventsArgs): Promise<CalendarEvent[]> {
    const body = JSON.stringify({
      instProfileIds: args.profileIds,
      resourceIds: args.resourceIds ?? [],
      start: args.start,
      end: args.end,
    });
    return (
      (await this.postJson<CalendarEvent[]>(
        'calendar.getEventsByProfileIdsAndResourceIds',
        body,
      )) ?? []
    );
  }

  async getThreads(opts: { page?: number; pageSize?: number } = {}): Promise<MessageThread[]> {
    const params: Record<string, string> = {
      sortOn: 'date',
      orderDirection: 'desc',
      page: String(opts.page ?? 0),
    };
    if (opts.pageSize) params.pageSize = String(opts.pageSize);
    const data = await this.getJson<ThreadsData>('messaging.getThreads', params);
    return data.threads ?? [];
  }

  /**
   * Fetch a single thread's messages. Throws AulaStepUpRequiredError when the
   * thread is sensitive and Aula returns status.code 403 — the user must
   * MitID step-up to read it.
   */
  async getMessagesForThread(
    threadId: number,
    opts: { page?: number } = {},
  ): Promise<{ subject?: string; messages: ThreadMessage[] }> {
    // Probe-aware version: every OTHER method routes through
    // getJsonRaw / postJson, which call ensureApiVersion() implicitly
    // and end up on the current working version (currently v23). This
    // one bypasses both helpers because it needs custom 403 → step-up
    // handling, and used to pin `this.apiVersion` (default 22) directly
    // — so a session that called get_thread before anything else
    // (e.g. straight from a cached threadId, skipping discover /
    // list_threads) hit /api/v22/ and got HTTP 410 from Aula's
    // deprecated-version response, surfacing as "410 error" to the
    // agent with no recovery.
    const version = await this.ensureApiVersion();
    const url = this.apiUrl(version, {
      method: 'messaging.getMessagesForThread',
      threadId: String(threadId),
      page: String(opts.page ?? 0),
    });
    const res = await this.http.request(url, { method: 'GET' });
    if (res.status !== 200) {
      throw new AulaApiError(
        `getMessagesForThread failed (status ${res.status})`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    const env = JSON.parse(res.body) as AulaEnvelope<ThreadMessagesData>;
    if (env.status?.code === 403) {
      throw new AulaStepUpRequiredError(
        env.status.message ??
          'Thread requires MitID step-up; ask the user to refresh their session.',
      );
    }
    if (env.status?.code && env.status.code !== 0) {
      throw new AulaApiError(
        `getMessagesForThread error code ${env.status.code}: ${env.status.message ?? '<unknown>'}`,
        res.status,
        url,
        res.body.slice(0, 300),
      );
    }
    const data: ThreadMessagesData = env.data ?? { messages: [] };
    return {
      ...(data.subject ? { subject: data.subject } : {}),
      messages: data.messages ?? [],
    };
  }

  /**
   * `notifications.getNotificationsForActiveProfile` — what's unread.
   * Returns the raw `data` field; agents can format the shape they need.
   */
  async getNotifications(): Promise<unknown> {
    return this.getJson<unknown>('notifications.getNotificationsForActiveProfile');
  }

  /**
   * `posts.getAllPosts` — class-level news feed (teacher posts, etc.).
   * Returns the raw `data` field. Pagination via `limit` + `index` (both 0-based).
   */
  async getPosts(opts: { limit?: number; index?: number } = {}): Promise<unknown> {
    const params: Record<string, string> = {};
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.index !== undefined) params.index = String(opts.index);
    return this.getJson<unknown>('posts.getAllPosts', params);
  }

  /**
   * Generic escape hatch for endpoints we haven't typed wrappers for.
   * The MCP server gates this behind AULA_MCP_RAW=1.
   *
   * @param method     Aula API method name (e.g. 'profiles.getProfilesByLogin')
   * @param params     Extra query-string params (access_token + method are added)
   * @param body       JSON body for POST requests; pass undefined for GET
   */
  async rawRequest(
    method: string,
    params: Record<string, string> = {},
    body?: unknown,
  ): Promise<unknown> {
    if (body !== undefined) {
      return this.postJson<unknown>(method, JSON.stringify(body));
    }
    return this.getJson<unknown>(method, params);
  }

  /**
   * Get a token for a third-party widget (Min Uddannelse / EasyIQ / Meebook
   * / Systematic). Used by the WidgetTokenManager (next package layer).
   */
  async getWidgetToken(widgetId: string): Promise<string> {
    const data = await this.getJsonRaw<string>(
      new URLSearchParams({ method: 'aulaToken.getAulaToken', widgetId }),
    );
    if (!data) throw new AulaApiError('aulaToken response missing data', 200, '', '');
    return data;
  }

  /** Generic GET that returns the parsed `data` field of the envelope. */
  async getJson<T>(method: string, query: Record<string, string> = {}): Promise<T> {
    const params = new URLSearchParams({ method, ...query });
    const data = await this.getJsonRaw<T>(params);
    if (data === undefined) {
      throw new AulaApiError(`${method} response missing data field`, 200, '', '');
    }
    return data;
  }

  /** GET with a manually-built params object (allows array fields like `childIds[]`). */
  async getJsonRaw<T>(params: URLSearchParams): Promise<T | undefined> {
    const version = await this.ensureApiVersion();
    params.set('access_token', this.tokens.access_token);
    const url = `${this.apiBaseHost}/api/v${version}/?${params.toString()}`;
    const res = await this.http.request(url, { method: 'GET' });
    return this.parseEnvelope<T>(res.url, res.status, res.body, params);
  }

  /** POST JSON body to an Aula API method. Sets CSRF header from cookie jar. */
  async postJson<T>(method: string, body: string): Promise<T | undefined> {
    const version = await this.ensureApiVersion();
    const params = new URLSearchParams({ method });
    params.set('access_token', this.tokens.access_token);
    const url = `${this.apiBaseHost}/api/v${version}/?${params.toString()}`;
    const csrf = await this.http.jar.getCookieValue(url, 'Csrfp-Token');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (csrf) headers['csrfp-token'] = csrf;
    const res = await this.http.request(url, { method: 'POST', headers, body });
    return this.parseEnvelope<T>(res.url, res.status, res.body, params);
  }

  /**
   * Probe-aware envelope parser. On 410, retries once after re-probing the
   * version (#246/#248 mid-session bumps).
   */
  private async parseEnvelope<T>(
    url: string,
    status: number,
    body: string,
    paramsForRetry: URLSearchParams,
  ): Promise<T | undefined> {
    if (status === 410 && this.versionVerified) {
      // Mid-session bump.
      this.versionVerified = false;
      this.apiVersion += 1;
      this.logger.warn('aula.api.version_410', { newProbeFrom: this.apiVersion });
      const newVersion = await this.ensureApiVersion();
      paramsForRetry.set('access_token', this.tokens.access_token);
      const retryUrl = `${this.apiBaseHost}/api/v${newVersion}/?${paramsForRetry.toString()}`;
      const res = await this.http.request(retryUrl, { method: 'GET' });
      return this.parseEnvelope<T>(res.url, res.status, res.body, paramsForRetry);
    }
    if (status !== 200) {
      throw new AulaApiError(`API returned status ${status}`, status, url, body.slice(0, 300));
    }
    const env = JSON.parse(body) as AulaEnvelope<T>;
    if (env.status?.code && env.status.code !== 0) {
      throw new AulaApiError(
        `API error code ${env.status.code}: ${env.status.message ?? '<unknown>'}`,
        status,
        url,
        body.slice(0, 300),
      );
    }
    return env.data;
  }

  private apiUrl(version: number, params: Record<string, string>): string {
    const qs = new URLSearchParams(params);
    qs.set('access_token', this.tokens.access_token);
    return `${this.apiBaseHost}/api/v${version}/?${qs.toString()}`;
  }
}

/**
 * Build the `presence.updatePresenceTemplate` POST body.
 *
 * The shape mirrors the Aula presence frontend's `preparePresenceTemplateParams`:
 * `presenceActivity` nests a different time block per `activityType` —
 * `pickup` / `selfDecider` / `sendHome` / `goHomeWith`. `expiresAt` only
 * means anything for a repeating template, so it's nulled for a one-off.
 */
function buildPresenceTemplateBody(args: UpdatePresenceTemplateArgs): Record<string, unknown> {
  const repeatPattern = args.repeatPattern ?? 'never';
  const entryTime = args.entryTime ?? null;
  const exitTime = args.exitTime ?? null;

  const presenceActivity: Record<string, unknown> = {
    activityType: PRESENCE_ACTIVITY_TYPE[args.activityType],
  };
  switch (args.activityType) {
    case 'picked_up_by':
      presenceActivity.pickup = { entryTime, exitTime, exitWith: args.pickedUpBy ?? null };
      break;
    case 'self_decider':
      presenceActivity.selfDecider = {
        entryTime,
        exitStartTime: args.selfDeciderStartTime ?? null,
        exitEndTime: args.selfDeciderEndTime ?? null,
      };
      break;
    case 'send_home':
      presenceActivity.sendHome = { entryTime, exitTime };
      break;
    case 'go_home_with':
      presenceActivity.goHomeWith = { entryTime, exitTime, exitWith: args.pickedUpBy ?? null };
      break;
  }

  return {
    institutionProfileId: args.institutionProfileId,
    byDate: args.date,
    presenceActivity,
    comment: args.comment ?? null,
    repeatPattern,
    expiresAt: repeatPattern === 'never' ? null : (args.repeatUntil ?? null),
  };
}

// Avoid unused-import lint when using AulaCookieJar transitively.
void AulaCookieJar;
