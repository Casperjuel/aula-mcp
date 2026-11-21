/**
 * Tool name style. The tools are named with dots (`aula.discover`), which
 * MCP allows, but the Anthropic Messages API only takes tool names matching
 * `^[a-zA-Z0-9_-]{1,128}$`. A client that hands MCP tool names straight to
 * that API (kagent does) gets a 400 for every request. With
 * AULA_MCP_TOOL_NAMES=underscore the tools are registered as `aula_discover`
 * and so on, and every mention of a tool name in the instructions, the tool
 * descriptions and the tool results is rewritten to match, so the model never
 * sees a name it can't call.
 *
 * The default stays `dotted`: clients that already work keep their names.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolNameStyle = 'dotted' | 'underscore';

export function toolNameStyle(env: NodeJS.ProcessEnv = process.env): ToolNameStyle {
  const value = env.AULA_MCP_TOOL_NAMES?.trim() || 'dotted';
  if (value === 'dotted' || value === 'underscore') return value;
  throw new Error(`AULA_MCP_TOOL_NAMES must be "dotted" or "underscore", got "${value}".`);
}

/** Rewrites the given tool names in free text, and leaves anything else
 *  that merely looks like one (`aula.dk`) alone. `aula.discover.children`
 *  becomes `aula_discover.children`: the longest tool name prefix wins. */
export function toolNameRewriter(names: Iterable<string>): (text: string) => string {
  const known = new Set(names);
  return (text) =>
    text.replace(/\baula(?:\.[a-z_]+)+/g, (match) => {
      for (let end = match.length; end > 0; end = match.lastIndexOf('.', end - 1)) {
        const candidate = match.slice(0, end);
        if (known.has(candidate)) return candidate.replaceAll('.', '_') + match.slice(end);
      }
      return match;
    });
}

type ToolHandler = (...args: unknown[]) => unknown;
/** One `registerTool` call. Its generic signature doesn't survive
 *  `Parameters<>`, so this spells out the part we touch. */
type RegisterArgs = [name: string, config: { description?: string }, handler: ToolHandler];

/** Tools collected from a `registerTools`-style function, ready to be
 *  registered on a server with underscore names. */
export interface UnderscoreTools {
  /** Rewrites tool names in other text, e.g. the server instructions. */
  rewrite(text: string): string;
  /** Registers the tools, with rewritten names, descriptions and results. */
  registerOn(mcp: McpServer): void;
}

export function underscoreTools(register: (server: McpServer) => void): UnderscoreTools {
  const calls: RegisterArgs[] = [];
  const collector = {
    registerTool: (...args: RegisterArgs) => {
      calls.push(args);
    },
  } as unknown as McpServer;
  register(collector);

  const rewrite = toolNameRewriter(calls.map(([name]) => name));
  return {
    rewrite,
    registerOn(mcp) {
      for (const [name, config, handler] of calls) {
        const wrapped: ToolHandler = async (...args) =>
          rewriteResult(await handler(...args), rewrite);
        (mcp.registerTool as (...args: RegisterArgs) => unknown).call(
          mcp,
          rewrite(name),
          {
            ...config,
            ...(config.description !== undefined
              ? { description: rewrite(config.description) }
              : {}),
          },
          wrapped,
        );
      }
    },
  };
}

function rewriteResult(result: unknown, rewrite: (text: string) => string): unknown {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return result;
  return {
    ...(result as object),
    content: content.map((item: { type?: unknown; text?: unknown }) =>
      item.type === 'text' && typeof item.text === 'string'
        ? { ...item, text: rewrite(item.text) }
        : item,
    ),
  };
}
