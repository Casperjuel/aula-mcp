/**
 * HTTP client tuned for the Aula auth flow.
 *
 * Why custom: the Python reference walks the redirect chain manually because
 * intermediate "200 OK with confirmation form" pages need to be parsed,
 * cross-domain cookies must persist, and the broker flow is sensitive to
 * Referer headers. Bun's native `fetch` is the transport; we layer on cookie
 * persistence and a manual redirect loop on top.
 */

import { AulaCookieJar } from './cookies.ts';
import { RedirectLoopError } from './errors.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import {
  noopTracer,
  sanitizeHeaders,
  sanitizeRequestBody,
  sanitizeResponseBody,
  sanitizeUrl,
  type WireTracer,
} from './wire-tracer.ts';

/** Default headers — replicates the Python mobile-Chrome fingerprint. */
export const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent':
    'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'upgrade-insecure-requests': '1',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
});

export interface AulaHttpClientOptions {
  jar?: AulaCookieJar;
  logger?: Logger;
  /** Override default headers (merged in; lower-cased on lookup). */
  defaultHeaders?: Record<string, string>;
  /** Wire tracer — captures sanitised request/response pairs. Defaults to
   *  noop. The CLI's `aula debug login` swaps in an InMemoryTracer or
   *  JsonlFileTracer to make failures diagnosable. */
  tracer?: WireTracer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams;
  /** Per-request override; defaults to the client's default headers. */
  noDefaultHeaders?: boolean;
}

export interface AulaResponse {
  status: number;
  headers: Headers;
  body: string;
  /** Final URL the request resolved to (= request URL when redirects are manual). */
  url: string;
}

export interface RedirectStep {
  url: string;
  status: number;
}

export interface FollowOptions extends RequestOptions {
  maxHops?: number;
}

export interface FollowResult {
  history: RedirectStep[];
  final: AulaResponse;
}

export class AulaHttpClient {
  readonly jar: AulaCookieJar;
  readonly tracer: WireTracer;
  private readonly logger: Logger;
  private readonly defaultHeaders: Record<string, string>;
  private seq = 0;

  constructor(options: AulaHttpClientOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.jar = options.jar ?? new AulaCookieJar({ logger: this.logger });
    this.tracer = options.tracer ?? noopTracer;
    this.defaultHeaders = { ...DEFAULT_HEADERS, ...(options.defaultHeaders ?? {}) };
  }

  /** Single request, cookies in/out. No automatic redirect following. */
  async request(url: string, options: RequestOptions = {}): Promise<AulaResponse> {
    const headers: Record<string, string> = options.noDefaultHeaders
      ? {}
      : { ...this.defaultHeaders };
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }

    const cookieHeader = await this.jar.cookieHeader(url);
    if (cookieHeader) headers.cookie = cookieHeader;

    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
    };
    if (options.body !== undefined) {
      init.body = options.body;
      // URLSearchParams sets its own content-type; for raw strings, leave to caller.
      if (options.body instanceof URLSearchParams && !('content-type' in headers)) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }

    // sanitizeUrl, not the raw URL: Aula's API carries `access_token` in the
    // query string, and a caller-supplied logger won't necessarily redact it.
    this.logger.debug('http.request', { method: init.method, url: sanitizeUrl(url) });
    const start = Date.now();
    const seq = ++this.seq;
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      // Network-level failure (DNS, connection refused, TLS, abort, etc.).
      // The wire trace is the user's primary debugging surface, so we record
      // the failure as a synthetic status-0 entry before re-throwing.
      const durationMs = Date.now() - start;
      const message = (e as Error).message ?? String(e);
      if (this.tracer !== noopTracer) {
        this.tracer.record({
          ts: new Date().toISOString(),
          seq,
          method: init.method ?? 'GET',
          url: sanitizeUrl(url),
          requestHeaders: sanitizeHeaders(headers),
          requestBody: sanitizeRequestBody(options.body),
          status: 0,
          responseHeaders: {},
          responseBody: `<network error: ${message}>`,
          responseBodyBytes: 0,
          durationMs,
        });
      }
      this.logger.error('http.network_error', { url: sanitizeUrl(url), error: message });
      throw e;
    }
    await this.jar.storeFromResponse(response.headers, url);
    const body = await response.text();
    const durationMs = Date.now() - start;
    if (this.tracer !== noopTracer) {
      const sanitisedBody = sanitizeResponseBody(body);
      this.tracer.record({
        ts: new Date().toISOString(),
        seq,
        method: init.method ?? 'GET',
        url: sanitizeUrl(url),
        requestHeaders: sanitizeHeaders(headers),
        requestBody: sanitizeRequestBody(options.body),
        status: response.status,
        responseHeaders: sanitizeHeaders(response.headers),
        responseBody: sanitisedBody.text,
        responseBodyBytes: sanitisedBody.bytes,
        durationMs,
      });
    }
    return {
      status: response.status,
      headers: response.headers,
      body,
      url,
    };
  }

  /**
   * Follow Location redirects manually, capping at `maxHops`.
   * Stops at the first non-3xx response. The caller decides whether further
   * "200 with hidden form" hops are needed.
   */
  async followRedirects(url: string, options: FollowOptions = {}): Promise<FollowResult> {
    const maxHops = options.maxHops ?? 10;
    const history: RedirectStep[] = [];
    let currentUrl = url;
    let currentOptions: RequestOptions = options;

    for (let hop = 0; hop < maxHops; hop++) {
      const response = await this.request(currentUrl, currentOptions);
      history.push({ url: currentUrl, status: response.status });

      if (response.status < 300 || response.status >= 400) {
        return { history, final: response };
      }

      const location = response.headers.get('location');
      if (!location) {
        // 3xx with no Location is unusual; treat as final.
        return { history, final: response };
      }

      currentUrl = new URL(location, currentUrl).toString();
      // Per RFC 7231: 303 always becomes GET; 301/302 typically become GET in
      // practice but spec ambiguity → preserve method only for 307/308.
      const preserveMethod = response.status === 307 || response.status === 308;
      currentOptions = preserveMethod
        ? { ...options, headers: options.headers ?? {} }
        : { headers: options.headers ?? {} };
    }

    throw new RedirectLoopError(maxHops, currentUrl);
  }
}
