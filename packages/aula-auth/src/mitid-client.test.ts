import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import type { AulaHttpClient, AulaResponse } from './http.ts';
import {
  MitidAuthenticatorUnavailableError,
  MitidClient,
  MitidError,
  parseAuxResponse,
} from './mitid-client.ts';
import { normalizeAuthenticatorType, resolveOfferedCombinationIds } from './mitid-types.ts';

describe('parseAuxResponse', () => {
  function buildAuxBody(inner: unknown): string {
    const auxB64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    return JSON.stringify({ Aux: auxB64 });
  }

  test('decodes a well-formed Aux blob', () => {
    const body = buildAuxBody({
      coreClient: { checksum: Buffer.from('cafebabe', 'hex').toString('base64') },
      parameters: { authenticationSessionId: '11111111-2222-3333-4444-555555555555' },
    });
    const out = parseAuxResponse(body);
    expect(out.clientHash).toBe('cafebabe');
    expect(out.authenticationSessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  test('accepts already-parsed object form', () => {
    const auxB64 = Buffer.from(
      JSON.stringify({
        coreClient: { checksum: Buffer.from('00ff', 'hex').toString('base64') },
        parameters: { authenticationSessionId: 'abc' },
      }),
      'utf8',
    ).toString('base64');
    const out = parseAuxResponse({ Aux: auxB64 });
    expect(out.clientHash).toBe('00ff');
    expect(out.authenticationSessionId).toBe('abc');
  });

  test('handles the double-JSON-encoded body that nemlog-in.mitid.dk actually returns', () => {
    // Real shape captured from a live login: the HTTP body is a JSON string
    // whose contents are the actual JSON object (so parsing once yields a
    // string, not the object).
    const inner = {
      coreClient: { checksum: Buffer.from('cafebabe', 'hex').toString('base64') },
      parameters: { authenticationSessionId: '78b4810a-e1e7-4e04-8fb4-650d7d9c81ef' },
    };
    const auxB64 = Buffer.from(JSON.stringify(inner), 'utf8').toString('base64');
    const innerObject = JSON.stringify({ Aux: auxB64 });
    const doubleEncodedBody = JSON.stringify(innerObject); // wraps the whole thing as a JSON string
    const out = parseAuxResponse(doubleEncodedBody);
    expect(out.clientHash).toBe('cafebabe');
    expect(out.authenticationSessionId).toBe('78b4810a-e1e7-4e04-8fb4-650d7d9c81ef');
  });

  test('throws when Aux missing', () => {
    expect(() => parseAuxResponse('{}')).toThrow(MitidError);
  });

  test('throws when Aux is not valid base64-JSON', () => {
    expect(() => parseAuxResponse(JSON.stringify({ Aux: 'not-base64-of-json' }))).toThrow(
      MitidError,
    );
  });

  test('throws when checksum or sessionId missing', () => {
    const body = buildAuxBody({ coreClient: {}, parameters: {} });
    expect(() => parseAuxResponse(body)).toThrow(MitidError);
  });
});

describe('normalizeAuthenticatorType', () => {
  test('maps the server\'s "TOKEN" (hardware kodeviser) to CODE_TOKEN', () => {
    expect(normalizeAuthenticatorType('TOKEN')).toBe('CODE_TOKEN');
  });

  test('passes APP, PASSWORD and CODE_TOKEN through unchanged', () => {
    expect(normalizeAuthenticatorType('APP')).toBe('APP');
    expect(normalizeAuthenticatorType('PASSWORD')).toBe('PASSWORD');
    expect(normalizeAuthenticatorType('CODE_TOKEN')).toBe('CODE_TOKEN');
  });
});

// Combinations as MitID offers them after identifyAsUser (upstream #365).
const APP = { id: 'S3', combinationItems: [{ name: 'MitID app' }] };
const APP_CHIP = { id: 'S4', combinationItems: [{ name: 'MitID app + chip' }] };
const APP_LOW = { id: 'L2', combinationItems: [{ name: 'MitID app' }] };
const KODEVISER = { id: 'S1', combinationItems: [{ name: 'MitID kodeviser' }] };
const UNKNOWN = { id: 'S2', combinationItems: [{ name: '?' }] };

describe('resolveOfferedCombinationIds', () => {
  test('uses the ID the account was offered when the static one is missing', () => {
    expect(resolveOfferedCombinationIds([APP_CHIP])).toEqual({ APP: 'S4' });
    expect(resolveOfferedCombinationIds([APP_LOW, KODEVISER])).toEqual({
      APP: 'L2',
      CODE_TOKEN: 'S1',
    });
  });

  test('prefers the static ID when several variants are offered', () => {
    expect(resolveOfferedCombinationIds([APP_CHIP, APP, APP_LOW])).toEqual({ APP: 'S3' });
  });

  test('skips unknown combination IDs', () => {
    expect(resolveOfferedCombinationIds([UNKNOWN, KODEVISER])).toEqual({ CODE_TOKEN: 'S1' });
    expect(resolveOfferedCombinationIds([UNKNOWN])).toEqual({});
  });
});

/** Scripted MitID backend: answers requests in order and records them. */
function fakeMitid(responses: unknown[]) {
  const sent: Array<{ url: string; body: unknown }> = [];
  const http = {
    async request(url: string, opts: { method?: string; body?: unknown } = {}) {
      sent.push({ url, body: opts.body });
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected request: ${url}`);
      return {
        status: 200,
        headers: new Headers(),
        body: JSON.stringify(next),
        url,
      } satisfies AulaResponse;
    },
  };
  return { http: http as unknown as AulaHttpClient, sent };
}

function nextResponse(authenticatorType: string, combinations: unknown[] = []) {
  return {
    nextAuthenticator: {
      authenticatorType,
      authenticatorSessionFlowKey: 'flow',
      eafeHash: 'eafe',
      authenticatorSessionId: `${authenticatorType}-session`,
    },
    combinations,
  };
}

async function identifiedClient(defaultType: string, combinations: unknown[], extra: unknown[]) {
  const mitid = fakeMitid([
    {
      brokerSecurityContext: 'ctx',
      serviceProviderName: 'Aula',
      referenceTextHeader: '',
      referenceTextBody: '',
    },
    {},
    nextResponse(defaultType, combinations),
    ...extra,
  ]);
  const client = await MitidClient.create({
    http: mitid.http,
    aux: { clientHash: 'ab', authenticationSessionId: 'session-1' },
  });
  const available = await client.identifyAsUser('user');
  return { client, available, sent: mitid.sent };
}

describe('MitidClient authenticator selection', () => {
  test('posts the combination ID the account was offered (S4, not S3)', async () => {
    const { client, sent } = await identifiedClient(
      'TOKEN',
      [APP_CHIP, KODEVISER],
      [nextResponse('APP'), { pollUrl: 'https://www.mitid.dk/poll', ticket: 't' }],
    );
    await client.startAppAuth();
    expect(JSON.parse(sent[3]?.body as string)).toEqual({ combinationId: 'S4' });
  });

  test('fails clearly when the account was not offered the authenticator', async () => {
    const { client, available, sent } = await identifiedClient('TOKEN', [KODEVISER, UNKNOWN], []);
    expect(available).toEqual({ CODE_TOKEN: 'MitID kodeviser' });
    const err = await client.startAppAuth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MitidAuthenticatorUnavailableError);
    expect((err as Error).message).toContain('APP authentication is not available');
    expect((err as Error).message).toContain('available: CODE_TOKEN');
    // Nothing was posted for the missing authenticator.
    expect(sent).toHaveLength(3);
  });

  test('falls back to the static table when MitID listed no combinations', async () => {
    const { client, sent } = await identifiedClient(
      'TOKEN',
      [],
      [nextResponse('APP'), { pollUrl: 'https://www.mitid.dk/poll', ticket: 't' }],
    );
    await client.startAppAuth();
    expect(JSON.parse(sent[3]?.body as string)).toEqual({ combinationId: 'S3' });
  });
});
