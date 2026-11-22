/**
 * Multi-parent mode, opt-in (AULA_MCP_ANONYMOUS_TOOL_LIST=1): answer
 * `initialize` and `tools/list` without a token, so a client that lists tools
 * on its own (kagent's controller, which has no parent's token) can see what
 * the server offers. Nothing else is answered this way: any other method,
 * and a request with a token at all, goes through the normal sign-in check.
 *
 * The listing comes from a server with no Aula session and no parent's data,
 * built per request and thrown away; registering tools never touches either,
 * and calling one is refused before it gets there. Tool names and
 * descriptions are the same for every parent, so nothing is told about whom.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { AulaContext } from './aula-context.ts';
import type { GalleryView } from './gallery.ts';
import type { SharedAccess } from './local-tools.ts';
import { createMcpApp } from './setup.ts';
import type { ParentStorage } from './storage.ts';

/** The JSON-RPC methods answered without a token, besides notifications. */
const LISTING_METHODS = new Set(['initialize', 'ping', 'tools/list']);

/** True when the request asks for nothing but the tool list (or a handshake). */
export async function isListingRequest(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || request.headers.has('authorization')) return false;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every((message) => {
      const method = (message as { method?: unknown } | null)?.method;
      return (
        typeof method === 'string' &&
        (LISTING_METHODS.has(method) || method.startsWith('notifications/'))
      );
    })
  );
}

/** Which optional tool groups the server has, so the list matches a parent's. */
export interface ListingFeatures {
  sync: boolean;
  gallery: boolean;
  local: boolean;
  shared: boolean;
}

/** Registration never calls these; tools/call never reaches them. */
const NO_SYNC = { status: async () => [], run: async () => [] };
const NO_GALLERY = {} as GalleryView;
const NO_LOCAL = {} as ParentStorage;
const NO_SHARED: SharedAccess = { owners: async () => [], open: async () => null };
const NO_STORE = { load: async () => null, save: async () => {}, clear: async () => {} };

/** Answers a listing request from a throwaway, session-less server. */
export async function serveToolListing(
  request: Request,
  logger: Logger,
  features: ListingFeatures,
): Promise<Response> {
  const app = createMcpApp({
    logger,
    context: new AulaContext({ logger, store: NO_STORE }),
    ...(features.sync ? { sync: NO_SYNC } : {}),
    ...(features.gallery ? { gallery: NO_GALLERY } : {}),
    ...(features.local ? { local: NO_LOCAL, feedStatus: async () => null } : {}),
    ...(features.shared ? { shared: NO_SHARED } : {}),
  });
  // Stateless: no session id, nothing kept between requests.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await app.mcp.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await app.mcp.close().catch(() => {});
    app.context.dispose();
  }
}
