/**
 * The aula-mcp API: the dashboard's data and actions as a versioned JSON API
 * under /api/v1, on its own port (AULA_MCP_API_PORT), multi-parent mode only.
 * It runs in the MCP server's own process because both use the same Aula
 * sessions: a second process would race the first for Aula's rotating refresh
 * token and log the parent out.
 *
 * Every call carries an OIDC access token for the API (issuer as for /mcp,
 * audience AULA_MCP_API_AUDIENCE) and works on the token subject's own data
 * only, or with `?owner=` on what another parent shares with them, read-only.
 * Reads need any valid token. A call that changes something, in Aula or here,
 * also needs the write scope (AULA_MCP_API_WRITE_SCOPE, default aula:write)
 * and lands in the parent's audit log, as from the API or, when the dashboard
 * server sent it, from the dashboard.
 *
 * The secret calendar feed and sharing with another parent are not part of
 * the API: only the dashboard server, which proves itself with the UI key
 * (AULA_MCP_API_UI_KEY), reaches them, and only for the signed-in parent.
 *
 * The routes themselves are the dashboard's (setup-ui.ts); this module checks
 * the caller and maps each API path onto them (api-routes.ts).
 */

import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '@aula-mcp/aula-auth';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { API_BASE, fromApiPath, isRead, isUiOnly, openApiDocument } from './api-routes.ts';
import { CallerAuthError, scopesOf, type TokenVerifier } from './oidc.ts';
import type { SetupLogin, SignedInParent } from './setup-login.ts';
import { createSetupApp, type SetupAppOptions } from './setup-ui.ts';

/** The header the dashboard server sends the UI key in. */
export const UI_KEY_HEADER = 'x-aula-ui-key';

export interface ApiOptions {
  logger: Logger;
  /** Checks the bearer token: signature, issuer and the API's audience. */
  verify: TokenVerifier;
  /** Needed for every change; null lets any valid token change things. */
  writeScope: string | null;
  /** The dashboard server's key; null when there is no dashboard server. */
  uiKey: string | null;
  version: string;
  /** Runs before every route, e.g. request telemetry. */
  middleware?: MiddlewareHandler;
  /** The dashboard's routes, for the token's parent. */
  setup: Omit<SetupAppOptions, 'parents' | 'pages' | 'triggerOf' | 'logger' | 'middleware'> & {
    parents: Omit<NonNullable<SetupAppOptions['parents']>, 'login'>;
  };
}

/** Whether `given` is the UI key, compared in constant time. */
function sameKey(given: string | undefined, key: string | null): boolean {
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function displayName(claims: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'preferred_username', 'email']) {
    const value = claims[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

export function createApiApp(options: ApiOptions): Hono {
  const { logger, verify, writeScope, uiKey } = options;

  // The parent and the source of each forwarded request, for the routes.
  const parents = new WeakMap<Request, SignedInParent>();
  const fromUi = new WeakSet<Request>();
  const login: SetupLogin = {
    mount: () => {},
    parent: (c: Context) => parents.get(c.req.raw) ?? null,
    // A bearer token is never sent by a browser on its own, so there is no
    // cross-site request to refuse; the dashboard server checks its pages.
    sameOrigin: () => true,
  };
  const routes = createSetupApp({
    ...options.setup,
    logger,
    pages: false,
    parents: { ...options.setup.parents, login },
    triggerOf: (c) => (fromUi.has(c.req.raw) ? 'dashboard' : 'api'),
    ...(options.middleware ? { middleware: options.middleware } : {}),
  });

  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get(`${API_BASE}/openapi.json`, (c) => c.json(openApiDocument(options.version, writeScope)));

  app.all(`${API_BASE}/*`, async (c) => {
    const path = fromApiPath(c.req.path);
    if (!path) return c.json({ error: 'not found' }, 404);
    const ui = sameKey(c.req.header(UI_KEY_HEADER), uiKey);
    // Unknown to anyone else, as if the routes were not there.
    if (isUiOnly(path) && !ui) return c.json({ error: 'not found' }, 404);

    // The feed answers to its secret link alone; calendar apps cannot sign in.
    let parent: SignedInParent | null = null;
    if (!path.startsWith('/feed/')) {
      let verified: Awaited<ReturnType<TokenVerifier>>;
      try {
        verified = await verify(c.req.header('authorization'));
      } catch (err) {
        if (err instanceof CallerAuthError) {
          const challenge =
            err.code === 'missing_token'
              ? 'Bearer'
              : `Bearer error="invalid_token", error_description="${err.message}"`;
          return c.json({ error: err.code, message: err.message }, 401, {
            'WWW-Authenticate': challenge,
          });
        }
        logger.error('aula-mcp.api.verify_failed', { error: (err as Error).message });
        return c.json(
          {
            error: 'identity_provider_unavailable',
            message: 'Could not verify the token right now.',
          },
          503,
        );
      }
      if (!isRead(c.req.method) && writeScope && !scopesOf(verified.claims).includes(writeScope)) {
        return c.json(
          { error: 'insufficient_scope', message: `Changes need the ${writeScope} scope.` },
          403,
          { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${writeScope}"` },
        );
      }
      const { claims } = verified;
      parent = {
        caller: verified.caller,
        name: displayName(claims) ?? verified.caller.sub,
        // Shares are matched on the email, so only a verified one counts.
        ...(typeof claims.email === 'string' &&
        claims.email !== '' &&
        claims.email_verified === true
          ? { email: claims.email }
          : {}),
      };
    }

    const url = new URL(c.req.url);
    url.pathname = path;
    const headers = new Headers(c.req.raw.headers);
    headers.delete(UI_KEY_HEADER);
    headers.delete('authorization');
    const request = new Request(url.href, {
      method: c.req.method,
      headers,
      ...(isRead(c.req.method) ? {} : { body: c.req.raw.body, duplex: 'half' }),
      signal: c.req.raw.signal,
    } as RequestInit);
    if (parent) parents.set(request, parent);
    if (ui) fromUi.add(request);
    return routes.fetch(request);
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}
