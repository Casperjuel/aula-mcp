import { describe, expect, test } from 'bun:test';
import {
  type AulaHttpClient,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
} from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';

function recordExpiringIn(seconds: number): StoredTokenRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: 1,
    username: 'demo',
    tokens: {
      access_token: 'AT',
      refresh_token: 'RT',
      token_type: 'Bearer',
      expires_in: 3600,
      expires_at: now + seconds,
      obtained_at: now,
    },
    saved_at: now,
  };
}

/** In-memory store, so a refresh is visible to the next load. */
class MemoryStore implements TokenStore {
  constructor(public record: StoredTokenRecord | null) {}
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

/** Answers the OAuth token endpoint and counts how often it was hit. */
function tokenEndpoint(): AulaHttpClient & { refreshes: number } {
  const http = {
    refreshes: 0,
    async request() {
      http.refreshes++;
      // Let concurrent callers pile up before the refresh resolves.
      await new Promise((r) => setTimeout(r, 10));
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: `AT${http.refreshes}`,
          refresh_token: `RT${http.refreshes}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };
    },
  };
  return http as unknown as AulaHttpClient & { refreshes: number };
}

function contextWith(record: StoredTokenRecord | null) {
  const store = new MemoryStore(record);
  const http = tokenEndpoint();
  const context = new AulaContext({ store, http, logger: silentLogger });
  return { store, http, context };
}

describe('AulaContext.refreshIfExpiringWithin', () => {
  test('no stored login resolves to false instead of throwing', async () => {
    const { context, http } = contextWith(null);
    expect(await context.refreshIfExpiringWithin(900)).toBe(false);
    expect(http.refreshes).toBe(0);
    context.dispose();
  });

  test('leaves a token with more than the window left alone', async () => {
    const { context, http } = contextWith(recordExpiringIn(3000));
    expect(await context.refreshIfExpiringWithin(900)).toBe(false);
    expect(http.refreshes).toBe(0);
    context.dispose();
  });

  test('renews inside the window and swaps the cached client', async () => {
    const { context, http, store } = contextWith(recordExpiringIn(600));
    const before = await context.getClient();
    expect(await context.refreshIfExpiringWithin(900)).toBe(true);
    expect(http.refreshes).toBe(1);
    expect(store.record?.tokens.access_token).toBe('AT1');
    expect(await context.getClient()).not.toBe(before);
    context.dispose();
  });

  test('shares a refresh already in flight from a tool call', async () => {
    // Expired, so the tool call's getClient() refreshes.
    const { context, http } = contextWith(recordExpiringIn(30));
    const [, renewed] = await Promise.all([
      context.getClient(),
      context.refreshIfExpiringWithin(900),
    ]);
    // One refresh, reused by the keep-alive; the new token is fresh again.
    expect(http.refreshes).toBe(1);
    expect(renewed).toBe(false);
    context.dispose();
  });
});
