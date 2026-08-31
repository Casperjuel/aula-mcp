/**
 * Wire tracing for the auth flow. When MitID fails (and it will, in subtle
 * ways), Casper needs to see the actual HTTP traffic to figure out why.
 *
 * The tracer gets called by AulaHttpClient before/after every fetch. We
 * sanitize bodies that contain known-secret fields (passwords, auth codes,
 * SAML responses, tokens) so a transcript is safe to share for debugging.
 *
 * Three implementations:
 *   - NoopTracer: default; zero-cost.
 *   - InMemoryTracer: collects all entries in an array. Use for a single CLI
 *     run and dump at the end.
 *   - JsonlFileTracer: appends one JSONL row per entry. Survives crashes.
 *
 * `formatTraceText` turns a trace into a readable terminal report.
 */

import { Buffer } from 'node:buffer';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WireEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  /** Sequence number — useful when sorting entries from concurrent calls. */
  seq: number;
  method: string;
  url: string;
  /** Sanitised request headers. */
  requestHeaders: Record<string, string>;
  /** Body summary; full body is replaced by `<redacted N bytes>` for secrets. */
  requestBody: string | null;
  status: number;
  /** Sanitised response headers. */
  responseHeaders: Record<string, string>;
  /** Body summary, possibly truncated. */
  responseBody: string;
  /** Response body length in bytes (before truncation). */
  responseBodyBytes: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface WireTracer {
  record(entry: WireEntry): void;
}

export const noopTracer: WireTracer = { record() {} };

/** Collect entries in memory. */
export class InMemoryTracer implements WireTracer {
  readonly entries: WireEntry[] = [];
  record(entry: WireEntry): void {
    this.entries.push(entry);
  }
  clear(): void {
    this.entries.length = 0;
  }
}

/** Append-only JSONL file tracer. Creates the parent dir if needed. */
export class JsonlFileTracer implements WireTracer {
  private dirReady = false;
  constructor(private readonly path: string) {}
  record(entry: WireEntry): void {
    void this.write(entry);
  }
  private async write(entry: WireEntry): Promise<void> {
    if (!this.dirReady) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

/** Compose multiple tracers — handy for "in memory AND file". */
export class CompositeTracer implements WireTracer {
  constructor(private readonly tracers: WireTracer[]) {}
  record(entry: WireEntry): void {
    for (const t of this.tracers) t.record(entry);
  }
}

// --------------------------------------------------------------------------
// Sanitization
// --------------------------------------------------------------------------

/** Header names whose value is replaced with `<redacted>`. Lower-case. */
const SECRET_HEADERS = new Set([
  'authorization',
  'aula-authorization',
  'cookie',
  'set-cookie',
  'csrfp-token',
  'x-csrf-token',
]);

/** Body field names (in form-urlencoded or JSON) we redact. */
const SECRET_BODY_FIELDS = [
  'password',
  'pwd',
  'mitidauthcode',
  'authorizationcode',
  'authorization_code',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'code_verifier',
  'samlresponse',
  'relaystate',
  '__requestverificationtoken',
  'sessionstorageactivesessionuuid',
  'sessionstorageactivechallenge',
  'm1',
  'flowvalueproof',
  'randoma',
  'identityclaim',
  'chosenoptionjson',
];

const SECRET_BODY_FIELDS_SET = new Set(SECRET_BODY_FIELDS.map((s) => s.toLowerCase()));

/**
 * Query-string keys to redact in URLs before they hit a tracer or a log sink.
 * Aula's API passes `access_token` as a query param (not a header), so without
 * this a transcript — or a single `logger.debug('http.request', { url })` —
 * would leak the JWT in every URL.
 */
const SECRET_URL_PARAMS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'code_verifier',
  'state',
  'mitidauthcode',
  '__requestverificationtoken',
  'ticket',
  'session_code',
]);

/**
 * Every `*_token` field we know about must be redacted in BOTH places — the
 * body denylist and the query-string denylist — because Aula and the broker
 * disagree on where a token travels. Exported for the parity test that keeps
 * the two lists from drifting when a new field shows up.
 */
export const SECRET_BODY_FIELD_NAMES: readonly string[] = SECRET_BODY_FIELDS;
export const SECRET_URL_PARAM_NAMES: readonly string[] = Array.from(SECRET_URL_PARAMS);

/** True for a value we already replaced — keeps sanitising idempotent. */
function isRedacted(value: string): boolean {
  return value.startsWith('<redacted');
}

/** Sanitise a URL by redacting known-secret query-string values. */
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let mutated = false;
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SECRET_URL_PARAMS.has(key.toLowerCase())) {
      const v = parsed.searchParams.get(key) ?? '';
      if (isRedacted(v)) continue;
      parsed.searchParams.set(key, `<redacted ${v.length}>`);
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : url;
}

/**
 * Sanitise a logger `meta` object before it reaches a console/stderr sink.
 * Uses the same denylists as the wire tracer: secret-named keys are replaced
 * wholesale, and every string is run through `sanitizeUrl`, so a bare
 * `{ url }` in a debug log is no more exposed than a token in a traced body.
 */
export function sanitizeLogMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return meta;
  return redactLogValue(meta) as Record<string, unknown>;
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUrl(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactLogValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_BODY_FIELDS_SET.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? `<redacted ${v.length} chars>` : `<redacted>`;
    } else {
      out[k] = redactLogValue(v);
    }
  }
  return out;
}

/** Truncation cap for response bodies (bytes). */
export const DEFAULT_BODY_CAP = 4_096;

export function sanitizeHeaders(headers: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (SECRET_HEADERS.has(key)) {
      out[key] = `<redacted ${v.length} chars>`;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** Sanitise a request body whose shape may be form-urlencoded or JSON. */
export function sanitizeRequestBody(
  body: string | URLSearchParams | Uint8Array | undefined,
): string | null {
  if (body === undefined) return null;
  if (body instanceof URLSearchParams) {
    const out = new URLSearchParams();
    for (const [k, v] of body) {
      out.set(k, SECRET_BODY_FIELDS_SET.has(k.toLowerCase()) ? `<redacted ${v.length}>` : v);
    }
    return out.toString();
  }
  if (body instanceof Uint8Array) {
    return `<binary ${body.length} bytes>`;
  }
  // String — try JSON first, then assume opaque.
  try {
    const parsed = JSON.parse(body) as unknown;
    return JSON.stringify(redactJson(parsed));
  } catch {
    return truncateString(body, DEFAULT_BODY_CAP);
  }
}

export function sanitizeResponseBody(
  body: string,
  cap = DEFAULT_BODY_CAP,
): {
  text: string;
  bytes: number;
} {
  const bytes = Buffer.byteLength(body, 'utf8');
  // For JSON/HTML responses, redact known secret fields by string match.
  let cleaned = body;
  if (looksLikeJson(body)) {
    try {
      const parsed = JSON.parse(body) as unknown;
      cleaned = JSON.stringify(redactJson(parsed));
    } catch {
      // fall through to raw
    }
  }
  return { text: truncateString(cleaned, cap), bytes };
}

function redactJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJson);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_BODY_FIELDS_SET.has(k.toLowerCase())) {
      out[k] =
        typeof v === 'string'
          ? `<redacted ${v.length}>`
          : v && typeof v === 'object' && 'value' in (v as object)
            ? `<redacted object with .value>`
            : `<redacted>`;
    } else {
      out[k] = redactJson(v);
    }
  }
  return out;
}

function truncateString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}…<+${s.length - cap} chars>`;
}

function looksLikeJson(s: string): boolean {
  const trimmed = s.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

// --------------------------------------------------------------------------
// Pretty-printing
// --------------------------------------------------------------------------

/** Render an InMemoryTracer's entries (or any list) as a human-readable log. */
export function formatTraceText(entries: readonly WireEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`\n# ${e.seq.toString().padStart(3, '0')}  ${e.ts}  ${e.method} ${e.url}`);
    lines.push(`  request headers:`);
    for (const [k, v] of Object.entries(e.requestHeaders)) lines.push(`    ${k}: ${v}`);
    if (e.requestBody) lines.push(`  request body: ${e.requestBody}`);
    lines.push(`  → ${e.status} (${e.durationMs} ms, ${e.responseBodyBytes} bytes)`);
    lines.push(`  response headers:`);
    for (const [k, v] of Object.entries(e.responseHeaders)) lines.push(`    ${k}: ${v}`);
    if (e.responseBody) {
      const indented = e.responseBody
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(`  response body:\n${indented}`);
    }
  }
  return lines.join('\n');
}
