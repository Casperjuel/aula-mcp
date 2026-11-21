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
import { type Context, Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';
import type { AulaContext } from './aula-context.ts';
import { buildDiscoverManifest } from './discover.ts';
import { detail, searchText, summarize, threadMessage } from './item-view.ts';
import { type Caller, callerId } from './oidc.ts';
import { renderDashboard } from './setup-dashboard.ts';
import type { SetupLogin } from './setup-login.ts';
import {
  ITEM_KINDS,
  type ItemKind,
  type KindStats,
  type ParentStorage,
  type StorageInfo,
} from './storage.ts';
import { type ParentSync, SYNC_JOBS, type SyncJobName } from './sync.ts';
import { DEFAULT_RENEW_WITHIN_SECONDS } from './token-keepalive.ts';
import { type ToolInfo, toolCatalog } from './tool-catalog.ts';
import { toolNameStyle } from './tool-names.ts';

/** Max time we'll hold a login session waiting on the user to pick their
 *  MitID identity after the picker is shown. After this the login rejects
 *  with a timeout so the session entry gets cleaned up instead of leaking. */
const IDENTITY_PICK_TIMEOUT_MS = 5 * 60 * 1000;

/** Most stored items a search reads through before it stops. */
const SEARCH_SCAN_LIMIT = 10_000;

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
  };
  /** Multi-parent mode: the sign-in, and each parent's own token store. */
  parents?: {
    login: SetupLogin;
    storeFor(caller: Caller): TokenStore;
    /** After a parent's tokens were saved or cleared. */
    changed?(caller: Caller): void;
  };
}

interface LoginSession {
  sessionId: string;
  username: string;
  /** callerId of the parent who started it; '' in single-parent mode. */
  owner: string;
  store: TokenStore;
  /** Called after the tokens were saved. */
  onSaved?: () => void;
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

  // --- the dashboard's stored data and sync jobs, all for this parent only ---

  const storageOf = (c: Context): ParentStorage | null =>
    options.myData?.storage?.forParent(parentOf(c)?.caller ?? null) ?? null;
  const syncOf = (c: Context): ParentSync | null =>
    options.myData?.sync?.forParent(parentOf(c)?.caller ?? null) ?? null;
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

  // Newest first, a page at a time. `q` searches the text the parent sees;
  // the stored data is encrypted, so that happens here and not in SQL.
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
    if (!q) {
      const rows = await store.list({ ...query, offset: page.offset, limit: page.limit + 1 });
      return c.json({
        items: rows.slice(0, page.limit).map(summarize),
        ...page,
        more: rows.length > page.limit,
      });
    }
    const matches = [];
    let scanned = 0;
    let skip = page.offset;
    for (;;) {
      const rows = await store.list({ ...query, offset: scanned, limit: 500 });
      scanned += rows.length;
      for (const row of rows) {
        if (!searchText(row).includes(q)) continue;
        if (skip > 0) skip--;
        else matches.push(row);
      }
      const exhausted = rows.length < 500;
      if (matches.length > page.limit || exhausted || scanned >= SEARCH_SCAN_LIMIT) {
        return c.json({
          items: matches.slice(0, page.limit).map(summarize),
          ...page,
          more: matches.length > page.limit,
          ...(!exhausted && matches.length <= page.limit ? { search_truncated: true } : {}),
        });
      }
    }
  });

  app.get('/data/items/:kind/:id', async (c) => {
    const store = storageOf(c);
    if (!store) return c.json({ error: 'local storage is off' }, 404);
    const kind = c.req.param('kind');
    if (!isKind(kind)) return c.json({ error: 'unknown kind' }, 400);
    const item = await store.get(kind, c.req.param('id'));
    if (!item) return c.json({ error: 'not found' }, 404);
    const messages =
      kind === 'message_thread'
        ? (await store.list({ kind: 'message', idPrefix: `${item.id}:`, limit: 500 }))
            .reverse()
            .map(threadMessage)
        : undefined;
    return c.json({ item: detail(item), ...(messages ? { messages } : {}) });
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
    if (body.all === true) return c.json({ deleted: await store.delete() });
    if (typeof body.kind !== 'string' || !isKind(body.kind)) {
      return c.json({ error: 'give a known kind, or all: true' }, 400);
    }
    return c.json({ deleted: await store.delete({ kind: body.kind }) });
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
    const session: LoginSession = {
      sessionId,
      username,
      owner: ownerOf(c),
      store: storeOf(c),
      ...(onSaved ? { onSaved } : {}),
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
    return c.json({ ok: true });
  });

  return app;
}

async function runLogin(session: LoginSession, logger: Logger): Promise<void> {
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
  } catch (err) {
    const error = err as Error;
    const terminal = {
      event: 'error' as const,
      data: JSON.stringify({ message: error.message, name: error.name ?? 'Error' }),
    };
    session.terminal = terminal;
    await emit('error', JSON.parse(terminal.data));
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
