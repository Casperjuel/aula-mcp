/**
 * Route-shape tests for the in-addon setup/login UI. We don't drive a real
 * MitID login here (that would need a network mock plus the real Aula
 * fixtures and is the domain of the integration suite); we just pin the
 * routes' contracts so a refactor can't silently change them.
 */

import { describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { createSetupApp } from './setup-ui.ts';

class MemoryStore implements TokenStore {
  private record: StoredTokenRecord | null = null;
  async load(): Promise<StoredTokenRecord | null> {
    return this.record;
  }
  async save(record: StoredTokenRecord): Promise<void> {
    this.record = record;
  }
  async clear(): Promise<void> {
    this.record = null;
  }
}

const SAMPLE_RECORD: StoredTokenRecord = {
  version: 1,
  username: 'demo',
  tokens: {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    obtained_at: Math.floor(Date.now() / 1000),
  },
  saved_at: Math.floor(Date.now() / 1000),
};

describe('createSetupApp', () => {
  test('GET /data serves the read-only My data page', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(new Request('http://test/data'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Mine data');
    // Relative paths, so the page also works behind HA ingress.
    expect(body).toContain("getJson('data/summary')");
  });

  test('GET /data/summary says what is stored and never returns the tokens', async () => {
    const store = new MemoryStore();
    await store.save(SAMPLE_RECORD);
    const app = createSetupApp({ store, autoRenew: true });
    const res = await app.fetch(new Request('http://test/data/summary'));
    const text = await res.text();
    expect(text).not.toContain('"AT"');
    expect(text).not.toContain('"RT"');
    const body = JSON.parse(text) as {
      parent: unknown;
      login: { logged_in: boolean; username: string; auto_renew: boolean };
      stored: Array<{ what: string }>;
      not_stored: string[];
    };
    expect(body.parent).toBeNull();
    expect(body.login).toMatchObject({ logged_in: true, username: 'demo', auto_renew: true });
    expect(body.stored.map((item) => item.what)).toContain('Dit Aula-login');
    expect(body.not_stored.length).toBeGreaterThan(0);
  });

  test('GET /data/summary without a login lists no Aula login', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const body = (await (await app.fetch(new Request('http://test/data/summary'))).json()) as {
      login: { logged_in: boolean };
      stored: Array<{ what: string }>;
    };
    expect(body.login.logged_in).toBe(false);
    expect(body.stored.map((item) => item.what)).not.toContain('Dit Aula-login');
  });

  test('GET /data/tools lists every tool, gated ones marked off', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const { tools } = (await (await app.fetch(new Request('http://test/data/tools'))).json()) as {
      tools: Array<{ name: string; enabled: boolean }>;
    };
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((tool) => typeof tool.enabled === 'boolean')).toBe(true);
  });

  test('GET /data/live needs a live context and an Aula login', async () => {
    const without = createSetupApp({ store: new MemoryStore() });
    expect((await without.fetch(new Request('http://test/data/live'))).status).toBe(404);

    const contextFor = () => {
      throw new Error('should not read Aula without a login');
    };
    const notLoggedIn = createSetupApp({ store: new MemoryStore(), myData: { contextFor } });
    expect((await notLoggedIn.fetch(new Request('http://test/data/live'))).status).toBe(409);
  });

  test('GET / serves the login HTML', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(new Request('http://test/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('aula-mcp');
    // The page wires up EventSource for SSE — pin that so a refactor
    // can't accidentally remove it.
    expect(body).toContain('EventSource');
    expect(body).toContain('login/start');
  });

  test('GET /status reports not logged in when store is empty', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(new Request('http://test/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logged_in: boolean };
    expect(body.logged_in).toBe(false);
  });

  test('GET /status reports current token state when store has a record', async () => {
    const store = new MemoryStore();
    await store.save(SAMPLE_RECORD);
    const app = createSetupApp({ store });
    const res = await app.fetch(new Request('http://test/status'));
    const body = (await res.json()) as {
      logged_in: boolean;
      username: string;
      seconds_remaining: number;
    };
    expect(body.logged_in).toBe(true);
    expect(body.username).toBe('demo');
    expect(body.seconds_remaining).toBeGreaterThan(0);
    expect(body).toMatchObject({ auto_renew: false, renews_at: null, seconds_until_renew: null });
  });

  test('GET /status says when the keep-alive renews next', async () => {
    const store = new MemoryStore();
    await store.save(SAMPLE_RECORD);
    const app = createSetupApp({ store, autoRenew: true });
    const body = (await (await app.fetch(new Request('http://test/status'))).json()) as {
      auto_renew: boolean;
      renews_at: number;
      seconds_until_renew: number;
    };
    expect(body.auto_renew).toBe(true);
    // Renewal starts 15 minutes before the access token expires.
    expect(body.renews_at).toBe(SAMPLE_RECORD.tokens.expires_at - 15 * 60);
    expect(body.seconds_until_renew).toBeGreaterThanOrEqual(0);
  });

  test('POST /login/start rejects missing username', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(
      new Request('http://test/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /login/start with invalid JSON returns 400', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(
      new Request('http://test/login/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  test('GET /login/events without sessionId returns 400', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(new Request('http://test/login/events'));
    expect(res.status).toBe(400);
  });

  test('GET /login/events with unknown sessionId returns 404', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(
      new Request('http://test/login/events?sessionId=00000000-0000-0000-0000-000000000000'),
    );
    expect(res.status).toBe(404);
  });

  test('POST /login/identity without sessionId returns 400', async () => {
    const app = createSetupApp({ store: new MemoryStore() });
    const res = await app.fetch(
      new Request('http://test/login/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: 0 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /logout clears the store', async () => {
    const store = new MemoryStore();
    await store.save(SAMPLE_RECORD);
    const app = createSetupApp({ store });
    const res = await app.fetch(new Request('http://test/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await store.load()).toBeNull();
  });
});
