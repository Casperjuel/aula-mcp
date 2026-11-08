import { describe, expect, test } from 'bun:test';
import { type StoredTokenRecord, silentLogger, type TokenStore } from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';
import { createMcpApp } from './setup.ts';

class CountingStore implements TokenStore {
  loads = 0;
  async load(): Promise<StoredTokenRecord | null> {
    this.loads += 1;
    return {
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
  }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}

describe('createMcpApp', () => {
  test('apps given the same context share it, and with it one client and one token load', async () => {
    const store = new CountingStore();
    const context = new AulaContext({ store, logger: silentLogger });
    const a = createMcpApp({ logger: silentLogger, context });
    const b = createMcpApp({ logger: silentLogger, context });
    expect(a.context).toBe(context);
    expect(b.context).toBe(context);
    expect(a.mcp).not.toBe(b.mcp);
    expect(await a.context.getClient()).toBe(await b.context.getClient());
    expect(store.loads).toBe(1);
    context.dispose();
  });

  test('without a context each app builds its own', () => {
    const a = createMcpApp({ logger: silentLogger });
    const b = createMcpApp({ logger: silentLogger });
    expect(a.context).not.toBe(b.context);
    a.context.dispose();
    b.context.dispose();
  });
});
