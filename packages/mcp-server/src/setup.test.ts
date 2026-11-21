import { describe, expect, test } from 'bun:test';
import { type StoredTokenRecord, silentLogger, type TokenStore } from '@aula-mcp/aula-auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  type JSONRPCMessage,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

describe('tools/call without arguments', () => {
  // kagent sends `"arguments": null` for a tool that takes no arguments. The
  // SDK's CallToolRequest schema only takes an object or nothing, so without
  // the fix in setup.ts the call fails with "expected record, received null"
  // before the tool handler runs.
  const setupUrl = 'https://aula-setup.example.com';
  const initialize: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'kagent-like', version: '0.0.0' },
    },
  };
  const initialized: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const callLoginTool = (params: Record<string, unknown>): JSONRPCMessage => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'aula_login_required', ...params },
  });

  interface Reply {
    result?: { content: unknown; isError?: boolean };
    error?: unknown;
  }

  function expectLoginAnswer(reply: Reply | undefined): void {
    expect(reply?.error).toBeUndefined();
    expect(reply?.result?.isError).toBeFalsy();
    expect(JSON.stringify(reply?.result?.content)).toContain(setupUrl);
  }

  function newApp() {
    const context = new AulaContext({ store: new CountingStore(), logger: silentLogger });
    const app = createMcpApp({
      logger: silentLogger,
      context,
      toolNames: 'underscore',
      loginRequired: { setupUrl, loggedIn: async () => false },
    });
    return {
      app,
      close: async () => {
        await app.mcp.close();
        context.dispose();
      },
    };
  }

  for (const [label, params] of [
    ['null', { arguments: null }],
    ['missing', {}],
  ] as const) {
    test(`arguments ${label} succeeds over an in-process (stdio-like) transport`, async () => {
      const { app, close } = newApp();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await app.mcp.connect(serverSide);
      const replies: JSONRPCMessage[] = [];
      clientSide.onmessage = (message) => {
        replies.push(message);
      };
      await clientSide.start();
      await clientSide.send(initialize);
      await clientSide.send(initialized);
      await clientSide.send(callLoginTool(params));
      for (let i = 0; i < 50 && !replies.some((m) => 'id' in m && m.id === 1); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expectLoginAnswer(replies.find((m) => 'id' in m && m.id === 1) as Reply | undefined);
      await close();
    });
  }

  test('arguments null succeeds over Streamable HTTP', async () => {
    const { app, close } = newApp();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await app.mcp.connect(transport);
    let sessionId: string | undefined;
    const post = async (body: JSONRPCMessage) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      const res = await transport.handleRequest(
        new Request('http://test/mcp', { method: 'POST', headers, body: JSON.stringify(body) }),
      );
      sessionId ??= res.headers.get('mcp-session-id') ?? undefined;
      return res;
    };
    await post(initialize);
    await post(initialized);
    const res = await post(callLoginTool({ arguments: null }));
    expect(res.status).toBe(200);
    expectLoginAnswer((await res.json()) as Reply);
    await close();
  });
});
