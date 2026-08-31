/**
 * Minimal structured logger interface. Callers pass their own (pino, console,
 * MCP transport, etc.). Default is silent so tests + libraries don't spam.
 *
 * The two concrete sinks below run every `meta` through `sanitizeLogMeta`
 * first. `AULA_MCP_LOG=1` and `aula login --debug` both point at them, and the
 * meta they carry routinely contains request URLs — which, for Aula, means
 * `?access_token=<JWT>`. Redacting at the sink (rather than only at the call
 * site) means a new `logger.debug` added later can't silently start leaking.
 */

import { sanitizeLogMeta } from './wire-tracer.ts';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function consoleLogger(prefix = 'aula-auth'): Logger {
  return {
    debug: (m, meta) => console.debug(`[${prefix}] ${m}`, sanitizeLogMeta(meta) ?? ''),
    info: (m, meta) => console.info(`[${prefix}] ${m}`, sanitizeLogMeta(meta) ?? ''),
    warn: (m, meta) => console.warn(`[${prefix}] ${m}`, sanitizeLogMeta(meta) ?? ''),
    error: (m, meta) => console.error(`[${prefix}] ${m}`, sanitizeLogMeta(meta) ?? ''),
  };
}

/**
 * Logger that writes every level to stderr. Use this in stdio MCP
 * servers — stdout is the JSON-RPC channel and `console.info`/`debug`
 * default to stdout in Node/Bun, which would corrupt the protocol.
 */
export function stderrLogger(prefix = 'aula-auth'): Logger {
  const write = (level: string, m: string, rawMeta?: Record<string, unknown>): void => {
    const meta = sanitizeLogMeta(rawMeta);
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${prefix}] ${level} ${m}${suffix}\n`);
  };
  return {
    debug: (m, meta) => write('DEBUG', m, meta),
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
