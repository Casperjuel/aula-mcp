/**
 * Wires AULA_MCP_TRACE_FILE into a JsonlFileTracer for the HTTP server.
 *
 * The wire tracer behind `aula login --debug` was never plugged into the
 * server: AulaContext built its AulaHttpClient without a `tracer`, so
 * `AULA_MCP_LOG=1` shows only method + sanitised URL — no status, no
 * response body, nothing to tell a failed call from a successful one.
 *
 * Off by default: with the variable unset, createHttpTracer returns
 * undefined, no file is touched and AulaHttpClient keeps its noop tracer.
 *
 * When set, the file is created 0600 (sanitised traffic is still
 * operator-only reading) and appended to, one JSONL line per exchange, with
 * the same redaction lists as the CLI transcripts. Nothing rotates it: unset
 * the variable and remove the file when done debugging.
 */

import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { JsonlFileTracer, type WireTracer } from '@aula-mcp/aula-auth';

export function resolveTraceFilePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.AULA_MCP_TRACE_FILE;
  return path && path.length > 0 ? path : undefined;
}

/**
 * Create (or keep) the trace file with mode 0600. Throws synchronously so a
 * path the process can't write fails startup, instead of the server running
 * "fine" while JsonlFileTracer's fire-and-forget writes fail unseen.
 */
export function ensureTraceFileWritable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // 'a' keeps an earlier run's trace. The open mode only applies on create,
  // so chmod also tightens a pre-existing file with looser permissions.
  const fd = openSync(path, 'a', 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

export function createHttpTracer(path: string | undefined): WireTracer | undefined {
  if (!path) return undefined;
  ensureTraceFileWritable(path);
  return new JsonlFileTracer(path);
}
