import { describe, expect, test } from 'bun:test';
import { resolveServerMode, ServerModeError } from './server-mode.ts';

const OIDC = {
  AULA_MCP_OIDC_ISSUER: 'https://id.example.com/realms/home',
  AULA_MCP_OIDC_AUDIENCE: 'aula-mcp',
};

describe('resolveServerMode', () => {
  test('defaults to single-parent', () => {
    expect(resolveServerMode({})).toEqual({ kind: 'single-parent' });
    expect(resolveServerMode({ AULA_MCP_MULTI_PARENT: '0' })).toEqual({ kind: 'single-parent' });
    expect(resolveServerMode({ AULA_MCP_MULTI_PARENT: '' })).toEqual({ kind: 'single-parent' });
  });

  test('multi-parent with issuer and audience', () => {
    expect(resolveServerMode({ AULA_MCP_MULTI_PARENT: '1', ...OIDC })).toEqual({
      kind: 'multi-parent',
      oidc: { issuer: OIDC.AULA_MCP_OIDC_ISSUER, audience: 'aula-mcp', acceptIdTokens: false },
    });
  });

  test('accepting ID tokens is opt-in and needs multi-parent mode', () => {
    const on = resolveServerMode({
      AULA_MCP_MULTI_PARENT: '1',
      AULA_MCP_OIDC_ACCEPT_ID_TOKEN: '1',
      ...OIDC,
    });
    expect(on.kind === 'multi-parent' && on.oidc.acceptIdTokens).toBe(true);
    expect(() => resolveServerMode({ AULA_MCP_OIDC_ACCEPT_ID_TOKEN: '1' })).toThrow(
      /multi-parent mode is off/,
    );
    expect(() =>
      resolveServerMode({
        AULA_MCP_MULTI_PARENT: '1',
        AULA_MCP_OIDC_ACCEPT_ID_TOKEN: 'yes',
        ...OIDC,
      }),
    ).toThrow(/must be 1 or 0/);
  });

  test('refuses OIDC settings while multi-parent mode is off', () => {
    expect(() => resolveServerMode(OIDC)).toThrow(ServerModeError);
    expect(() => resolveServerMode({ AULA_MCP_OIDC_AUDIENCE: 'aula-mcp' })).toThrow(
      /AULA_MCP_MULTI_PARENT=1/,
    );
  });

  test('refuses a flag value other than 1 or 0', () => {
    expect(() => resolveServerMode({ AULA_MCP_MULTI_PARENT: 'true', ...OIDC })).toThrow(
      /must be 1 or 0/,
    );
  });

  test('refuses multi-parent mode without issuer or audience', () => {
    expect(() => resolveServerMode({ AULA_MCP_MULTI_PARENT: '1' })).toThrow(
      /AULA_MCP_OIDC_ISSUER and AULA_MCP_OIDC_AUDIENCE/,
    );
    expect(() =>
      resolveServerMode({
        AULA_MCP_MULTI_PARENT: '1',
        AULA_MCP_OIDC_ISSUER: OIDC.AULA_MCP_OIDC_ISSUER,
        AULA_MCP_OIDC_AUDIENCE: '  ',
      }),
    ).toThrow(/AULA_MCP_OIDC_AUDIENCE/);
  });

  test('requires https except on loopback', () => {
    const withIssuer = (issuer: string) =>
      resolveServerMode({
        AULA_MCP_MULTI_PARENT: '1',
        AULA_MCP_OIDC_ISSUER: issuer,
        AULA_MCP_OIDC_AUDIENCE: 'aula-mcp',
      });
    expect(() => withIssuer('http://keycloak.lan/realms/home')).toThrow(/must use https/);
    expect(() => withIssuer('not a url')).toThrow(/not a valid URL/);
    expect(withIssuer('http://localhost:8080/realms/home').kind).toBe('multi-parent');
    expect(withIssuer('http://127.0.0.1:8080/realms/home').kind).toBe('multi-parent');
  });
});
