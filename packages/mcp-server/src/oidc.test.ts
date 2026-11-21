import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@aula-mcp/aula-auth';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT,
} from 'jose';
import {
  authenticateRequest,
  CallerAuthError,
  callerId,
  createOidcVerifier,
  sameCaller,
} from './oidc.ts';

const ISSUER = 'https://id.example.com/realms/home';
const AUDIENCE = 'aula-mcp';

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

function sign(claims: JWTPayload, opts: { key?: CryptoKey; expiresIn?: string } = {}) {
  return new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: 'parent-a', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.key ?? signingKey);
}

function verifier() {
  return createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: createLocalJWKSet({ keys: [publicJwk] }),
  });
}

async function rejection(promise: Promise<unknown>): Promise<CallerAuthError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CallerAuthError) return err;
    throw err;
  }
  throw new Error('expected a CallerAuthError');
}

describe('createOidcVerifier', () => {
  test('a valid access token yields the caller', async () => {
    const caller = await verifier()(`Bearer ${await sign({})}`);
    expect(caller).toEqual({ issuer: ISSUER, sub: 'parent-a' });
  });

  test('a missing or malformed header is missing_token', async () => {
    const verify = verifier();
    expect((await rejection(verify(null))).code).toBe('missing_token');
    expect((await rejection(verify('Basic abc'))).code).toBe('missing_token');
    expect((await rejection(verify('Bearer'))).code).toBe('missing_token');
  });

  test('rejects wrong audience, wrong issuer, expiry and a foreign key', async () => {
    const verify = verifier();
    const tokens = [
      await sign({ aud: 'some-other-api' }),
      await sign({ iss: 'https://evil.example.com' }),
      await sign({}, { expiresIn: '-5m' }),
      await sign({}, { key: otherKey }),
      'not.a.jwt',
    ];
    for (const token of tokens) {
      expect((await rejection(verify(`Bearer ${token}`))).code).toBe('invalid_token');
    }
  });

  test('rejects an HMAC token even with the right claims', async () => {
    const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: 'parent-a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-len'));
    expect((await rejection(verifier()(`Bearer ${token}`))).code).toBe('invalid_token');
  });

  test('rejects a Keycloak ID token', async () => {
    const token = await sign({ typ: 'ID' });
    expect((await rejection(verifier()(`Bearer ${token}`))).code).toBe('invalid_token');
  });

  test('rejects a token without a subject', async () => {
    const token = await sign({ sub: '' });
    expect((await rejection(verifier()(`Bearer ${token}`))).code).toBe('invalid_token');
  });
});

describe('discovery', () => {
  let idp: ReturnType<typeof Bun.serve>;
  let issuer: string;
  let discoveryCalls = 0;
  let advertisedIssuer: (() => string) | undefined;

  beforeAll(() => {
    idp = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === '/realms/home/.well-known/openid-configuration') {
          discoveryCalls += 1;
          return Response.json({
            issuer: advertisedIssuer?.() ?? issuer,
            jwks_uri: `${issuer}/certs`,
          });
        }
        if (pathname === '/realms/home/certs') return Response.json({ keys: [publicJwk] });
        return new Response('not found', { status: 404 });
      },
    });
    issuer = `http://127.0.0.1:${idp.port}/realms/home`;
  });

  afterAll(() => idp.stop(true));

  test('finds the keys through the issuer', async () => {
    advertisedIssuer = undefined;
    const verify = createOidcVerifier({ issuer, audience: AUDIENCE });
    const token = await sign({ iss: issuer });
    expect(await verify(`Bearer ${token}`)).toEqual({ issuer, sub: 'parent-a' });
  });

  test('an issuer mismatch is a 503, and discovery is retried', async () => {
    advertisedIssuer = () => 'https://someone-else.example.com';
    const verify = createOidcVerifier({ issuer, audience: AUDIENCE });
    const request = () =>
      new Request('http://localhost/mcp', { headers: { authorization: 'Bearer x.y.z' } });

    const before = discoveryCalls;
    const first = await authenticateRequest(verify, request(), silentLogger);
    expect(first).toBeInstanceOf(Response);
    expect((first as Response).status).toBe(503);

    await authenticateRequest(verify, request(), silentLogger);
    expect(discoveryCalls - before).toBe(2);
  });
});

describe('authenticateRequest', () => {
  test('a bad token gets a 401 with the resource metadata challenge', async () => {
    const res = await authenticateRequest(
      verifier(),
      new Request('https://aula.example.com/mcp'),
      silentLogger,
    );
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://aula.example.com/.well-known/oauth-protected-resource"',
    );
  });
});

describe('caller identity', () => {
  test('the same sub at another issuer is a different caller', () => {
    const a = { issuer: ISSUER, sub: 'parent-a' };
    const elsewhere = { issuer: 'https://other.example.com', sub: 'parent-a' };
    expect(sameCaller(a, { ...a })).toBe(true);
    expect(sameCaller(a, elsewhere)).toBe(false);
    expect(callerId(a)).not.toBe(callerId(elsewhere));
    expect(callerId(a)).toMatch(/^[0-9a-f]{32}$/);
  });
});
