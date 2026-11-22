import { describe, expect, test } from 'bun:test';
import { resolveApi, resolveServerMode, resolveUiServer, ServerModeError } from './server-mode.ts';

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
      setupLogin: null,
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

  describe('setup UI sign-in', () => {
    const SETUP = {
      AULA_MCP_MULTI_PARENT: '1',
      AULA_MCP_INGRESS_PORT: '8099',
      AULA_MCP_SETUP_URL: 'https://aula-setup.example.com',
      AULA_MCP_SETUP_CLIENT_ID: 'aula-mcp-setup',
      ...OIDC,
    };
    const setupLogin = (env: Record<string, string | undefined>) => {
      const mode = resolveServerMode(env);
      return mode.kind === 'multi-parent' ? mode.setupLogin : undefined;
    };

    test('the setup UI in multi-parent mode gets its sign-in config', () => {
      expect(setupLogin(SETUP)).toEqual({
        publicUrl: 'https://aula-setup.example.com',
        clientId: 'aula-mcp-setup',
      });
      expect(setupLogin({ ...SETUP, AULA_MCP_SETUP_CLIENT_SECRET: 's3cret' })?.clientSecret).toBe(
        's3cret',
      );
      expect(
        setupLogin({ ...SETUP, AULA_MCP_SETUP_URL: 'https://aula-setup.example.com/' }),
      ).toEqual({ publicUrl: 'https://aula-setup.example.com', clientId: 'aula-mcp-setup' });
    });

    test('refuses the setup UI in multi-parent mode without a sign-in', () => {
      expect(() => resolveServerMode({ ...SETUP, AULA_MCP_SETUP_URL: undefined })).toThrow(
        /requires AULA_MCP_SETUP_URL/,
      );
      expect(() => resolveServerMode({ ...SETUP, AULA_MCP_SETUP_CLIENT_ID: '' })).toThrow(
        /requires AULA_MCP_SETUP_CLIENT_ID/,
      );
    });

    test('refuses an insecure or non-origin setup URL', () => {
      expect(() =>
        resolveServerMode({ ...SETUP, AULA_MCP_SETUP_URL: 'http://aula-setup.lan' }),
      ).toThrow(/must use https/);
      expect(() =>
        resolveServerMode({ ...SETUP, AULA_MCP_SETUP_URL: 'https://example.com/aula' }),
      ).toThrow(/without a path/);
      expect(setupLogin({ ...SETUP, AULA_MCP_SETUP_URL: 'http://localhost:8099' })?.publicUrl).toBe(
        'http://localhost:8099',
      );
    });

    test('refuses setup settings that would do nothing', () => {
      expect(() => resolveServerMode({ ...SETUP, AULA_MCP_INGRESS_PORT: undefined })).toThrow(
        /setup UI is off/,
      );
      expect(() =>
        resolveServerMode({
          AULA_MCP_SETUP_CLIENT_ID: 'aula-mcp-setup',
          AULA_MCP_INGRESS_PORT: '8099',
        }),
      ).toThrow(/multi-parent mode is off/);
    });

    test('single-parent mode keeps its setup UI without a sign-in', () => {
      expect(resolveServerMode({ AULA_MCP_INGRESS_PORT: '8099' })).toEqual({
        kind: 'single-parent',
      });
    });
  });
});

describe('resolveApi', () => {
  const multi = resolveServerMode({ AULA_MCP_MULTI_PARENT: '1', ...OIDC });
  const KEY = 'k'.repeat(32);

  test('off unless a port is set, and then nothing else may be set', () => {
    expect(resolveApi({}, multi)).toBeNull();
    expect(() => resolveApi({ AULA_MCP_API_UI_KEY: KEY }, multi)).toThrow(ServerModeError);
  });

  test('defaults: the /mcp audience and the aula:write scope', () => {
    expect(resolveApi({ AULA_MCP_API_PORT: '8080' }, multi)).toEqual({
      port: 8080,
      audience: 'aula-mcp',
      writeScope: 'aula:write',
      uiKey: null,
      uiUrl: null,
    });
    const own = resolveApi(
      {
        AULA_MCP_API_PORT: '8080',
        AULA_MCP_API_AUDIENCE: 'aula-mcp-api',
        AULA_MCP_API_WRITE_SCOPE: '',
        AULA_MCP_API_UI_KEY: KEY,
        AULA_MCP_UI_URL: 'https://aula.example.com/',
      },
      multi,
    );
    expect(own).toMatchObject({
      audience: 'aula-mcp-api',
      writeScope: null,
      uiKey: KEY,
      uiUrl: 'https://aula.example.com',
    });
  });

  test('needs multi-parent mode, a real port, a long UI key and its URL', () => {
    expect(() => resolveApi({ AULA_MCP_API_PORT: '8080' }, { kind: 'single-parent' })).toThrow(
      /multi-parent/,
    );
    expect(() => resolveApi({ AULA_MCP_API_PORT: 'x' }, multi)).toThrow(/valid port/);
    expect(() =>
      resolveApi(
        { AULA_MCP_API_PORT: '8080', AULA_MCP_API_UI_KEY: 'short', AULA_MCP_UI_URL: 'https://a.b' },
        multi,
      ),
    ).toThrow(/at least 32/);
    expect(() =>
      resolveApi({ AULA_MCP_API_PORT: '8080', AULA_MCP_API_UI_KEY: KEY }, multi),
    ).toThrow(/AULA_MCP_UI_URL/);
  });
});

describe('resolveUiServer', () => {
  const env = {
    AULA_MCP_OIDC_ISSUER: OIDC.AULA_MCP_OIDC_ISSUER,
    AULA_MCP_UI_URL: 'https://aula.example.com',
    AULA_MCP_UI_CLIENT_ID: 'aula-mcp-ui',
    AULA_MCP_API_URL: 'http://aula-mcp-api:8080',
    AULA_MCP_API_UI_KEY: 'k'.repeat(32),
  };

  test('reads its settings, with port 8099 and the aula:write scope by default', () => {
    expect(resolveUiServer(env)).toEqual({
      port: 8099,
      issuer: OIDC.AULA_MCP_OIDC_ISSUER,
      login: { publicUrl: 'https://aula.example.com', clientId: 'aula-mcp-ui' },
      scopes: ['aula:write'],
      apiUrl: 'http://aula-mcp-api:8080',
      uiKey: 'k'.repeat(32),
    });
    expect(resolveUiServer({ ...env, AULA_MCP_UI_SCOPES: 'a, b' }).scopes).toEqual(['a', 'b']);
  });

  test('refuses a missing setting, plain http in the browser, or a short key', () => {
    for (const name of Object.keys(env)) {
      expect(() => resolveUiServer({ ...env, [name]: '' })).toThrow(name);
    }
    expect(() => resolveUiServer({ ...env, AULA_MCP_UI_URL: 'http://aula.example.com' })).toThrow(
      /https/,
    );
    expect(() => resolveUiServer({ ...env, AULA_MCP_API_UI_KEY: 'short' })).toThrow(/32/);
    expect(() => resolveUiServer({ ...env, AULA_MCP_API_URL: 'ftp://x' })).toThrow(/http/);
  });
});
