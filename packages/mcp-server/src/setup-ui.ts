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
import { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import QRCode from 'qrcode';

/** Max time we'll hold a login session waiting on the user to pick their
 *  MitID identity after the picker is shown. After this the login rejects
 *  with a timeout so the session entry gets cleaned up instead of leaking. */
const IDENTITY_PICK_TIMEOUT_MS = 5 * 60 * 1000;

export interface SetupAppOptions {
  logger?: Logger;
  /** Override the token store (tests). Production uses the addon's
   *  EncryptedFileTokenStore under `AULA_MCP_DIR`. */
  store?: TokenStore;
}

interface LoginSession {
  sessionId: string;
  username: string;
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

const ICON_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 3 1 9l11 6 9-4.91V17h2V9z"/></svg>`;

export function createSetupApp(options: SetupAppOptions = {}): Hono {
  const logger = options.logger ?? silentLogger;
  const store = options.store ?? defaultAddonStore();
  const loginSessions = new Map<string, LoginSession>();

  const app = new Hono();

  app.get('/', (c) => c.html(renderSetupPage()));

  app.get('/status', async (c) => {
    const record = await store.load();
    if (!record) return c.json({ logged_in: false });
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      logged_in: true,
      username: record.username,
      identity_name: record.identityName ?? null,
      expires_at: record.tokens.expires_at,
      seconds_remaining: Math.max(0, record.tokens.expires_at - now),
      saved_at: record.saved_at,
    });
  });

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
    const session: LoginSession = {
      sessionId,
      username,
      pendingIdentity: null,
      bufferedEvents: [],
      abort: new AbortController(),
      done,
      signalDone,
    };
    loginSessions.set(sessionId, session);

    // Fire the login in the background; the route returns the sessionId
    // immediately so the browser can subscribe to /login/events.
    runLogin(session, store, logger).catch((err) => {
      logger.error('setup.login.unexpected_error', { error: (err as Error).message });
    });

    return c.json({ sessionId });
  });

  app.get('/login/events', (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);
    const session = loginSessions.get(sessionId);
    if (!session) return c.json({ error: 'unknown sessionId' }, 404);

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
    if (!session) return c.json({ error: 'unknown sessionId' }, 404);
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
    await store.clear();
    return c.json({ ok: true });
  });

  return app;
}

async function runLogin(session: LoginSession, store: TokenStore, logger: Logger): Promise<void> {
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
    await store.save(record);

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

function renderSetupPage(): string {
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
  code { background: var(--card); border: 1px solid var(--border); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
</style>
</head>
<body>
<main>
  <h1>${ICON_SVG} aula-mcp</h1>
  <p>Log ind med MitID, så HA's Assist + Voice kan tale med Aula.</p>

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
    statusDetail.textContent = (data.identity_name ? data.identity_name + ' — ' : '') +
      (data.username) + '. Access token udløber om ' + expiresMin + ' min.';
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
      (data.identityName ? 'Identitet: ' + data.identityName + '. ' : '') +
      'Access udløber om ' + Math.round((data.expiresInSec || 0) / 60) + ' min.';
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
