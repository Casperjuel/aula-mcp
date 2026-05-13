/**
 * Hono + MCP Streamable HTTP server. Runs on Bun.
 *
 * Routes:
 *   POST /mcp             — MCP JSON-RPC requests (Streamable HTTP transport)
 *   GET  /mcp             — Streamable HTTP SSE channel
 *   DELETE /mcp           — session close
 *   GET  /sse             — Legacy MCP SSE transport (Home Assistant's MCP
 *                           client integration speaks this dialect)
 *   POST /messages        — Client→server channel for the /sse session,
 *                           selected by ?sessionId=… query param
 *   GET  /healthz         — liveness probe
 *
 * For stdio transport (e.g. spawn-by-agent-runtime use cases like Claude
 * Desktop, Cursor, Cline), see `server-stdio.ts` — same tool surface,
 * different transport.
 *
 * Env:
 *   AULA_MCP_PORT             — port to bind for MCP traffic (default 7878)
 *   AULA_MCP_HOST             — interface to bind (default 127.0.0.1)
 *   AULA_MCP_DIR              — config dir (default ~/.config/aula-mcp)
 *   AULA_MCP_KEY              — encryption key for the token store
 *   AULA_MCP_RAW=1            — enable the aula.raw_request escape hatch
 *   AULA_MCP_LOG=1            — verbose console logs from auth/client layers
 *   AULA_MCP_ALLOW_REMOTE=1   — allow binding to non-loopback addresses (refuses
 *                               by default; the server is single-user and any
 *                               peer with /mcp access can drive your tokens)
 *   AULA_MCP_SSE_MAX_SESSIONS — max concurrent legacy /sse sessions before new
 *                               GET /sse requests get 503'd (default 16)
 *   AULA_MCP_SSE_IDLE_MS      — evict /sse sessions idle for >this many ms
 *                               (default 300_000 = 5 min)
 *   AULA_MCP_INGRESS_PORT     — if set, also boots the in-addon setup/login UI
 *                               on this port (bound to 0.0.0.0 for HA Ingress).
 *                               Default unset; the HA addon sets it to 8099.
 */

import { consoleLogger, silentLogger } from '@aula-mcp/aula-auth';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createMcpApp, type McpApp } from './setup.ts';
import { createSetupApp } from './setup-ui.ts';
import { HonoSseTransport } from './sse-transport.ts';

const PORT = Number(process.env.AULA_MCP_PORT ?? 7878);
const HOST = process.env.AULA_MCP_HOST ?? '127.0.0.1';

const logger = process.env.AULA_MCP_LOG === '1' ? consoleLogger('aula-mcp') : silentLogger;

assertSafeBindAddress(HOST);

const { mcp } = createMcpApp({ logger });

// Streamable HTTP transport. Stateful mode — the SDK explicitly forbids
// reusing a *stateless* transport across requests
// ("Stateless transport cannot be reused across requests"), so we provide a
// session-id generator and let the transport track per-session state. For
// single-user use this is a single session that gets created on the first
// request and reused thereafter.
const transport = new WebStandardStreamableHTTPServerTransport({
  enableJsonResponse: true,
  sessionIdGenerator: () => crypto.randomUUID(),
});

await mcp.connect(transport);

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, name: 'aula-mcp' }));

const handleMcp = async (request: Request): Promise<Response> => transport.handleRequest(request);
app.post('/mcp', (c) => handleMcp(c.req.raw));
app.get('/mcp', (c) => handleMcp(c.req.raw));
app.delete('/mcp', (c) => handleMcp(c.req.raw));

// Legacy MCP SSE transport — for clients that haven't moved to Streamable HTTP
// yet, notably Home Assistant's official `mcp` (client) integration. Each
// GET /sse opens a fresh session: own McpServer instance, own AulaContext,
// own sessionId. POSTs to /messages?sessionId=… get routed back to the
// matching session's transport.
//
// The session map is capped + idle-evicted. The MCP server defaults to
// loopback, but the HA addon exposes it on the LAN, so an unbounded map is
// a footgun — a crashed/looping client could pile up sessions indefinitely.
interface SseSession {
  transport: HonoSseTransport;
  app: McpApp;
  lastActivityAt: number;
}
const SSE_MAX_SESSIONS = Math.max(1, Number(process.env.AULA_MCP_SSE_MAX_SESSIONS ?? 16));
const SSE_IDLE_MS = Math.max(1_000, Number(process.env.AULA_MCP_SSE_IDLE_MS ?? 300_000));
const SSE_SWEEP_INTERVAL_MS = Math.max(1_000, Math.floor(SSE_IDLE_MS / 4));
const sseSessions = new Map<string, SseSession>();

async function closeSseSession(sessionId: string, reason: string): Promise<void> {
  const session = sseSessions.get(sessionId);
  if (!session) return;
  sseSessions.delete(sessionId);
  try {
    await session.transport.close();
  } catch (err) {
    logger.error('aula-mcp.sse.transport_close_error', {
      sessionId,
      reason,
      error: (err as Error).message,
    });
  }
  try {
    await session.app.mcp.close();
  } catch (err) {
    logger.error('aula-mcp.sse.mcp_close_error', {
      sessionId,
      reason,
      error: (err as Error).message,
    });
  }
}

// Single sweeper, started once at boot. `unref()` so the interval doesn't
// keep the process alive on its own — the shutdown handler clears it
// explicitly anyway, but unref() is belt-and-braces in case of a bug.
const sseSweeper: ReturnType<typeof setInterval> = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sseSessions) {
    if (now - session.lastActivityAt > SSE_IDLE_MS) {
      logger.info('aula-mcp.sse.session_evicted_idle', {
        sessionId,
        idleMs: now - session.lastActivityAt,
      });
      void closeSseSession(sessionId, 'idle');
    }
  }
}, SSE_SWEEP_INTERVAL_MS);
sseSweeper.unref?.();

app.get('/sse', (c) => {
  if (sseSessions.size >= SSE_MAX_SESSIONS) {
    logger.error('aula-mcp.sse.session_rejected_cap', {
      active: sseSessions.size,
      cap: SSE_MAX_SESSIONS,
    });
    return c.json(
      {
        error: 'sse session cap reached',
        active: sseSessions.size,
        cap: SSE_MAX_SESSIONS,
      },
      503,
    );
  }
  return streamSSE(c, async (stream) => {
    const sessionId = crypto.randomUUID();
    const sseTransport = new HonoSseTransport({
      sessionId,
      messageEndpoint: '/messages',
      stream,
      onActivity: () => {
        const s = sseSessions.get(sessionId);
        if (s) s.lastActivityAt = Date.now();
      },
    });
    // McpServer.connect() binds a single transport, so we instantiate a
    // fresh server per SSE connection. AulaContext is cheap to construct
    // — it just lazily wraps the shared token store on first call.
    const sessionApp = createMcpApp({ logger });
    sseSessions.set(sessionId, {
      transport: sseTransport,
      app: sessionApp,
      lastActivityAt: Date.now(),
    });

    const closed = new Promise<void>((resolve) => {
      stream.onAbort(async () => {
        await closeSseSession(sessionId, 'abort');
        resolve();
      });
    });

    try {
      // mcp.connect() calls transport.start(), which writes the spec-required
      // first event (`endpoint`) telling the client where to POST.
      await sessionApp.mcp.connect(sseTransport);
      logger.info('aula-mcp.sse.session_opened', { sessionId });
    } catch (err) {
      logger.error('aula-mcp.sse.connect_failed', {
        sessionId,
        error: (err as Error).message,
      });
      await closeSseSession(sessionId, 'connect_failed');
      return;
    }

    // Hold the SSE stream open until the client disconnects.
    await closed;
    logger.info('aula-mcp.sse.session_closed', { sessionId });
  });
});

app.post('/messages', async (c) => {
  const sessionId = c.req.query('sessionId');
  if (!sessionId) return c.json({ error: 'missing sessionId query parameter' }, 400);
  const session = sseSessions.get(sessionId);
  if (!session) return c.json({ error: 'unknown sessionId' }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  session.lastActivityAt = Date.now();
  session.transport.receive(body);
  // The actual JSON-RPC response is delivered over the SSE channel; the POST
  // is just an inbound carrier, so 202 Accepted is the spec-correct ack.
  return c.body(null, 202);
});

logger.info('aula-mcp.listening', { host: HOST, port: PORT });
process.stdout.write(`aula-mcp listening on http://${HOST}:${PORT}/mcp (healthz at /healthz)\n`);

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // MCP's Streamable HTTP transport holds the GET /mcp connection open for
  // SSE; Bun's default 10 s idleTimeout closes it mid-session and prints
  // "request timed out after 10 seconds." Bump to 4 min — long enough for
  // typical client poll cadences, short enough to clean up dead peers.
  idleTimeout: 240,
  fetch: app.fetch,
});

// Optional in-addon setup/login UI. The HA addon sets AULA_MCP_INGRESS_PORT
// to 8099; HA Supervisor proxies its Ingress traffic to that port, giving
// users a one-click login flow inside HA's sidebar. Skipped when unset so
// non-addon deployments (CLI workstation, VPS) don't open an extra port.
let setupServer: ReturnType<typeof Bun.serve> | null = null;
const INGRESS_PORT_RAW = process.env.AULA_MCP_INGRESS_PORT;
if (INGRESS_PORT_RAW) {
  const ingressPort = Number(INGRESS_PORT_RAW);
  if (!Number.isInteger(ingressPort) || ingressPort <= 0) {
    process.stderr.write(`AULA_MCP_INGRESS_PORT="${INGRESS_PORT_RAW}" is not a valid port.\n`);
    process.exit(2);
  }
  const setupApp = createSetupApp({ logger });
  setupServer = Bun.serve({
    port: ingressPort,
    // HA Ingress proxies from the Supervisor host *to* this port, so bind on
    // all interfaces — the addon container's network namespace already isolates
    // the port from the LAN unless config.yaml exposes it via `ports:`.
    hostname: '0.0.0.0',
    fetch: setupApp.fetch,
  });
  logger.info('aula-mcp.setup_ui.listening', { port: ingressPort });
  process.stdout.write(
    `aula-mcp setup UI listening on http://0.0.0.0:${ingressPort}/ (HA Ingress)\n`,
  );
}

// Graceful shutdown — finish in-flight requests before exiting.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${signal} received — shutting down gracefully…\n`);
  // Stop the idle sweeper first so it can't fire mid-shutdown and race with
  // session cleanup; this also lets the event loop drain if anything still
  // refs the interval.
  clearInterval(sseSweeper);
  try {
    await Promise.all(
      Array.from(sseSessions.keys()).map((sid) => closeSseSession(sid, 'shutdown')),
    );
    await server.stop();
    if (setupServer) await setupServer.stop();
    await mcp.close();
  } catch (err) {
    logger.error('aula-mcp.shutdown_error', { error: (err as Error).message });
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Refuse to bind to a non-loopback address unless the operator opts in
 * explicitly. The MCP server is single-user; anyone who can hit `/mcp`
 * effectively *is* the logged-in user. Set AULA_MCP_ALLOW_REMOTE=1 if you
 * understand the implications (e.g. fronted by an authenticated reverse
 * proxy).
 */
function assertSafeBindAddress(host: string): void {
  if (process.env.AULA_MCP_ALLOW_REMOTE === '1') return;
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  if (loopback) return;
  process.stderr.write(
    `Refusing to bind to non-loopback address (${host}). The MCP server is\n` +
      'single-user and exposes your Aula tokens to anyone who can reach /mcp.\n' +
      'If you front it with an authenticated reverse proxy and accept the risk,\n' +
      'set AULA_MCP_ALLOW_REMOTE=1.\n',
  );
  process.exit(2);
}
