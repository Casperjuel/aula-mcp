/**
 * The dashboard server in front of the API (ui-app.ts). Stateless: no Aula
 * session, no stored data, so it can run anywhere the API is reachable.
 *
 * Env:
 *   AULA_MCP_UI_PORT          — port to bind (default 8099), on all interfaces
 *   AULA_MCP_UI_URL           — the origin browsers open the dashboard on
 *   AULA_MCP_OIDC_ISSUER      — the identity provider, as for the API
 *   AULA_MCP_UI_CLIENT_ID     — the dashboard's OIDC client
 *   AULA_MCP_UI_CLIENT_SECRET — for a confidential client. Optional.
 *   AULA_MCP_UI_SCOPES        — scopes asked for on top of openid profile email
 *                               (default aula:write, which the API wants for
 *                               changes)
 *   AULA_MCP_API_URL          — where the API is, e.g. http://aula-mcp-api:8080
 *   AULA_MCP_API_UI_KEY       — the key the API knows this server by
 *   AULA_MCP_LOG=1            — console logs
 *   AULA_MCP_OTEL=1           — OpenTelemetry, as for the MCP server
 */

import { consoleLogger, silentLogger } from '@aula-mcp/aula-auth';
import { resolveUiServer, ServerModeError } from './server-mode.ts';
import { createSetupLogin } from './setup-login.ts';
import { httpTelemetry, startTelemetry, telemetryConfig, withTelemetryLogs } from './telemetry.ts';
import { createUiApp } from './ui-app.ts';
import { VERSION } from './version.ts';

const config = (() => {
  try {
    return resolveUiServer(process.env);
  } catch (err) {
    if (!(err instanceof ServerModeError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
})();

const otel = (() => {
  const telemetry = telemetryConfig(process.env, VERSION);
  return telemetry ? startTelemetry(telemetry) : null;
})();
const baseLogger = process.env.AULA_MCP_LOG === '1' ? consoleLogger('aula-mcp-ui') : silentLogger;
const logger = otel ? withTelemetryLogs(baseLogger) : baseLogger;

const app = createUiApp({
  logger,
  login: createSetupLogin({
    ...config.login,
    issuer: config.issuer,
    logger,
    forwardTokens: { scopes: config.scopes },
  }),
  apiUrl: config.apiUrl,
  uiKey: config.uiKey,
  ...(otel ? { middleware: httpTelemetry('ui') } : {}),
});

const server = Bun.serve({
  port: config.port,
  hostname: '0.0.0.0',
  // The Aula login streams its progress over SSE; Bun's 10 s default would
  // close it mid-flow.
  idleTimeout: 240,
  fetch: app.fetch,
});
logger.info('aula-mcp.ui.listening', { port: config.port });
process.stdout.write(`aula-mcp dashboard listening on http://0.0.0.0:${config.port}/\n`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.stop();
  await otel?.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
