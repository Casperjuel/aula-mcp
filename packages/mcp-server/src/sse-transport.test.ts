/**
 * In-process MCP SSE protocol test. Mounts the SSE routes against a fresh
 * Hono app + a one-tool McpServer, then drives the legacy SSE handshake
 * through `app.fetch()` (no `Bun.serve`, no real network).
 *
 * Covers: endpoint announce, initialize round-trip, tools/list, tools/call,
 * unknown sessionId, multiple concurrent sessions.
 */

import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { HonoSseTransport } from './sse-transport.ts';

interface SseSession {
  transport: HonoSseTransport;
  mcp: McpServer;
}

/**
 * Builds the smallest possible SSE-enabled MCP app for testing. Mirrors
 * the wiring in `server.ts` but with a single in-memory tool so we never
 * touch Aula/AulaContext.
 */
function buildTestApp(): Hono {
  const sessions = new Map<string, SseSession>();
  const app = new Hono();

  app.get('/sse', (c) =>
    streamSSE(c, async (stream) => {
      const sessionId = crypto.randomUUID();
      const transport = new HonoSseTransport({
        sessionId,
        messageEndpoint: '/messages',
        stream,
      });
      const mcp = new McpServer(
        { name: 'aula-mcp-test', version: '0.0.0' },
        { capabilities: { tools: {} } },
      );
      mcp.registerTool(
        'echo',
        {
          title: 'Echo',
          description: 'Echoes its input back as a text content block.',
          inputSchema: { msg: z.string() },
        },
        async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
      );
      sessions.set(sessionId, { transport, mcp });

      const closed = new Promise<void>((resolve) => {
        stream.onAbort(async () => {
          sessions.delete(sessionId);
          try {
            await transport.close();
          } catch {}
          try {
            await mcp.close();
          } catch {}
          resolve();
        });
      });

      await mcp.connect(transport);
      await closed;
    }),
  );

  app.post('/messages', async (c) => {
    const sessionId = c.req.query('sessionId');
    if (!sessionId) return c.json({ error: 'missing sessionId' }, 400);
    const session = sessions.get(sessionId);
    if (!session) return c.json({ error: 'unknown sessionId' }, 404);
    const body = (await c.req.json()) as JSONRPCMessage;
    session.transport.receive(body);
    return c.body(null, 202);
  });

  return app;
}

interface SseEvent {
  event?: string;
  data: string;
}

/**
 * SSE event reader over a ReadableStream<Uint8Array>. Buffers partial chunks
 * and yields one event at a time via `next()`. Throws on timeout so a hung
 * test fails loudly instead of hanging the suite.
 */
class SseReader {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  // The DOM-lib `ReadableStreamDefaultReader` and Bun/Node's `node:stream/web`
  // variant differ on the presence of `readMany`; using a structural type
  // avoids the cross-lib variance without dragging either import in.
  private readonly reader: {
    read(): Promise<{ value?: Uint8Array; done: boolean }>;
    cancel(): Promise<void>;
    releaseLock(): void;
  };
  private readonly queue: SseEvent[] = [];
  private streamEnded = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader() as unknown as typeof this.reader;
  }

  async next(timeoutMs = 5000): Promise<SseEvent> {
    if (this.queue.length > 0) return this.queue.shift() as SseEvent;
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `SseReader.next() timed out after ${timeoutMs}ms (buffer="${this.buffer.slice(0, 80)}")`,
        );
      }
      if (this.streamEnded) throw new Error('SSE stream ended with no event');
      const { value, done } = await this.reader.read();
      if (done) {
        this.streamEnded = true;
        if (this.queue.length === 0) throw new Error('SSE stream ended with no event');
        break;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
      this.parseBuffer();
    }
    return this.queue.shift() as SseEvent;
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {}
    try {
      this.reader.releaseLock();
    } catch {}
  }

  private parseBuffer(): void {
    let sepIdx = this.buffer.indexOf('\n\n');
    while (sepIdx !== -1) {
      const chunk = this.buffer.slice(0, sepIdx);
      this.buffer = this.buffer.slice(sepIdx + 2);
      const ev: SseEvent = { data: '' };
      for (const line of chunk.split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const field = line.slice(0, colon);
        const v = line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') ev.event = v;
        else if (field === 'data') ev.data = ev.data ? `${ev.data}\n${v}` : v;
      }
      if (ev.event !== undefined || ev.data !== '') this.queue.push(ev);
      sepIdx = this.buffer.indexOf('\n\n');
    }
  }
}

async function openSse(
  app: Hono,
): Promise<{ reader: SseReader; sessionId: string; res: Response }> {
  const res = await app.fetch(new Request('http://test/sse', { method: 'GET' }));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
  if (!res.body) throw new Error('SSE response missing body');
  const reader = new SseReader(res.body);
  const endpointEv = await reader.next();
  expect(endpointEv.event).toBe('endpoint');
  const url = new URL(endpointEv.data, 'http://test');
  const sessionId = url.searchParams.get('sessionId');
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  return { reader, sessionId: sessionId as string, res };
}

async function sendMessage(
  app: Hono,
  sessionId: string,
  message: JSONRPCMessage,
): Promise<Response> {
  return app.fetch(
    new Request(`http://test/messages?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    }),
  );
}

describe('HonoSseTransport', () => {
  test('opens SSE, announces endpoint, completes initialize handshake', async () => {
    const app = buildTestApp();
    const { reader, sessionId } = await openSse(app);

    const initReq: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sse-test-client', version: '0' },
      },
    } as JSONRPCMessage;
    const postRes = await sendMessage(app, sessionId, initReq);
    expect(postRes.status).toBe(202);

    const initRespEv = await reader.next();
    expect(initRespEv.event).toBe('message');
    const initResp = JSON.parse(initRespEv.data) as {
      id?: number;
      result?: { serverInfo?: { name?: string } };
    };
    expect(initResp.id).toBe(1);
    expect(initResp.result?.serverInfo?.name).toBe('aula-mcp-test');

    await reader.close();
  });

  test('tools/list returns the echo tool after initialize', async () => {
    const app = buildTestApp();
    const { reader, sessionId } = await openSse(app);

    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sse-test-client', version: '0' },
      },
    } as JSONRPCMessage);
    await reader.next(); // initialize response

    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    } as JSONRPCMessage);

    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    } as JSONRPCMessage);

    const listEv = await reader.next();
    expect(listEv.event).toBe('message');
    const listResp = JSON.parse(listEv.data) as {
      id?: number;
      result?: { tools?: Array<{ name: string }> };
    };
    expect(listResp.id).toBe(2);
    const toolNames = (listResp.result?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('echo');

    await reader.close();
  });

  test('tools/call round-trips through SSE', async () => {
    const app = buildTestApp();
    const { reader, sessionId } = await openSse(app);

    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sse-test-client', version: '0' },
      },
    } as JSONRPCMessage);
    await reader.next();
    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    } as JSONRPCMessage);

    await sendMessage(app, sessionId, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'hej fra HA' } },
    } as JSONRPCMessage);

    const callEv = await reader.next();
    const callResp = JSON.parse(callEv.data) as {
      id?: number;
      result?: { content?: Array<{ type: string; text?: string }> };
    };
    expect(callResp.id).toBe(99);
    expect(callResp.result?.content?.[0]?.text).toBe('hej fra HA');

    await reader.close();
  });

  test('POST to /messages with unknown sessionId returns 404', async () => {
    const app = buildTestApp();
    const res = await sendMessage(app, '00000000-0000-0000-0000-000000000000', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    } as JSONRPCMessage);
    expect(res.status).toBe(404);
  });

  test('POST to /messages without sessionId returns 400', async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request('http://test/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('concurrent SSE sessions get distinct ids and isolated tool calls', async () => {
    const app = buildTestApp();
    const a = await openSse(app);
    const b = await openSse(app);
    expect(a.sessionId).not.toBe(b.sessionId);

    for (const { sessionId, reader } of [a, b]) {
      await sendMessage(app, sessionId, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'sse-test-client', version: '0' },
        },
      } as JSONRPCMessage);
      await reader.next();
      await sendMessage(app, sessionId, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      } as JSONRPCMessage);
    }

    // A's call should resolve only on A's stream, B's only on B's.
    await sendMessage(app, a.sessionId, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'from-a' } },
    } as JSONRPCMessage);
    const aResp = await a.reader.next();
    const aPayload = JSON.parse(aResp.data) as { result?: { content?: Array<{ text?: string }> } };
    expect(aPayload.result?.content?.[0]?.text).toBe('from-a');

    await sendMessage(app, b.sessionId, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'from-b' } },
    } as JSONRPCMessage);
    const bResp = await b.reader.next();
    const bPayload = JSON.parse(bResp.data) as { result?: { content?: Array<{ text?: string }> } };
    expect(bPayload.result?.content?.[0]?.text).toBe('from-b');

    await a.reader.close();
    await b.reader.close();
  });
});
