/**
 * OpenTelemetry for the HTTP server: traces, metrics and logs over OTLP/HTTP,
 * each one switched on separately. Off unless AULA_MCP_OTEL=1.
 *
 * Everything here records through the global OpenTelemetry API, so with
 * telemetry off every call is a no-op and tests need no setup. Instruments
 * are made on first use, after startTelemetry() has set the providers.
 *
 * What leaves the pod: route templates (never paths with ids in them), Aula
 * method names, sync job names, tool names, status codes, counts and
 * durations. Never Aula content, URLs with tokens, parent ids in metric
 * labels, or the text of a message. Logs go through sanitizeLogMeta and the
 * fields in MASKED_LOG_FIELDS are masked on top of that.
 */

import { type Logger, sanitizeLogMeta } from '@aula-mcp/aula-auth';
import {
  type Attributes,
  context,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Histogram,
  logs,
  metrics,
  type Context as OtelContext,
  propagation,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  detectResources,
  resourceAttributesEnvDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

export const TELEMETRY_SIGNALS = ['traces', 'metrics', 'logs'] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

export interface TelemetryConfig {
  /** OTLP/HTTP base URL; /v1/traces, /v1/metrics and /v1/logs are added. */
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  signals: Set<TelemetrySignal>;
  /** Share of new traces kept, 0..1. A trace started by the caller keeps the caller's choice. */
  sampleRatio: number;
  metricIntervalMs: number;
  /** Send debug logs too (AULA_MCP_LOG=1); otherwise info and up. */
  debugLogs: boolean;
}

/** Read the config from the environment, or null when telemetry is off. */
export function telemetryConfig(
  env: NodeJS.ProcessEnv,
  serviceVersion: string,
): TelemetryConfig | null {
  if (env.AULA_MCP_OTEL !== '1') return null;
  const signals = new Set<TelemetrySignal>();
  for (const s of (env.AULA_MCP_OTEL_SIGNALS ?? TELEMETRY_SIGNALS.join(',')).split(',')) {
    const name = s.trim();
    if ((TELEMETRY_SIGNALS as readonly string[]).includes(name)) {
      signals.add(name as TelemetrySignal);
    }
  }
  const ratio = Number(env.AULA_MCP_OTEL_SAMPLE_RATIO ?? 1);
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000);
  return {
    endpoint: (env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, ''),
    serviceName: env.OTEL_SERVICE_NAME || 'aula-mcp',
    serviceVersion,
    signals,
    sampleRatio: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1,
    metricIntervalMs: Number.isFinite(interval) && interval >= 1_000 ? interval : 30_000,
    debugLogs: env.AULA_MCP_LOG === '1',
  };
}

export interface Telemetry {
  config: TelemetryConfig;
  /** Send what is still buffered, then stop. */
  shutdown(): Promise<void>;
}

/** Set the global providers for the switched-on signals. */
export function startTelemetry(config: TelemetryConfig): Telemetry {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const resource = resourceFromAttributes({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    ...(process.env.HOSTNAME ? { 'service.instance.id': process.env.HOSTNAME } : {}),
  }).merge(detectResources({ detectors: [resourceAttributesEnvDetector] }));
  const stops: Array<() => Promise<void>> = [];

  if (config.signals.has('traces')) {
    const provider = new TracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(config.sampleRatio) }),
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces` }),
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    stops.push(() => provider.shutdown());
  }
  if (config.signals.has('metrics')) {
    const provider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics` }),
          exportIntervalMillis: config.metricIntervalMs,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(provider);
    stops.push(() => provider.shutdown());
  }
  if (config.signals.has('logs')) {
    const provider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: `${config.endpoint}/v1/logs` }),
        }),
      ],
    });
    logs.setGlobalLoggerProvider(provider);
    stops.push(() => provider.shutdown());
  }
  logsDebug = config.debugLogs;

  return {
    config,
    shutdown: async () => {
      await Promise.allSettled(stops.map((stop) => stop()));
    },
  };
}

// --- instruments ------------------------------------------------------------

const SCOPE = '@aula-mcp/mcp-server';
const tracer = () => trace.getTracer(SCOPE);
const meter = () => metrics.getMeter(SCOPE);

/** Seconds, from a quick local call to a slow Aula sync page. */
export const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

/**
 * An instrument made on first use. The metrics API has no proxy provider, so
 * it is made again if the global provider changed since (tests).
 */
const once = <T>(make: () => T) => {
  let value: T | undefined;
  let madeFor: unknown;
  return () => {
    const provider = metrics.getMeterProvider();
    if (value === undefined || madeFor !== provider) {
      value = make();
      madeFor = provider;
    }
    return value;
  };
};

const seconds = (name: string, description: string) =>
  once(
    (): Histogram =>
      meter().createHistogram(name, {
        unit: 's',
        description,
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      }),
  );

const httpDuration = seconds(
  'http.server.request.duration',
  'HTTP requests answered by aula-mcp, by route template.',
);
const toolDuration = seconds('aula_mcp.tool.duration', 'MCP tool calls, by tool and outcome.');
const syncDuration = seconds('aula_mcp.sync.duration', 'Background sync jobs, by job and outcome.');
const syncItems = once(() =>
  meter().createCounter('aula_mcp.sync.items', {
    description: 'Items a sync job fetched from Aula, changed in storage, or was refused.',
  }),
);
const auditEvents = once(() =>
  meter().createCounter('aula_mcp.audit.events', {
    description: 'Audit log entries: writes to Aula, syncs, sharing and sign-ins, by outcome.',
  }),
);

const outcome = (ok: boolean) => (ok ? 'ok' : 'error');
const errorType = (err: unknown) => (err instanceof Error ? err.name : 'Error');

// --- HTTP -------------------------------------------------------------------

const headerGetter = {
  get: (carrier: Headers, key: string) => carrier.get(key) ?? undefined,
  keys: (carrier: Headers) => [...carrier.keys()],
};

/** The route template that answered, e.g. `/data/messages/:id/reply`. */
function routeOf(c: Parameters<MiddlewareHandler>[0]): string {
  const handler = matchedRoutes(c)
    .filter((r) => r.method !== 'ALL')
    .at(-1);
  return handler?.path ?? 'unmatched';
}

/**
 * Hono middleware: a server span per request (continuing the caller's trace
 * when it sends `traceparent`) and the request-duration histogram. Health
 * checks are counted but not traced.
 */
export function httpTelemetry(server: 'mcp' | 'setup' | 'api' | 'ui'): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    const method = c.req.method;
    const parent = propagation.extract(context.active(), c.req.raw.headers, headerGetter);
    const span =
      c.req.path === '/healthz'
        ? undefined
        : tracer().startSpan(
            method,
            { kind: SpanKind.SERVER, attributes: { 'http.request.method': method, server } },
            parent,
          );
    let failed: unknown;
    try {
      await context.with(span ? trace.setSpan(parent, span) : parent, next);
    } catch (err) {
      failed = err;
      throw err;
    } finally {
      const route = routeOf(c);
      const status = failed ? 500 : c.res.status;
      const attributes: Attributes = {
        'http.request.method': method,
        'http.route': route,
        'http.response.status_code': status,
        server,
      };
      if (span) {
        span.updateName(`${method} ${route}`);
        span.setAttributes(attributes);
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      httpDuration().record((performance.now() - started) / 1000, attributes);
    }
  };
}

// --- tools, sync, audit -----------------------------------------------------

async function inSpan<T>(
  name: string,
  attributes: Attributes,
  run: () => Promise<T>,
  parent: OtelContext = context.active(),
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      return await run();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorType(err) });
      span.setAttribute('error.type', errorType(err));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Wraps an MCP tool callback in a span and the tool-duration histogram. A
 * result with `isError` counts as an error, the same as a throw.
 */
export function instrumentTool<A extends unknown[], R>(
  tool: string,
  callback: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const started = performance.now();
    let ok = false;
    try {
      const result = await inSpan(`tool ${tool}`, { 'mcp.tool.name': tool }, async () => {
        const r = await callback(...args);
        if ((r as { isError?: boolean } | null)?.isError === true) {
          trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: 'tool error' });
        } else {
          ok = true;
        }
        return r;
      });
      return result;
    } finally {
      toolDuration().record((performance.now() - started) / 1000, {
        tool,
        outcome: outcome(ok),
      });
    }
  };
}

export interface SyncJobTelemetry {
  fetched: number;
  changed: number;
  skipped?: number;
}

/** Runs one sync job in a span and records its duration and item counts. */
export async function traceSyncJob<T extends SyncJobTelemetry>(
  job: string,
  trigger: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let ok = false;
  try {
    // A sync job is its own trace, not part of whatever request started the tick.
    const result = await inSpan(
      `sync ${job}`,
      { 'aula_mcp.sync.job': job, 'aula_mcp.sync.trigger': trigger },
      run,
      trigger === 'manual' ? context.active() : trace.deleteSpan(context.active()),
    );
    ok = true;
    const items = syncItems();
    // Not `job`: that is Prometheus's own label for the scrape target.
    const labels = { 'aula_mcp.sync.job': job };
    items.add(result.fetched, { ...labels, kind: 'fetched' });
    items.add(result.changed, { ...labels, kind: 'changed' });
    if (result.skipped) items.add(result.skipped, { ...labels, kind: 'skipped' });
    return result;
  } finally {
    syncDuration().record((performance.now() - started) / 1000, {
      'aula_mcp.sync.job': job,
      'aula_mcp.sync.trigger': trigger,
      outcome: outcome(ok),
    });
  }
}

/** Counts an audit entry by category, action and outcome. */
export function countAuditEvent(category: string, action: string, ok: boolean): void {
  auditEvents().add(1, { category, action, outcome: outcome(ok) });
}

/** Reports gauges read when metrics are collected, e.g. open MCP sessions. */
export function observeGauge(
  name: string,
  description: string,
  read: () => Array<{ value: number; attributes?: Attributes }>,
): void {
  meter()
    .createObservableGauge(name, { description })
    .addCallback((result) => {
      for (const { value, attributes } of read()) result.observe(value, attributes);
    });
}

// --- logs -------------------------------------------------------------------

/** Log fields that are masked before a log record leaves the pod. */
export const MASKED_LOG_FIELDS = /username|snippet|session|cookie|token|password|secret|code/i;

let logsDebug = false;

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
} as const;

/** Log attributes as OTLP takes them: primitives, the rest as short JSON. */
export function logAttributes(meta: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(sanitizeLogMeta(meta) ?? {})) {
    if (MASKED_LOG_FIELDS.test(key)) {
      out[key] = '[masked]';
    } else if (typeof value === 'string') {
      out[key] = value.slice(0, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value != null) {
      out[key] = JSON.stringify(value).slice(0, 500);
    }
  }
  return out;
}

/**
 * The given logger, plus every info, warn and error line (and debug when
 * AULA_MCP_LOG=1) as an OpenTelemetry log record in the current trace. With
 * the logs signal off the records go nowhere.
 */
export function withTelemetryLogs(base: Logger): Logger {
  const emit = (level: keyof typeof SEVERITY, message: string, meta?: Record<string, unknown>) => {
    if (level === 'debug' && !logsDebug) return;
    logs.getLogger(SCOPE).emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: message,
      attributes: logAttributes(meta),
    });
  };
  return {
    debug: (m, meta) => {
      base.debug(m, meta);
      emit('debug', m, meta);
    },
    info: (m, meta) => {
      base.info(m, meta);
      emit('info', m, meta);
    },
    warn: (m, meta) => {
      base.warn(m, meta);
      emit('warn', m, meta);
    },
    error: (m, meta) => {
      base.error(m, meta);
      emit('error', m, meta);
    },
  };
}
