/**
 * The API: bearer tokens for the API's audience, the write scope for
 * changes, each parent's own data only, the UI-only routes behind the UI key,
 * and the mapping between API and dashboard paths.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { type StoredTokenRecord, silentLogger, type TokenStore } from '@aula-mcp/aula-auth';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { createApiApp, UI_KEY_HEADER } from './api.ts';
import { API_ROUTES, fromApiPath, isUiOnly, toApiPath } from './api-routes.ts';
import { type Caller, callerId, createTokenVerifier } from './oidc.ts';
import { createStorage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

const ISSUER = 'https://id.example.com/realms/home';
const AUDIENCE = 'aula-mcp-api';
const UI_KEY = 'k'.repeat(40);

let signingKey: CryptoKey;
let publicJwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
});

const token = (sub: string, claims: Record<string, unknown> = {}) =>
  new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);

class MemoryStore implements TokenStore {
  record: StoredTokenRecord | null = { username: 'x' } as StoredTokenRecord;
  async load() {
    return this.record;
  }
  async save(record: StoredTokenRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}

async function setup() {
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 7), {
    type: 'sqlite',
    location: 'test',
  });
  const idOf = (caller: Caller | null) => (caller ? callerId(caller) : 'nobody');
  const a = { issuer: ISSUER, sub: 'parent-a' };
  await storage.forParent(idOf(a)).put([
    { kind: 'post', id: '1', data: 'a' },
    { kind: 'post', id: '2', data: 'b' },
  ]);
  await storage
    .forParent(idOf({ issuer: ISSUER, sub: 'parent-b' }))
    .put([{ kind: 'post', id: '9', data: 'z' }]);
  const stores = new Map<string, MemoryStore>();
  const storeFor = (caller: Caller) => {
    const id = callerId(caller);
    if (!stores.has(id)) stores.set(id, new MemoryStore());
    return stores.get(id) as MemoryStore;
  };
  const app = createApiApp({
    logger: silentLogger,
    verify: createTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      acceptIdTokens: false,
      keys: createLocalJWKSet({ keys: [publicJwk] }),
    }),
    writeScope: 'aula:write',
    uiKey: UI_KEY,
    version: '1.2.3',
    setup: {
      parents: { storeFor },
      myData: {
        contextFor: () => {
          throw new Error('no Aula in this test');
        },
        storage: { info: storage.info, forParent: (caller) => storage.forParent(idOf(caller)) },
        feeds: {
          tokens: storage.feeds,
          parentIdOf: idOf,
          storageFor: (id) => storage.forParent(id),
          publicUrl: 'https://aula.example.com',
        },
        sharing: { shares: storage.shares, open: async () => null },
      },
    },
  });
  const call = async (
    path: string,
    init: { method?: string; auth?: string; ui?: boolean; key?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (init.auth) headers.authorization = `Bearer ${init.auth}`;
    if (init.ui || init.key) headers[UI_KEY_HEADER] = init.key ?? UI_KEY;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return app.request(path, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  };
  return { call, storage, stores, idOf, a };
}

describe('API paths', () => {
  test('map onto the dashboard paths and back', () => {
    for (const [ui, api] of [
      ['/data/summary', '/api/v1/summary'],
      ['/data/messages/5/read', '/api/v1/messages/5/read'],
      ['/status', '/api/v1/aula/status'],
      ['/login/start', '/api/v1/aula/login/start'],
      ['/logout', '/api/v1/aula/logout'],
      ['/feed/abc/calendar.ics', '/api/v1/feed/abc/calendar.ics'],
    ] as const) {
      expect(toApiPath(ui)).toBe(api);
      expect(fromApiPath(api)).toBe(ui);
    }
    expect(toApiPath('/auth/login')).toBeNull();
    expect(toApiPath('/kalender')).toBeNull();
    expect(fromApiPath('/api/v1/aula/other')).toBeNull();
    expect(fromApiPath('/api/v2/summary')).toBeNull();
  });

  test('the OpenAPI routes are all API routes and none is UI-only', () => {
    for (const route of API_ROUTES) {
      const path = fromApiPath(`/api/v1${route.path.replace(/\{[a-zA-Z]+\}/g, 'x')}`);
      expect(path).not.toBeNull();
      expect(isUiOnly(path as string)).toBe(false);
    }
    expect(isUiOnly('/data/shares')).toBe(true);
    expect(isUiOnly('/data/calendar-feed/remove')).toBe(true);
    expect(isUiOnly('/feed/abc/calendar.ics')).toBe(true);
    expect(isUiOnly('/data/sharesx')).toBe(false);
  });
});

describe('API', () => {
  test('publishes its OpenAPI document without a token, without the UI-only routes', async () => {
    const { call } = await setup();
    const res = await call('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { info: { version: string }; paths: Record<string, unknown> };
    expect(doc.info.version).toBe('1.2.3');
    expect(Object.keys(doc.paths)).toContain('/api/v1/messages/{id}/reply');
    expect(Object.keys(doc.paths).some((p) => /shares|calendar-feed|feed\//.test(p))).toBe(false);
  });

  test('refuses a missing or wrong token', async () => {
    const { call } = await setup();
    const missing = await call('/api/v1/stats');
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    const other = await new SignJWT({ iss: ISSUER, aud: 'aula-mcp', sub: 'parent-a' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setExpirationTime('5m')
      .sign(signingKey);
    expect((await call('/api/v1/stats', { auth: other })).status).toBe(401);
    expect((await call('/api/v1/stats', { auth: 'garbage' })).status).toBe(401);
  });

  test("reads the token subject's own data only", async () => {
    const { call } = await setup();
    const res = await call('/api/v1/items?kind=post', { auth: await token('parent-a') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id).sort()).toEqual(['1', '2']);
    const b = (await (
      await call('/api/v1/items?kind=post', { auth: await token('parent-b') })
    ).json()) as { items: Array<{ id: string }> };
    expect(b.items.map((i) => i.id)).toEqual(['9']);
  });

  test("another parent's data only when shared, read-only", async () => {
    const { call, idOf } = await setup();
    const auth = await token('parent-a');
    const owner = idOf({ issuer: ISSUER, sub: 'parent-b' });
    expect((await call(`/api/v1/stats?owner=${owner}`, { auth })).status).toBe(404);
    const write = await call(`/api/v1/delete?owner=${owner}`, {
      method: 'POST',
      auth: await token('parent-a', { scope: 'aula:write' }),
      body: { kinds: ['post'] },
    });
    expect(write.status).toBe(403);
  });

  test('changes need the write scope and are audited as from the API', async () => {
    const { call, storage, stores, idOf, a } = await setup();
    const plain = await call('/api/v1/aula/logout', {
      method: 'POST',
      auth: await token('parent-a', { scope: 'openid profile' }),
    });
    expect(plain.status).toBe(403);
    expect(plain.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(stores.get(callerId(a))?.record ?? 'untouched').not.toBeNull();

    const ok = await call('/api/v1/aula/logout', {
      method: 'POST',
      auth: await token('parent-a', { scope: 'openid aula:write' }),
    });
    expect(ok.status).toBe(200);
    expect(stores.get(callerId(a))?.record).toBeNull();
    const [entry] = await storage.forParent(idOf(a)).auditLog({ category: 'account' });
    expect(entry).toMatchObject({ action: 'aula_logout', details: { trigger: 'api' } });
  });

  test('a change the dashboard server sends is audited as from the dashboard', async () => {
    const { call, storage, idOf, a } = await setup();
    const res = await call('/api/v1/aula/logout', {
      method: 'POST',
      ui: true,
      auth: await token('parent-a', { scope: 'aula:write' }),
    });
    expect(res.status).toBe(200);
    const [entry] = await storage.forParent(idOf(a)).auditLog({ category: 'account' });
    expect(entry?.details).toMatchObject({ trigger: 'dashboard' });
  });

  test('the calendar feed and sharing answer to the dashboard server only', async () => {
    const { call } = await setup();
    const auth = await token('parent-a', { scope: 'aula:write' });
    expect((await call('/api/v1/shares', { auth })).status).toBe(404);
    expect((await call('/api/v1/calendar-feed', { auth })).status).toBe(404);
    expect((await call('/api/v1/feed/abc/calendar.ics')).status).toBe(404);
    expect((await call('/api/v1/shares', { auth, ui: true })).status).toBe(200);

    // The dashboard makes a link; the feed answers to it with the UI key alone.
    const made = await call('/api/v1/calendar-feed', { method: 'POST', auth, ui: true, body: {} });
    expect(made.status).toBe(200);
    const { url } = (await made.json()) as { url: string };
    expect(url.startsWith('https://aula.example.com/feed/')).toBe(true);
    const feedPath = new URL(url).pathname;
    expect((await call(`/api/v1${feedPath}`)).status).toBe(404);
    const feed = await call(`/api/v1${feedPath}`, { ui: true });
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
  });

  test('a wrong UI key counts as none', async () => {
    const { call } = await setup();
    const auth = await token('parent-a');
    expect((await call('/api/v1/shares', { auth, key: `${UI_KEY}x` })).status).toBe(404);
    expect((await call('/api/v1/shares', { auth, key: 'k' })).status).toBe(404);
    expect((await call('/api/v1/nothing-here', { auth: await token('parent-a') })).status).toBe(
      404,
    );
  });
});
