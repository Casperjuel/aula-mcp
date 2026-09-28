/**
 * KeychainTokenStore tests. Skipped on non-darwin (the `security` CLI is
 * macOS-only). Each test uses a unique service name so concurrent runs and
 * the user's real keychain don't collide.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from './crypto.ts';
import { KeychainTokenStore } from './keychain-token-store.ts';
import type { StoredTokenRecord } from './token-store.ts';

const isDarwin = process.platform === 'darwin';
const itDarwin = isDarwin ? test : test.skip;

function uniqueService(): string {
  return `aula-mcp-test-${randomBytes(4).toString('hex')}`;
}

const SAMPLE: StoredTokenRecord = {
  version: 1,
  username: 'cj-test',
  tokens: {
    access_token: 'AT-test',
    refresh_token: 'RT-test',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    obtained_at: Math.floor(Date.now() / 1000),
  },
  identityName: 'Test Identity',
  saved_at: Math.floor(Date.now() / 1000),
};

describe('KeychainTokenStore.isSupported', () => {
  test('matches process.platform', () => {
    expect(KeychainTokenStore.isSupported()).toBe(process.platform === 'darwin');
  });
});

describe('KeychainTokenStore non-darwin behaviour', () => {
  // Always-runs assertion: on non-darwin, every operation should throw.
  test.skipIf(isDarwin)('throws on every operation', async () => {
    const store = new KeychainTokenStore({ service: 'will-not-be-used' });
    await expect(store.load()).rejects.toThrow();
    await expect(store.save(SAMPLE)).rejects.toThrow();
    await expect(store.clear()).rejects.toThrow();
  });
});

describe('KeychainTokenStore roundtrip (macOS only)', () => {
  itDarwin('save → load returns the record verbatim', async () => {
    const service = uniqueService();
    const store = new KeychainTokenStore({ service });
    try {
      await store.save(SAMPLE);
      const loaded = await store.load();
      expect(loaded).toEqual(SAMPLE);
    } finally {
      await store.clear().catch(() => {});
    }
  });

  // `security find-generic-password -w` prints the password hex-encoded when
  // it contains non-ASCII bytes — e.g. a Danish identity name.
  itDarwin('save → load survives non-ASCII characters (æ ø å)', async () => {
    const service = uniqueService();
    const store = new KeychainTokenStore({ service });
    const danish: StoredTokenRecord = { ...SAMPLE, identityName: 'Søren Ærø Åberg' };
    try {
      await store.save(danish);
      expect(await store.load()).toEqual(danish);
    } finally {
      await store.clear().catch(() => {});
    }
  });

  itDarwin('load returns null when no entry exists', async () => {
    const store = new KeychainTokenStore({ service: uniqueService() });
    expect(await store.load()).toBeNull();
  });

  itDarwin('save twice updates the entry (no duplicate-item error)', async () => {
    const service = uniqueService();
    const store = new KeychainTokenStore({ service });
    try {
      await store.save(SAMPLE);
      const updated: StoredTokenRecord = { ...SAMPLE, username: 'cj-test-2' };
      await store.save(updated);
      const loaded = await store.load();
      expect(loaded?.username).toBe('cj-test-2');
    } finally {
      await store.clear().catch(() => {});
    }
  });

  itDarwin('clear removes the entry; subsequent load returns null', async () => {
    const service = uniqueService();
    const store = new KeychainTokenStore({ service });
    await store.save(SAMPLE);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  itDarwin('clear is idempotent — second call does not throw', async () => {
    const service = uniqueService();
    const store = new KeychainTokenStore({ service });
    await store.save(SAMPLE);
    await store.clear();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  itDarwin('path is a stable identifier string', () => {
    const store = new KeychainTokenStore({ service: 'svc-x', account: 'acct-y' });
    expect(store.path).toBe('keychain://svc-x/acct-y');
  });
});
