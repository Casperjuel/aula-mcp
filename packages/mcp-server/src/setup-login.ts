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
 *
 * For the dashboard server in front of the API (ui-app.ts), `forwardTokens`
 * also keeps the parent's access and refresh token in the session, on the
 * server only, and renews the access token before it runs out. The browser
 * only ever holds the session cookie.
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
  /** With `forwardTokens`: a current access token of this browser's parent,
   *  renewed when needed; null when signed out or the renewal was refused. */
  accessToken?(c: Context): Promise<string | null>;
}

export interface SetupLoginOptions extends SetupLoginConfig {
  issuer: string;
  logger: Logger;
  /** Key lookup instead of the issuer's JWKS (tests). */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  /** Keep the tokens to call the API with, asking for these extra scopes too. */
  forwardTokens?: { scopes: string[] };
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
  /** With `forwardTokens` only. Never logged, never sent to the browser. */
  tokens?: Tokens;
  /** A renewal in flight, so parallel requests share it. */
  renewing?: Promise<Tokens | null> | undefined;
}

interface Tokens {
  access: string;
  refresh?: string;
  /** When the access token runs out, ms. */
  accessExpiresAt: number;
}

/** Renew this long before the access token runs out. */
const RENEW_EARLY_MS = 30 * 1000;

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
        scope: ['openid', 'profile', 'email', ...(options.forwardTokens?.scopes ?? [])].join(' '),
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

      const grant = await exchangeCode(idp, code, entry.verifier);
      const idToken = typeof grant?.id_token === 'string' ? grant.id_token : null;
      if (!idToken) return c.text('Sign-in failed: the code was not accepted.', 400);
      const tokens = options.forwardTokens ? tokensOf(grant) : undefined;
      if (options.forwardTokens && !tokens) {
        return c.text('Sign-in failed: no access token was issued.', 400);
      }

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
        ...(tokens ? { tokens } : {}),
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

  function exchangeCode(idp: Provider, code: string, verifier: string) {
    return tokenRequest(idp, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  }

  /** A call to the token endpoint; null when it is refused. */
  async function tokenRequest(
    idp: Provider,
    params: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const body = new URLSearchParams({ ...params, client_id: clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (clientSecret) {
      const basic = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
    }
    const res = await fetchImpl(idp.tokenEndpoint, { method: 'POST', headers, body });
    if (!res.ok) {
      logger.warn('setup.auth.token_request_failed', {
        grant: params.grant_type,
        status: res.status,
      });
      return null;
    }
    const json = (await res.json().catch(() => null)) as unknown;
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  }

  function tokensOf(grant: Record<string, unknown> | null, previous?: Tokens): Tokens | undefined {
    if (!grant || typeof grant.access_token !== 'string' || grant.access_token === '')
      return undefined;
    const expiresIn = typeof grant.expires_in === 'number' ? grant.expires_in : 60;
    const refresh =
      typeof grant.refresh_token === 'string' ? grant.refresh_token : previous?.refresh;
    return {
      access: grant.access_token,
      ...(refresh ? { refresh } : {}),
      accessExpiresAt: Date.now() + expiresIn * 1000,
    };
  }

  async function renew(session: Session): Promise<Tokens | null> {
    const refresh = session.tokens?.refresh;
    if (!refresh) return null;
    let idp: Provider;
    try {
      idp = await provider();
    } catch {
      return null;
    }
    return (
      tokensOf(
        await tokenRequest(idp, { grant_type: 'refresh_token', refresh_token: refresh }),
        session.tokens,
      ) ?? null
    );
  }

  async function accessToken(c: Context): Promise<string | null> {
    const id = getCookie(c, sessionCookie);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session?.tokens || session.expiresAt <= Date.now()) return null;
    if (session.tokens.accessExpiresAt - RENEW_EARLY_MS > Date.now()) return session.tokens.access;
    session.renewing ??= renew(session).finally(() => {
      session.renewing = undefined;
    });
    const tokens = await session.renewing;
    if (!tokens) {
      // The identity provider ended the session; sign in again.
      sessions.delete(id);
      return null;
    }
    session.tokens = tokens;
    return tokens.access;
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

  return { mount, parent, sameOrigin, ...(options.forwardTokens ? { accessToken } : {}) };
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
