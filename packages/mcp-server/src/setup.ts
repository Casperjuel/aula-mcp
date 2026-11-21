/**
 * Shared MCP server construction. Both transports (HTTP in `server.ts`,
 * stdio in `server-stdio.ts`) wire the same tool surface, instructions,
 * and AulaContext. Keeping the construction here means only one place
 * to edit when capabilities or instructions change.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AulaContext } from './aula-context.ts';
import type { ParentSync } from './sync.ts';
import { type ToolNameStyle, toolName, toolNameStyle, underscoreTools } from './tool-names.ts';
import { registerTools } from './tools.ts';
import { VERSION } from './version.ts';

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

/**
 * A parent who has not logged in to Aula yet (multi-parent mode). Their
 * session gets one small tool instead of the whole Aula tool set: every tool
 * schema is sent to the model with each request, so this keeps a chat that
 * can't reach Aula anyway cheap, and the model can answer with the login link
 * straight from the tool description. Once the parent has logged in, calling
 * the tool swaps in the Aula tools (the client is told the tool list changed).
 */
export interface LoginRequired {
  /** Where the parent logs in to Aula; null without a setup UI. */
  setupUrl: string | null;
  /** True once the parent's Aula tokens are saved. */
  loggedIn(): Promise<boolean>;
}

export interface McpAppOptions {
  logger: Logger;
  /** Reuse this context instead of creating one. The HTTP server passes one
   *  for all its sessions so they share a single token refresh path, client
   *  and set of caches (and one token-file watcher) rather than one each. */
  context?: AulaContext;
  /** Defaults to AULA_MCP_TOOL_NAMES; see tool-names.ts. */
  toolNames?: ToolNameStyle;
  /** Start the session with only the login tool. */
  loginRequired?: LoginRequired;
  /** The caller's background sync, when local storage is on. */
  sync?: ParentSync;
}

export interface McpApp {
  mcp: McpServer;
  context: AulaContext;
}

export function createMcpApp({
  logger,
  context = new AulaContext({ logger }),
  toolNames = toolNameStyle(),
  loginRequired,
  sync,
}: McpAppOptions): McpApp {
  const extras = sync ? { sync } : {};
  const tools =
    toolNames === 'underscore'
      ? underscoreTools((server) => registerTools(server, context, process.env, extras))
      : null;
  const registerAulaTools = (server: McpServer) => {
    if (tools) tools.registerOn(server);
    else registerTools(server, context, process.env, extras);
  };
  const instructions = loginRequired
    ? loginMessage(loginRequired.setupUrl)
    : tools
      ? tools.rewrite(INSTRUCTIONS)
      : INSTRUCTIONS;
  const mcp = new McpServer(
    {
      name: 'aula-mcp',
      version: VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );
  if (loginRequired) registerLoginTool(mcp, loginRequired, toolNames, registerAulaTools);
  else registerAulaTools(mcp);
  return { mcp, context };
}

export function loginMessage(setupUrl: string | null): string {
  const where = setupUrl
    ? `Tell the parent to log in to Aula with MitID at ${setupUrl} and then ask again.`
    : 'Tell the parent to ask whoever runs aula-mcp to log them in to Aula, then ask again.';
  return (
    `The parent is not logged in to Aula, so no Aula data is available. ${where} ` +
    'Reply with just that, in their language, and do not try anything else.'
  );
}

function registerLoginTool(
  mcp: McpServer,
  login: LoginRequired,
  style: ToolNameStyle,
  registerAulaTools: (server: McpServer) => void,
): void {
  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
  const tool = mcp.registerTool(
    toolName('aula.login_required', style),
    {
      title: 'Log in to Aula',
      // The description carries the whole answer, so the model needs no call.
      description: `${loginMessage(login.setupUrl)} Call this only if the parent says they have logged in now.`,
      inputSchema: {},
    },
    async () => {
      if (!(await login.loggedIn())) return text(loginMessage(login.setupUrl));
      tool.remove();
      registerAulaTools(mcp);
      return text(
        'The parent is logged in to Aula now and the Aula tools are available. ' +
          `Call ${toolName('aula.discover', style)} first, then answer.`,
      );
    },
  );
}
