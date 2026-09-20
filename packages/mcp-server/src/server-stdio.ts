/**
 * MCP server, stdio transport. Same tool surface as `server.ts`; meant
 * for spawn-by-agent-runtime use cases (Claude Desktop, Cursor, Cline,
 * openclaw-gateway) where stdio is the simpler local transport — no
 * port allocation, no daemon, no loopback-binding decisions.
 *
 * IMPORTANT: stdout is the JSON-RPC channel. This file MUST NOT write
 * anything to stdout itself. Logs go to stderr via `stderrLogger` when
 * `AULA_MCP_LOG=1`; silent otherwise.
 *
 * Env (HTTP-only vars in `server.ts` are ignored here):
 *   AULA_MCP_DIR     — config dir (default ~/.config/aula-mcp)
 *   AULA_MCP_KEY     — encryption key for the token store
 *   AULA_MCP_RAW=1   — enable the aula.raw_request escape hatch and return the
 *                      calendar / ugeplan results unslimmed and in UTC
 *   AULA_MCP_WRITE=1 — enable write tools (aula.presence.set_template)
 *   AULA_MCP_LOG=1   — verbose logs to stderr
 */

import { silentLogger, stderrLogger } from '@aula-mcp/aula-auth';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpApp } from './setup.ts';

const logger = process.env.AULA_MCP_LOG === '1' ? stderrLogger('aula-mcp') : silentLogger;

const { mcp } = createMcpApp({ logger });

await mcp.connect(new StdioServerTransport());

logger.info('aula-mcp.stdio_ready');

// Graceful shutdown — close the MCP server cleanly so the SDK flushes
// any in-flight responses before the process exits.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('aula-mcp.shutdown', { signal });
  try {
    await mcp.close();
  } catch (err) {
    logger.error('aula-mcp.shutdown_error', { error: (err as Error).message });
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
