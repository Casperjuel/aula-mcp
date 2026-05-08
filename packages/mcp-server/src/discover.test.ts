import { describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import { buildDiscoverManifest } from './discover.ts';

const TOKENS: AulaTokens = {
  access_token: 'AT',
  refresh_token: 'RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

interface FakeOptions {
  widgets?: string[];
  username?: string;
  identityName?: string | null;
  childCount?: number;
}

function fakeContext(opts: FakeOptions = {}): AulaContext {
  const username = opts.username ?? 'cj';
  const identityName = opts.identityName === undefined ? 'Forælder' : opts.identityName;
  const widgets = opts.widgets ?? [];
  const childCount = opts.childCount ?? 1;
  const children = Array.from({ length: childCount }, (_, i) => ({
    id: 1000 + i,
    name: `Child ${i + 1}`,
    userId: 2000 + i,
    institutionProfile: {
      id: 9000 + i,
      institutionName: 'Demo Skole',
      institutionCode: 'D12345',
    },
  }));

  const fakeClient = {
    currentApiVersion: 22,
    async getProfilesByLogin() {
      return { profiles: [{ id: 1, name: 'Casper', children }] };
    },
    async getProfileContext() {
      return {
        userId: 5000,
        pageConfiguration: {
          // Match the live API's nested shape: { widget: { widgetId } }.
          widgetConfigurations: widgets.map((widgetId) => ({ widget: { widgetId } })),
        },
      };
    },
  };

  return {
    record: {
      version: 1 as const,
      username,
      tokens: TOKENS,
      saved_at: Math.floor(Date.now() / 1000),
      ...(identityName !== null ? { identityName } : {}),
    },
    async getClient(): Promise<AulaClient> {
      return fakeClient as unknown as AulaClient;
    },
  } as unknown as AulaContext;
}

describe('buildDiscoverManifest', () => {
  test('basic shape: user, children, apiVersion, tokens, capabilities', async () => {
    const m = await buildDiscoverManifest(fakeContext());
    expect(m.user.username).toBe('cj');
    expect(m.user.identityName).toBe('Forælder');
    expect(m.children).toHaveLength(1);
    expect(m.children[0]?.name).toBe('Child 1');
    expect(m.children[0]?.institution?.code).toBe('D12345');
    expect(m.apiVersion).toBe(22);
    expect(m.tokens.seconds_remaining).toBeGreaterThan(0);
    // Always present capability blocks:
    expect(Object.keys(m.capabilities).sort()).toEqual([
      'calendar',
      'huskelisten',
      'lektier',
      'messages',
      'notifications',
      'opgaver',
      'posts',
      'presence',
      'profiles',
      'ugebrev',
      'ugeplan',
    ]);
  });

  test('detectedWidgets is empty when no widget configs are reported', async () => {
    const m = await buildDiscoverManifest(fakeContext({ widgets: [] }));
    expect(m.detectedWidgets).toEqual([]);
    // Capabilities for which no widget is detected get an inline note.
    expect(m.capabilities.ugeplan?.notes).toBeDefined();
    expect(m.capabilities.opgaver?.notes).toBeDefined();
  });

  test('Meebook widget (0004) → meebook tool listed first for ugeplan', async () => {
    const m = await buildDiscoverManifest(fakeContext({ widgets: ['0004'] }));
    expect(m.detectedWidgets).toContain('0004');
    expect(m.capabilities.ugeplan?.tools).toEqual(['aula.ugeplan.meebook']);
    expect(m.capabilities.ugeplan?.summary).toContain('meebook');
    // Meebook surfaces the one-time browser SSO prerequisite as a note.
    expect(m.capabilities.ugeplan?.notes).toContain('Meebook');
  });

  test('EasyIQ SkolePortal widget (0128) → easyiq_skoleportal listed first', async () => {
    const m = await buildDiscoverManifest(fakeContext({ widgets: ['0128'] }));
    expect(m.detectedWidgets).toContain('0128');
    expect(m.capabilities.ugeplan?.tools[0]).toBe('aula.ugeplan.easyiq_skoleportal');
  });

  test('all known widgets light up their respective capabilities', async () => {
    const m = await buildDiscoverManifest(
      fakeContext({ widgets: ['0001', '0029', '0030', '0062', '0128', '0142'] }),
    );
    expect(m.detectedWidgets).toEqual(['0001', '0029', '0030', '0062', '0128', '0142']);
    // ugeplan has both EasyIQ and SkolePortal detected
    expect(m.capabilities.ugeplan?.tools).toContain('aula.ugeplan.easyiq');
    expect(m.capabilities.ugeplan?.tools).toContain('aula.ugeplan.easyiq_skoleportal');
    // lektier surfaces only when 0142 is detected.
    expect(m.capabilities.lektier?.tools).toEqual(['aula.lektier.easyiq']);
    expect(m.capabilities.lektier?.notes).toBeUndefined();
    // No 'not detected' notes for these capabilities
    expect(m.capabilities.opgaver?.notes).toBeUndefined();
    expect(m.capabilities.ugebrev?.notes).toBeUndefined();
    expect(m.capabilities.huskelisten?.notes).toBeUndefined();
  });

  test('lektier carries a "not detected" note when 0142 absent', async () => {
    const m = await buildDiscoverManifest(fakeContext({ widgets: [] }));
    expect(m.capabilities.lektier?.notes).toContain('0142');
  });

  test('rawRequestEnabled reflects AULA_MCP_RAW env', async () => {
    const original = process.env.AULA_MCP_RAW;
    process.env.AULA_MCP_RAW = '1';
    try {
      const m = await buildDiscoverManifest(fakeContext());
      expect(m.rawRequestEnabled).toBe(true);
    } finally {
      if (original === undefined) delete process.env.AULA_MCP_RAW;
      else process.env.AULA_MCP_RAW = original;
    }
  });

  test('omits identityName when not set in record', async () => {
    const m = await buildDiscoverManifest(fakeContext({ identityName: null }));
    expect(m.user.identityName).toBeUndefined();
  });
});
