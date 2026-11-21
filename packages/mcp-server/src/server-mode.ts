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
 * Every half-configured state is a startup error rather than a guess: the
 * flag without an issuer/audience, or OIDC settings without the flag. A typo
 * must never leave someone believing auth is on when it isn't.
 */

export interface OidcConfig {
  /** Must equal the `iss` claim of the access tokens exactly. */
  issuer: string;
  /** Must appear in the `aud` claim of the access tokens. */
  audience: string;
}

export type ServerMode = { kind: 'single-parent' } | { kind: 'multi-parent'; oidc: OidcConfig };

export class ServerModeError extends Error {
  override readonly name = 'ServerModeError';
}

type Env = Record<string, string | undefined>;

export function resolveServerMode(env: Env): ServerMode {
  const flag = env.AULA_MCP_MULTI_PARENT ?? '';
  const issuer = env.AULA_MCP_OIDC_ISSUER?.trim() ?? '';
  const audience = env.AULA_MCP_OIDC_AUDIENCE?.trim() ?? '';

  if (flag === '' || flag === '0') {
    if (issuer || audience) {
      throw new ServerModeError(
        'AULA_MCP_OIDC_ISSUER / AULA_MCP_OIDC_AUDIENCE are set but multi-parent mode is off.\n' +
          'Set AULA_MCP_MULTI_PARENT=1 to require OIDC, or remove the OIDC settings.',
      );
    }
    return { kind: 'single-parent' };
  }
  if (flag !== '1') {
    throw new ServerModeError(`AULA_MCP_MULTI_PARENT must be 1 or 0, got "${flag}".`);
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

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new ServerModeError(`AULA_MCP_OIDC_ISSUER is not a valid URL: "${issuer}".`);
  }
  // The signing keys are fetched from the issuer, so plain HTTP would let
  // anyone on the path swap them. Loopback is allowed for local testing.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ServerModeError(
      `AULA_MCP_OIDC_ISSUER must use https (http is only allowed for localhost), got "${issuer}".`,
    );
  }

  return { kind: 'multi-parent', oidc: { issuer, audience } };
}
