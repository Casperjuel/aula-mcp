import { describe, expect, test } from 'bun:test';
import {
  formatTraceText,
  InMemoryTracer,
  SECRET_BODY_FIELD_NAMES,
  SECRET_URL_PARAM_NAMES,
  sanitizeHeaders,
  sanitizeLogMeta,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
  type WireEntry,
} from './wire-tracer.ts';

/** Stand-in for a real bearer JWT. No test may let this string survive. */
const JWT = 'eyJhbGciOiJSUzI1NiJ9.PAYLOAD.SIGNATURE';

describe('sanitizeUrl', () => {
  test('redacts access_token in query string', () => {
    const url =
      'https://www.aula.dk/api/v22/?method=profiles.getProfilesByLogin&access_token=eyJhbGciOiJSUzI1NiJ9.long.jwt.value';
    const out = sanitizeUrl(url);
    expect(out).toContain('method=profiles.getProfilesByLogin');
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(out).toContain('access_token=%3Credacted');
  });

  test('redacts every known-secret query param', () => {
    const url = 'https://example.com/?code=AUTHCODE&state=STATE&access_token=AT&ticket=T&keep=ok';
    const out = sanitizeUrl(url);
    expect(out).not.toContain('AUTHCODE');
    expect(out).not.toContain('STATE');
    expect(out).not.toContain('AT');
    expect(out).not.toContain('=T&');
    expect(out).toContain('keep=ok');
  });

  test('returns the URL unchanged when no secrets are present', () => {
    const url = 'https://example.com/x?foo=bar';
    expect(sanitizeUrl(url)).toBe(url);
  });

  test('returns the input unchanged when not a valid URL', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });

  test('redacts refresh_token and id_token too', () => {
    const out = sanitizeUrl(`https://example.com/cb?refresh_token=${JWT}&id_token=${JWT}`);
    expect(out).not.toContain('SIGNATURE');
    expect(out).toContain('refresh_token=%3Credacted');
    expect(out).toContain('id_token=%3Credacted');
  });

  test('is idempotent — a second pass keeps the first redaction verbatim', () => {
    const once = sanitizeUrl(`https://www.aula.dk/api/v22/?access_token=${JWT}`);
    expect(sanitizeUrl(once)).toBe(once);
  });
});

describe('redaction denylist parity', () => {
  // The lists are the thing that silently falls behind when Aula adds a field.
  // Tokens travel in the query string on the API and in the body on the OAuth
  // endpoints, so anything token-shaped has to appear in both.
  test('every *_token field is redacted in both bodies and query strings', () => {
    const bodyFields = new Set(SECRET_BODY_FIELD_NAMES);
    const urlParams = new Set(SECRET_URL_PARAM_NAMES);
    for (const name of ['access_token', 'refresh_token', 'id_token']) {
      expect(bodyFields.has(name)).toBe(true);
      expect(urlParams.has(name)).toBe(true);
    }
    for (const name of [...bodyFields, ...urlParams]) {
      if (!name.endsWith('_token')) continue;
      expect(bodyFields.has(name)).toBe(true);
      expect(urlParams.has(name)).toBe(true);
    }
  });
});

describe('sanitizeLogMeta', () => {
  test('scrubs the access_token out of a logged request URL', () => {
    const meta = sanitizeLogMeta({
      method: 'GET',
      url: `https://www.aula.dk/api/v22/?method=messaging.getThreads&access_token=${JWT}`,
    });
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain(JWT);
    expect(serialised).not.toContain('SIGNATURE');
    expect(serialised).toContain('messaging.getThreads');
    expect(meta?.method).toBe('GET');
  });

  test('redacts secret-named keys whatever the value looks like', () => {
    const meta = sanitizeLogMeta({ access_token: JWT, refresh_token: JWT, id_token: JWT });
    expect(JSON.stringify(meta)).not.toContain('SIGNATURE');
    expect(meta?.access_token).toMatch(/^<redacted/);
    expect(meta?.refresh_token).toMatch(/^<redacted/);
    expect(meta?.id_token).toMatch(/^<redacted/);
  });

  test('recurses into nested objects and arrays', () => {
    const meta = sanitizeLogMeta({
      hops: [{ url: `https://broker.unilogin.dk/cb?code=AUTHCODE&access_token=${JWT}` }],
      tokens: { access_token: JWT },
    });
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain(JWT);
    expect(serialised).not.toContain('AUTHCODE');
  });

  test('leaves harmless meta alone and passes undefined through', () => {
    expect(sanitizeLogMeta({ hop: 3, status: 302 })).toEqual({ hop: 3, status: 302 });
    expect(sanitizeLogMeta(undefined)).toBeUndefined();
  });
});

describe('sanitizeHeaders', () => {
  test('redacts Cookie / Authorization / Set-Cookie / CSRF headers', () => {
    const out = sanitizeHeaders({
      cookie: 'a=b; sessionId=xyz',
      authorization: 'Bearer XYZ',
      'aula-authorization': 'Bearer XYZ',
      'csrfp-token': 'TOKEN',
      'user-agent': 'Mozilla',
    });
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out.authorization).toMatch(/^<redacted/);
    expect(out['aula-authorization']).toMatch(/^<redacted/);
    expect(out['csrfp-token']).toMatch(/^<redacted/);
    expect(out['user-agent']).toBe('Mozilla');
  });

  test('accepts a Headers object', () => {
    const h = new Headers();
    h.set('Cookie', 'val');
    h.set('X-Custom', 'ok');
    const out = sanitizeHeaders(h);
    expect(out.cookie).toMatch(/^<redacted/);
    expect(out['x-custom']).toBe('ok');
  });
});

describe('sanitizeRequestBody', () => {
  test('redacts secret fields in form-urlencoded body', () => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'AUTHCODE',
      code_verifier: 'PKCE_VERIFIER',
      password: 'hunter2',
    });
    const out = sanitizeRequestBody(body);
    expect(out).toContain('grant_type=authorization_code');
    expect(out).toContain('code=%3Credacted');
    expect(out).toContain('password=%3Credacted');
    // code_verifier is also redacted — it's PKCE state and could be used to
    // forge a token exchange against a captured authorization code.
    expect(out).toContain('code_verifier=%3Credacted');
  });

  test('redacts secret fields in JSON body', () => {
    const json = JSON.stringify({
      randomA: { value: 'A_HEX' },
      m1: { value: 'M1_HEX' },
      flowValueProof: { value: 'PROOF' },
      keep_me: 'fine',
    });
    const out = sanitizeRequestBody(json);
    if (out == null) throw new Error('expected non-null');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.randomA).toContain('redacted');
    expect(parsed.m1).toContain('redacted');
    expect(parsed.flowValueProof).toContain('redacted');
    expect(parsed.keep_me).toBe('fine');
  });

  test('binary body is summarised as length only', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    expect(sanitizeRequestBody(buf)).toBe('<binary 4 bytes>');
  });

  test('returns null when body is undefined', () => {
    expect(sanitizeRequestBody(undefined)).toBeNull();
  });
});

describe('sanitizeResponseBody', () => {
  test('truncates long bodies and reports original size', () => {
    const big = 'x'.repeat(10_000);
    const out = sanitizeResponseBody(big, 100);
    expect(out.bytes).toBe(10_000);
    expect(out.text.length).toBeLessThanOrEqual(140);
    expect(out.text.endsWith('chars>')).toBe(true);
  });

  test('redacts SAMLResponse-shaped JSON keys', () => {
    const body = JSON.stringify({ access_token: 'AAA', refresh_token: 'RRR', expires_in: 60 });
    const out = sanitizeResponseBody(body);
    const parsed = JSON.parse(out.text) as Record<string, unknown>;
    expect(parsed.access_token).toContain('redacted');
    expect(parsed.refresh_token).toContain('redacted');
    expect(parsed.expires_in).toBe(60);
  });

  test('redacts a full OIDC token response, id_token included', () => {
    const body = JSON.stringify({
      access_token: JWT,
      refresh_token: JWT,
      id_token: JWT,
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const out = sanitizeResponseBody(body);
    expect(out.text).not.toContain('SIGNATURE');
    expect(out.text).toContain('Bearer');
  });
});

describe('InMemoryTracer + formatTraceText', () => {
  test('captures entries and formats them as text', () => {
    const tracer = new InMemoryTracer();
    const entry: WireEntry = {
      ts: '2026-05-04T01:00:00Z',
      seq: 1,
      method: 'GET',
      url: 'https://example.com/x',
      requestHeaders: { accept: '*/*' },
      requestBody: null,
      status: 200,
      responseHeaders: { 'content-type': 'text/html' },
      responseBody: '<html>hi</html>',
      responseBodyBytes: 15,
      durationMs: 42,
    };
    tracer.record(entry);
    expect(tracer.entries).toHaveLength(1);
    const text = formatTraceText(tracer.entries);
    expect(text).toContain('GET https://example.com/x');
    expect(text).toContain('200 (42 ms, 15 bytes)');
    expect(text).toContain('<html>hi</html>');
  });
});
