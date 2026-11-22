/**
 * aula.session.status: whether the caller is logged in to Aula here. It
 * makes no call to Aula, so dashboards (borger-all-in-one) can show a
 * connection status without spending one, and it is registered before and
 * after login, so it works while only the login tool is offered.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';

export interface SessionStatus {
  loggedIn: boolean;
  /** When the access token runs out, ISO 8601. The keep-alive renews it before. */
  expiresAt?: string;
  secondsRemaining?: number;
}

export async function sessionStatus(context: AulaContext): Promise<SessionStatus> {
  const tokens = await context.storedTokens();
  if (!tokens) return { loggedIn: false };
  return {
    loggedIn: true,
    expiresAt: new Date(tokens.expires_at * 1000).toISOString(),
    secondsRemaining: Math.max(0, tokens.expires_at - Math.floor(Date.now() / 1000)),
  };
}

export function registerSessionStatusTool(
  server: McpServer,
  context: AulaContext,
  name = 'aula.session.status',
): RegisteredTool {
  return server.registerTool(
    name,
    {
      title: 'Aula login status',
      description:
        'Whether the parent is logged in to Aula here, and when the current access token runs ' +
        'out (it is renewed before then). Reads only the saved login and never calls Aula. ' +
        'Use it when asked whether Aula is connected; for Aula data, call the other tools.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await sessionStatus(context), null, 2) }],
    }),
  );
}
