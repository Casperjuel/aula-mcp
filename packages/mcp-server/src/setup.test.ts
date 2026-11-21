import { describe, expect, test } from 'bun:test';
import { type StoredTokenRecord, silentLogger, type TokenStore } from '@aula-mcp/aula-auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AulaContext } from './aula-context.ts';
import { createMcpApp, type LoginRequired } from './setup.ts';

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

describe('createMcpApp with loginRequired', () => {
  async function open(loginRequired: LoginRequired, toolNames: 'dotted' | 'underscore') {
    const context = new AulaContext({ store: new CountingStore(), logger: silentLogger });
    const app = createMcpApp({ logger: silentLogger, context, toolNames, loginRequired });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await app.mcp.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    await client.connect(clientSide);
    return {
      client,
      listChanged: () => listChanged,
      close: async () => {
        await client.close();
        context.dispose();
      },
    };
  }

  test('offers only the login tool, with the setup link in its description', async () => {
    const url = 'https://aula-setup.example.com';
    const session = await open({ setupUrl: url, loggedIn: async () => false }, 'underscore');
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['aula_login_required']);
    expect(tools[0]?.description).toContain(url);
    expect(session.client.getInstructions()).toContain(url);

    const result = await session.client.callTool({ name: 'aula_login_required', arguments: {} });
    expect(JSON.stringify(result.content)).toContain(url);
    expect((await session.client.listTools()).tools).toHaveLength(1);
    await session.close();
  });

  test('without a setup UI it says who to ask', async () => {
    const session = await open({ setupUrl: null, loggedIn: async () => false }, 'dotted');
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['aula.login_required']);
    expect(tools[0]?.description).toContain('whoever runs aula-mcp');
    await session.close();
  });

  test('once the parent has logged in, calling it swaps in the Aula tools', async () => {
    let loggedIn = false;
    const session = await open(
      { setupUrl: 'https://aula-setup.example.com', loggedIn: async () => loggedIn },
      'underscore',
    );
    loggedIn = true;
    const result = await session.client.callTool({ name: 'aula_login_required', arguments: {} });
    expect(JSON.stringify(result.content)).toContain('aula_discover');
    const names = (await session.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('aula_discover');
    expect(names).not.toContain('aula_login_required');
    expect(session.listChanged()).toBeGreaterThan(0);
    await session.close();
  });
});
