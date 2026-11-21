/**
 * Every MCP tool the server has, enabled or not, read straight from
 * registerTools so the list can never drift from what the server offers. The
 * setup UI's "Værktøjer" tab and docs/tools.md are both built from it.
 */

import { silentLogger } from '@aula-mcp/aula-auth';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, z } from 'zod';
import { AulaContext } from './aula-context.ts';
import { type ToolNameStyle, toolName } from './tool-names.ts';
import { registerTools } from './tools.ts';

export type ToolAccess = 'read' | 'write' | 'raw';

export interface ToolParameter {
  name: string;
  /** JSON Schema type, e.g. `string`, `array`, `integer`. */
  type: string;
  required: boolean;
  description?: string;
}

export interface ToolInfo {
  name: string;
  title?: string;
  description: string;
  access: ToolAccess;
  parameters: ToolParameter[];
  enabled: boolean;
  /** Set when the tool is off: what turns it on. */
  enableWith?: string;
}

interface Collected {
  name: string;
  config: { title?: string; description?: string; inputSchema?: ZodRawShape };
}

const GATES: Record<Exclude<ToolAccess, 'read'>, string> = {
  write: 'AULA_MCP_WRITE',
  raw: 'AULA_MCP_RAW',
};

export function toolCatalog(
  env: NodeJS.ProcessEnv = process.env,
  style: ToolNameStyle = 'dotted',
): ToolInfo[] {
  const read = collect({ ...env, AULA_MCP_WRITE: '0', AULA_MCP_RAW: '0' });
  const gated = (access: keyof typeof GATES) =>
    collect({ ...env, AULA_MCP_WRITE: '0', AULA_MCP_RAW: '0', [GATES[access]]: '1' }).filter(
      (tool) => !read.some((r) => r.name === tool.name),
    );
  const all: Array<[Collected, ToolAccess]> = [
    ...read.map((tool) => [tool, 'read'] as [Collected, ToolAccess]),
    ...gated('write').map((tool) => [tool, 'write'] as [Collected, ToolAccess]),
    ...gated('raw').map((tool) => [tool, 'raw'] as [Collected, ToolAccess]),
  ];
  return all.map(([tool, access]) => {
    const enabled = access === 'read' || env[GATES[access]] === '1';
    return {
      name: toolName(tool.name, style),
      ...(tool.config.title ? { title: tool.config.title } : {}),
      description: tool.config.description ?? '',
      access,
      parameters: parametersOf(tool.config.inputSchema ?? {}),
      enabled,
      ...(enabled ? {} : { enableWith: `${GATES[access as keyof typeof GATES]}=1` }),
    };
  });
}

function collect(env: NodeJS.ProcessEnv): Collected[] {
  const tools: Collected[] = [];
  const collector = {
    registerTool: (name: string, config: Collected['config']) => {
      tools.push({ name, config });
    },
  } as unknown as McpServer;
  // Registration never touches the context; only the handlers do.
  const context = new AulaContext({ logger: silentLogger, store: NO_STORE });
  try {
    registerTools(collector, context, env, { sync: NO_SYNC });
  } finally {
    context.dispose();
  }
  return tools;
}

const NO_SYNC = {
  status: async () => [],
  run: async () => [],
};

const NO_STORE = {
  load: async () => null,
  save: async () => {},
  clear: async () => {},
};

function parametersOf(shape: ZodRawShape): ToolParameter[] {
  const schema = z.toJSONSchema(z.object(shape), { unrepresentable: 'any' }) as {
    properties?: Record<string, { type?: string | string[]; description?: string }>;
    required?: string[];
  };
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    type: [property.type ?? 'any'].flat().join(' | '),
    required: schema.required?.includes(name) ?? false,
    ...(property.description ? { description: property.description } : {}),
  }));
}

/** docs/tools.md, generated; `bun run docs:tools` rewrites it. */
export function renderToolsMarkdown(tools: ToolInfo[]): string {
  const lines = [
    '# aula-mcp tools',
    '',
    '<!-- Generated from tool-catalog.ts by `bun run docs:tools`. Do not edit by hand. -->',
    '',
    'Every MCP tool the server offers. Read tools are always on; write tools need',
    '`AULA_MCP_WRITE=1` and the raw escape hatch needs `AULA_MCP_RAW=1`. With',
    '`AULA_MCP_TOOL_NAMES=underscore` the dots become underscores (`aula_discover`).',
    '',
    '| Tool | Access | What it does |',
    '| --- | --- | --- |',
    ...tools.map(
      (tool) =>
        `| [\`${tool.name}\`](#${anchor(tool.name)}) | ${accessLabel(tool)} | ${tool.title ?? ''} |`,
    ),
    '',
  ];
  for (const tool of tools) {
    lines.push(`## \`${tool.name}\``, '');
    if (tool.title) lines.push(`**${tool.title}** · ${accessLabel(tool)}`, '');
    lines.push(tool.description, '');
    if (tool.parameters.length === 0) {
      lines.push('No parameters.', '');
      continue;
    }
    lines.push('| Parameter | Type | Required | Description |', '| --- | --- | --- | --- |');
    for (const p of tool.parameters) {
      lines.push(
        `| \`${p.name}\` | ${p.type} | ${p.required ? 'yes' : 'no'} | ${cell(p.description ?? '')} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function accessLabel(tool: ToolInfo): string {
  if (tool.access === 'read') return 'read';
  return `${tool.access} (\`${GATES[tool.access]}=1\`)`;
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
