/**
 * The dashboard as its own server, in front of the API (api.ts). It holds no
 * Aula session and no stored data: it serves the page, signs each parent in
 * with the identity provider (setup-login.ts, keeping their tokens on this
 * server only) and forwards the page's calls to the API with the parent's
 * access token and the UI key. The browser only ever holds a session cookie.
 *
 * The page is the same as the in-process dashboard's, and calls the same
 * paths; api-routes.ts maps them onto the API. Changes still need the
 * parent's confirmation in the page and a same-origin request, checked here;
 * the API checks the token, its write scope, and audits.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { isRead, toApiPath } from './api-routes.ts';
import { DASHBOARD_ROUTES, isDashboardPath, renderDashboard } from './setup-dashboard.ts';
import type { SetupLogin } from './setup-login.ts';
import { injectTraceContext } from './telemetry.ts';

/** Must match api.ts; kept here so the dashboard server does not load the API. */
const UI_KEY_HEADER = 'x-aula-ui-key';

/** Request headers passed on to the API. Nothing else of the browser's. */
const REQUEST_HEADERS = ['accept', 'content-type', 'last-event-id', 'range', 'if-none-match'];
/** Response headers passed back to the browser. */
const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'referrer-policy',
  'x-robots-tag',
  'x-content-type-options',
  'content-security-policy',
];

export interface UiAppOptions {
  logger: Logger;
  /** The sign-in; must keep tokens (`forwardTokens`). */
  login: SetupLogin;
  /** Where the API is, e.g. http://aula-mcp-api:8080. */
  apiUrl: string;
  /** Proves to the API that a call comes from this server. */
  uiKey: string;
  middleware?: MiddlewareHandler;
  fetch?: typeof fetch;
}

export function createUiApp(options: UiAppOptions): Hono {
  const { login, logger, uiKey } = options;
  const accessToken = login.accessToken;
  if (!accessToken) throw new Error('The dashboard server needs a sign-in that keeps tokens.');
  const fetchImpl = options.fetch ?? fetch;
  const apiUrl = options.apiUrl.replace(/\/+$/, '');

  const app = new Hono();
  if (options.middleware) app.use(options.middleware);
  app.get('/healthz', (c) => c.json({ ok: true }));

  /** The same call to the API, as `token`'s parent (none for the feed). */
  const forward = async (c: Context, token: string | null): Promise<Response> => {
    const path = toApiPath(c.req.path);
    if (!path) return c.json({ error: 'not found' }, 404);
    const headers = new Headers({ [UI_KEY_HEADER]: uiKey });
    for (const name of REQUEST_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    if (token) headers.set('authorization', `Bearer ${token}`);
    injectTraceContext(headers);
    const target = `${apiUrl}${path}${new URL(c.req.url).search}`;
    const read = isRead(c.req.method);
    const send = () =>
      fetchImpl(target, {
        method: c.req.method,
        headers,
        ...(read ? {} : { body: c.req.raw.body, duplex: 'half' }),
        signal: c.req.raw.signal,
        redirect: 'manual',
      } as RequestInit);
    let res: Response;
    try {
      res = await send().catch((err) => {
        // A kept-alive connection the API closed meanwhile fails the first
        // try. A read is safe to send again; a change might have arrived.
        if (!read || c.req.raw.signal.aborted) throw err;
        return send();
      });
    } catch (err) {
      logger.error('aula-mcp.ui.api_unreachable', { error: (err as Error).message });
      return c.json({ error: 'the API cannot be reached right now' }, 502);
    }
    const out = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = res.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };

  // A calendar app cannot sign in; the feed answers to its secret link alone.
  app.get('/feed/:token/calendar.ics', (c) => forward(c, null));

  login.mount(app);
  app.use('*', async (c, next) => {
    if (!login.parent(c)) {
      if (c.req.method === 'GET' && isDashboardPath(c.req.path)) {
        const next = c.req.path === '/' ? '' : `?next=${encodeURIComponent(c.req.path)}`;
        return c.redirect(`/auth/login${next}`, 302);
      }
      return c.json({ error: 'not signed in' }, 401);
    }
    if (!isRead(c.req.method) && !login.sameOrigin(c)) {
      return c.json({ error: 'cross-origin request refused' }, 403);
    }
    await next();
  });

  for (const route of DASHBOARD_ROUTES) {
    app.get(route, (c) => c.html(renderDashboard(login.parent(c)?.name, c.req.path)));
  }

  const toApi = async (c: Context) => {
    const token = await accessToken(c);
    if (!token) return c.json({ error: 'not signed in' }, 401);
    return forward(c, token);
  };
  app.all('/data/*', toApi);
  app.all('/status', toApi);
  app.all('/login/*', toApi);
  app.all('/logout', toApi);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
