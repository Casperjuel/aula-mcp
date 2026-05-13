/**
 * Hono-native MCP SSE transport.
 *
 * The MCP SDK ships an `SSEServerTransport`, but it's Node-only (built on
 * `http.IncomingMessage`/`ServerResponse`) and marked deprecated in favour of
 * Streamable HTTP. Home Assistant's official MCP client integration still
 * speaks the legacy SSE transport, so we ship a Hono/Bun-compatible
 * implementation here.
 *
 * Legacy SSE transport protocol:
 *   1. Client GETs `/sse` and keeps the connection open.
 *   2. Server's FIRST SSE event MUST be `event: endpoint` whose data is the
 *      URI the client should POST subsequent messages to (including the
 *      sessionId query parameter that ties POSTs back to this stream).
 *   3. Client POSTs JSON-RPC messages to `/messages?sessionId=…`.
 *   4. Server pushes JSON-RPC responses as `event: message` events on the
 *      held-open SSE stream.
 *
 * One SSE connection = one transport instance = one MCP server session.
 */

import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import type { SSEStreamingApi } from 'hono/streaming';

export interface HonoSseTransportOptions {
  sessionId: string;
  /** Path the client should POST follow-up messages to. */
  messageEndpoint: string;
  stream: SSEStreamingApi;
  /**
   * Invoked whenever the transport sees inbound or outbound traffic. Used by
   * the host to update a `lastActivityAt` field for idle-session eviction.
   */
  onActivity?: () => void;
}

export class HonoSseTransport implements Transport {
  readonly sessionId: string;

  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;

  private readonly stream: SSEStreamingApi;
  private readonly messageEndpoint: string;
  private readonly onActivity: (() => void) | undefined;
  private closed = false;
  private started = false;

  constructor(opts: HonoSseTransportOptions) {
    this.sessionId = opts.sessionId;
    this.stream = opts.stream;
    this.messageEndpoint = opts.messageEndpoint;
    this.onActivity = opts.onActivity;
  }

  async start(): Promise<void> {
    if (this.started) {
      // The SDK calls start() implicitly via Server.connect(); calling it
      // twice is a programming error, not a runtime condition.
      throw new Error('HonoSseTransport.start() called twice');
    }
    this.started = true;
    const url = `${this.messageEndpoint}?sessionId=${encodeURIComponent(this.sessionId)}`;
    await this.stream.writeSSE({ event: 'endpoint', data: url });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed || this.stream.aborted || this.stream.closed) return;
    await this.stream.writeSSE({ event: 'message', data: JSON.stringify(message) });
    this.onActivity?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.stream.closed && !this.stream.aborted) {
      try {
        await this.stream.close();
      } catch {
        // Stream may already be torn down by the runtime; nothing to do.
      }
    }
    this.onclose?.();
  }

  /**
   * Feed a JSON-RPC message that arrived via POST /messages into the
   * transport's onmessage callback. Called by the route handler.
   *
   * Mirrors the stock `SSEServerTransport.handleMessage()` behaviour from
   * the MCP SDK: the inbound payload is run through `JSONRPCMessageSchema`
   * before it ever reaches `onmessage`, so a malformed body surfaces as an
   * `onerror` event instead of being passed up the stack as a half-typed
   * value the SDK will trip over.
   */
  receive(message: unknown, extra?: MessageExtraInfo): void {
    if (this.closed) {
      this.onerror?.(new Error('Received message on closed SSE transport'));
      return;
    }
    if (!this.onmessage) {
      // The Transport interface explicitly warns about this race: "This
      // method should only be called after callbacks are installed, or
      // else messages may be lost." McpServer.connect() installs the
      // handler before transport.start() resolves, so in practice this
      // only fires on truly out-of-order traffic.
      this.onerror?.(new Error('Received message before onmessage handler installed'));
      return;
    }
    let parsed: JSONRPCMessage;
    try {
      parsed = JSONRPCMessageSchema.parse(message);
    } catch (err) {
      this.onerror?.(err as Error);
      return;
    }
    this.onActivity?.();
    this.onmessage(parsed, extra);
  }
}
