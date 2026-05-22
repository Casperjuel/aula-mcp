/**
 * End-to-end MCP server integration test. Boots the Hono app + Streamable
 * HTTP transport in-process, dispatches real JSON-RPC requests via
 * `app.fetch()`, and asserts the wire shape MCP clients see.
 *
 * The AulaContext is faked so we never hit Aula. No network, no tokens.
 * Covers the dispatcher + transport layer that's otherwise untested.
 *
 * The MCP Streamable HTTP transport needs the Accept header to advertise
 * both `application/json` AND `text/event-stream`, even when
 * enableJsonResponse=true means responses are plain JSON. Real clients do
 * this; we replicate.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { AulaContext } from './aula-context.ts';
import { registerTools } from './tools.ts';

const TOKENS: AulaTokens = {
  access_token: 'AT',
  refresh_token: 'RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

function fakeContext(): AulaContext {
  const fakeClient = {
    currentApiVersion: 22,
    async getProfilesByLogin() {
      return {
        profiles: [
          {
            id: 1,
            name: 'Casper',
            children: [
              {
                id: 1001,
                name: 'Emilie',
                userId: 2001,
                institutionProfile: {
                  id: 9001,
                  institutionName: 'Demo Skole',
                  institutionCode: 'D12345',
                },
              },
            ],
          },
        ],
      };
    },
    async getProfileContext() {
      return {
        userId: 5000,
        pageConfiguration: {
          widgetConfigurations: [
            { widget: { widgetId: '0001' } },
            { widget: { widgetId: '0030' } },
          ],
        },
      };
    },
    async getPresenceTemplates() {
      return {
        presenceWeekTemplates: [{ institutionProfile: { id: 9001 }, dayTemplates: [] }],
      };
    },
  };
  return {
    record: {
      version: 1 as const,
      username: 'cj',
      tokens: TOKENS,
      identityName: 'Forælder',
      saved_at: Math.floor(Date.now() / 1000),
    },
    async getClient(): Promise<AulaClient> {
      return fakeClient as unknown as AulaClient;
    },
    async getGuardianUserId(): Promise<string> {
      return '5000';
    },
  } as unknown as AulaContext;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let app: Hono;
let mcp: McpServer;
let transport: WebStandardStreamableHTTPServerTransport;

beforeAll(async () => {
  app = new Hono();
  mcp = new McpServer(
    { name: 'aula-mcp-test', version: '0.0.0-test' },
    { capabilities: { tools: {} } },
  );
  registerTools(mcp, fakeContext());
  // Stateful mode — the SDK forbids reusing a stateless transport across
  // requests, which a multi-test suite necessarily does. Mirror what
  // production does in server.ts.
  transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await mcp.connect(transport);
  app.post('/mcp', (c) => transport.handleRequest(c.req.raw));
  app.get('/mcp', (c) => transport.handleRequest(c.req.raw));
  app.delete('/mcp', (c) => transport.handleRequest(c.req.raw));
});

afterAll(async () => {
  await mcp.close();
});

/** Track session id across requests (the transport echoes one in the
 *  initialize response and expects it back on every subsequent call). */
let sessionId: string | undefined;

async function rpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await app.fetch(
    new Request('http://test/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    }),
  );
  // Capture the session id the server allocates on initialize.
  const echoedSessionId = res.headers.get('mcp-session-id');
  if (echoedSessionId) sessionId = echoedSessionId;
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Transport returned ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = await res.text();
  // Response can be plain JSON or an SSE event with `data: { ... }` line.
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error(`SSE response had no data line: ${body}`);
    return JSON.parse(dataLine.slice(5).trim()) as JsonRpcResponse;
  }
  return JSON.parse(body) as JsonRpcResponse;
}

let initialised = false;

async function init(): Promise<void> {
  if (initialised) return;
  // The MCP transport requires an `initialize` handshake before tool calls.
  await rpc({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aula-mcp-test-client', version: '0.0.0' },
    },
  });
  // Per spec, send an `initialized` notification (no id) before tool calls.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  await app.fetch(
    new Request('http://test/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    }),
  );
  initialised = true;
}

describe('MCP server: tools/list', () => {
  test('returns every registered tool with its name and description', async () => {
    await init();
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.error).toBeUndefined();
    const tools = (r.result as { tools: Array<{ name: string; description: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('aula.discover');
    expect(names).toContain('aula.profiles.list');
    expect(names).toContain('aula.presence.today');
    expect(names).toContain('aula.presence.templates');
    expect(names).toContain('aula.calendar.events');
    expect(names).toContain('aula.messages.list_threads');
    expect(names).toContain('aula.messages.get_thread');
    expect(names).toContain('aula.messages.get_attachment');
    expect(names).toContain('aula.notifications.list');
    expect(names).toContain('aula.posts.list');
    expect(names).toContain('aula.ugeplan.easyiq');
    expect(names).toContain('aula.ugeplan.meebook');
    expect(names).toContain('aula.ugeplan.easyiq_skoleportal');
    expect(names).toContain('aula.opgaver.minuddannelse');
    expect(names).toContain('aula.ugebrev.minuddannelse');
    expect(names).toContain('aula.huskelisten.systematic');
    // aula.raw_request is NOT in the list because AULA_MCP_RAW isn't set.
    expect(names).not.toContain('aula.raw_request');
    // aula.presence.set_template is gated the same way behind AULA_MCP_WRITE.
    expect(names).not.toContain('aula.presence.set_template');
  });
});

describe('MCP server: tools/call(aula.discover)', () => {
  test('returns a parseable manifest with our fake context', async () => {
    await init();
    const r = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'aula.discover', arguments: {} },
    });
    expect(r.error).toBeUndefined();
    const result = r.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toHaveLength(1);
    const first = result.content[0];
    if (!first) throw new Error('expected content[0]');
    expect(first.type).toBe('text');
    const manifest = JSON.parse(first.text) as {
      user: { username: string };
      children: Array<{ name: string }>;
      detectedWidgets: string[];
      capabilities: Record<string, { tools: string[] }>;
    };
    expect(manifest.user.username).toBe('cj');
    expect(manifest.children[0]?.name).toBe('Emilie');
    expect(manifest.detectedWidgets).toEqual(['0001', '0030']);
    // EasyIQ (0001) should be listed first for ugeplan since it's detected.
    expect(manifest.capabilities.ugeplan?.tools[0]).toBe('aula.ugeplan.easyiq');
  });
});

describe('MCP server: tools/call(aula.presence.templates)', () => {
  test('returns the presenceWeekTemplates payload', async () => {
    await init();
    const r = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'aula.presence.templates', arguments: { childIds: [9001] } },
    });
    expect(r.error).toBeUndefined();
    const result = r.result as { content: Array<{ type: string; text: string }> };
    const first = result.content[0];
    if (!first) throw new Error('expected content[0]');
    const data = JSON.parse(first.text) as {
      presenceWeekTemplates: Array<{ institutionProfile: { id: number } }>;
    };
    expect(data.presenceWeekTemplates[0]?.institutionProfile.id).toBe(9001);
  });
});

describe('MCP server: tools/call validation', () => {
  test('rejects unknown tool name with an error response', async () => {
    await init();
    const r = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'aula.this_does_not_exist', arguments: {} },
    });
    // Either the result is an `isError: true` content payload, or there's a
    // top-level error field. Both are valid MCP shapes; accept either.
    if (r.error) {
      expect(r.error.message.length).toBeGreaterThan(0);
    } else {
      const result = r.result as { isError?: boolean; content?: unknown };
      expect(result.isError).toBe(true);
    }
  });

  test('rejects invalid argument shape (childIds must be non-empty array)', async () => {
    await init();
    const r = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'aula.presence.today', arguments: { childIds: [] } },
    });
    // Zod min(1) → validation error somewhere in the response.
    const text = JSON.stringify(r);
    expect(text.toLowerCase()).toMatch(/error|invalid|too small/);
  });
});
