import { afterEach, describe, expect, test } from 'bun:test';
import { consoleLogger, silentLogger, stderrLogger } from './logger.ts';

/**
 * The README tells people a `--debug` trace (and `AULA_MCP_LOG=1` output) is
 * safe to attach to a GitHub issue. These tests hold the sinks to that
 * promise: no bearer token, in a meta field or inside a URL, may reach the
 * console or stderr.
 */

/** Stand-in for a real bearer JWT. No test may let this string survive. */
const JWT = 'eyJhbGciOiJSUzI1NiJ9.PAYLOAD.SIGNATURE';
const API_URL = `https://www.aula.dk/api/v22/?method=messaging.getThreads&access_token=${JWT}`;

const originalConsole = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};
const originalStderrWrite = process.stderr.write.bind(process.stderr);

afterEach(() => {
  console.debug = originalConsole.debug;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  process.stderr.write = originalStderrWrite;
});

/** Swap all four console methods for a collector and return what was written. */
function captureConsole(run: () => void): string {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.debug = sink;
  console.info = sink;
  console.warn = sink;
  console.error = sink;
  run();
  return lines.join('\n');
}

function captureStderr(run: () => void): string {
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  run();
  return chunks.join('');
}

describe('consoleLogger', () => {
  test('never emits an access_token carried in a request URL', () => {
    const out = captureConsole(() => {
      consoleLogger('test').debug('http.request', { method: 'GET', url: API_URL });
    });
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('SIGNATURE');
    expect(out).toContain('messaging.getThreads');
  });

  test('never emits a token passed as a meta field, at any level', () => {
    const out = captureConsole(() => {
      const log = consoleLogger('test');
      log.info('oauth.tokens', { access_token: JWT, refresh_token: JWT, id_token: JWT });
      log.warn('oauth.nested', { record: { tokens: { access_token: JWT } } });
      log.error('oauth.failed', { url: `https://example.com/cb?code=AUTHCODE&state=STATE` });
    });
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('AUTHCODE');
    expect(out).not.toContain('STATE');
  });
});

describe('stderrLogger', () => {
  test('never emits an access_token carried in a request URL', () => {
    const out = captureStderr(() => {
      stderrLogger('test').debug('http.request', { method: 'GET', url: API_URL });
    });
    expect(out).not.toContain(JWT);
    expect(out).toContain('http.request');
    expect(out).toContain('messaging.getThreads');
  });

  test('never emits a token passed as a meta field', () => {
    const out = captureStderr(() => {
      stderrLogger('test').error('token-store.refresh.failed', { refresh_token: JWT });
    });
    expect(out).not.toContain(JWT);
    expect(out).toContain('<redacted');
  });
});

describe('silentLogger', () => {
  test('writes nothing at all', () => {
    const out = captureConsole(() => {
      silentLogger.debug('http.request', { url: API_URL });
    });
    expect(out).toBe('');
  });
});
