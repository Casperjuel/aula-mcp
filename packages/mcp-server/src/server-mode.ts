/**
 * Which mode the server runs in, read from the environment once at startup.
 *
 *   single-parent (default) — one Aula login, no caller authentication. The
 *                             code path is the same as before multi-parent
 *                             mode existed.
 *   multi-parent            — AULA_MCP_MULTI_PARENT=1. Every request must
 *                             carry an OIDC access token, and each parent
 *                             gets their own Aula session.
 *
 * AULA_MCP_OIDC_ACCEPT_ID_TOKEN=1 also accepts OIDC ID tokens. Some fronts
 * only forward an ID token (kagent behind oauth2-proxy), so it exists for
 * them; the audience check still applies.
 *
 * In multi-parent mode the setup UI (AULA_MCP_INGRESS_PORT) signs each parent
 * in with the same identity provider before showing their Aula login, so it
 * needs its own OIDC client: AULA_MCP_SETUP_URL (where browsers reach it),
 * AULA_MCP_SETUP_CLIENT_ID and, for a confidential client,
 * AULA_MCP_SETUP_CLIENT_SECRET. Single-parent mode doesn't use them.
 *
 * Every half-configured state is a startup error rather than a guess: the
 * flag without an issuer/audience, or OIDC settings without the flag. A typo
 * must never leave someone believing auth is on when it isn't.
 */

export interface OidcConfig {
  /** Must equal the `iss` claim of the access tokens exactly. */
  issuer: string;
  /** Must appear in the `aud` claim of the access tokens. */
  audience: string;
  /** Also accept ID tokens (AULA_MCP_OIDC_ACCEPT_ID_TOKEN=1). Off by default. */
  acceptIdTokens: boolean;
}

/** The setup UI's own sign-in, multi-parent mode only. */
export interface SetupLoginConfig {
  /** Origin browsers open the setup UI on; the redirect URI is built from it. */
  publicUrl: string;
  clientId: string;
  /** Unset for a public client (PKCE only). */
  clientSecret?: string;
}

export type ServerMode =
  | { kind: 'single-parent' }
  | { kind: 'multi-parent'; oidc: OidcConfig; setupLogin: SetupLoginConfig | null };

export class ServerModeError extends Error {
  override readonly name = 'ServerModeError';
}

type Env = Record<string, string | undefined>;

export function resolveServerMode(env: Env): ServerMode {
  const flag = env.AULA_MCP_MULTI_PARENT ?? '';
  const issuer = env.AULA_MCP_OIDC_ISSUER?.trim() ?? '';
  const audience = env.AULA_MCP_OIDC_AUDIENCE?.trim() ?? '';
  const acceptIdToken = env.AULA_MCP_OIDC_ACCEPT_ID_TOKEN ?? '';
  const setupUrl = env.AULA_MCP_SETUP_URL?.trim() ?? '';
  const setupClientId = env.AULA_MCP_SETUP_CLIENT_ID?.trim() ?? '';
  const setupClientSecret = env.AULA_MCP_SETUP_CLIENT_SECRET ?? '';

  if (flag === '' || flag === '0') {
    if (issuer || audience || acceptIdToken) {
      throw new ServerModeError(
        'AULA_MCP_OIDC_* settings are set but multi-parent mode is off.\n' +
          'Set AULA_MCP_MULTI_PARENT=1 to require OIDC, or remove the OIDC settings.',
      );
    }
    if (setupUrl || setupClientId || setupClientSecret) {
      throw new ServerModeError(
        'AULA_MCP_SETUP_* settings are set but multi-parent mode is off.\n' +
          'The setup UI only signs parents in in multi-parent mode; remove them.',
      );
    }
    return { kind: 'single-parent' };
  }
  if (flag !== '1') {
    throw new ServerModeError(`AULA_MCP_MULTI_PARENT must be 1 or 0, got "${flag}".`);
  }
  if (!['', '0', '1'].includes(acceptIdToken)) {
    throw new ServerModeError(
      `AULA_MCP_OIDC_ACCEPT_ID_TOKEN must be 1 or 0, got "${acceptIdToken}".`,
    );
  }

  const missing = [
    issuer ? null : 'AULA_MCP_OIDC_ISSUER',
    audience ? null : 'AULA_MCP_OIDC_AUDIENCE',
  ].filter((name) => name !== null);
  if (missing.length > 0) {
    throw new ServerModeError(
      `Multi-parent mode requires ${missing.join(' and ')}.\n` +
        'The server will not start without an identity provider.',
    );
  }

  // The signing keys are fetched from the issuer, so plain HTTP would let
  // anyone on the path swap them. Loopback is allowed for local testing.
  secureUrl('AULA_MCP_OIDC_ISSUER', issuer);

  return {
    kind: 'multi-parent',
    oidc: { issuer, audience, acceptIdTokens: acceptIdToken === '1' },
    setupLogin: resolveSetupLogin(env, setupUrl, setupClientId, setupClientSecret),
  };
}

function resolveSetupLogin(
  env: Env,
  publicUrl: string,
  clientId: string,
  clientSecret: string,
): SetupLoginConfig | null {
  if (!env.AULA_MCP_INGRESS_PORT) {
    if (publicUrl || clientId || clientSecret) {
      throw new ServerModeError(
        'AULA_MCP_SETUP_* settings are set but the setup UI is off (AULA_MCP_INGRESS_PORT).',
      );
    }
    return null;
  }
  const missing = [
    publicUrl ? null : 'AULA_MCP_SETUP_URL',
    clientId ? null : 'AULA_MCP_SETUP_CLIENT_ID',
  ].filter((name) => name !== null);
  if (missing.length > 0) {
    throw new ServerModeError(
      `The setup UI in multi-parent mode requires ${missing.join(' and ')}.\n` +
        'It signs each parent in before their Aula login and will not start without it.',
    );
  }
  // Session cookies are only sent back over https.
  const url = secureUrl('AULA_MCP_SETUP_URL', publicUrl);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ServerModeError(
      `AULA_MCP_SETUP_URL must be an origin without a path, got "${publicUrl}".`,
    );
  }
  return { publicUrl: url.origin, clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/** https, or http on loopback for local testing. */
function secureUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServerModeError(`${name} is not a valid URL: "${value}".`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ServerModeError(
      `${name} must use https (http is only allowed for localhost), got "${value}".`,
    );
  }
  return url;
}
