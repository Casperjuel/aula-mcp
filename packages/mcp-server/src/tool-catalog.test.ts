import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { renderToolsMarkdown, toolCatalog } from './tool-catalog.ts';

describe('toolCatalog', () => {
  test('lists every tool, read tools on and gated tools off with what turns them on', () => {
    const tools = toolCatalog({});
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('aula.discover')).toMatchObject({ access: 'read', enabled: true });
    expect(byName.get('aula.presence.set_template')).toMatchObject({
      access: 'write',
      enabled: false,
      enableWith: 'AULA_MCP_WRITE=1',
    });
    expect(byName.get('aula.raw_request')).toMatchObject({
      access: 'raw',
      enabled: false,
      enableWith: 'AULA_MCP_RAW=1',
    });
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(20);
  });

  test('gated tools are enabled when their flag is set', () => {
    const tools = toolCatalog({ AULA_MCP_WRITE: '1' });
    expect(tools.find((t) => t.name === 'aula.presence.set_template')?.enabled).toBe(true);
    expect(tools.find((t) => t.name === 'aula.raw_request')?.enabled).toBe(false);
  });

  test('parameters come from the input schema', () => {
    const today = toolCatalog({}).find((t) => t.name === 'aula.presence.today');
    expect(today?.parameters).toEqual([
      {
        name: 'childIds',
        type: 'array',
        required: true,
        description: 'Aula child IDs (from aula.discover.children[].id)',
      },
    ]);
  });

  test('underscore style renames the tools', () => {
    expect(toolCatalog({}, 'underscore').map((t) => t.name)).toContain('aula_discover');
  });

  test('docs/tools.md is up to date (run `bun run docs:tools`)', async () => {
    const onDisk = await readFile(new URL('../../../docs/tools.md', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderToolsMarkdown(toolCatalog({})));
  });
});
