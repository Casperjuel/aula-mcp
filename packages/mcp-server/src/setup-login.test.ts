import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StoredTokenRecord, silentLogger, type TokenStore } from '@aula-mcp/aula-auth';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { GalleryFiles, GalleryView } from './gallery.ts';
import { type Caller, callerId } from './oidc.ts';
import { createSetupLogin } from './setup-login.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';
import type { SyncJobName } from './sync.ts';

const PUBLIC_URL = 'https://aula-setup.example.com';
const CLIENT_ID = 'aula-mcp-setup';

class MemoryStore implements TokenStore {
  record: StoredTokenRecord | null = null;
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

let signingKey: CryptoKey;
let publicJwk: JWK;
let idp: ReturnType<typeof Bun.serve>;
let issuer: string;
let lastTokenRequest: { body: URLSearchParams; authorization: string | null } | undefined;
/** What the fake provider puts in the next ID token, given the request's nonce. */
let idTokenClaims: (nonce: string) => Record<string, unknown>;
/** Nonce from the most recent authorization redirect. */
let nonce = '';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  idp = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/realms/home/.well-known/openid-configuration') {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          end_session_endpoint: `${issuer}/logout`,
        });
      }
      if (pathname === '/realms/home/token') {
        const body = new URLSearchParams(await req.text());
        lastTokenRequest = { body, authorization: req.headers.get('authorization') };
        if (body.get('code') !== 'good-code')
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const idToken = await new SignJWT(idTokenClaims(nonce))
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(signingKey);
        return Response.json({ id_token: idToken, access_token: 'at' });
      }
      return new Response('not found', { status: 404 });
    },
  });
  issuer = `http://127.0.0.1:${idp.port}/realms/home`;
});

afterAll(async () => {
  idp.stop(true);
  await rm(galleryDir, { recursive: true, force: true });
});

const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 2), {
  type: 'sqlite',
  location: 'test',
});
await storage.forParent('parent-a').put([{ kind: 'post', id: '1', data: 'a' }]);

// Parent C has one downloaded photo; parent B has no gallery.
const galleryDir = await mkdtemp(join(tmpdir(), 'aula-gallery-'));
const galleryFiles = new GalleryFiles({ dir: galleryDir, downloads: true, stopAt: 1 });
await storage.forParent('parent-c').put([
  {
    kind: 'gallery_album',
    id: '11',
    data: {
      album: { id: 11, title: 'Skovtur' },
      child: 'Anna',
      folder: 'Anna/Skovtur',
      mediaCount: 1,
    },
  },
  {
    kind: 'gallery_media',
    id: '11:1',
    data: {
      albumId: 11,
      media: { id: 1, mediaType: 'image', file: { id: 1, name: 'IMG_1.jpg' } },
      path: 'Anna/Skovtur/IMG_1.jpg',
      thumb: null,
      sha256: 'ab',
      bytes: 5,
      downloadedAt: 1,
    },
  },
]);
await mkdir(join(galleryFiles.forParent('parent-c').location, 'Anna/Skovtur'), { recursive: true });
await writeFile(
  join(galleryFiles.forParent('parent-c').location, 'Anna/Skovtur/IMG_1.jpg'),
  'photo',
);

function setup(clientSecret?: string) {
  const stores = new Map<string, MemoryStore>();
  const changed: string[] = [];
  const login = createSetupLogin({
    issuer,
    publicUrl: PUBLIC_URL,
    clientId: CLIENT_ID,
    ...(clientSecret ? { clientSecret } : {}),
    logger: silentLogger,
    keys: createLocalJWKSet({ keys: [publicJwk] }),
  });
  const storeFor = (caller: Caller) => {
    const id = callerId(caller);
    let store = stores.get(id);
    if (!store) {
      store = new MemoryStore();
      stores.set(id, store);
    }
    return store;
  };
  const liveFor: string[] = [];
  const syncRuns: Array<{ sub: string; jobs: SyncJobName[] }> = [];
  const app = createSetupApp({
    logger: silentLogger,
    parents: { login, storeFor, changed: (caller) => changed.push(caller.sub) },
    myData: {
      tools: [],
      storage: { info: storage.info, forParent: (caller) => storage.forParent(caller?.sub ?? '') },
      contextFor: (caller) => {
        liveFor.push(caller?.sub ?? 'none');
        throw new Error(`no Aula in tests (${caller?.sub})`);
      },
      gallery: {
        forParent: (caller) =>
          new GalleryView(
            storage.forParent(caller?.sub ?? ''),
            galleryFiles.forParent(caller?.sub ?? 'none'),
          ),
      },
      sharing: {
        shares: storage.shares,
        open: async (viewer, ownerId) => {
          const store = await storage.sharedWith(callerId(viewer), ownerId);
          return store ? { store, gallery: null } : null;
        },
      },
      sync: {
        forParent: (caller) => ({
          status: async () => [],
          run: async (jobs) => {
            syncRuns.push({ sub: caller?.sub ?? 'none', jobs: jobs ?? [] });
            return [];
          },
        }),
      },
    },
  });
  return { app, storeFor, changed, liveFor, syncRuns };
}

type App = ReturnType<typeof setup>['app'];

function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, value] = (pair ?? '').split('=');
    if (name) out[name] = value ?? '';
  }
  return out;
}

const claimsFor =
  (sub: string, extra: Record<string, unknown> = {}) =>
  (n: string) => ({ iss: issuer, aud: CLIENT_ID, sub, nonce: n, name: `Parent ${sub}`, ...extra });

/** Runs the whole sign-in and returns the session cookie header. */
async function signIn(app: App, sub: string, extra: Record<string, unknown> = {}): Promise<string> {
  idTokenClaims = claimsFor(sub, extra);
  const start = await app.request('/auth/login');
  const location = new URL(start.headers.get('location') ?? '');
  nonce = location.searchParams.get('nonce') ?? '';
  const state = location.searchParams.get('state') ?? '';
  const stateCookie = cookiesFrom(start)['__Host-aula-setup-state'];
  const callback = await app.request(`/auth/callback?code=good-code&state=${state}`, {
    headers: { cookie: `__Host-aula-setup-state=${stateCookie}` },
  });
  expect(callback.status).toBe(303);
  return `__Host-aula-setup=${cookiesFrom(callback)['__Host-aula-setup']}`;
}

describe('setup UI sign-in', () => {
  test('a browser that is not signed in is sent to the identity provider', async () => {
    const { app } = setup();
    const page = await app.request('/');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/auth/login');
    expect((await app.request('/status')).status).toBe(401);

    const start = await app.request('/auth/login');
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') ?? '');
    expect(location.href.startsWith(`${issuer}/auth?`)).toBe(true);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.headers.getSetCookie().join()).toContain('HttpOnly');
  });

  test('signs in with PKCE and the client secret, then shows the parent their own status', async () => {
    const { app, storeFor } = setup('s3cret');
    const cookie = await signIn(app, 'parent-a');

    const sent = lastTokenRequest;
    expect(sent?.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:s3cret`)}`);
    expect(sent?.body.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/callback`);
    expect(sent?.body.get('code_verifier')).toBeTruthy();

    const page = await app.request('/', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Parent parent-a');

    const caller = { issuer, sub: 'parent-a' };
    await storeFor(caller).save({
      version: 1,
      username: 'a',
      tokens: {
        access_token: 'AT',
        refresh_token: 'RT',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        obtained_at: Math.floor(Date.now() / 1000),
      },
      saved_at: Math.floor(Date.now() / 1000),
    });
    const status = await app.request('/status', { headers: { cookie } });
    expect(((await status.json()) as { username: string }).username).toBe('a');

    const other = await signIn(app, 'parent-b');
    const otherStatus = await app.request('/status', { headers: { cookie: other } });
    expect(await otherStatus.json()).toEqual({ logged_in: false });
  });

  test('the PKCE verifier matches the challenge', async () => {
    const { app } = setup();
    idTokenClaims = claimsFor('parent-a');
    const start = await app.request('/auth/login');
    const location = new URL(start.headers.get('location') ?? '');
    nonce = location.searchParams.get('nonce') ?? '';
    const state = location.searchParams.get('state') ?? '';
    await app.request(`/auth/callback?code=good-code&state=${state}`, {
      headers: { cookie: `__Host-aula-setup-state=${state}` },
    });
    const verifier = lastTokenRequest?.body.get('code_verifier') ?? '';
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      location.searchParams.get('code_challenge') ?? 'missing',
    );
  });

  test('refuses a callback from another browser, a replay, and bad ID tokens', async () => {
    const { app } = setup();
    const begin = async (claims: (n: string) => Record<string, unknown>) => {
      idTokenClaims = claims;
      const start = await app.request('/auth/login');
      const location = new URL(start.headers.get('location') ?? '');
      nonce = location.searchParams.get('nonce') ?? '';
      return location.searchParams.get('state') ?? '';
    };
    const finish = (state: string, cookieState = state, code = 'good-code') =>
      app.request(`/auth/callback?code=${code}&state=${state}`, {
        headers: { cookie: `__Host-aula-setup-state=${cookieState}` },
      });

    // Login CSRF: the state is real, but this browser didn't start it.
    const stolen = await begin(claimsFor('attacker'));
    expect((await finish(stolen, 'something-else')).status).toBe(400);
    // The state is used up by that attempt.
    expect((await finish(stolen)).status).toBe(400);

    expect(await finish(await begin(claimsFor('a')), undefined, 'bad-code')).toHaveProperty(
      'status',
      400,
    );
    expect((await finish(await begin(claimsFor('a', { aud: 'kagent' })))).status).toBe(400);
    expect(
      (await finish(await begin(claimsFor('a', { iss: 'https://evil.example.com' })))).status,
    ).toBe(400);
    expect((await finish(await begin(claimsFor('a', { azp: 'kagent' })))).status).toBe(400);
    expect(
      (await finish(await begin((n) => ({ ...claimsFor('a')(n), nonce: `${n}x` })))).status,
    ).toBe(400);
  });

  test('state-changing requests need the setup UI origin', async () => {
    const { app } = setup();
    const cookie = await signIn(app, 'parent-a');
    const post = (origin?: string) =>
      app.request('/logout', {
        method: 'POST',
        headers: { cookie, ...(origin ? { origin } : {}) },
      });
    expect((await post()).status).toBe(403);
    expect((await post('https://evil.example.com')).status).toBe(403);
    expect((await post(PUBLIC_URL)).status).toBe(200);
  });

  test('My data shows each parent only their own data', async () => {
    const { app, storeFor, liveFor } = setup();
    expect((await app.request('/data')).status).toBe(302);
    expect((await app.request('/data/summary')).status).toBe(401);
    expect((await app.request('/data/live')).status).toBe(401);
    expect((await app.request('/data/tools')).status).toBe(401);

    const a = await signIn(app, 'parent-a');
    const b = await signIn(app, 'parent-b');
    await storeFor({ issuer, sub: 'parent-a' }).save({
      version: 1,
      username: 'a',
      tokens: {
        access_token: 'AT',
        refresh_token: 'RT',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        obtained_at: Math.floor(Date.now() / 1000),
      },
      saved_at: Math.floor(Date.now() / 1000),
    });

    const summaryA = (await (
      await app.request('/data/summary', { headers: { cookie: a } })
    ).json()) as {
      parent: { name: string };
      login: { username?: string };
      database: { kinds: Array<{ kind: string; count: number }> };
    };
    expect(summaryA.parent.name).toBe('Parent parent-a');
    expect(summaryA.database.kinds).toMatchObject([{ kind: 'post', count: 1 }]);
    expect(summaryA.login.username).toBe('a');
    const summaryB = (await (
      await app.request('/data/summary', { headers: { cookie: b } })
    ).json()) as {
      parent: { name: string };
      login: { logged_in: boolean };
      database: { kinds: unknown[] };
    };
    expect(summaryB.parent.name).toBe('Parent parent-b');
    expect(summaryB.database.kinds).toEqual([]);
    expect(summaryB.login.logged_in).toBe(false);

    // B has no Aula login, so nothing is read for B; A reads through A's context.
    expect((await app.request('/data/live', { headers: { cookie: b } })).status).toBe(409);
    expect((await app.request('/data/live', { headers: { cookie: a } })).status).toBe(502);
    expect(liveFor).toEqual(['parent-a']);
  });

  test('the dashboard reads, deletes and syncs only for the signed-in parent', async () => {
    const { app, storeFor, syncRuns } = setup();
    expect((await app.request('/')).status).toBe(302);
    expect((await app.request('/data/items')).status).toBe(401);
    expect((await app.request('/data/items/post/1')).status).toBe(401);
    expect((await app.request('/data/sync')).status).toBe(401);

    const a = await signIn(app, 'parent-a');
    const b = await signIn(app, 'parent-b');
    const login: StoredTokenRecord = {
      version: 1,
      username: 'b',
      tokens: {
        access_token: 'AT',
        refresh_token: 'RT',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        obtained_at: Math.floor(Date.now() / 1000),
      },
      saved_at: Math.floor(Date.now() / 1000),
    };
    await storeFor({ issuer, sub: 'parent-b' }).save(login);
    const page = await app.request('/', { headers: { cookie: a } });
    expect(await page.text()).toContain('Parent parent-a');

    const itemsOf = async (cookie: string) =>
      (
        (await (await app.request('/data/items', { headers: { cookie } })).json()) as {
          items: Array<{ id: string }>;
        }
      ).items.map((item) => item.id);
    expect(await itemsOf(a)).toEqual(['1']);
    expect(await itemsOf(b)).toEqual([]);
    expect((await app.request('/data/items/post/1', { headers: { cookie: a } })).status).toBe(200);
    expect((await app.request('/data/items/post/1', { headers: { cookie: b } })).status).toBe(404);

    const post = (path: string, cookie: string, body: unknown, origin = PUBLIC_URL) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // B deleting everything removes nothing of A's.
    const deleted = await post('/data/delete', b, { confirm: 'SLET', all: true });
    expect(await deleted.json()).toEqual({ deleted: 0 });
    expect(await itemsOf(a)).toEqual(['1']);
    // And a page on another site cannot delete for A.
    const forged = await post(
      '/data/delete',
      a,
      { confirm: 'SLET', all: true },
      'https://evil.example.com',
    );
    expect(forged.status).toBe(403);
    expect(await itemsOf(a)).toEqual(['1']);

    // A has no Aula login here, so A cannot start a sync; B's run is B's.
    expect((await post('/data/sync/run', a, {})).status).toBe(409);
    expect((await post('/data/sync/run', b, { jobs: ['posts'] })).status).toBe(202);
    expect((await post('/data/sync/run', b, {}, 'https://evil.example.com')).status).toBe(403);
    expect(syncRuns).toEqual([{ sub: 'parent-b', jobs: ['posts'] }]);
  });

  test('the gallery shows, serves and deletes only for the signed-in parent', async () => {
    const { app } = setup();
    expect((await app.request('/data/gallery')).status).toBe(401);
    expect((await app.request('/data/gallery/file/11/1')).status).toBe(401);

    const c = await signIn(app, 'parent-c');
    const b = await signIn(app, 'parent-b');
    const albumsOf = async (cookie: string) =>
      (
        (await (await app.request('/data/gallery', { headers: { cookie } })).json()) as {
          albums: Array<{ id: number }>;
        }
      ).albums.map((album) => album.id);
    expect(await albumsOf(c)).toEqual([11]);
    expect(await albumsOf(b)).toEqual([]);
    for (const path of ['/data/gallery/albums/11', '/data/gallery/file/11/1']) {
      expect((await app.request(path, { headers: { cookie: c } })).status).toBe(200);
      expect((await app.request(path, { headers: { cookie: b } })).status).toBe(404);
    }

    const post = (cookie: string, body: unknown, origin = PUBLIC_URL) =>
      app.request('/data/gallery/delete', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    // B deleting C's album, or everything, leaves C's alone.
    expect(await (await post(b, { confirm: 'SLET', albumId: 11 })).json()).toEqual({
      deleted: { albums: 0, files: 0 },
    });
    expect(await (await post(b, { confirm: 'SLET', all: true })).json()).toEqual({
      deleted: { albums: 0, files: 0 },
    });
    expect((await post(c, { confirm: 'SLET', all: true }, 'https://evil.example.com')).status).toBe(
      403,
    );
    expect(
      await (await app.request('/data/gallery/file/11/1', { headers: { cookie: c } })).text(),
    ).toBe('photo');
  });

  test('a parent shares their data read-only with the email they give', async () => {
    const { app } = setup();
    const ownerId = callerId({ issuer, sub: 'share-a' });
    const viewerId = callerId({ issuer, sub: 'share-b' });
    await storage.forParent(ownerId).put([
      { kind: 'message', id: 'm1', data: { text: 'til begge' } },
      { kind: 'message', id: 'm2', data: { text: 'kun til A' } },
    ]);
    await storage
      .forParent(viewerId)
      .put([{ kind: 'message', id: 'm1', data: { text: 'til begge' } }]);
    const a = await signIn(app, 'share-a', { email: 'a@example.dk', email_verified: true });
    const b = await signIn(app, 'share-b', { email: 'B@example.dk', email_verified: true });
    // Without a verified email the claim never matches.
    const c = await signIn(app, 'share-c', { email: 'b@example.dk', email_verified: false });
    const get = async (path: string, cookie: string) => {
      const res = await app.request(path, { headers: { cookie } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const post = (path: string, cookie: string, body: unknown, origin = PUBLIC_URL) =>
      app.request(path, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await get('/data/shares', a)).body).toMatchObject({
      available: true,
      email: 'a@example.dk',
      granted: [],
      shared_with_me: [],
    });
    expect((await post('/data/shares', a, { email: 'a@example.dk' })).status).toBe(400);
    expect((await post('/data/shares', a, { email: 'not an email' })).status).toBe(400);
    expect(
      (await post('/data/shares', a, { email: 'b@example.dk' }, 'https://evil.example.com')).status,
    ).toBe(403);
    expect((await post('/data/shares', a, { email: 'b@example.dk' })).status).toBe(200);

    // Nothing is shared before B is matched by their verified email.
    const owner = `owner=${ownerId}`;
    expect((await get(`/data/items?${owner}`, b)).status).toBe(404);
    expect((await get('/data/shares', c)).body.shared_with_me).toEqual([]);
    expect((await get('/data/shares', b)).body.shared_with_me).toEqual([
      { owner: ownerId, name: 'Parent share-a', since: expect.any(Number) },
    ]);
    expect((await get('/data/shares', a)).body.granted).toEqual([
      { email: 'b@example.dk', active: true, since: expect.any(Number) },
    ]);
    expect((await get(`/data/items?${owner}`, c)).status).toBe(404);

    // B reads only what they do not have themselves, and cannot change it.
    const items = (await get(`/data/items?${owner}`, b)).body.items as Array<{ id: string }>;
    expect(items.map((i) => i.id)).toEqual(['m2']);
    expect((await get(`/data/items/message/m1?${owner}`, b)).status).toBe(404);
    expect((await get(`/data/items/message/m2?${owner}`, b)).status).toBe(200);
    expect((await get(`/data/stats?${owner}`, b)).body.kinds).toMatchObject([
      { kind: 'message', count: 1 },
    ]);
    expect((await post(`/data/delete?${owner}`, b, { confirm: 'SLET', all: true })).status).toBe(
      403,
    );
    expect((await get(`/data/sync?${owner}`, b)).status).toBe(403);
    expect((await get(`/data/items?owner=${viewerId}`, a)).status).toBe(404);

    // Taking it back ends it at once.
    expect((await post('/data/shares/remove', a, { email: 'b@example.dk' })).status).toBe(200);
    expect((await post('/data/shares/remove', a, { email: 'b@example.dk' })).status).toBe(404);
    expect((await get(`/data/items?${owner}`, b)).status).toBe(404);
  });

  test('a login session belongs to the parent who started it', async () => {
    const { app } = setup();
    const a = await signIn(app, 'parent-a');
    const b = await signIn(app, 'parent-b');
    const start = await app.request('/login/start', {
      method: 'POST',
      headers: { cookie: a, origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone' }),
    });
    const { sessionId } = (await start.json()) as { sessionId: string };
    const events = await app.request(`/login/events?sessionId=${sessionId}`, {
      headers: { cookie: b },
    });
    expect(events.status).toBe(404);
    const pick = await app.request(`/login/identity?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { cookie: b, origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ index: 1 }),
    });
    expect(pick.status).toBe(404);
  });

  test('signing out ends the session and the provider session', async () => {
    const { app, changed } = setup();
    const cookie = await signIn(app, 'parent-a');
    await app.request('/logout', { method: 'POST', headers: { cookie, origin: PUBLIC_URL } });
    expect(changed).toEqual(['parent-a']);

    const out = await app.request('/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: PUBLIC_URL },
    });
    expect(out.status).toBe(303);
    const location = new URL(out.headers.get('location') ?? '');
    expect(location.href.startsWith(`${issuer}/logout?`)).toBe(true);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(`${PUBLIC_URL}/`);
    expect((await app.request('/status', { headers: { cookie } })).status).toBe(401);
  });
});
