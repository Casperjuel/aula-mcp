import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@aula-mcp/aula-auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMcpApp } from './setup.ts';
import { toolNameRewriter, toolNameStyle, underscoreTools } from './tool-names.ts';

async function connect(mcp: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

/** What the Anthropic Messages API accepts as a tool name. */
const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

describe('toolNameStyle', () => {
  test('defaults to dotted and accepts underscore', () => {
    expect(toolNameStyle({})).toBe('dotted');
    expect(toolNameStyle({ AULA_MCP_TOOL_NAMES: '' })).toBe('dotted');
    expect(toolNameStyle({ AULA_MCP_TOOL_NAMES: 'underscore' })).toBe('underscore');
    expect(() => toolNameStyle({ AULA_MCP_TOOL_NAMES: 'snake' })).toThrow('AULA_MCP_TOOL_NAMES');
  });
});

describe('toolNameRewriter', () => {
  const rewrite = toolNameRewriter(['aula.discover', 'aula.messages.get_thread']);

  test('rewrites known tool names, the longest prefix of a dotted path, and nothing else', () => {
    expect(rewrite('Call `aula.discover` first, then aula.messages.get_thread.')).toBe(
      'Call `aula_discover` first, then aula_messages_get_thread.',
    );
    expect(rewrite('ids from aula.discover.children[].id')).toBe(
      'ids from aula_discover.children[].id',
    );
    expect(rewrite('log in at aula.dk; aula.messages is a group')).toBe(
      'log in at aula.dk; aula.messages is a group',
    );
  });
});

describe('underscoreTools', () => {
  test('renames tools and rewrites their descriptions and text results', async () => {
    const tools = underscoreTools((server) => {
      server.registerTool(
        'aula.a',
        { description: 'Then call aula.b.', inputSchema: { n: z.number() } },
        async ({ n }) => ({ content: [{ type: 'text', text: `aula.b with ${n}` }] }),
      );
      server.registerTool('aula.b', { description: 'B' }, async () => ({
        content: [{ type: 'text', text: 'see aula.dk' }],
      }));
    });
    const mcp = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    tools.registerOn(mcp);
    const client = await connect(mcp);

    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => [t.name, t.description])).toEqual([
      ['aula_a', 'Then call aula_b.'],
      ['aula_b', 'B'],
    ]);
    const result = await client.callTool({ name: 'aula_a', arguments: { n: 2 } });
    expect(result.content).toEqual([{ type: 'text', text: 'aula_b with 2' }]);
    const other = await client.callTool({ name: 'aula_b', arguments: {} });
    expect(other.content).toEqual([{ type: 'text', text: 'see aula.dk' }]);
    expect(tools.rewrite('use aula.a')).toBe('use aula_a');
    await client.close();
  });
});

describe('createMcpApp tool names', () => {
  test('underscore: every tool name is one the Anthropic API accepts, and so are mentions', async () => {
    const app = createMcpApp({ logger: silentLogger, toolNames: 'underscore' });
    const client = await connect(app.mcp);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.name).toMatch(ANTHROPIC_TOOL_NAME);
      // A description may only name tools that exist under their new name.
      expect(tool.description ?? '').not.toMatch(/\baula\.discover\b/);
    }
    expect(tools.map((t) => t.name)).toContain('aula_discover');
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('`aula_discover`');
    expect(instructions).not.toContain('aula.discover');
    await client.close();
    app.context.dispose();
  });

  test('dotted (the default) keeps the names as they always were', async () => {
    const app = createMcpApp({ logger: silentLogger, toolNames: 'dotted' });
    const client = await connect(app.mcp);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('aula.discover');
    expect(client.getInstructions()).toContain('`aula.discover`');
    await client.close();
    app.context.dispose();
  });
});
