/**
 * Caller authentication for multi-parent mode. aula-mcp is an OAuth resource
 * server: it validates the access token itself (signature against the
 * issuer's JWKS, `iss`, `aud`, `exp`) and takes the parent's identity from
 * `sub`. It never trusts an identity asserted by a proxy or agent runtime;
 * kagent's trusted-proxy mode, for one, forwards the token without checking
 * its signature.
 */

import { createHash } from 'node:crypto';
import type { Logger } from '@aula-mcp/aula-auth';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { OidcConfig } from './server-mode.ts';

/** Asymmetric algorithms only; an HMAC token would mean a shared secret. */
const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'EdDSA',
];

/** The authenticated parent behind a request. */
export interface Caller {
  issuer: string;
  sub: string;
}

/** Stable, filesystem-safe id for a caller. Includes the issuer so a change of
 *  IdP never maps a new user onto an old user's Aula session. */
export function callerId(caller: Caller): string {
  return createHash('sha256').update(`${caller.issuer}\n${caller.sub}`).digest('hex').slice(0, 32);
}

export function sameCaller(a: Caller, b: Caller): boolean {
  return a.issuer === b.issuer && a.sub === b.sub;
}

/** The request carried no usable token. Maps to 401. */
export class CallerAuthError extends Error {
  override readonly name = 'CallerAuthError';
  constructor(
    readonly code: 'missing_token' | 'invalid_token',
    message: string,
  ) {
    super(message);
  }
}

export type CallerVerifier = (authorization: string | null | undefined) => Promise<Caller>;

export interface OidcVerifierOptions extends OidcConfig {
  /** Key lookup to use instead of discovering the issuer's JWKS (tests). */
  keys?: JWTVerifyGetKey;
  /** Override fetch for discovery (tests). */
  fetch?: typeof fetch;
}

export function createOidcVerifier(options: OidcVerifierOptions): CallerVerifier {
  const { issuer, audience } = options;
  let keysPromise: Promise<JWTVerifyGetKey> | undefined = options.keys
    ? Promise.resolve(options.keys)
    : undefined;
  const keys = (): Promise<JWTVerifyGetKey> => {
    keysPromise ??= discoverKeys(issuer, options.fetch ?? fetch).catch((err: unknown) => {
      // Retry discovery on the next request instead of caching the failure.
      keysPromise = undefined;
      throw err;
    });
    return keysPromise;
  };

  return async (authorization) => {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match?.[1]) throw new CallerAuthError('missing_token', 'Missing bearer token.');
    const getKey = await keys();
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
    try {
      ({ payload } = await jwtVerify(match[1], getKey, {
        issuer,
        audience,
        algorithms: ALGORITHMS,
        requiredClaims: ['sub', 'exp'],
        clockTolerance: 30,
      }));
    } catch (err) {
      if (err instanceof errors.JOSEError) {
        throw new CallerAuthError('invalid_token', 'Invalid or expired token.');
      }
      throw err;
    }
    // Keycloak marks ID tokens with typ "ID". One issued to the aula-mcp
    // client would pass the audience check, but it isn't an access token.
    if (payload.typ === 'ID') {
      throw new CallerAuthError('invalid_token', 'An ID token is not an access token.');
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new CallerAuthError('invalid_token', 'Token has no subject.');
    }
    return { issuer, sub: payload.sub };
  };
}

async function discoverKeys(issuer: string, fetchImpl: typeof fetch): Promise<JWTVerifyGetKey> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${url} returned ${res.status}`);
  const doc = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (doc.issuer !== issuer) {
    throw new Error(
      `OIDC discovery issuer mismatch: configured "${issuer}", provider says "${String(doc.issuer)}"`,
    );
  }
  if (typeof doc.jwks_uri !== 'string') throw new Error('OIDC discovery has no jwks_uri');
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/** RFC 9728 protected resource metadata, so MCP clients can find the IdP. */
export function protectedResourceMetadata(oidc: OidcConfig, resource: string) {
  return {
    resource,
    authorization_servers: [oidc.issuer],
    bearer_methods_supported: ['header'],
  };
}

/** The caller behind a request, or the 401/503 response to send instead. */
export async function authenticateRequest(
  verify: CallerVerifier,
  request: Request,
  logger: Logger,
): Promise<Caller | Response> {
  try {
    return await verify(request.headers.get('authorization'));
  } catch (err) {
    if (err instanceof CallerAuthError) return unauthorizedResponse(err, request);
    // Discovery or key fetch failed: the IdP is unreachable, not the token bad.
    logger.error('aula-mcp.oidc.verify_failed', { error: (err as Error).message });
    return Response.json(
      { error: 'identity_provider_unavailable', message: 'Could not verify the token right now.' },
      { status: 503 },
    );
  }
}

/** 401 with the challenge the MCP authorization spec expects. */
export function unauthorizedResponse(err: CallerAuthError, request: Request): Response {
  const metadata = new URL('/.well-known/oauth-protected-resource', request.url).href;
  const challenge =
    err.code === 'missing_token'
      ? `Bearer resource_metadata="${metadata}"`
      : `Bearer error="invalid_token", error_description="${err.message}", resource_metadata="${metadata}"`;
  return Response.json(
    { error: err.code, message: err.message },
    { status: 401, headers: { 'WWW-Authenticate': challenge } },
  );
}
