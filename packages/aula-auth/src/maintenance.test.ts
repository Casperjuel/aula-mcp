import { describe, expect, test } from 'bun:test';
import { AulaLoginClient } from './aula-login-client.ts';
import { DEFAULT_OAUTH_CONFIG, OAuthError, refreshAccessToken } from './aula-oauth.ts';
import { AulaMaintenanceError, isAulaMaintenancePage } from './errors.ts';
import type { AulaHttpClient } from './http.ts';

// Shape of the notice login.aula.dk served during the 2026-10-21 window (#139).
const NOTICE = `<!doctype html><html><head><title>Aula</title></head><body>
  <h1>Aula er midlertidigt utilgængelig</h1>
  <p>Aula bliver opdateret og er derfor ikke tilgængelig på nuværende tidspunkt.</p>
  <a href="https://aulainfo.dk/driftstatus">Driftstatus</a>
</body></html>`;

type Res = { status: number; body?: string; location?: string };

function fakeHttp(responses: Res[]) {
  const urls: string[] = [];
  const http = {
    request: async (url: string) => {
      urls.push(url);
      const r = responses.shift();
      if (!r) throw new Error(`unexpected request to ${url}`);
      return {
        status: r.status,
        url,
        body: r.body ?? '',
        headers: new Headers(r.location ? { location: r.location } : {}),
      };
    },
  };
  return { http: http as unknown as AulaHttpClient, urls };
}

describe('isAulaMaintenancePage', () => {
  test('recognises the maintenance notice', () => {
    expect(isAulaMaintenancePage(NOTICE)).toBe(true);
  });

  test('does not flag an ordinary page', () => {
    expect(isAulaMaintenancePage('<html><title>Aula</title><div id="app"></div></html>')).toBe(
      false,
    );
  });
});

describe('refreshAccessToken during maintenance', () => {
  test('a 302 to the notice page throws AulaMaintenanceError', async () => {
    const { http, urls } = fakeHttp([
      { status: 302, location: '/' },
      { status: 200, body: NOTICE },
    ]);
    const err = await refreshAccessToken(http, DEFAULT_OAUTH_CONFIG, 'RT').catch((e) => e);
    expect(err).toBeInstanceOf(AulaMaintenanceError);
    expect(err.message).toContain('aulainfo.dk/driftstatus');
    expect(urls[1]).toBe('https://login.aula.dk/');
  });

  test('a 302 elsewhere keeps the original OAuthError', async () => {
    const { http } = fakeHttp([
      { status: 302, location: '/' },
      { status: 200, body: '<html>login</html>' },
    ]);
    const err = await refreshAccessToken(http, DEFAULT_OAUTH_CONFIG, 'RT').catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.message).toContain('status 302');
  });

  test('never follows a redirect off aula.dk', async () => {
    const { http, urls } = fakeHttp([{ status: 302, location: 'https://evil.example/' }]);
    const err = await refreshAccessToken(http, DEFAULT_OAUTH_CONFIG, 'RT').catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(urls.length).toBe(1);
  });

  test('a plain 400 is reported as before, without an extra request', async () => {
    const { http, urls } = fakeHttp([{ status: 400, body: '{"error":"invalid_grant"}' }]);
    const err = await refreshAccessToken(http, DEFAULT_OAUTH_CONFIG, 'RT').catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(urls.length).toBe(1);
  });
});

describe('login chain during maintenance', () => {
  test('authorize.php -> / notice throws AulaMaintenanceError, not "unexpected host"', async () => {
    const { http } = fakeHttp([
      { status: 302, location: '/?response_type=code' },
      { status: 200, body: NOTICE },
    ]);
    const client = new AulaLoginClient({ http });
    // biome-ignore lint/suspicious/noExplicitAny: exercising the private chain walker
    const walk = (client as any).walkOauthChain.bind(client);
    const err = await walk(
      'https://login.aula.dk/simplesaml/module.php/oidc/authorize.php?x=1',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AulaMaintenanceError);
    expect((err as Error).message).toContain('hop 1');
  });
});
