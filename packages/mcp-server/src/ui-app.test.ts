/**
 * The dashboard server in front of the API: it signs parents in, serves the
 * page, and forwards the page's calls with the parent's token and the UI key,
 * passing on nothing else of the browser's.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@aula-mcp/aula-auth';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { SetupLogin } from './setup-login.ts';
import { createUiApp } from './ui-app.ts';

const UI_KEY = 'u'.repeat(40);
const ORIGIN = 'https://aula.example.com';

interface Seen {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}
let seen: Seen[] = [];
let api: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      if (url.pathname.endsWith('.ics')) {
        return new Response('BEGIN:VCALENDAR', {
          headers: { 'content-type': 'text/calendar', 'set-cookie': 'x=1' },
        });
      }
      return Response.json({ ok: true }, { headers: { 'x-internal': 'secret' } });
    },
  });
});
afterAll(() => api.stop(true));

/** Signed in as `parent` with cookie `s=1`; `token` is what accessToken gives. */
function make(token: string | null = 'tok') {
  const login: SetupLogin = {
    mount: (app) => app.get('/auth/login', (c) => c.text('sign in')),
    parent: (c: Context) =>
      getCookie(c, 's') === '1'
        ? { caller: { issuer: 'https://id', sub: 'a' }, name: 'Parent A' }
        : null,
    sameOrigin: (c: Context) => c.req.header('origin') === ORIGIN,
    accessToken: async () => token,
  };
  seen = [];
  return createUiApp({
    logger: silentLogger,
    login,
    apiUrl: `http://127.0.0.1:${api.port}/`,
    uiKey: UI_KEY,
  });
}
const signedIn = { cookie: 's=1' };

describe('dashboard server', () => {
  test('sends a signed-out browser to sign in, and answers calls with 401', async () => {
    const app = make();
    const page = await app.request('/kalender');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/login?next=%2Fkalender');
    const data = await app.request('/data/summary');
    expect(data.status).toBe(401);
    expect(await data.json()).toEqual({ error: 'not signed in' });
    expect(seen).toEqual([]);
  });

  test('serves the page with the parent shown', async () => {
    const res = await make().request('/galleri/12', { headers: signedIn });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<base href="../">');
    expect(html).toContain('Parent A');
  });

  test("forwards reads with the parent's token and the UI key, nothing else", async () => {
    const res = await make().request('/data/items?kind=post&owner=b', {
      headers: { ...signedIn, accept: 'application/json', 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-internal')).toBeNull();
    const [call] = seen;
    expect(call?.path).toBe('/api/v1/items');
    expect(call?.search).toBe('?kind=post&owner=b');
    expect(call?.headers.authorization).toBe('Bearer tok');
    expect(call?.headers['x-aula-ui-key']).toBe(UI_KEY);
    expect(call?.headers.cookie).toBeUndefined();
    expect(call?.headers['x-forwarded-for']).toBeUndefined();
  });

  test('forwards changes from its own pages only', async () => {
    const app = make();
    const post = (origin: string) =>
      app.request('/data/messages/7/read', {
        method: 'POST',
        headers: { ...signedIn, origin, 'content-type': 'application/json' },
        body: '{}',
      });
    expect((await post('https://evil.example.com')).status).toBe(403);
    expect(seen).toEqual([]);
    expect((await post(ORIGIN)).status).toBe(200);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/messages/7/read',
      body: '{}',
    });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });

  test('maps the Aula login routes', async () => {
    const app = make();
    await app.request('/status', { headers: signedIn });
    await app.request('/login/events?sessionId=x', { headers: signedIn });
    expect(seen.map((s) => s.path + s.search)).toEqual([
      '/api/v1/aula/status',
      '/api/v1/aula/login/events?sessionId=x',
    ]);
  });

  test('a sign-in whose token cannot be renewed must sign in again', async () => {
    const res = await make(null).request('/data/summary', { headers: signedIn });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not signed in' });
    expect(seen).toEqual([]);
  });

  test('the calendar feed needs no sign-in and gets no token', async () => {
    const res = await make().request('/feed/abc/calendar.ics?skema=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(seen[0]?.path).toBe('/api/v1/feed/abc/calendar.ics');
    expect(seen[0]?.search).toBe('?skema=1');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers['x-aula-ui-key']).toBe(UI_KEY);
  });

  test('other paths are not forwarded', async () => {
    const res = await make().request('/api/v1/summary', { headers: signedIn });
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  test('an unreachable API is a 502', async () => {
    const app = createUiApp({
      logger: silentLogger,
      login: {
        mount: () => {},
        parent: () => ({ caller: { issuer: 'https://id', sub: 'a' }, name: 'A' }),
        sameOrigin: () => true,
        accessToken: async () => 'tok',
      },
      apiUrl: 'http://127.0.0.1:1',
      uiKey: UI_KEY,
    });
    expect((await app.request('/data/summary')).status).toBe(502);
  });
});
