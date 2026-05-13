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
