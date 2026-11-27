/**
 * AULA_MCP_TRACE_FILE: off by default, 0600 when on, loud on a bad path, and
 * redacted end to end — a real AulaHttpClient request against a local server,
 * read back from the file, so the redaction checked is the one the server
 * actually runs, not a hand-built entry.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AulaHttpClient,
  JsonlFileTracer,
  MemoryTokenStore,
  noopTracer,
  type WireTracer,
} from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';
import { createHttpTracer, ensureTraceFileWritable, resolveTraceFilePath } from './trace-config.ts';

// Obviously fake values; never real tokens.
const FAKE_BEARER = 'fake-bearer-token-0000';
const FAKE_QUERY_TOKEN = 'fake-query-token-1111';
const FAKE_BODY_TOKEN = 'fake-body-token-2222';
const FAKE_WIDGET_TOKEN = 'fake-widget-token-3333';
const FAKE_SESSION_UUID = 'fake-session-uuid-4444';
const FAKE_SESSION_ID = 'fake-session-id-5555';

let dir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aula-mcp-trace-test-'));
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // Aula's widget-token endpoint answers the bearer token under `data`.
    fetch: (req) =>
      req.url.includes('method=aulaToken.getAulaToken')
        ? Response.json({ status: { code: 0 }, data: FAKE_WIDGET_TOKEN })
        : Response.json({ access_token: FAKE_BODY_TOKEN, ok: true }),
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function requestOnce(http: AulaHttpClient): Promise<number> {
  const res = await http.request(
    `http://127.0.0.1:${server.port}/api?access_token=${FAKE_QUERY_TOKEN}`,
    {
      headers: { authorization: `Bearer ${FAKE_BEARER}` },
    },
  );
  return res.status;
}

/** JsonlFileTracer writes fire-and-forget; poll briefly for the line. */
async function readWhenWritten(path: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (text.length > 0) return text;
    await new Promise((r) => setTimeout(r, 10));
  }
  return '';
}

describe('resolveTraceFilePath', () => {
  test('unset or empty -> undefined', () => {
    expect(resolveTraceFilePath({})).toBeUndefined();
    expect(resolveTraceFilePath({ AULA_MCP_TRACE_FILE: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test('a set path is returned as-is', () => {
    expect(resolveTraceFilePath({ AULA_MCP_TRACE_FILE: '/x/y.jsonl' } as NodeJS.ProcessEnv)).toBe(
      '/x/y.jsonl',
    );
  });
});

describe('createHttpTracer', () => {
  test('a valid path -> JsonlFileTracer, file created 0600', () => {
    const path = join(dir, 'nested', 'ok.jsonl');
    expect(createHttpTracer(path)).toBeInstanceOf(JsonlFileTracer);
    expect(existsSync(path)).toBe(true);
    // POSIX mode bits don't restrict access on Windows.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test('an unwritable path throws at creation', () => {
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'not a directory');
    const path = join(blocker, 'sub', 'trace.jsonl');
    expect(() => createHttpTracer(path)).toThrow();
    expect(() => ensureTraceFileWritable(path)).toThrow();
  });
});

describe('trace file end to end', () => {
  test('variable unset: no tracer, request succeeds, nothing is written', async () => {
    const off = mkdtempSync(join(dir, 'off-'));
    const tracer = createHttpTracer(resolveTraceFilePath({}));
    expect(tracer).toBeUndefined();
    const http = new AulaHttpClient(tracer ? { tracer } : {});
    expect(await requestOnce(http)).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(off)).toEqual([]);
  });

  test('variable set: one redacted JSONL line per request', async () => {
    const path = join(dir, 'on', 'trace.jsonl');
    const tracer = createHttpTracer(
      resolveTraceFilePath({ AULA_MCP_TRACE_FILE: path } as NodeJS.ProcessEnv),
    );
    if (!tracer) throw new Error('expected a tracer for a set path');
    const http = new AulaHttpClient({ tracer });
    expect(await requestOnce(http)).toBe(200);

    const text = await readWhenWritten(path);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry.status).toBe(200);
    expect(entry.method).toBe('GET');
    expect(entry.responseBody).toContain('"ok":true');
    expect(text).not.toContain(FAKE_BEARER);
    expect(text).not.toContain(FAKE_QUERY_TOKEN);
    expect(text).not.toContain(FAKE_BODY_TOKEN);
    expect(text).toContain('redacted');
  });

  test('widget bearer token under `data` and session ids are redacted; other `data` is kept', async () => {
    const path = join(dir, 'widget', 'trace.jsonl');
    const tracer = createHttpTracer(path);
    if (!tracer) throw new Error('expected a tracer for a set path');
    const http = new AulaHttpClient({ tracer });
    const base = `http://127.0.0.1:${server.port}/api/`;
    await http.request(`${base}?method=aulaToken.getAulaToken&widgetId=0000`);
    await http.request(`${base}?method=calendar.getEvents&sessionUUID=${FAKE_SESSION_UUID}`, {
      method: 'POST',
      headers: { sessionuuid: FAKE_SESSION_UUID },
      body: JSON.stringify({ sessionId: FAKE_SESSION_ID, keep: 'visible-field' }),
    });

    let text = '';
    for (let i = 0; i < 50 && text.trim().split('\n').length < 2; i++) {
      text = await readWhenWritten(path);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).not.toContain(FAKE_WIDGET_TOKEN);
    expect(text).not.toContain(FAKE_SESSION_UUID);
    expect(text).not.toContain(FAKE_SESSION_ID);
    // Only the token endpoint's `data` is a secret; other fields stay readable.
    expect(text).toContain('visible-field');
    expect(text).toContain('widgetId=0000');
  });
});

describe('AulaContext tracer option', () => {
  // `http` is private; read it through a cast rather than widening the API.
  const httpOf = (c: AulaContext) => (c as unknown as { http: AulaHttpClient }).http;

  test('a tracer passed in reaches the shared AulaHttpClient', () => {
    const tracer: WireTracer = { record() {} };
    const context = new AulaContext({ store: new MemoryTokenStore(), tracer });
    expect(httpOf(context).tracer).toBe(tracer);
    context.dispose();
  });

  test('without one, the client keeps its noop default', () => {
    const context = new AulaContext({ store: new MemoryTokenStore() });
    expect(httpOf(context).tracer).toBe(noopTracer);
    context.dispose();
  });
});
