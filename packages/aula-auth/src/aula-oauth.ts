/**
 * Aula's OAuth 2.0 (OpenID Connect with PKCE) configuration and token helpers.
 * Constants captured from the production AulaLoginClient (`client.py:135-143`).
 *
 * The token endpoint is shared between the auth-code exchange and the
 * refresh-token grant, so both live here.
 */

import { AulaAuthError } from './errors.ts';
import type { AulaHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import { sanitizeUrl } from './wire-tracer.ts';

export interface AulaOAuthConfig {
  /** Aula's mobile-app OAuth client ID. */
  clientId: string;
  scope: string;
  /** The redirect URI registered for this client. The auth flow captures the
   * `code` from this URL when the OAuth callback fires. */
  redirectUri: string;
  /** Base URL for `/simplesaml/...` paths. */
  authBaseUrl: string;
  /** UniLogin broker base URL — used by the SAML federation step. */
  brokerBaseUrl: string;
}

export const DEFAULT_OAUTH_CONFIG: Readonly<AulaOAuthConfig> = Object.freeze({
  clientId: '_99949a54b8b65423862aac1bf629599ed64231607a',
  scope: 'aula-sensitive',
  redirectUri: 'https://app-private.aula.dk',
  authBaseUrl: 'https://login.aula.dk',
  brokerBaseUrl: 'https://broker.unilogin.dk',
});

export const oauthUrls = {
  authorize(cfg: AulaOAuthConfig): string {
    return `${cfg.authBaseUrl}/simplesaml/module.php/oidc/authorize.php`;
  },
  token(cfg: AulaOAuthConfig): string {
    return `${cfg.authBaseUrl}/simplesaml/module.php/oidc/token.php`;
  },
  /** Final SAML ACS endpoint at Aula. */
  samlAcs(cfg: AulaOAuthConfig): string {
    return `${cfg.authBaseUrl}/simplesaml/module.php/saml/sp/saml2-acs.php/uni-sp`;
  },
  /** Broker SAML endpoint that consumes the MitID-issued SAMLResponse. */
  brokerSamlEndpoint(cfg: AulaOAuthConfig): string {
    return `${cfg.brokerBaseUrl}/auth/realms/broker/broker/nemlogin3/endpoint`;
  },
  /** Build the post-broker-login URL from the params we captured. */
  postBrokerLogin(
    cfg: AulaOAuthConfig,
    params: { sessionCode: string; execution: string; clientId: string; tabId: string },
  ): string {
    const qs = new URLSearchParams({
      session_code: params.sessionCode,
      execution: params.execution,
      client_id: params.clientId,
      tab_id: params.tabId,
    });
    return `${cfg.brokerBaseUrl}/auth/realms/broker/login-actions/post-broker-login?${qs.toString()}`;
  },
};

export interface AulaTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  /** Seconds until expiry, as returned by the server. */
  expires_in: number;
  /** Unix epoch seconds at which the access token expires. Computed locally. */
  expires_at: number;
  /** When these tokens were obtained, for debugging. */
  obtained_at: number;
}

export class OAuthError extends AulaAuthError {
  override readonly name: string = 'OAuthError';
}

export interface BuildAuthorizeUrlOpts {
  config: AulaOAuthConfig;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl({ config, state, codeChallenge }: BuildAuthorizeUrlOpts): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: config.scope,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${oauthUrls.authorize(config)}?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Caller supplies an HTTP client; this is just the request wrapping + parsing.
 */
export async function exchangeAuthorizationCode(
  http: AulaHttpClient,
  config: AulaOAuthConfig,
  args: { code: string; codeVerifier: string },
  logger: Logger = silentLogger,
): Promise<AulaTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_verifier: args.codeVerifier,
  });
  logger.debug('oauth.token_exchange.start');
  const res = await http.request(oauthUrls.token(config), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (res.status !== 200) {
    throw new OAuthError(`Token exchange failed (status ${res.status}): ${res.body.slice(0, 300)}`);
  }
  const tokens = parseTokenResponse(res.body);
  logger.info('oauth.token_exchange.success', { expires_in: tokens.expires_in });
  return tokens;
}

/** Refresh an access token using a previously-issued refresh token. */
export async function refreshAccessToken(
  http: AulaHttpClient,
  config: AulaOAuthConfig,
  refreshToken: string,
  logger: Logger = silentLogger,
): Promise<AulaTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  logger.debug('oauth.refresh.start');
  const res = await http.request(oauthUrls.token(config), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (res.status !== 200) {
    throw new OAuthError(`Token refresh failed (status ${res.status}): ${res.body.slice(0, 300)}`);
  }
  const tokens = parseTokenResponse(res.body, refreshToken);
  logger.info('oauth.refresh.success', { expires_in: tokens.expires_in });
  return tokens;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Parse a token endpoint response. `fallbackRefresh` lets us preserve the
 * caller's refresh token when the server's refresh-token grant response omits
 * it (some IdPs only return a new refresh token if rotation is enabled).
 */
export function parseTokenResponse(rawBody: string, fallbackRefresh?: string): AulaTokens {
  let parsed: RawTokenResponse;
  try {
    parsed = JSON.parse(rawBody) as RawTokenResponse;
  } catch (e) {
    throw new OAuthError('Token response was not valid JSON', { cause: e });
  }
  if (!parsed.access_token) throw new OAuthError('Token response missing access_token');
  if (parsed.token_type && parsed.token_type !== 'Bearer') {
    throw new OAuthError(`Unexpected token_type: ${parsed.token_type}`);
  }
  if (typeof parsed.expires_in !== 'number') {
    throw new OAuthError('Token response missing numeric expires_in');
  }
  const refreshToken = parsed.refresh_token ?? fallbackRefresh;
  if (!refreshToken) throw new OAuthError('Token response missing refresh_token (no fallback)');

  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: parsed.access_token,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: parsed.expires_in,
    expires_at: now + parsed.expires_in,
    obtained_at: now,
  };
}

/** Pull `code` and `state` from a callback URL like `https://app-private.aula.dk?code=...&state=...`. */
export function parseAuthorizationCallback(url: string): { code: string; state: string } {
  const u = new URL(url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  // Sanitised: whichever of code/state IS present is a credential, and this
  // message reaches the login log and any bug report pasted from it.
  if (!code) throw new OAuthError(`Authorization callback missing code: ${sanitizeUrl(url)}`);
  if (!state) throw new OAuthError(`Authorization callback missing state: ${sanitizeUrl(url)}`);
  return { code, state };
}

/** True if a token expires within `bufferSeconds` (default 60). */
export function isTokenExpired(
  tokens: Pick<AulaTokens, 'expires_at'>,
  bufferSeconds = 60,
): boolean {
  return Math.floor(Date.now() / 1000) + bufferSeconds >= tokens.expires_at;
}
