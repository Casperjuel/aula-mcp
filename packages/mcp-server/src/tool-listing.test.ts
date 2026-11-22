/**
 * The tool list without a token: only a handshake and tools/list qualify,
 * and the list is the same one a signed-in parent gets.
 */

import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@aula-mcp/aula-auth';
import { isListingRequest, serveToolListing } from './tool-listing.ts';

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://aula-mcp/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const features = { sync: true, gallery: true, local: true, shared: true };

describe('anonymous tool listing', () => {
  test('qualifies a handshake and tools/list only', async () => {
    expect(await isListingRequest(rpc(initialize))).toBe(true);
    expect(await isListingRequest(rpc(list))).toBe(true);
    expect(
      await isListingRequest(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })),
    ).toBe(true);
    expect(
      await isListingRequest(
        rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aula_discover' } }),
      ),
    ).toBe(false);
    expect(
      await isListingRequest(rpc([list, { jsonrpc: '2.0', id: 4, method: 'tools/call' }])),
    ).toBe(false);
    expect(await isListingRequest(rpc([]))).toBe(false);
    expect(await isListingRequest(rpc(null))).toBe(false);
    expect(await isListingRequest(new Request('http://aula-mcp/mcp'))).toBe(false);
    expect(
      await isListingRequest(
        new Request('http://aula-mcp/mcp', { method: 'POST', body: 'not json' }),
      ),
    ).toBe(false);
  });

  test('a request with a token goes through the sign-in check', async () => {
    expect(await isListingRequest(rpc(list, { authorization: 'Bearer x' }))).toBe(false);
  });

  test('answers initialize and tools/list with the tools, and leaves the body readable', async () => {
    const req = rpc(list);
    expect(await isListingRequest(req)).toBe(true);
    const init = await serveToolListing(rpc(initialize), silentLogger, features);
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const res = await serveToolListing(req, silentLogger, features);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(10);
    expect(names.some((n) => /discover/.test(n))).toBe(true);
    expect(names.some((n) => /local/.test(n))).toBe(true);
  });

  test('lists fewer tools when the server has no local storage', async () => {
    const count = async (f: typeof features) => {
      const res = await serveToolListing(rpc(list), silentLogger, f);
      return ((await res.json()) as { result: { tools: unknown[] } }).result.tools.length;
    };
    const none = { sync: false, gallery: false, local: false, shared: false };
    expect(await count(none)).toBeLessThan(await count(features));
  });
});
