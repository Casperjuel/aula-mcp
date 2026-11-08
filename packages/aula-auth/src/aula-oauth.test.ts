import { describe, expect, test } from 'bun:test';
import {
  buildAuthorizeUrl,
  DEFAULT_OAUTH_CONFIG,
  isTokenExpired,
  OAuthError,
  oauthUrls,
  parseAuthorizationCallback,
  parseTokenResponse,
} from './aula-oauth.ts';

describe('buildAuthorizeUrl', () => {
  test('emits all PKCE + OAuth params in the spec order', () => {
    const url = buildAuthorizeUrl({
      config: DEFAULT_OAUTH_CONFIG,
      state: 'STATE',
      codeChallenge: 'CHALLENGE',
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(
      'https://login.aula.dk/simplesaml/module.php/oidc/authorize.php',
    );
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(DEFAULT_OAUTH_CONFIG.clientId);
    expect(u.searchParams.get('scope')).toBe('aula-sensitive');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app-private.aula.dk');
    expect(u.searchParams.get('state')).toBe('STATE');
    expect(u.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('parseAuthorizationCallback', () => {
  test('extracts code + state from a callback URL', () => {
    const out = parseAuthorizationCallback(
      'https://app-private.aula.dk?code=AUTHCODE&state=STATE&extra=x',
    );
    expect(out).toEqual({ code: 'AUTHCODE', state: 'STATE' });
  });

  test('throws on missing code', () => {
    expect(() => parseAuthorizationCallback('https://app-private.aula.dk?state=STATE')).toThrow(
      OAuthError,
    );
  });

  test('throws on missing state', () => {
    expect(() => parseAuthorizationCallback('https://app-private.aula.dk?code=X')).toThrow(
      OAuthError,
    );
  });
});

describe('parseTokenResponse', () => {
  test('parses a standard token response', () => {
    const tokens = parseTokenResponse(
      JSON.stringify({
        access_token: 'AAA',
        refresh_token: 'RRR',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    expect(tokens.access_token).toBe('AAA');
    expect(tokens.refresh_token).toBe('RRR');
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('uses fallback refresh token if server omits one', () => {
    const tokens = parseTokenResponse(
      JSON.stringify({ access_token: 'AAA', token_type: 'Bearer', expires_in: 100 }),
      'OLD_RT',
    );
    expect(tokens.refresh_token).toBe('OLD_RT');
  });

  test('rejects non-Bearer token types', () => {
    expect(() =>
      parseTokenResponse(
        JSON.stringify({
          access_token: 'A',
          refresh_token: 'R',
          token_type: 'Mac',
          expires_in: 60,
        }),
      ),
    ).toThrow(OAuthError);
  });

  test('rejects responses missing access_token', () => {
    expect(() =>
      parseTokenResponse(JSON.stringify({ expires_in: 60, refresh_token: 'R' })),
    ).toThrow(OAuthError);
  });

  test('rejects non-JSON body', () => {
    expect(() => parseTokenResponse('not json')).toThrow(OAuthError);
  });
});

describe('isTokenExpired', () => {
  test('treats just-issued tokens as not expired', () => {
    const expires_at = Math.floor(Date.now() / 1000) + 3600;
    expect(isTokenExpired({ expires_at })).toBe(false);
  });

  test('considers tokens within the buffer window expired', () => {
    const expires_at = Math.floor(Date.now() / 1000) + 30;
    expect(isTokenExpired({ expires_at }, 60)).toBe(true);
  });
});

describe('oauthUrls', () => {
  test('post-broker-login URL includes all four query params', () => {
    const url = oauthUrls.postBrokerLogin(DEFAULT_OAUTH_CONFIG, {
      sessionCode: 'sc',
      execution: 'ex',
      clientId: 'cid',
      tabId: 'tid',
    });
    const u = new URL(url);
    expect(u.searchParams.get('session_code')).toBe('sc');
    expect(u.searchParams.get('execution')).toBe('ex');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('tab_id')).toBe('tid');
  });

  test('broker SAML endpoint defaults to nemlogin3 and takes an alias', () => {
    expect(oauthUrls.brokerSamlEndpoint(DEFAULT_OAUTH_CONFIG)).toBe(
      'https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3/endpoint',
    );
    expect(oauthUrls.brokerSamlEndpoint(DEFAULT_OAUTH_CONFIG, 'nemlogin3_privat')).toBe(
      'https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3_privat/endpoint',
    );
  });
});
