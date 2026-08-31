import { afterEach, describe, expect, test } from 'bun:test';
import { AulaHttpClient } from './http.ts';
import type { Logger } from './logger.ts';
import { InMemoryTracer } from './wire-tracer.ts';

/**
 * End-to-end guard for the leak path in #86: Aula puts `access_token` in the
 * query string, so the request URL itself is a credential. The client must
 * hand a sanitised URL to both the wire tracer AND the logger — the latter
 * matters because `AULA_MCP_LOG=1` / `aula login --debug` point a real sink
 * at it, and a caller-supplied logger does no redaction of its own.
 */

/** Stand-in for a real bearer JWT. No test may let this string survive. */
const JWT = 'eyJhbGciOiJSUzI1NiJ9.PAYLOAD.SIGNATURE';
const API_URL = `https://www.aula.dk/api/v22/?method=messaging.getThreads&access_token=${JWT}`;

interface CapturedLog {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

function capturingLogger(sink: CapturedLog[]): Logger {
  return {
    debug: (message, meta) => sink.push({ level: 'debug', message, ...(meta ? { meta } : {}) }),
    info: (message, meta) => sink.push({ level: 'info', message, ...(meta ? { meta } : {}) }),
    warn: (message, meta) => sink.push({ level: 'warn', message, ...(meta ? { meta } : {}) }),
    error: (message, meta) => sink.push({ level: 'error', message, ...(meta ? { meta } : {}) }),
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Replace global fetch; records the URLs it was called with. */
function stubFetch(response: Response | (() => never)): string[] {
  const seen: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    seen.push(String(input));
    if (typeof response === 'function') return Promise.reject(new Error('connection refused'));
    return Promise.resolve(response.clone());
  }) as typeof fetch;
  return seen;
}

describe('AulaHttpClient logging', () => {
  test('logs a redacted URL, and still sends the real one', async () => {
    const seen = stubFetch(new Response('{}', { status: 200 }));
    const logs: CapturedLog[] = [];
    const client = new AulaHttpClient({ logger: capturingLogger(logs) });

    await client.request(API_URL);

    // The wire is untouched — only the log line is scrubbed.
    expect(seen[0]).toBe(API_URL);
    const serialised = JSON.stringify(logs);
    expect(serialised).not.toContain(JWT);
    expect(serialised).not.toContain('SIGNATURE');
    expect(serialised).toContain('http.request');
    expect(serialised).toContain('messaging.getThreads');
  });

  test('logs a redacted URL on a network error too', async () => {
    stubFetch(() => {
      throw new Error('unreachable');
    });
    const logs: CapturedLog[] = [];
    const client = new AulaHttpClient({ logger: capturingLogger(logs) });

    await expect(client.request(API_URL)).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toContain(JWT);
  });

  test('traces a redacted URL', async () => {
    stubFetch(new Response('{}', { status: 200 }));
    const tracer = new InMemoryTracer();
    const client = new AulaHttpClient({ tracer });

    await client.request(API_URL);

    expect(JSON.stringify(tracer.entries)).not.toContain(JWT);
    expect(tracer.entries[0]?.url).toContain('access_token=%3Credacted');
  });
});
