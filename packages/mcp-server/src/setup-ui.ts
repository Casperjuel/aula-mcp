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
import { type Caller, callerId } from './oidc.ts';
import type { SetupLogin } from './setup-login.ts';
import { renderMyDataPage } from './setup-my-data.ts';
import type { KindStats, ParentStorage, StorageInfo } from './storage.ts';
import { DEFAULT_RENEW_WITHIN_SECONDS } from './token-keepalive.ts';
import { type ToolInfo, toolCatalog } from './tool-catalog.ts';
import { toolNameStyle } from './tool-names.ts';

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
  }

  app.get('/', (c) => c.html(renderSetupPage(parentOf(c)?.name)));

  app.get('/status', async (c) => c.json(await loginStatus(storeOf(c))));

  const tools = options.myData?.tools ?? toolCatalog(process.env, toolNameStyle());

  app.get('/data', (c) => c.html(renderMyDataPage(parentOf(c)?.name)));

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

/** `signedInAs` is set in multi-parent mode, for the sign-out bar. */
function renderSetupPage(signedInAs?: string): string {
  const account = signedInAs
    ? `<form class="account" method="post" action="/auth/logout">
    <span>Logget ind som <strong>${escapeHtml(signedInAs)}</strong></span>
    <button type="submit" class="secondary">Log af</button>
  </form>`
    : '';
  // Inline single-page UI. Vanilla JS + EventSource so it works without a
  // build step inside the addon. Styling kept minimal to match HA's frame.
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>aula-mcp — login</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6b7280; --bg: #ffffff; --card: #f7f7f8; --border: #e5e7eb; --accent: #03a9f4; --error: #b00020; --success: #117a3a; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1aa; --bg: #111114; --card: #1c1c1f; --border: #2a2a2e; } }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 2rem 1rem; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
  h1 svg { color: var(--accent); }
  p { color: var(--muted); margin: 0 0 1rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; margin: 1rem 0; }
  .qr-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
  .qr-wrap > div { background: #fff; border-radius: 8px; padding: 0.5rem; display: flex; align-items: center; justify-content: center; }
  .qr-wrap svg { width: 100%; height: auto; max-width: 240px; }
  label { display: block; font-weight: 500; margin-bottom: 0.25rem; }
  input[type=text] { width: 100%; padding: 0.6rem 0.75rem; font-size: 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); }
  button { font: inherit; padding: 0.6rem 1.1rem; border-radius: 8px; border: 0; background: var(--accent); color: #fff; font-weight: 500; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .status-line { display: flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--muted); }
  .dot.ok { background: var(--success); }
  .dot.err { background: var(--error); }
  .stage { font-weight: 500; }
  .stage.error { color: var(--error); }
  .stage.success { color: var(--success); }
  .identity-options button { margin: 0.25rem 0.5rem 0.25rem 0; background: var(--card); color: var(--fg); border: 1px solid var(--border); }
  .muted { color: var(--muted); font-size: 0.85rem; }
  details { margin-top: 1rem; }
  summary { cursor: pointer; color: var(--muted); }
  .account { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; color: var(--muted); }
  code { background: var(--card); border: 1px solid var(--border); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
</style>
</head>
<body>
<main>
  <h1>${ICON_SVG} aula-mcp</h1>
  ${account}
  <p>Log ind med MitID, så HA's Assist + Voice kan tale med Aula.</p>
  <p><a href="data">Mine data og værktøjer →</a></p>

  <div class="card" id="status-card">
    <div class="status-line">
      <span class="dot" id="status-dot"></span>
      <span id="status-text">Indlæser status…</span>
    </div>
    <div id="status-detail" class="muted" style="margin-top: 0.5rem;"></div>
    <div class="row" id="status-actions" style="margin-top: 0.75rem;"></div>
  </div>

  <div class="card" id="login-card" hidden>
    <label for="username">MitID-brugernavn</label>
    <input type="text" id="username" placeholder="dit MitID-username" autocomplete="username" />
    <div class="row" style="margin-top: 0.75rem;">
      <button id="start-btn">Start login</button>
      <span class="muted">Du scanner QR-koden med MitID-appen.</span>
    </div>
  </div>

  <div class="card" id="progress-card" hidden>
    <div class="status-line">
      <span class="dot" id="progress-dot"></span>
      <span class="stage" id="stage">Starter…</span>
    </div>
    <div id="progress-detail" class="muted" style="margin-top: 0.5rem;"></div>
    <div class="qr-wrap" id="qr-wrap" hidden></div>
    <div id="identity-choice" hidden style="margin-top: 1rem;">
      <p style="margin: 0 0 0.5rem;">Du har flere identiteter — vælg den der hører til Aula:</p>
      <div class="identity-options" id="identity-options"></div>
    </div>
  </div>

  <details>
    <summary>Hvad sker der her?</summary>
    <p class="muted">Login-flow'et kører lokalt i din HA-installation. MitID-godkendelsen sker mellem MitID-appen og <code>nemlog-in.mitid.dk</code> — denne side ser kun de OAuth-tokens du får tilbage, og gemmer dem krypteret i <code>/config/aula-mcp/</code>. Tokens forlader ikke din HA.</p>
  </details>
</main>

<script>
const $ = (id) => document.getElementById(id);
const statusDot = $('status-dot');
const statusText = $('status-text');
const statusDetail = $('status-detail');
const statusActions = $('status-actions');
const loginCard = $('login-card');
const progressCard = $('progress-card');
const progressDot = $('progress-dot');
const stage = $('stage');
const progressDetail = $('progress-detail');
const qrWrap = $('qr-wrap');
const identityChoice = $('identity-choice');
const identityOptions = $('identity-options');
const startBtn = $('start-btn');
const usernameInput = $('username');

let currentSessionId = null;
let currentSource = null;

async function refreshStatus() {
  const res = await fetch('status');
  const data = await res.json();
  if (data.logged_in) {
    statusDot.classList.add('ok');
    statusDot.classList.remove('err');
    statusText.textContent = 'Logget ind';
    const expiresMin = Math.round(data.seconds_remaining / 60);
    let renewal;
    if (data.auto_renew) {
      const renewMin = Math.round(data.seconds_until_renew / 60);
      renewal = 'Automatisk fornyelse er slået til. ' + (renewMin > 0
        ? 'Næste fornyelse om ca. ' + renewMin + ' min.'
        : 'Fornyes inden for få minutter.');
    } else {
      renewal = 'Automatisk fornyelse er slået fra: access token udløber om ' + expiresMin +
        ' min. og fornyes først ved næste brug.';
    }
    statusDetail.textContent = (data.identity_name ? data.identity_name + ' — ' : '') +
      (data.username) + '. ' + renewal;
    statusActions.innerHTML = '';
    const logoutBtn = document.createElement('button');
    logoutBtn.textContent = 'Log ud';
    logoutBtn.className = 'secondary';
    logoutBtn.onclick = async () => {
      await fetch('logout', { method: 'POST' });
      await refreshStatus();
    };
    statusActions.appendChild(logoutBtn);
    loginCard.hidden = true;
  } else {
    statusDot.classList.remove('ok', 'err');
    statusText.textContent = 'Ikke logget ind';
    statusDetail.textContent = 'Klik nedenfor for at starte MitID-login.';
    statusActions.innerHTML = '';
    loginCard.hidden = false;
  }
}

function setStage(text, kind = '') {
  stage.textContent = text;
  stage.classList.remove('error', 'success');
  if (kind) stage.classList.add(kind);
  progressDot.classList.remove('ok', 'err');
  if (kind === 'success') progressDot.classList.add('ok');
  if (kind === 'error') progressDot.classList.add('err');
}

function showQR(svg1, svg2, refresh) {
  qrWrap.hidden = false;
  qrWrap.innerHTML = '<div>' + svg1 + '</div><div>' + svg2 + '</div>';
  progressDetail.textContent = 'Scan en af QR-koderne med MitID-appen (skifter automatisk).';
}

function showIdentityChoice(options) {
  identityChoice.hidden = false;
  identityOptions.innerHTML = '';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.textContent = opt.name;
    btn.onclick = async () => {
      identityOptions.innerHTML = '<span class="muted">Vælger ' + opt.name + '…</span>';
      await fetch('login/identity?sessionId=' + encodeURIComponent(currentSessionId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: opt.index }),
      });
    };
    identityOptions.appendChild(btn);
  }
}

startBtn.onclick = async () => {
  const username = usernameInput.value.trim();
  if (!username) {
    usernameInput.focus();
    return;
  }
  startBtn.disabled = true;
  loginCard.hidden = true;
  progressCard.hidden = false;
  qrWrap.hidden = true;
  identityChoice.hidden = true;
  setStage('Starter login…');
  progressDetail.textContent = '';

  const res = await fetch('login/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    setStage('Kunne ikke starte login', 'error');
    progressDetail.textContent = 'HTTP ' + res.status + ' — tjek log.';
    startBtn.disabled = false;
    return;
  }
  const { sessionId } = await res.json();
  currentSessionId = sessionId;

  currentSource = new EventSource('login/events?sessionId=' + encodeURIComponent(sessionId));

  currentSource.addEventListener('qr', (ev) => {
    setStage('Venter på MitID');
    const data = JSON.parse(ev.data);
    showQR(data.svg1, data.svg2, data.refreshCount);
  });
  currentSource.addEventListener('otp', (ev) => {
    const data = JSON.parse(ev.data);
    setStage('Indtast OTP i MitID-appen');
    progressDetail.textContent = 'Kode: ' + data.code;
  });
  currentSource.addEventListener('verified', () => {
    setStage('Bekræft i MitID-appen');
    progressDetail.textContent = 'Godkend login i MitID-appen.';
  });
  currentSource.addEventListener('identity', (ev) => {
    setStage('Vælg identitet');
    const data = JSON.parse(ev.data);
    showIdentityChoice(data.options);
  });
  currentSource.addEventListener('identity-selected', () => {
    identityChoice.hidden = true;
    setStage('Fortsætter…');
  });
  currentSource.addEventListener('success', async (ev) => {
    setStage('Logget ind 🎉', 'success');
    const data = JSON.parse(ev.data);
    progressDetail.textContent = 'Tokens gemt. ' +
      (data.identityName ? 'Identitet: ' + data.identityName + '. ' : '');
    currentSource.close();
    startBtn.disabled = false;
    await refreshStatus();
  });
  currentSource.addEventListener('error', (ev) => {
    if (!ev.data) return;
    setStage('Login fejlede', 'error');
    try {
      const data = JSON.parse(ev.data);
      progressDetail.textContent = data.message || 'Ukendt fejl.';
    } catch {
      progressDetail.textContent = 'Forbindelsen blev afbrudt.';
    }
    currentSource.close();
    startBtn.disabled = false;
  });
};

refreshStatus();
</script>
</body>
</html>`;
}
