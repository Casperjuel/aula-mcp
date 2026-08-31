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

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** Mirrors ATTACHMENT_MAX_BYTES in tools.ts (module-private there). */
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/** One attachment as Aula shapes it inside a thread message. */
interface FakeAttachment {
  file: { name?: string; url?: string; mediaType?: string };
}

/** Thread 77: three attachments spread over three messages, in wire order. */
const THREADS: Record<number, Array<{ attachments?: FakeAttachment[] }>> = {
  77: [
    {
      attachments: [
        { file: { name: 'kostplan.pdf', url: 'https://cdn.test/a', mediaType: 'application/pdf' } },
      ],
    },
    // No attachments at all — the flattening must skip straight past it.
    {},
    {
      attachments: [
        { file: { name: 'seddel.txt', url: 'https://cdn.test/b' } },
        // Path separators, to exercise the on-disk name scrubbing.
        { file: { name: '../../etc/pas swd.pdf', url: 'https://cdn.test/c' } },
      ],
    },
  ],
  78: [{}],
};

interface FakeOptions {
  /** Thread id to its messages, for aula.messages.get_attachment. */
  threads?: Record<number, Array<{ attachments?: FakeAttachment[] }>>;
  /** Every presence.updatePresenceTemplate arg object, in call order. */
  templateWrites?: unknown[];
}

function fakeContext(opts: FakeOptions = {}): AulaContext {
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
    async updatePresenceTemplate(args: unknown) {
      opts.templateWrites?.push(args);
      return { id: 4242, status: 'created' };
    },
    async getMessagesForThread(threadId: number) {
      return { subject: 'Sommerfest', messages: opts.threads?.[threadId] ?? [] };
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

interface Harness {
  /** Send one JSON-RPC request over the transport, handshaking first. */
  rpc(req: JsonRpcRequest): Promise<JsonRpcResponse>;
  /** `tools/call` plus JSON.parse of the single text content block. */
  call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Every tool name from `tools/list`. */
  toolNames(id: number): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * A live server + transport pair behind `app.fetch()`. A factory rather than
 * a module-level singleton because the write tools are registered off
 * AULA_MCP_WRITE at `registerTools` time, so covering both states needs two
 * independently-registered servers in the same file.
 */
async function createHarness(context: AulaContext): Promise<Harness> {
  const app = new Hono();
  const mcp = new McpServer(
    { name: 'aula-mcp-test', version: '0.0.0-test' },
    { capabilities: { tools: {} } },
  );
  registerTools(mcp, context);
  // Stateful mode — the SDK forbids reusing a stateless transport across
  // requests, which a multi-test suite necessarily does. Mirror what
  // production does in server.ts.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await mcp.connect(transport);
  app.post('/mcp', (c) => transport.handleRequest(c.req.raw));
  app.get('/mcp', (c) => transport.handleRequest(c.req.raw));
  app.delete('/mcp', (c) => transport.handleRequest(c.req.raw));

  // Track the session id across requests (the transport echoes one in the
  // initialize response and expects it back on every subsequent call).
  let sessionId: string | undefined;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) h['mcp-session-id'] = sessionId;
    return h;
  }

  async function post(body: unknown): Promise<Response> {
    const res = await app.fetch(
      new Request('http://test/mcp', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      }),
    );
    // Capture the session id the server allocates on initialize.
    const echoedSessionId = res.headers.get('mcp-session-id');
    if (echoedSessionId) sessionId = echoedSessionId;
    return res;
  }

  async function send(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const res = await post(req);
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
    await send({
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
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    initialised = true;
  }

  async function rpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    await init();
    return send(req);
  }

  return {
    rpc,
    async call(id, name, args) {
      const r = await rpc({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      expect(r.error).toBeUndefined();
      const result = r.result as { content: Array<{ type: string; text: string }> };
      const first = result.content[0];
      if (!first) throw new Error(`${name} returned no content`);
      expect(first.type).toBe('text');
      return JSON.parse(first.text) as Record<string, unknown>;
    },
    async toolNames(id) {
      const r = await rpc({ jsonrpc: '2.0', id, method: 'tools/list' });
      expect(r.error).toBeUndefined();
      const { tools } = r.result as { tools: Array<{ name: string }> };
      return tools.map((t) => t.name);
    },
    async close() {
      await mcp.close();
    },
  };
}

/** Set (or clear) an env var, returning the previous value for restoring. */
function setEnv(key: string, value: string | undefined): string | undefined {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return previous;
}

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness(fakeContext({ threads: THREADS }));
});

afterAll(async () => {
  await harness.close();
});

describe('MCP server: tools/list', () => {
  test('returns every registered tool with its name and description', async () => {
    const names = await harness.toolNames(1);
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
    expect(names).toContain('aula.posts.get_attachment');
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
    // Same gate — reporting a child sick must never register on a read-only server.
    expect(names).not.toContain('aula.presence.report_sick');
  });
});

describe('MCP server: tools/call(aula.discover)', () => {
  test('returns a parseable manifest with our fake context', async () => {
    const manifest = (await harness.call(2, 'aula.discover', {})) as unknown as {
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
    const data = (await harness.call(5, 'aula.presence.templates', {
      childIds: [9001],
    })) as unknown as {
      presenceWeekTemplates: Array<{ institutionProfile: { id: number } }>;
    };
    expect(data.presenceWeekTemplates[0]?.institutionProfile.id).toBe(9001);
  });
});

describe('MCP server: tools/call validation', () => {
  test('rejects unknown tool name with an error response', async () => {
    const r = await harness.rpc({
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
    const r = await harness.rpc({
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

// ---------------------------------------------------------------------------
// aula.presence.set_template — the write gate
// ---------------------------------------------------------------------------

describe('MCP server: tools/call(aula.presence.set_template)', () => {
  let writeHarness: Harness;
  const writes: unknown[] = [];

  beforeAll(async () => {
    // The gate is read at registration time, so flip it around createHarness
    // and put it straight back — nothing else in the file should see it set.
    const previous = setEnv('AULA_MCP_WRITE', '1');
    try {
      writeHarness = await createHarness(fakeContext({ templateWrites: writes }));
    } finally {
      setEnv('AULA_MCP_WRITE', previous);
    }
  });

  afterAll(async () => {
    await writeHarness.close();
  });

  afterEach(() => {
    writes.length = 0;
  });

  test('is advertised in tools/list when AULA_MCP_WRITE=1', async () => {
    const names = await writeHarness.toolNames(10);
    expect(names).toContain('aula.presence.set_template');
    // The other write tools share the one gate, so they arrive together.
    expect(names).toContain('aula.presence.report_sick');
    expect(names).toContain('aula.messages.mark_read');
  });

  test('happy path: routes through to the client and returns { ok: true, result }', async () => {
    const out = await writeHarness.call(11, 'aula.presence.set_template', {
      institutionProfileId: 9001,
      date: '2026-06-01',
      activityType: 'picked_up_by',
      entryTime: '08:00',
      exitTime: '15:30',
      pickedUpBy: 'Farmor',
      comment: 'Farmor henter',
    });
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ id: 4242, status: 'created' });
    // The tool must hand the client exactly what the caller asked for, with
    // repeatPattern defaulted rather than left undefined.
    expect(writes).toEqual([
      {
        institutionProfileId: 9001,
        date: '2026-06-01',
        activityType: 'picked_up_by',
        repeatPattern: 'never',
        entryTime: '08:00',
        exitTime: '15:30',
        pickedUpBy: 'Farmor',
        comment: 'Farmor henter',
      },
    ]);
  });

  test('a repeating template forwards repeatPattern and repeatUntil', async () => {
    const out = await writeHarness.call(12, 'aula.presence.set_template', {
      institutionProfileId: 9001,
      date: '2026-06-01',
      activityType: 'send_home',
      exitTime: '15:00',
      repeat: 'every_2_weeks',
      repeatUntil: '2026-06-30',
    });
    expect(out.ok).toBe(true);
    expect(writes).toEqual([
      {
        institutionProfileId: 9001,
        date: '2026-06-01',
        activityType: 'send_home',
        repeatPattern: 'every_2_weeks',
        exitTime: '15:00',
        repeatUntil: '2026-06-30',
      },
    ]);
  });

  test('cross-field validation fails before the client is called', async () => {
    const out = await writeHarness.call(13, 'aula.presence.set_template', {
      institutionProfileId: 9001,
      date: '2026-06-01',
      // picked_up_by without pickedUpBy — validateSetTemplateArgs rejects it.
      activityType: 'picked_up_by',
      exitTime: '15:30',
    });
    expect(out.error).toBe('invalid_arguments');
    expect((out.problems as string[])[0]).toContain('pickedUpBy');
    expect(writes).toEqual([]);
  });

  test('Zod rejects a malformed date before the handler runs', async () => {
    const r = await writeHarness.rpc({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'aula.presence.set_template',
        arguments: {
          institutionProfileId: 9001,
          date: '01-06-2026',
          activityType: 'send_home',
        },
      },
    });
    expect(JSON.stringify(r).toLowerCase()).toMatch(/error|invalid/);
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aula.messages.get_attachment / aula.posts.get_attachment
//
// Both call the same downloadAttachmentToDisk helper, so each branch is
// covered once through the messages tool and spot-checked from the posts one.
//
// `fetch` is stubbed for the whole block: the tool deliberately uses plain
// global fetch (the CloudFront signature in the URL is the auth), and the
// harness itself never touches global fetch — it dispatches through
// `app.fetch()`. Downloads land in a per-run temp dir via
// AULA_MCP_ATTACHMENTS_DIR, removed in afterAll.
// ---------------------------------------------------------------------------

describe('MCP server: tools/call(aula.messages.get_attachment)', () => {
  let dir: string;
  let previousDir: string | undefined;
  let realFetch: typeof globalThis.fetch;
  let requested: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aula-mcp-attachments-'));
    previousDir = setEnv('AULA_MCP_ATTACHMENTS_DIR', dir);
    realFetch = globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    setEnv('AULA_MCP_ATTACHMENTS_DIR', previousDir);
    await rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Replace global fetch with one that records URLs and replays `respond`. */
  function stubFetch(respond: (url: string) => Response): void {
    requested = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return Promise.resolve(respond(url));
    }) as unknown as typeof globalThis.fetch;
  }

  test('downloads into AULA_MCP_ATTACHMENTS_DIR and returns the path', async () => {
    stubFetch(() => new Response('%PDF-1.7 madplan'));
    const out = await harness.call(20, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 0,
    });

    expect(out.ok).toBe(true);
    expect(out.filename).toBe('kostplan.pdf');
    expect(out.mediaType).toBe('application/pdf');
    expect(out.bytes).toBe(16);
    // The override is honoured, and the on-disk name is prefixed thread-index
    // so two sources can't collide in the shared directory.
    expect(dirname(out.path as string)).toBe(dir);
    expect(out.path).toBe(join(dir, '77-0-kostplan.pdf'));
    expect(await readFile(out.path as string, 'utf8')).toBe('%PDF-1.7 madplan');
    expect(requested).toEqual(['https://cdn.test/a']);
  });

  test('attachmentIndex flattens across messages in order', async () => {
    stubFetch(() => new Response('seddel'));
    const out = await harness.call(21, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 1,
    });
    // Index 1 lives on the *third* message — the empty one in between must
    // not consume an index.
    expect(out.filename).toBe('seddel.txt');
    expect(requested).toEqual(['https://cdn.test/b']);
    // No mediaType on this attachment, so the key is omitted rather than null.
    expect('mediaType' in out).toBe(false);
  });

  test('sanitises path separators out of the on-disk filename', async () => {
    stubFetch(() => new Response('x'));
    const out = await harness.call(22, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 2,
    });
    // `filename` echoes what Aula sent; only the on-disk name is scrubbed.
    expect(out.filename).toBe('../../etc/pas swd.pdf');
    expect(out.path).toBe(join(dir, '77-2-.._.._etc_pas swd.pdf'));
    // The whole point: nothing escapes the attachments directory.
    expect(dirname(out.path as string)).toBe(dir);
  });

  test('attachment_not_found when the index is past the end', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called for a missing attachment');
    });
    const out = await harness.call(23, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 99,
    });
    expect(out.error).toBe('attachment_not_found');
    expect(out.threadId).toBe(77);
    expect(out.attachmentIndex).toBe(99);
    expect(out.totalAttachments).toBe(3);
    expect(requested).toEqual([]);
  });

  test('attachment_not_found on a thread with no attachments at all', async () => {
    stubFetch(() => {
      throw new Error('fetch must not be called for a missing attachment');
    });
    const out = await harness.call(24, 'aula.messages.get_attachment', {
      threadId: 78,
      attachmentIndex: 0,
    });
    expect(out.error).toBe('attachment_not_found');
    expect(out.totalAttachments).toBe(0);
  });

  test('download_failed carries the CloudFront status and body excerpt', async () => {
    stubFetch(
      () =>
        new Response('<Error><Code>AccessDenied</Code></Error>', {
          status: 403,
          statusText: 'Forbidden',
        }),
    );
    const out = await harness.call(25, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 0,
    });
    expect(out.ok).toBeUndefined();
    expect(out.error).toBe('download_failed');
    expect(out.httpStatus).toBe(403);
    expect(out.filename).toBe('kostplan.pdf');
    expect(out.body).toContain('AccessDenied');
    expect(out.path).toBeUndefined();
  });

  test('attachment_too_large from the declared content-length, before reading the body', async () => {
    let bodyRead = false;
    stubFetch(() => {
      const res = new Response('tiny', {
        headers: { 'content-length': String(ATTACHMENT_MAX_BYTES + 1) },
      });
      // Flag any attempt to buffer the body — the declared-size check must
      // short-circuit first rather than pull 50MB down before rejecting it.
      Object.defineProperty(res, 'arrayBuffer', {
        value: () => {
          bodyRead = true;
          return Promise.resolve(new ArrayBuffer(4));
        },
      });
      return res;
    });
    const out = await harness.call(26, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 0,
    });
    expect(out.error).toBe('attachment_too_large');
    expect(out.bytes).toBe(ATTACHMENT_MAX_BYTES + 1);
    expect(out.maxBytes).toBe(ATTACHMENT_MAX_BYTES);
    expect(out.filename).toBe('kostplan.pdf');
    expect(bodyRead).toBe(false);
  });

  test('attachment_too_large from the actual bytes when content-length is absent', async () => {
    // No content-length header at all — the declared check passes and only
    // the post-download byte count catches it.
    stubFetch(() => new Response(new Uint8Array(ATTACHMENT_MAX_BYTES + 1)));
    const out = await harness.call(27, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 0,
    });
    expect(out.error).toBe('attachment_too_large');
    expect(out.bytes).toBe(ATTACHMENT_MAX_BYTES + 1);
    expect(out.maxBytes).toBe(ATTACHMENT_MAX_BYTES);
    expect(out.path).toBeUndefined();
  });

  test('a file exactly on the cap is still accepted', async () => {
    stubFetch(() => new Response(new Uint8Array(ATTACHMENT_MAX_BYTES)));
    const out = await harness.call(28, 'aula.messages.get_attachment', {
      threadId: 77,
      attachmentIndex: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.bytes).toBe(ATTACHMENT_MAX_BYTES);
  });

  // The posts tool differs only in how it arrives at a URL, so these two
  // assert the shared helper behaves identically from the other call site.
  test('aula.posts.get_attachment writes with its own post- prefix', async () => {
    stubFetch(() => new Response('%PDF-1.7 nyhed'));
    const out = await harness.call(29, 'aula.posts.get_attachment', {
      postId: 314,
      url: 'https://cdn.test/post-attachment',
      filename: 'Sommerfest program.pdf',
    });
    expect(out.ok).toBe(true);
    expect(out.path).toBe(join(dir, 'post-314-Sommerfest program.pdf'));
    expect(out.bytes).toBe(14);
    // The posts tool has no mediaType to pass, so the key stays off.
    expect('mediaType' in out).toBe(false);
    expect(requested).toEqual(['https://cdn.test/post-attachment']);
  });

  test('aula.posts.get_attachment surfaces download_failed the same way', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));
    const out = await harness.call(30, 'aula.posts.get_attachment', {
      postId: 314,
      url: 'https://cdn.test/post-attachment',
      filename: 'Sommerfest program.pdf',
    });
    expect(out.error).toBe('download_failed');
    expect(out.httpStatus).toBe(404);
  });
});
