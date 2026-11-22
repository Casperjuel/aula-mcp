/**
 * Sign-in for the setup UI in multi-parent mode. Before a parent sees an Aula
 * login, the setup UI signs them in with the same identity provider as /mcp
 * (authorization code flow with PKCE) and takes their identity from the ID
 * token's `sub`. That gives the same Caller, and so the same parent
 * directory, as the parent's MCP requests.
 *
 *   GET  /auth/login     redirect to the identity provider
 *   GET  /auth/callback  code exchange, then a session cookie
 *   POST /auth/logout    end the session (and the provider's, if it can)
 *
 * Sessions live in memory: a restart signs everyone out, which costs a
 * redirect. The state cookie ties a callback to the browser that started the
 * login, so nobody can sign someone else's browser in to their account.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { ALGORITHMS, type Caller } from './oidc.ts';
import type { SetupLoginConfig } from './server-mode.ts';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** A flood of /auth/login calls must not grow memory without bound. */
const MAX_PENDING = 1000;

export interface SignedInParent {
  caller: Caller;
  /** For display only. */
  name: string;
  /** Only when the identity provider says it is verified: what shares are matched on. */
  email?: string;
}

export interface SetupLogin {
  /** Adds the /auth routes. */
  mount(app: Hono): void;
  /** Who this browser is signed in as, or null. */
  parent(c: Context): SignedInParent | null;
  /** A state-changing request from the setup UI's own pages. */
  sameOrigin(c: Context): boolean;
}

export interface SetupLoginOptions extends SetupLoginConfig {
  issuer: string;
  logger: Logger;
  /** Key lookup instead of the issuer's JWKS (tests). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

interface Provider {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint?: string;
  keys: JWTVerifyGetKey;
}

/**
 * Where sign-in may send the browser back to: a plain path on this site. No
 * `//`, backslash, dot segment or query, so it can never point elsewhere.
 */
const RETURN_PATH = /^\/(?!\/)[A-Za-z0-9_%/-]{0,200}$/;

interface Pending {
  verifier: string;
  nonce: string;
  /** The page to return to after sign-in, a path on this site only. */
  next: string;
  expiresAt: number;
}

interface Session extends SignedInParent {
  expiresAt: number;
}

export function createSetupLogin(options: SetupLoginOptions): SetupLogin {
  const { issuer, clientId, clientSecret, publicUrl, logger } = options;
  const fetchImpl = options.fetch ?? fetch;
  const redirectUri = `${publicUrl}/auth/callback`;
  const secure = publicUrl.startsWith('https:');
  // __Host- cookies are https-only, host-only and Path=/.
  const sessionCookie = secure ? '__Host-aula-setup' : 'aula-setup';
  const stateCookie = secure ? '__Host-aula-setup-state' : 'aula-setup-state';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'Lax', path: '/' } as const;

  const pending = new Map<string, Pending>();
  const sessions = new Map<string, Session>();

  let providerPromise: Promise<Provider> | undefined;
  const provider = (): Promise<Provider> => {
    providerPromise ??= discover(issuer, fetchImpl, options.keys).catch((err: unknown) => {
      providerPromise = undefined;
      throw err;
    });
    return providerPromise;
  };

  function sweep(now: number): void {
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
  }

  function unavailable(c: Context, err: unknown) {
    logger.error('setup.auth.provider_unavailable', { error: (err as Error).message });
    return c.text('The identity provider cannot be reached right now. Try again shortly.', 503);
  }

  function mount(app: Hono): void {
    app.get('/auth/login', async (c) => {
      let idp: Provider;
      try {
        idp = await provider();
      } catch (err) {
        return unavailable(c, err);
      }
      const now = Date.now();
      sweep(now);
      if (pending.size >= MAX_PENDING) return c.text('Too many sign-ins in progress.', 503);

      const state = randomToken();
      const verifier = randomToken();
      const nonce = randomToken();
      const next = c.req.query('next') ?? '';
      pending.set(state, {
        verifier,
        nonce,
        next: RETURN_PATH.test(next) ? next : '/',
        expiresAt: now + PENDING_TTL_MS,
      });
      setCookie(c, stateCookie, state, { ...cookieOptions, maxAge: PENDING_TTL_MS / 1000 });

      const url = new URL(idp.authorizationEndpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
        nonce,
        code_challenge: await s256(verifier),
        code_challenge_method: 'S256',
      }).toString();
      return c.redirect(url.href, 302);
    });

    app.get('/auth/callback', async (c) => {
      const state = c.req.query('state') ?? '';
      const expected = getCookie(c, stateCookie);
      deleteCookie(c, stateCookie, cookieOptions);
      const entry = state ? pending.get(state) : undefined;
      if (state) pending.delete(state);
      if (!entry || expected !== state || entry.expiresAt <= Date.now()) {
        return c.text('This sign-in has expired or was started elsewhere. Start again.', 400);
      }
      const providerError = c.req.query('error');
      if (providerError) {
        logger.warn('setup.auth.provider_error', { error: providerError });
        return c.text(`Sign-in failed: ${providerError}`, 400);
      }
      const code = c.req.query('code');
      if (!code) return c.text('Sign-in failed: no code.', 400);

      let idp: Provider;
      try {
        idp = await provider();
      } catch (err) {
        return unavailable(c, err);
      }

      const idToken = await exchangeCode(idp, code, entry.verifier);
      if (!idToken) return c.text('Sign-in failed: the code was not accepted.', 400);

      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await jwtVerify(idToken, idp.keys, {
          issuer,
          audience: clientId,
          algorithms: ALGORITHMS,
          requiredClaims: ['sub', 'exp'],
          clockTolerance: 30,
        }));
      } catch (err) {
        if (!(err instanceof errors.JOSEError)) throw err;
        logger.warn('setup.auth.id_token_rejected', { error: err.message });
        return c.text('Sign-in failed: the ID token was not valid.', 400);
      }
      const sub = claims.sub;
      if (claims.nonce !== entry.nonce || typeof sub !== 'string' || sub === '') {
        return c.text('Sign-in failed: the ID token was not valid.', 400);
      }
      if (claims.azp !== undefined && claims.azp !== clientId) {
        return c.text('Sign-in failed: the ID token was not valid.', 400);
      }

      const id = randomToken();
      sessions.set(id, {
        caller: { issuer, sub },
        name: displayName(claims) ?? sub,
        ...(typeof claims.email === 'string' &&
        claims.email !== '' &&
        claims.email_verified === true
          ? { email: claims.email }
          : {}),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      setCookie(c, sessionCookie, id, { ...cookieOptions, maxAge: SESSION_TTL_MS / 1000 });
      return c.redirect(`${publicUrl}${entry.next}`, 303);
    });

    app.post('/auth/logout', async (c) => {
      if (!sameOrigin(c)) return c.text('Forbidden', 403);
      const id = getCookie(c, sessionCookie);
      if (id) sessions.delete(id);
      deleteCookie(c, sessionCookie, cookieOptions);
      let target = `${publicUrl}/`;
      try {
        const { endSessionEndpoint } = await provider();
        if (endSessionEndpoint) {
          const url = new URL(endSessionEndpoint);
          url.search = new URLSearchParams({
            client_id: clientId,
            post_logout_redirect_uri: `${publicUrl}/`,
          }).toString();
          target = url.href;
        }
      } catch {
        // Signed out here either way.
      }
      return c.redirect(target, 303);
    });
  }

  async function exchangeCode(idp: Provider, code: string, verifier: string) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (clientSecret) {
      const basic = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
    }
    const res = await fetchImpl(idp.tokenEndpoint, { method: 'POST', headers, body });
    if (!res.ok) {
      logger.warn('setup.auth.code_exchange_failed', { status: res.status });
      return null;
    }
    const json = (await res.json()) as { id_token?: unknown };
    return typeof json.id_token === 'string' ? json.id_token : null;
  }

  function parent(c: Context): SignedInParent | null {
    const id = getCookie(c, sessionCookie);
    const session = id ? sessions.get(id) : undefined;
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id as string);
      return null;
    }
    return {
      caller: session.caller,
      name: session.name,
      ...(session.email ? { email: session.email } : {}),
    };
  }

  // Browsers send Origin on every POST, so a missing one is refused too.
  function sameOrigin(c: Context): boolean {
    return c.req.header('origin') === publicUrl;
  }

  return { mount, parent, sameOrigin };
}

async function discover(
  issuer: string,
  fetchImpl: typeof fetch,
  keys: JWTVerifyGetKey | undefined,
): Promise<Provider> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${url} returned ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  if (doc.issuer !== issuer) {
    throw new Error(
      `OIDC discovery issuer mismatch: configured "${issuer}", provider says "${String(doc.issuer)}"`,
    );
  }
  const { authorization_endpoint, token_endpoint, jwks_uri, end_session_endpoint } = doc;
  if (typeof authorization_endpoint !== 'string' || typeof token_endpoint !== 'string') {
    throw new Error('OIDC discovery has no authorization or token endpoint');
  }
  if (!keys && typeof jwks_uri !== 'string') throw new Error('OIDC discovery has no jwks_uri');
  return {
    authorizationEndpoint: authorization_endpoint,
    tokenEndpoint: token_endpoint,
    ...(typeof end_session_endpoint === 'string'
      ? { endSessionEndpoint: end_session_endpoint }
      : {}),
    keys: keys ?? createRemoteJWKSet(new URL(jwks_uri as string)),
  };
}

function displayName(claims: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'preferred_username', 'email']) {
    const value = claims[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString('base64url');
}
