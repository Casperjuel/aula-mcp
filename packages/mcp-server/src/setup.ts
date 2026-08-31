/**
 * Shared MCP server construction. Both transports (HTTP in `server.ts`,
 * stdio in `server-stdio.ts`) wire the same tool surface, instructions,
 * and AulaContext. Keeping the construction here means only one place
 * to edit when capabilities or instructions change.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AulaContext } from './aula-context.ts';
import { registerTools } from './tools.ts';

const INSTRUCTIONS = [
  'This server exposes the Danish school platform Aula to AI agents.',
  '',
  'Workflow:',
  '1. Call `aula.discover` ONCE per session and reuse the manifest. It returns',
  '   children (with names + ids), institutions, the current API version, and',
  "   `detectedWidgets` — the widget IDs this user's schools actually have.",
  '2. Resolve any kid names mentioned in the user prompt against',
  '   `manifest.children[].name` (case-insensitive, partial — e.g. `luk`',
  "   matches `Lukas`). Use the matching child's `id` for `childIds` and for",
  '   `aula.calendar.events` `profileIds`. Only use `userId` when a tool schema',
  '   explicitly asks for a user/profile user ID.',
  '3. Pick ONE subordinate tool, not many. `manifest.capabilities[area].tools[0]`',
  '   is the right one for this user — only fall back to alternatives if the',
  "   first errors. Never call ugeplan tools whose widget id isn't in",
  '   `detectedWidgets`.',
  "4. Default time windows: when the user says 'denne uge' / 'this week' use",
  "   `range: 'this_week'`; 'næste uge' → 'next_week'; 'i dag' → 'today'.",
  "   All times are Europe/Copenhagen — don't shift them.",
  "5. Reply in the user's language (Danish if they wrote Danish). Dates as",
  '   `mandag 12. maj`-style, not ISO, unless they ask.',
  '',
  "Never re-call `aula.discover` mid-session unless a tool returns 'children",
  "or widgets unknown' — token refresh is handled server-side, you don't need",
  'to poll for it.',
].join('\n');

export interface McpAppOptions {
  logger: Logger;
}

export interface McpApp {
  mcp: McpServer;
  context: AulaContext;
}

export function createMcpApp({ logger }: McpAppOptions): McpApp {
  const context = new AulaContext({ logger });
  const mcp = new McpServer(
    {
      name: 'aula-mcp',
      version: '0.0.0',
    },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  registerTools(mcp, context);
  return { mcp, context };
}
