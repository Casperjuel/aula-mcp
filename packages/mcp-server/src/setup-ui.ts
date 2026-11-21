/**
 * In-addon setup / login UI.
 *
 * Standalone Hono app served on a second port (default 8099). Home Assistant
 * proxies it via Ingress, so the user opens "Aula" in HA's sidebar and gets
 * an interactive MitID login flow without ever leaving HA.
 *
 * Flow:
 *   1. GET  /            → HTML page. Shows token status + "Start login" button.
 *   2. POST /login/start → kicks off MitID APP-method login. Returns sessionId.
 *   3. GET  /login/events?sessionId=… → SSE stream:
 *        event: qr            data: { svg, refreshCount }
 *        event: otp           data: { code }
 *        event: verified      data: {}
 *        event: identity      data: { options: [{ index, name }] }
 *        event: success       data: { identityName?, expiresInSec }
 *        event: error         data: { message }
 *   4. POST /login/identity?sessionId=… { index } → resolves selectIdentity.
 *
 * The same `AulaLoginClient` the CLI uses runs in the addon — no duplication
 * of MitID logic. We just translate its callbacks into SSE events.
 *
 * Routes are stateful per login session: `loginSessions` holds the SSE
 * writer, the in-flight selectIdentity resolver, and the abort signal. A
 * single user (single household) is the design point; concurrent logins
 * aren't useful and aren't supported.
 *
 * Multi-parent mode (`parents` set): every route but /auth/* needs a parent
 * signed in through setup-login.ts, and works on that parent's own token
 * store only. A login session belongs to the parent who started it; another
 * parent gets the same 404 as for an unknown session id.
 *
 * The dashboard (setup-dashboard.ts) reads and changes the parent's own
 * stored data and sync jobs through the /data/* JSON routes below. Each
 * route picks the storage and the sync from the signed-in parent, never from
 * the request, so no parameter can reach another parent's rows. Requests
 * that change something must be same-origin JSON: multi-parent mode checks
 * the Origin, and these routes also refuse any other content type, which a
 * cross-site form cannot send without a CORS preflight.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AulaHttpClient,
  AulaLoginClient,
  EncryptedFileTokenStore,
  type IdentityOption,
  type Logger,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
} from '@aula-mcp/aula-auth';
import type { AulaClient, UpdatePresenceTemplateArgs } from '@aula-mcp/aula-client';
import { type Context, Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';
import { isInline } from './attachments.ts';
import type { AulaContext } from './aula-context.ts';
import { feedEvents, toIcs } from './calendar-feed.ts';
import {
  childPlan,
  childrenToday,
  ownChildren,
  sendSickReport,
  sickReportRefusal,
  type VacationAnswerDay,
  vacationAnswerProblems,
  vacationDays,
  vacationProblems,
  vacationRequests,
} from './child-actions.ts';
import { buildDiscoverManifest } from './discover.ts';
import type { GalleryView } from './gallery.ts';
import { detail, SENDER_ROLES, type SenderRole, summarize } from './item-view.ts';
import {
  ACTIVITY_MAX_DAYS,
  activityByDay,
  roleCounts,
  searchItems,
  threadMessages,
} from './local-data.ts';
import type { SharedView } from './local-tools.ts';
import { type Caller, callerId } from './oidc.ts';
import { renderDashboard } from './setup-dashboard.ts';
import type { SetupLogin } from './setup-login.ts';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditEntry,
  type FeedTokens,
  ITEM_KINDS,
  type ItemKind,
  type KindStats,
  normalEmail,
  type ParentStorage,
  type Shares,
  type StorageInfo,
} from './storage.ts';
import { type ParentSync, SYNC_JOBS, type SyncJobName } from './sync.ts';
import { DEFAULT_RENEW_WITHIN_SECONDS } from './token-keepalive.ts';
import { type ToolInfo, toolCatalog } from './tool-catalog.ts';
import { toolNameStyle } from './tool-names.ts';
import { validateSetTemplateArgs } from './tools.ts';

/** Max time we'll hold a login session waiting on the user to pick their
 *  MitID identity after the picker is shown. After this the login rejects
 *  with a timeout so the session entry gets cleaned up instead of leaking. */
const IDENTITY_PICK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SetupAppOptions {
  logger?: Logger;
  /** Override the token store (tests). Production uses the addon's
   *  EncryptedFileTokenStore under `AULA_MCP_DIR`. */
  store?: TokenStore;
  /** The background keep-alive renews the tokens (AULA_MCP_KEEPALIVE). */
  autoRenew?: boolean;
  /** The "Mine data" page. Without it, /data shows what is stored and the
   *  tool list, but cannot read anything live from Aula. */
  myData?: {
    /** Defaults to every tool with the server's own env and name style. */
    tools?: ToolInfo[];
    /** The parent's own context (null caller in single-parent mode). */
    contextFor(caller: Caller | null): AulaContext;
    /** Local storage, when it is on. */
    storage?: {
      info: StorageInfo;
      /** The parent's own rows (null caller in single-parent mode). */
      forParent(caller: Caller | null): ParentStorage;
    };
    /** The sync jobs, when local storage is on. */
    sync?: {
      /** The parent's own jobs (null caller in single-parent mode). */
      forParent(caller: Caller | null): ParentSync;
    };
    /** The downloaded gallery, when local storage is on. */
    gallery?: {
      /** The parent's own albums and files (null caller in single-parent mode). */
      forParent(caller: Caller | null): GalleryView;
    };
    /** Local storage: the secret calendar feed link of each parent. */
    feeds?: {
      tokens: FeedTokens;
      /** The stored-data id of a signed-in parent ('default' in single-parent mode). */
      parentIdOf(caller: Caller | null): string;
      storageFor(parentId: string): ParentStorage;
      /** Where browsers and calendar apps reach this UI; the request's origin when null. */
      publicUrl: string | null;
    };
    /** Multi-parent mode with local storage: sharing with another parent. */
    sharing?: {
      shares: Shares;
      /** What `owner` shares with `viewer`, read-only; null unless they do. */
      open(viewer: Caller, ownerId: string): Promise<SharedView | null>;
    };
  };
  /** Multi-parent mode: the sign-in, and each parent's own token store. */
  parents?: {
    login: SetupLogin;
    storeFor(caller: Caller): TokenStore;
    /** After a parent's tokens were saved or cleared. */
    changed?(caller: Caller): void;
  };
}

/** The reads `?owner=` works for: stored items and files, never sync, login or changes. */
const SHARED_READS =
  /^\/data\/(stats|items(\/[^/]+\/[^/]+)?|activity|messages\/roles|gallery(\/albums\/[^/]+|\/(file|thumb)\/[^/]+\/[^/]+)?|attachments\/(post|message)\/[^/]+\/[^/]+)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HENTEFORM = ['picked_up_by', 'self_decider', 'send_home', 'go_home_with'] as const;

/** This Monday to Sunday next week, in local time. */
function twoWeeks(now = new Date()): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const last = new Date(today);
  last.setDate(today.getDate() + 13);
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: day(today), to: day(last) };
}

/** A one-day komme/gå change from the dashboard, or what is wrong with it. */
/** `children` (a list of ids) or `child` (one id) from a request body. */
function childIdsOf(body: Record<string, unknown>): number[] | null {
  const raw = Array.isArray(body.children) ? body.children : [body.child];
  const ids = raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
  return ids.length > 0 && ids.length === raw.length && ids.length <= 10 ? [...new Set(ids)] : null;
}

function planArgs(body: Record<string, unknown>): UpdatePresenceTemplateArgs | string {
  const { child, date, activityType } = body;
  if (typeof child !== 'number' || !Number.isInteger(child) || child <= 0) {
    return 'child must be an id';
  }
  if (typeof date !== 'string' || !ISO_DAY.test(date)) return 'date must be YYYY-MM-DD';
  if (!HENTEFORM.includes(activityType as (typeof HENTEFORM)[number])) {
    return `activityType must be one of ${HENTEFORM.join(', ')}`;
  }
  const args: UpdatePresenceTemplateArgs = {
    institutionProfileId: child,
    date,
    activityType: activityType as (typeof HENTEFORM)[number],
  };
  for (const key of [
    'entryTime',
    'exitTime',
    'selfDeciderStartTime',
    'selfDeciderEndTime',
  ] as const) {
    const value = body[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !HH_MM.test(value)) return `${key} must be HH:mm`;
    args[key] = value;
  }
  for (const key of ['pickedUpBy', 'comment'] as const) {
    const value = body[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 500) return `${key} must be text`;
    args[key] = value.trim();
  }
  const repeat = body.repeat ?? 'never';
  if (repeat !== 'never' && repeat !== 'weekly' && repeat !== 'every_2_weeks') {
    return 'repeat must be never, weekly or every_2_weeks';
  }
  if (repeat !== 'never') {
    const until = body.repeatUntil;
    if (typeof until !== 'string' || !ISO_DAY.test(until)) return 'repeatUntil must be YYYY-MM-DD';
    if (until < date) return 'repeatUntil must not be before date';
    if (until > `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`) {
      return 'repeatUntil must be within a year of date';
    }
    args.repeatPattern = repeat;
    args.repeatUntil = until;
  }
  return args;
}

interface LoginSession {
  sessionId: string;
  username: string;
  /** callerId of the parent who started it; '' in single-parent mode. */
  owner: string;
  store: TokenStore;
  /** Called after the tokens were saved. */
  onSaved?: () => void;
  /** Records how the login went in the parent's audit log. */
  audit?: (entry: AuditEntry) => Promise<void>;
  stream?: SSEStreamingApi;
  /** Resolver waiting on user identity choice; null when no pending pick. */
  pendingIdentity: ((index: number) => void) | null;
  /** Queue of events that arrived before the stream was attached. */
  bufferedEvents: Array<{ event: string; data: string }>;
  abort: AbortController;
  /** Set when the login resolves (success or error). The terminal event has
   *  already been sent via `emit()` — this is just a flag so a late-attaching
   *  SSE stream can replay it on connect. */
  terminal?: { event: 'success' | 'error'; data: string };
  /** Resolves when runLogin has finished (after the terminal event has been
   *  emitted). The SSE route handler awaits this instead of polling. */
  done: Promise<void>;
  /** Called by runLogin after the terminal event lands. */
  signalDone: () => void;
}

/** HTML pages of the setup UI, as opposed to its JSON endpoints. */
const PAGES = new Set(['/', '/data']);

export const ICON_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 3 1 9l11 6 9-4.91V17h2V9z"/></svg>`;

export function createSetupApp(options: SetupAppOptions = {}): Hono {
  const logger = options.logger ?? silentLogger;
  const parents = options.parents;
  const sharedStore = parents ? null : (options.store ?? defaultAddonStore());
  const loginSessions = new Map<string, LoginSession>();

  const app = new Hono();

  // Signed-in parent for this request; the middleware below guarantees one.
  const parentOf = (c: Context) => parents?.login.parent(c) ?? null;
  const sharedViews = new WeakMap<Request, SharedView>();
  const ownerOf = (c: Context): string => {
    const parent = parentOf(c);
    return parent ? callerId(parent.caller) : '';
  };
  const storeOf = (c: Context): TokenStore => {
    const parent = parentOf(c);
    if (sharedStore) return sharedStore;
    if (!parents || !parent) throw new Error('No signed-in parent to pick a token store for.');
    return parents.storeFor(parent.caller);
  };
  const changedFor = (c: Context): (() => void) | undefined => {
    const parent = parentOf(c);
    const changed = parents?.changed;
    return parent && changed ? () => changed(parent.caller) : undefined;
  };

  // A calendar app cannot sign in, so the feed answers to its secret link
  // alone, before the sign-in below. Unknown links get the same 404 as any
  // missing page.
  const feeds = options.myData?.feeds;
  if (feeds) {
    app.get('/feed/:token/calendar.ics', async (c) => {
      const parentId = await feeds.tokens.resolve(c.req.param('token'));
      if (!parentId) return c.text('Not found', 404);
      const events = await feedEvents(feeds.storageFor(parentId), {
        lessons: c.req.query('skema') === '1',
      });
      return c.body(toIcs(events), 200, {
        'content-type': 'text/calendar; charset=utf-8',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex',
      });
    });
  }

  if (parents) {
    parents.login.mount(app);
    app.use('*', async (c, next) => {
      if (!parents.login.parent(c)) {
        // Pages send the browser to sign in; API calls just get a 401.
        if (c.req.method === 'GET' && PAGES.has(c.req.path)) return c.redirect('/auth/login', 302);
        return c.json({ error: 'not signed in' }, 401);
      }
      if (c.req.method !== 'GET' && !parents.login.sameOrigin(c)) {
        return c.json({ error: 'cross-origin request refused' }, 403);
      }
      await next();
    });
    // `?owner=<parent id>` reads what that parent shares with this one, and
    // only for the reads above.
    app.use('/data/*', async (c, next) => {
      const owner = c.req.query('owner');
      if (owner === undefined) return next();
      if (c.req.method !== 'GET' || !SHARED_READS.test(c.req.path)) {
        return c.json({ error: 'shared data is read-only' }, 403);
      }
      const parent = parents.login.parent(c);
      const view = parent && (await options.myData?.sharing?.open(parent.caller, owner));
      if (!view) return c.json({ error: 'not shared with you' }, 404);
      sharedViews.set(c.req.raw, view);
      await next();
    });
  } else {
    // Single-parent mode has no sign-in; still refuse a browser that says
    // the request comes from another site.
    app.use('*', async (c, next) => {
      const site = c.req.header('sec-fetch-site');
      if (c.req.method !== 'GET' && site && site !== 'same-origin' && site !== 'none') {
        return c.json({ error: 'cross-origin request refused' }, 403);
      }
      await next();
    });
  }

  // One page for both; /data is where the old "Mine data" page lived.
  app.get('/', (c) => c.html(renderDashboard(parentOf(c)?.name)));
  app.get('/data', (c) => c.html(renderDashboard(parentOf(c)?.name)));

  app.get('/status', async (c) => c.json(await loginStatus(storeOf(c))));

  const tools = options.myData?.tools ?? toolCatalog(process.env, toolNameStyle());

  // What aula-mcp keeps about the signed-in parent. Never the tokens.
  app.get('/data/summary', async (c) => {
    const store = storeOf(c);
    const login = await loginStatus(store);
    const parent = parentOf(c);
    const storage = options.myData?.storage;
    const database = storage
      ? {
          type: storage.info.type,
          location: storage.info.location,
          kinds: await storage.forParent(parent?.caller ?? null).stats(),
        }
      : null;
    return c.json({
      parent: parent ? { name: parent.name, id: callerId(parent.caller) } : null,
      login,
      database,
      stored: storedItems(store, login.logged_in, parent !== null, database),
      not_stored: [
        ...(database
          ? []
          : [
              'Beskeder, opslag, kalender, ugeplaner, lektier, fravær, kontakter og billeder fra Aula. ' +
                'De hentes live fra Aula, når du spørger, og gemmes ikke.',
            ]),
        'Hvad du skriver til AI-assistenten. aula-mcp ser kun de værktøjskald, assistenten laver.',
      ],
    });
  });

  app.get('/data/tools', (c) => c.json({ tools }));

  // Counts per kind; with `owner`, of what that parent shares with you.
  app.get('/data/stats', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    return c.json({ kinds: await store.stats() });
  });

  // A live read through the parent's own context: who and what Aula shows.
  app.get('/data/live', async (c) => {
    if (!options.myData) return c.json({ error: 'live data is not available here' }, 404);
    if (!(await storeOf(c).load())) return c.json({ error: 'not logged in to Aula' }, 409);
    const parent = parentOf(c);
    try {
      const manifest = await buildDiscoverManifest(
        options.myData.contextFor(parent?.caller ?? null),
      );
      return c.json({
        user: manifest.user,
        children: manifest.children.map((child) => ({
          id: child.id,
          name: child.name,
          institution: child.institution?.name ?? null,
        })),
        capabilities: Object.entries(manifest.capabilities).map(([area, capability]) => ({
          area,
          summary: capability.summary,
          tools: capability.tools,
        })),
        detected_widgets: manifest.detectedWidgets,
      });
    } catch (err) {
      logger.warn('setup.data.live_failed', { error: (err as Error).message });
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  // --- shortcuts for one child, live in Aula through this parent's login ---
  //
  // The parent clicks these themselves and confirms each write in the page,
  // so they do not wait for AULA_MCP_WRITE, which keeps an agent from writing
  // unasked. Only the parent's own children, and every write is audited.

  const clientOf = async (c: Context): Promise<AulaClient | null> => {
    if (!options.myData || !(await storeOf(c).load())) return null;
    return options.myData.contextFor(parentOf(c)?.caller ?? null).getClient();
  };
  const aulaFailed = (c: Context, what: string, err: unknown) => {
    logger.warn(`setup.children.${what}_failed`, { error: (err as Error).message });
    return c.json({ error: (err as Error).message }, 502);
  };

  app.get('/data/children', async (c) => {
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    try {
      return c.json({ children: await childrenToday(client) });
    } catch (err) {
      return aulaFailed(c, 'today', err);
    }
  });

  // The komme/gå plan, today and the next 13 days unless `from` and `to` say otherwise.
  app.get('/data/children/plan', async (c) => {
    const child = Number(c.req.query('child'));
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!Number.isInteger(child) || child <= 0)
      return c.json({ error: 'child must be an id' }, 400);
    const window = from && to && ISO_DAY.test(from) && ISO_DAY.test(to) ? { from, to } : twoWeeks();
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    try {
      if (!(await ownChildren(client)).has(child)) return c.json({ error: 'not your child' }, 404);
      return c.json({ ...window, days: await childPlan(client, child, window.from, window.to) });
    } catch (err) {
      return aulaFailed(c, 'plan', err);
    }
  });

  app.post('/data/children/sick', async (c) => {
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const ids = childIdsOf(body);
    if (!ids || typeof body.sick !== 'boolean') {
      return c.json({ error: 'give child (an id) or children, and sick (true or false)' }, 400);
    }
    const sick = body.sick;
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    const started = Date.now();
    const action = sick ? 'presence_report_sick' : 'presence_undo_sick';
    try {
      const refusal = await sickReportRefusal(client, ids, sick);
      if (refusal) return c.json(refusal, 409);
      await sendSickReport(client, ids, sick);
    } catch (err) {
      await auditOf(c)?.({
        category: 'aula',
        action,
        ok: false,
        durationMs: Date.now() - started,
        details: { children: ids.length, error: (err as Error).message.slice(0, 300) },
      });
      return aulaFailed(c, 'sick', err);
    }
    await auditOf(c)?.({
      category: 'aula',
      action,
      ok: true,
      durationMs: Date.now() - started,
      details: { children: ids.length },
    });
    return c.json({ ok: true });
  });

  // The komme/gå plan for one day, or repeating weekly or every other week
  // on that weekday until repeatUntil.
  app.post('/data/children/plan', async (c) => {
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const args = planArgs(body);
    if (typeof args === 'string') return c.json({ error: args }, 400);
    const problems = validateSetTemplateArgs({
      ...args,
      repeat: args.repeatPattern,
      repeatUntil: args.repeatUntil,
    });
    if (problems.length > 0) return c.json({ error: problems.join(' ') }, 400);
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    const started = Date.now();
    const details = {
      children: 1,
      date: args.date,
      activityType: args.activityType,
      repeat: args.repeatPattern ?? 'never',
      ...(args.repeatUntil ? { repeatUntil: args.repeatUntil } : {}),
    };
    try {
      if (!(await ownChildren(client)).has(args.institutionProfileId)) {
        return c.json({ error: 'not your child' }, 404);
      }
      await client.updatePresenceTemplate({ repeatPattern: 'never', ...args });
    } catch (err) {
      await auditOf(c)?.({
        category: 'aula',
        action: 'presence_set_template',
        ok: false,
        durationMs: Date.now() - started,
        details: { ...details, error: (err as Error).message.slice(0, 300) },
      });
      return aulaFailed(c, 'plan', err);
    }
    await auditOf(c)?.({
      category: 'aula',
      action: 'presence_set_template',
      ok: true,
      durationMs: Date.now() - started,
      details,
    });
    return c.json({ ok: true });
  });

  // Ferie/fri over whole days. Aula's calendar.addVacation, not yet verified
  // against the live API; a registration can only be removed in Aula.
  app.post('/data/children/vacation', async (c) => {
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const { startDate, endDate } = body;
    const ids = childIdsOf(body);
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (!ids || typeof startDate !== 'string' || typeof endDate !== 'string') {
      return c.json({ error: 'give child (an id) or children, startDate and endDate' }, 400);
    }
    const problems = vacationProblems({ startDate, endDate, comment });
    if (problems.length > 0) return c.json({ error: problems.join(' ') }, 400);
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    const started = Date.now();
    const details = { children: ids.length, days: vacationDays(startDate, endDate) };
    try {
      const own = await ownChildren(client);
      if (!ids.every((id) => own.has(id))) return c.json({ error: 'not your child' }, 404);
      await client.addVacation({
        childIds: ids,
        startDate,
        endDate,
        ...(comment ? { comment } : {}),
      });
    } catch (err) {
      await auditOf(c)?.({
        category: 'aula',
        action: 'presence_add_vacation',
        ok: false,
        durationMs: Date.now() - started,
        details: { ...details, error: (err as Error).message.slice(0, 300) },
      });
      return aulaFailed(c, 'vacation', err);
    }
    await auditOf(c)?.({
      category: 'aula',
      action: 'presence_add_vacation',
      ok: true,
      durationMs: Date.now() - started,
      details,
    });
    return c.json({ ok: true });
  });

  // The institution's ferie requests (ferieregistrering) and the answer to one.
  app.get('/data/children/vacation-requests', async (c) => {
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    try {
      return c.json({ requests: await vacationRequests(client) });
    } catch (err) {
      return aulaFailed(c, 'vacation_requests', err);
    }
  });

  app.post('/data/children/vacation-requests/answer', async (c) => {
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const { childId, responseId } = body;
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    const days: VacationAnswerDay[] = [];
    for (const d of Array.isArray(body.days) ? (body.days as unknown[]) : []) {
      const row = (d ?? {}) as Record<string, unknown>;
      if (typeof row.date !== 'string' || typeof row.isComing !== 'boolean') {
        return c.json({ error: 'each day needs date and isComing' }, 400);
      }
      days.push({
        date: row.date,
        isComing: row.isComing,
        ...(typeof row.entryTime === 'string' && row.entryTime ? { entryTime: row.entryTime } : {}),
        ...(typeof row.exitTime === 'string' && row.exitTime ? { exitTime: row.exitTime } : {}),
      });
    }
    if (!Number.isSafeInteger(childId) || !Number.isSafeInteger(responseId)) {
      return c.json({ error: 'give childId, responseId and days' }, 400);
    }
    const client = await clientOf(c);
    if (!client) return c.json({ error: 'not logged in to Aula' }, 409);
    const started = Date.now();
    const details = { days: days.length, coming: days.filter((d) => d.isComing).length };
    try {
      const request = (await vacationRequests(client)).find(
        (r) => r.childId === childId && r.responseId === responseId,
      );
      if (!request) return c.json({ error: 'no such ferie request' }, 404);
      const problems = vacationAnswerProblems(request, days, comment);
      if (problems.length > 0) return c.json({ error: problems.join(' ') }, 400);
      await client.respondToVacationRequest({
        childId: request.childId,
        responseId: request.responseId,
        days,
        ...(comment ? { comment } : {}),
      });
    } catch (err) {
      await auditOf(c)?.({
        category: 'aula',
        action: 'presence_answer_vacation_request',
        ok: false,
        durationMs: Date.now() - started,
        details: { ...details, error: (err as Error).message.slice(0, 300) },
      });
      return aulaFailed(c, 'vacation_answer', err);
    }
    await auditOf(c)?.({
      category: 'aula',
      action: 'presence_answer_vacation_request',
      ok: true,
      durationMs: Date.now() - started,
      details,
    });
    return c.json({ ok: true });
  });

  // The secret calendar feed link: made, shown once and removed here only.
  const feedUrl = (c: Context, token: string) =>
    `${feeds?.publicUrl ?? new URL(c.req.url).origin}/feed/${token}/calendar.ics`;
  app.get('/data/calendar-feed', async (c) => {
    if (!feeds) return c.json({ error: 'local storage is off' }, 404);
    const status = await feeds.tokens.status(feeds.parentIdOf(parentOf(c)?.caller ?? null));
    return c.json({ active: status !== null, ...status });
  });
  app.post('/data/calendar-feed', async (c) => {
    if (!feeds) return c.json({ error: 'local storage is off' }, 404);
    const replaced = await feeds.tokens.status(feeds.parentIdOf(parentOf(c)?.caller ?? null));
    const token = await feeds.tokens.create(feeds.parentIdOf(parentOf(c)?.caller ?? null));
    await auditOf(c)?.({
      category: 'sharing',
      action: 'calendar_feed_created',
      ok: true,
      details: { replaced: replaced !== null },
    });
    return c.json({ url: feedUrl(c, token) });
  });
  app.post('/data/calendar-feed/remove', async (c) => {
    if (!feeds) return c.json({ error: 'local storage is off' }, 404);
    const removed = await feeds.tokens.revoke(feeds.parentIdOf(parentOf(c)?.caller ?? null));
    await auditOf(c)?.({ category: 'sharing', action: 'calendar_feed_removed', ok: true });
    return c.json({ removed });
  });

  // --- the dashboard's stored data and sync jobs, all for this parent only ---

  // A read with ?owner= gets the shared view the middleware opened.
  const storageOf = (c: Context): ParentStorage | null =>
    sharedViews.get(c.req.raw)?.store ??
    options.myData?.storage?.forParent(parentOf(c)?.caller ?? null) ??
    null;
  const syncOf = (c: Context): ParentSync | null =>
    options.myData?.sync?.forParent(parentOf(c)?.caller ?? null) ?? null;
  const galleryOf = (c: Context): GalleryView | null => {
    const shared = sharedViews.get(c.req.raw);
    if (shared) return shared.gallery;
    return options.myData?.gallery?.forParent(parentOf(c)?.caller ?? null) ?? null;
  };
  /** Records an action in the signed-in parent's own audit log; never fails the request. */
  const auditOf = (c: Context) => {
    const store = options.myData?.storage?.forParent(parentOf(c)?.caller ?? null);
    if (!store) return undefined;
    return async (entry: AuditEntry) => {
      try {
        await store.audit({ ...entry, details: { trigger: 'dashboard', ...entry.details } });
      } catch {}
    };
  };
  /** Jobs asked for from the dashboard that have not finished, per parent. */
  const queuedRuns = new Map<string, Set<SyncJobName>>();

  /** The JSON body of a request that changes something, or null to refuse it. */
  const changeBody = async (c: Context): Promise<Record<string, unknown> | null> => {
    if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return null;
    const body = (await c.req.json().catch(() => null)) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  };

  // Newest first, a page at a time. `q` searches the text the parent sees and
  // `role` (messages and threads) picks who sent it; the stored data is
  // encrypted, so both filters run here and not in SQL.
  app.get('/data/items', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const rawKind = c.req.query('kind') || undefined;
    if (rawKind && !isKind(rawKind)) return c.json({ error: 'unknown kind' }, 400);
    const kind = rawKind as ItemKind | undefined;
    const since = optionalInt(c.req.query('since'));
    const until = optionalInt(c.req.query('until'));
    const offset = optionalInt(c.req.query('offset')) ?? 0;
    const limit = optionalInt(c.req.query('limit')) ?? 30;
    if ([since, until, offset, limit].some((n) => Number.isNaN(n))) {
      return c.json({ error: 'since, until, offset and limit must be integers' }, 400);
    }
    const page = { offset: Math.max(offset, 0), limit: Math.min(Math.max(limit, 1), 100) };
    const query = {
      ...(kind ? { kind } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const q = (c.req.query('q') ?? '').trim().slice(0, 200).toLocaleLowerCase('da-DK');
    const role = c.req.query('role') || undefined;
    if (role) {
      if (!(SENDER_ROLES as readonly string[]).includes(role)) {
        return c.json({ error: 'role must be guardian, employee, child or other' }, 400);
      }
      if (kind !== 'message' && kind !== 'message_thread') {
        return c.json({ error: 'role needs kind=message or kind=message_thread' }, 400);
      }
    }
    const found = await searchItems(store, {
      ...query,
      ...(q ? { q } : {}),
      ...(role ? { role: role as SenderRole } : {}),
      ...page,
    });
    return c.json({
      items: found.items.map(summarize),
      ...page,
      more: found.more,
      ...(found.truncated ? { search_truncated: true } : {}),
    });
  });

  // How many messages, media, posts and notifications arrived each day.
  app.get('/data/activity', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const since = optionalInt(c.req.query('since'));
    const until = optionalInt(c.req.query('until'));
    if (since === undefined || until === undefined || Number.isNaN(since) || Number.isNaN(until)) {
      return c.json({ error: 'since and until are required unix seconds' }, 400);
    }
    if (until < since || until - since > ACTIVITY_MAX_DAYS * 86400) {
      return c.json({ error: `the range must be 0 to ${ACTIVITY_MAX_DAYS} days` }, 400);
    }
    return c.json({ days: await activityByDay(store, since, until) });
  });

  // How many threads and messages each kind of sender wrote, for this parent.
  app.get('/data/messages/roles', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const { threads, messages, truncated } = await roleCounts(store);
    return c.json({ threads, messages, ...(truncated ? { truncated: true } : {}) });
  });

  app.get('/data/items/:kind/:id', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 400);
    const item = await store.get(kind, c.req.param('id'));
    if (!item) return c.json({ error: 'not found' }, 404);
    const gallery = galleryOf(c);
    const view = detail(item);
    // Marks which attachments have a saved copy the page can open.
    if (gallery && (kind === 'post' || kind === 'message')) {
      view.attachments = await gallery.attachments(kind, item.id);
    }
    const messages = kind === 'message_thread' ? await threadMessages(store, item.id) : undefined;
    if (gallery && messages) {
      for (const m of messages) {
        if (m.attachments.length) m.attachments = await gallery.attachments('message', m.id);
      }
    }
    return c.json({ item: view, ...(messages ? { messages } : {}) });
  });

  app.get('/data/sync', async (c) => {
    const sync = syncOf(c);
    const loggedIn = (await loginStatus(storeOf(c))).logged_in;
    if (!sync) return c.json({ available: false, logged_in: loggedIn, jobs: [] });
    const queued = queuedRuns.get(ownerOf(c)) ?? new Set();
    const jobs = await sync.status();
    return c.json({
      available: true,
      logged_in: loggedIn,
      jobs: jobs.map((job) => ({ ...job, queued: queued.has(job.job) && !job.running })),
    });
  });

  // The parent's own audit log, newest first, and which key seals their rows.
  // Never part of a shared view.
  app.get('/data/audit', async (c) => {
    const store = options.myData?.storage?.forParent(parentOf(c)?.caller ?? null);
    if (!store) return c.json({ available: false, events: [] });
    const category = c.req.query('category');
    const ok = c.req.query('ok');
    const before = Number(c.req.query('before'));
    const limit = Number(c.req.query('limit'));
    const [events, key] = await Promise.all([
      store.auditLog({
        ...(category && (AUDIT_CATEGORIES as readonly string[]).includes(category)
          ? { category: category as AuditCategory }
          : {}),
        ...(ok === 'true' || ok === 'false' ? { ok: ok === 'true' } : {}),
        ...(Number.isFinite(before) && before > 0 ? { before } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
      store.keyStatus(),
    ]);
    return c.json({ available: true, categories: AUDIT_CATEGORIES, events, key });
  });

  // Starts the jobs and answers at once; the page follows them in /data/sync.
  // A run of every job can take longer than an HTTP request may stay idle.
  app.post('/data/sync/run', async (c) => {
    const sync = syncOf(c);
    if (!sync) return c.json({ error: 'sync is off' }, 404);
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const asked = body.jobs === undefined ? [...SYNC_JOBS] : body.jobs;
    if (!Array.isArray(asked) || asked.length === 0 || !asked.every(isJob)) {
      return c.json({ error: `jobs must be some of ${SYNC_JOBS.join(', ')}` }, 400);
    }
    if (!(await storeOf(c).load())) return c.json({ error: 'not logged in to Aula' }, 409);
    const owner = ownerOf(c);
    const queued = queuedRuns.get(owner) ?? new Set<SyncJobName>();
    queuedRuns.set(owner, queued);
    for (const job of asked) queued.add(job);
    void sync
      .run(asked)
      .catch((err) => logger.warn('setup.sync_run_failed', { error: (err as Error).message }))
      .finally(() => {
        for (const job of asked) queued.delete(job);
      });
    return c.json({ started: asked }, 202);
  });

  // Deletes the parent's own copy of one kind, or of everything. Nothing in Aula.
  app.post('/data/delete', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    if (body.confirm !== 'SLET') return c.json({ error: 'confirm must be "SLET"' }, 400);
    if (body.all === true) {
      // The files go too, so nothing is left on disk without its row.
      await galleryOf(c)?.remove({ all: true });
      const deleted = await store.delete();
      await auditOf(c)?.({
        category: 'data',
        action: 'delete',
        ok: true,
        details: { kind: 'all', deleted },
      });
      return c.json({ deleted });
    }
    if (typeof body.kind !== 'string' || !isKind(body.kind)) {
      return c.json({ error: 'give a known kind, or all: true' }, 400);
    }
    if (body.kind === 'gallery_album' || body.kind === 'gallery_media') {
      return c.json({ error: 'delete gallery albums with /data/gallery/delete' }, 400);
    }
    // Saved attachments go with their posts or messages.
    if (body.kind === 'post' || body.kind === 'message') {
      await galleryOf(c)?.removeAttachments(body.kind);
    }
    const deleted = await store.delete({ kind: body.kind });
    await auditOf(c)?.({
      category: 'data',
      action: 'delete',
      ok: true,
      details: { kind: body.kind, deleted },
    });
    return c.json({ deleted });
  });

  // --- sharing: whom this parent shares with, and who shares with them ---

  app.get('/data/shares', async (c) => {
    const parent = parentOf(c);
    const sharing = options.myData?.sharing;
    if (!parent || !sharing) return c.json({ available: false });
    const id = callerId(parent.caller);
    // Shares waiting for this parent's verified email become theirs.
    if (parent.email && (await sharing.shares.claim(id, parent.email)) > 0) {
      await auditOf(c)?.({ category: 'sharing', action: 'claim', ok: true });
    }
    const [granted, owners] = await Promise.all([
      sharing.shares.granted(id),
      sharing.shares.owners(id),
    ]);
    return c.json({
      available: true,
      email: parent.email ?? null,
      granted,
      shared_with_me: owners.map((o) => ({ owner: o.ownerId, name: o.ownerName, since: o.since })),
    });
  });

  // Shares this parent's stored data, read-only, with whoever signs in with
  // the email. They see only what they have not stored themselves.
  app.post('/data/shares', async (c) => {
    const parent = parentOf(c);
    const sharing = options.myData?.sharing;
    if (!parent || !sharing) return c.json({ error: 'sharing is not available' }, 404);
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    const email = typeof body.email === 'string' ? normalEmail(body.email) : '';
    if (email.length > 254 || !EMAIL.test(email)) {
      return c.json({ error: 'give the email the other parent signs in with' }, 400);
    }
    if (parent.email && normalEmail(parent.email) === email) {
      return c.json({ error: 'that is your own email' }, 400);
    }
    const id = callerId(parent.caller);
    await sharing.shares.grant(id, parent.name, email);
    await auditOf(c)?.({ category: 'sharing', action: 'grant', ok: true, details: { email } });
    return c.json({ granted: await sharing.shares.granted(id) });
  });

  app.post('/data/shares/remove', async (c) => {
    const parent = parentOf(c);
    const sharing = options.myData?.sharing;
    if (!parent || !sharing) return c.json({ error: 'sharing is not available' }, 404);
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    if (typeof body.email !== 'string') return c.json({ error: 'give the email' }, 400);
    const id = callerId(parent.caller);
    if (!(await sharing.shares.revoke(id, body.email))) {
      return c.json({ error: 'not shared with that email' }, 404);
    }
    await auditOf(c)?.({
      category: 'sharing',
      action: 'revoke',
      ok: true,
      details: { email: normalEmail(body.email) },
    });
    return c.json({ granted: await sharing.shares.granted(id) });
  });

  // --- the downloaded gallery, this parent's own folder only ---

  app.get('/data/gallery', async (c) => {
    const gallery = galleryOf(c);
    if (!gallery) return c.json({ error: 'local storage is off' }, 404);
    const child = c.req.query('child') || undefined;
    const year = c.req.query('year') || undefined;
    const [status, albums] = await Promise.all([
      gallery.status(),
      gallery.albums({ ...(child ? { child } : {}), ...(year ? { year } : {}) }),
    ]);
    // Posts with photos are albums too, made here and not in Aula.
    const posts = child ? [] : await gallery.postAlbums();
    return c.json({
      status,
      albums,
      posts: year ? posts.filter((p) => p.date?.startsWith(year)) : posts,
    });
  });

  app.get('/data/gallery/albums/:albumId', async (c) => {
    const gallery = galleryOf(c);
    if (!gallery) return c.json({ error: 'local storage is off' }, 404);
    const albumId = Number(c.req.param('albumId'));
    if (!Number.isSafeInteger(albumId)) return c.json({ error: 'bad album id' }, 400);
    const album = (await gallery.albums({ includeRemoved: true })).find((a) => a.id === albumId);
    if (!album) return c.json({ error: 'no such album' }, 404);
    return c.json({ album, media: await gallery.media(albumId) });
  });

  // The stored original or thumbnail. Looked up by id in the parent's own
  // rows, so a path from the request is never used.
  app.get('/data/gallery/:variant{file|thumb}/:albumId/:mediaId', async (c) => {
    const gallery = galleryOf(c);
    if (!gallery) return c.json({ error: 'local storage is off' }, 404);
    const albumId = Number(c.req.param('albumId'));
    const mediaId = Number(c.req.param('mediaId'));
    if (!Number.isSafeInteger(albumId) || !Number.isSafeInteger(mediaId)) {
      return c.json({ error: 'bad id' }, 400);
    }
    const variant = c.req.param('variant') === 'thumb' ? 'thumb' : 'original';
    const file = await gallery.file(albumId, mediaId, variant);
    if (!file) return c.json({ error: 'not downloaded' }, 404);
    const download = c.req.query('download') === '1';
    return new Response(Readable.toWeb(file.stream) as ReadableStream, {
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.bytes),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });

  // A saved attachment of a post or message, looked up by its index in the
  // parent's own row. Only types a browser shows safely are served inline;
  // everything else is a download, and the sandbox keeps a file from
  // running script on this origin.
  app.get('/data/attachments/:kind{post|message}/:id/:index', async (c) => {
    const gallery = galleryOf(c);
    if (!gallery) return c.json({ error: 'local storage is off' }, 404);
    const kind = c.req.param('kind') === 'post' ? 'post' : 'message';
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) return c.json({ error: 'bad index' }, 400);
    const file = await gallery.attachment(kind, c.req.param('id'), index);
    if (!file) return c.json({ error: 'not saved' }, 404);
    const inline = c.req.query('download') !== '1' && isInline(file.mediaType);
    return new Response(Readable.toWeb(file.stream) as ReadableStream, {
      headers: {
        'content-type': inline ? file.mediaType : 'application/octet-stream',
        'content-length': String(file.bytes),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'sandbox',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });

  // Deletes the local copy of one album or of all of them; sync does not
  // fetch them again. Nothing in Aula.
  app.post('/data/gallery/delete', async (c) => {
    const gallery = galleryOf(c);
    if (!gallery) return c.json({ error: 'local storage is off' }, 404);
    const body = await changeBody(c);
    if (!body) return c.json({ error: 'expected a JSON body' }, 415);
    if (body.confirm !== 'SLET') return c.json({ error: 'confirm must be "SLET"' }, 400);
    if (body.all === true) return c.json({ deleted: await gallery.remove({ all: true }) });
    if (typeof body.albumId !== 'number' || !Number.isSafeInteger(body.albumId)) {
      return c.json({ error: 'give an albumId, or all: true' }, 400);
    }
    return c.json({ deleted: await gallery.remove({ albumId: body.albumId }) });
  });

  async function loginStatus(store: TokenStore) {
    const record = await store.load();
    if (!record) return { logged_in: false as const };
    const now = Math.floor(Date.now() / 1000);
    const { expires_at } = record.tokens;
    // The keep-alive renews once less than DEFAULT_RENEW_WITHIN_SECONDS is
    // left, at its next check (every few minutes).
    const renewsAt = options.autoRenew ? expires_at - DEFAULT_RENEW_WITHIN_SECONDS : null;
    return {
      logged_in: true as const,
      username: record.username,
      identity_name: record.identityName ?? null,
      expires_at,
      seconds_remaining: Math.max(0, expires_at - now),
      saved_at: record.saved_at,
      auto_renew: options.autoRenew === true,
      renews_at: renewsAt,
      seconds_until_renew: renewsAt === null ? null : Math.max(0, renewsAt - now),
    };
  }

  app.post('/login/start', async (c) => {
    let body: { username?: string };
    try {
      body = (await c.req.json()) as { username?: string };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const username = (body.username ?? '').trim();
    if (!username) return c.json({ error: 'username is required' }, 400);

    const sessionId = crypto.randomUUID();
    let signalDone!: () => void;
    const done = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    const onSaved = changedFor(c);
    const audit = auditOf(c);
    const session: LoginSession = {
      sessionId,
      username,
      owner: ownerOf(c),
      store: storeOf(c),
      ...(onSaved ? { onSaved } : {}),
      ...(audit ? { audit } : {}),
      pendingIdentity: null,
      bufferedEvents: [],
      abort: new AbortController(),
      done,
      signalDone,
    };
    loginSessions.set(sessionId, session);

    // Fire the login in the background; the route returns the sessionId
    // immediately so the browser can subscribe to /login/events.
    runLogin(session, logger).catch((err) => {
      logger.error('setup.login.unexpected_error', { error: (err as Error).message });
    });

    return c.json({ sessionId });
  });

  app.get('/login/events', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);
    const session = loginSessions.get(sessionId);
    if (!session || session.owner !== ownerOf(c)) {
      return c.json({ error: 'unknown sessionId' }, 404);
    }

    return streamSSE(c, async (stream) => {
      session.stream = stream;

      // Drain any events buffered before the stream attached.
      for (const ev of session.bufferedEvents) {
        await stream.writeSSE(ev);
      }
      session.bufferedEvents.length = 0;

      // Hold the stream open until either the user disconnects or runLogin
      // finishes. runLogin emits its terminal event via `emit()` (which now
      // writes to this attached stream); we just need to wait for it to
      // signal completion via `session.done`.
      const aborted = new Promise<'aborted'>((resolve) => {
        stream.onAbort(() => {
          session.abort.abort();
          resolve('aborted');
        });
      });
      const finished = session.done.then(() => 'finished' as const);

      await Promise.race([aborted, finished]);
      loginSessions.delete(sessionId);
    });
  });

  app.post('/login/identity', async (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);
    const session = loginSessions.get(sessionId);
    if (!session || session.owner !== ownerOf(c)) {
      return c.json({ error: 'unknown sessionId' }, 404);
    }
    if (!session.pendingIdentity) return c.json({ error: 'no pending identity choice' }, 409);
    let body: { index?: number };
    try {
      body = (await c.req.json()) as { index?: number };
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const index = Number(body.index);
    // MitID identity indices are 1-based — `0` is treated as "no identity
    // selected" by the rest of the auth pipeline, so refuse it explicitly.
    if (!Number.isInteger(index) || index < 1) {
      return c.json({ error: 'index must be a positive integer' }, 400);
    }
    session.pendingIdentity(index);
    session.pendingIdentity = null;
    return c.body(null, 202);
  });

  app.post('/logout', async (c) => {
    await storeOf(c).clear();
    changedFor(c)?.();
    await auditOf(c)?.({ category: 'account', action: 'aula_logout', ok: true });
    return c.json({ ok: true });
  });

  return app;
}

async function runLogin(session: LoginSession, logger: Logger): Promise<void> {
  const started = Date.now();
  const http = new AulaHttpClient({ logger });
  const client = new AulaLoginClient({ http, logger });
  let lastQrCount = -1;
  let identityName: string | undefined;
  let identityIndex: number | undefined;

  const emit = async (event: string, data: unknown): Promise<void> => {
    const payload = { event, data: JSON.stringify(data) };
    if (session.stream && !session.stream.aborted) {
      try {
        await session.stream.writeSSE(payload);
        return;
      } catch (err) {
        logger.error('setup.login.sse_write_error', { error: (err as Error).message });
      }
    }
    session.bufferedEvents.push(payload);
  };

  try {
    const tokens = await client.login({
      username: session.username,
      method: 'APP',
      signal: session.abort.signal,
      selectIdentity: async (options: IdentityOption[]) => {
        await emit('identity', {
          options: options.map((o) => ({ index: o.index, name: o.name })),
        });
        // Wait for the user to POST /login/identity, with two escape hatches:
        // (a) the request abort (browser closes the SSE stream) and
        // (b) a hard timeout so a user who walks away doesn't leak the
        //     session entry forever.
        const choice = await new Promise<number>((resolve, reject) => {
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.abort.signal.removeEventListener('abort', onAbort);
            fn();
          };
          session.pendingIdentity = (idx) => settle(() => resolve(idx));
          const onAbort = (): void => settle(() => reject(new Error('aborted')));
          session.abort.signal.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(
            () => settle(() => reject(new Error('identity selection timed out'))),
            IDENTITY_PICK_TIMEOUT_MS,
          );
        });
        session.pendingIdentity = null;
        identityIndex = choice;
        identityName = options.find((o) => o.index === choice)?.name;
        await emit('identity-selected', { index: choice, name: identityName ?? null });
        return choice;
      },
      appCallbacks: {
        onOtp: async (otp) => {
          await emit('otp', { code: otp });
        },
        onQr: async ({ qr1Json, qr2Json, updateCount }) => {
          if (updateCount === lastQrCount) return;
          lastQrCount = updateCount;
          const [svg1, svg2] = await Promise.all([
            QRCode.toString(qr1Json, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }),
            QRCode.toString(qr2Json, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }),
          ]);
          await emit('qr', { svg1, svg2, refreshCount: updateCount });
        },
        onVerified: async () => {
          await emit('verified', {});
        },
      },
    });

    const now = Math.floor(Date.now() / 1000);
    const record: StoredTokenRecord = {
      version: 1,
      username: session.username,
      tokens,
      saved_at: now,
      ...(identityIndex !== undefined ? { identityIndex } : {}),
      ...(identityName ? { identityName } : {}),
    };
    await session.store.save(record);
    session.onSaved?.();

    const terminal = {
      event: 'success' as const,
      data: JSON.stringify({
        identityName: identityName ?? null,
        expiresInSec: Math.max(0, tokens.expires_at - now),
      }),
    };
    session.terminal = terminal;
    await emit('success', JSON.parse(terminal.data));
    logger.info('setup.login.success', { username: session.username });
    await session.audit?.({
      category: 'account',
      action: 'aula_login',
      ok: true,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    const error = err as Error;
    const terminal = {
      event: 'error' as const,
      data: JSON.stringify({ message: error.message, name: error.name ?? 'Error' }),
    };
    session.terminal = terminal;
    await emit('error', JSON.parse(terminal.data));
    await session.audit?.({
      category: 'account',
      action: 'aula_login',
      ok: false,
      durationMs: Date.now() - started,
      details: { error: error.message.slice(0, 300) },
    });
    logger.error('setup.login.failed', {
      username: session.username,
      name: error.name,
      message: error.message,
    });
  } finally {
    // Always signal — the SSE route handler waits on this to clean up the
    // session entry. Without this, an unexpected throw could leak the entry
    // until process restart.
    session.signalDone();
  }
}

interface StoredItem {
  what: string;
  where: string;
  detail: string;
}

/** Where the parent's data lives on this server, described for the parent. */
function storedItems(
  store: TokenStore,
  loggedIn: boolean,
  multiParent: boolean,
  database: { type: string; location: string; kinds: KindStats[] } | null,
): StoredItem[] {
  const items: StoredItem[] = [];
  if (database) {
    const count = database.kinds.reduce((sum, kind) => sum + kind.count, 0);
    items.push({
      what: 'Dine Aula-data i den lokale database',
      where: `${database.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}: ${database.location}`,
      detail:
        (count === 0
          ? 'Ingen data gemt endnu. '
          : `${count} ting gemt, fordelt på ${database.kinds.length} typer. `) +
        'Indholdet er krypteret med en nøgle, der kun gælder dig, og gemmes, indtil du selv sletter det.',
    });
  }
  const filePath = (store as { filePath?: unknown }).filePath;
  const where =
    typeof filePath === 'string'
      ? `Krypteret fil på serveren: ${filePath} (nøglen ligger ved siden af i .key)`
      : 'macOS-nøgleringen på serveren';
  if (loggedIn) {
    items.push({
      what: 'Dit Aula-login',
      where,
      detail:
        'Adgangsnøgler (OAuth access- og refresh-token) til din Aula-konto, dit MitID-brugernavn ' +
        'og den valgte identitet. Nøglerne vises aldrig her. "Log ud af Aula" sletter dem.',
    });
  }
  items.push({
    what: 'Vedhæftninger du har bedt assistenten åbne',
    where:
      process.env.AULA_MCP_ATTACHMENTS_DIR ??
      'Midlertidig mappe på serveren (aula-attachments i systemets temp-mappe)',
    detail: 'Filer fra beskeder og opslag gemmes her, når assistenten henter dem.',
  });
  items.push({
    what: 'Midlertidig cache',
    where: 'Serverens hukommelse',
    detail:
      'Din profil og dine børns id’er, så de ikke hentes ved hvert kald. Slettes ved genstart.',
  });
  if (multiParent) {
    items.push({
      what: 'Din identitet hos login-udbyderen',
      where: 'Serverens hukommelse (login-session, op til 8 timer)',
      detail: 'Navn og id fra din login-udbyder, så serveren ved, at det er dig.',
    });
  }
  return items;
}

function defaultAddonStore(): TokenStore {
  // Mirror AulaContext's default store path resolution: honour AULA_MCP_DIR
  // when set (the HA addon's run.sh exports it to /config/aula-mcp), and
  // otherwise fall back to ~/.config/aula-mcp so non-addon deployments (dev
  // boxes, VPS) don't try to write into a non-existent /config directory.
  const dir = process.env.AULA_MCP_DIR ?? join(homedir(), '.config', 'aula-mcp');
  return new EncryptedFileTokenStore({
    filePath: join(dir, 'tokens.json'),
    keyFilePath: join(dir, '.key'),
  });
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

function isKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

function isJob(value: unknown): value is SyncJobName {
  return typeof value === 'string' && (SYNC_JOBS as readonly string[]).includes(value);
}

/** undefined when absent, NaN when not an integer. */
function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}
