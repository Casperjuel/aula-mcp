/**
 * Every MCP tool the server has, enabled or not, read straight from
 * registerTools so the list can never drift from what the server offers. The
 * setup UI's "Værktøjer" tab and docs/tools.md are both built from it.
 */

import { silentLogger } from '@aula-mcp/aula-auth';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, z } from 'zod';
import { AulaContext } from './aula-context.ts';
import type { GalleryView } from './gallery.ts';
import type { ParentStorage } from './storage.ts';
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
  /** For gated tools: the flag that decides it, e.g. `AULA_MCP_WRITE=1`. */
  gate?: string;
}

interface Collected {
  name: string;
  config: { title?: string; description?: string; inputSchema?: ZodRawShape };
}

const GATES: Record<Exclude<ToolAccess, 'read'>, string> = {
  write: 'AULA_MCP_WRITE',
  raw: 'AULA_MCP_RAW',
};

/** Write tools that are on unless their flag is `0`. */
const DEFAULT_ON = 'AULA_MCP_MARK_READ';

const ALL_OFF = { AULA_MCP_WRITE: '0', AULA_MCP_RAW: '0', [DEFAULT_ON]: '0' };

export function toolCatalog(
  env: NodeJS.ProcessEnv = process.env,
  style: ToolNameStyle = 'dotted',
): ToolInfo[] {
  const read = collect({ ...env, ...ALL_OFF });
  const only = (flag: string, on: string) =>
    collect({ ...env, ...ALL_OFF, [flag]: on }).filter(
      (tool) => !read.some((r) => r.name === tool.name),
    );
  const defaultOn = env[DEFAULT_ON] !== '0';
  type Row = { tool: Collected; access: ToolAccess; enabled: boolean; on?: string; gate?: string };
  const rows: Row[] = [
    ...read.map((tool): Row => ({ tool, access: 'read', enabled: true })),
    ...only(DEFAULT_ON, '1').map(
      (tool): Row => ({
        tool,
        access: 'write',
        enabled: defaultOn,
        on: `${DEFAULT_ON} unset`,
        gate: `on unless ${DEFAULT_ON}=0`,
      }),
    ),
    ...(['write', 'raw'] as const).flatMap((access) =>
      only(GATES[access], '1').map(
        (tool): Row => ({
          tool,
          access,
          enabled: env[GATES[access]] === '1',
          on: `${GATES[access]}=1`,
          gate: `${GATES[access]}=1`,
        }),
      ),
    ),
  ];
  return rows.map(({ tool, access, enabled, on, gate }) => ({
    name: toolName(tool.name, style),
    ...(tool.config.title ? { title: tool.config.title } : {}),
    description: tool.config.description ?? '',
    access,
    parameters: parametersOf(tool.config.inputSchema ?? {}),
    enabled,
    ...(enabled || !on ? {} : { enableWith: on }),
    ...(gate ? { gate } : {}),
  }));
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
    registerTools(collector, context, env, {
      sync: NO_SYNC,
      gallery: NO_GALLERY,
      local: NO_LOCAL,
    });
  } finally {
    context.dispose();
  }
  return tools;
}

const NO_SYNC = {
  status: async () => [],
  run: async () => [],
};

/** Registration never calls it. */
const NO_GALLERY = {} as GalleryView;
const NO_LOCAL = {} as ParentStorage;

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
    '`AULA_MCP_WRITE=1` and the raw escape hatch needs `AULA_MCP_RAW=1`. Marking',
    'threads read or unread is on unless `AULA_MCP_MARK_READ=0`. With',
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
  if (!tool.gate) return 'read';
  return `${tool.access} (\`${tool.gate}\`)`;
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
