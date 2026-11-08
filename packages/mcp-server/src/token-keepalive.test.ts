import { describe, expect, test } from 'bun:test';
import type { AulaHttpClient, StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import { startTokenKeepAlive } from './token-keepalive.ts';

function storeWith(record: StoredTokenRecord | null): TokenStore & { saves: number } {
  const s = {
    saves: 0,
    load: async () => record,
    save: async () => {
      s.saves++;
    },
    clear: async () => {},
  };
  return s as unknown as TokenStore & { saves: number };
}

function recordExpiringIn(seconds: number): StoredTokenRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    tokens: {
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
      expires_at: now + seconds,
    },
    saved_at: now,
  } as unknown as StoredTokenRecord;
}

// Never reached: the cases below don't hit the network.
const http = {} as AulaHttpClient;

describe('startTokenKeepAlive', () => {
  test('does nothing when no tokens are stored', async () => {
    const ka = startTokenKeepAlive({ store: storeWith(null), http, intervalMs: 1e9 });
    expect(await ka.tick()).toBe(false);
    ka.stop();
  });

  test('does nothing while the token is still fresh', async () => {
    const store = storeWith(recordExpiringIn(3000));
    const ka = startTokenKeepAlive({ store, http, intervalMs: 1e9 });
    expect(await ka.tick()).toBe(false);
    expect(store.saves).toBe(0);
    ka.stop();
  });

  test('swallows a failed renewal instead of throwing', async () => {
    // Expiring soon, but http is a stub, so the refresh call throws.
    const ka = startTokenKeepAlive({
      store: storeWith(recordExpiringIn(30)),
      http,
      intervalMs: 1e9,
    });
    expect(await ka.tick()).toBe(false);
    ka.stop();
  });
});
