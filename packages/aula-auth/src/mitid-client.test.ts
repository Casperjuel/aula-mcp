import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { MitidError, parseAuxResponse } from './mitid-client.ts';
import { normalizeAuthenticatorType } from './mitid-types.ts';

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
