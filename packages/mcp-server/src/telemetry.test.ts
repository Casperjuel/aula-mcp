/**
 * Telemetry against in-memory exporters: config from the environment, HTTP
 * spans and metrics by route template (never the path with its ids), tool
 * and sync outcomes, and log records with sensitive fields masked.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { silentLogger } from '@aula-mcp/aula-auth';
import { context, logs, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { Hono } from 'hono';
import {
  countAuditEvent,
  httpTelemetry,
  instrumentTool,
  logAttributes,
  telemetryConfig,
  traceSyncJob,
  withTelemetryLogs,
} from './telemetry.ts';

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  logs.setGlobalLoggerProvider(
    new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords })] }),
  );
});
afterAll(() => {
  trace.disable();
  metrics.disable();
  logs.disable();
  propagation.disable();
  context.disable();
});

async function points(name: string) {
  await reader.forceFlush();
  const all = metricExporter.getMetrics();
  const latest = all.at(-1);
  return (latest?.scopeMetrics ?? [])
    .flatMap((s) => s.metrics)
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) =>
      m.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value as unknown })),
    );
}

describe('telemetryConfig', () => {
  test('off unless AULA_MCP_OTEL=1', () => {
    expect(telemetryConfig({}, '1.0.0')).toBeNull();
    expect(telemetryConfig({ AULA_MCP_OTEL: 'true' }, '1.0.0')).toBeNull();
  });

  test('reads endpoint, signals, ratio and interval', () => {
    const config = telemetryConfig(
      {
        AULA_MCP_OTEL: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
        OTEL_SERVICE_NAME: 'aula',
        AULA_MCP_OTEL_SIGNALS: 'metrics, logs,bogus',
        AULA_MCP_OTEL_SAMPLE_RATIO: '7',
        OTEL_METRIC_EXPORT_INTERVAL: '10',
      },
      '1.2.3',
    );
    expect(config).toMatchObject({
      endpoint: 'http://collector:4318',
      serviceName: 'aula',
      serviceVersion: '1.2.3',
      sampleRatio: 1,
      metricIntervalMs: 30_000,
      debugLogs: false,
    });
    expect([...(config?.signals ?? [])]).toEqual(['metrics', 'logs']);
    expect([...(telemetryConfig({ AULA_MCP_OTEL: '1' }, 'x')?.signals ?? [])]).toEqual([
      'traces',
      'metrics',
      'logs',
    ]);
  });
});

describe('httpTelemetry', () => {
  test('names spans and metrics by route template', async () => {
    spans.reset();
    const app = new Hono();
    app.use(httpTelemetry('setup'));
    app.get('/healthz', (c) => c.text('ok'));
    app.post('/data/messages/:id/reply', (c) => c.json({}, 201));
    await app.fetch(new Request('http://t/data/messages/12345/reply', { method: 'POST' }));
    await app.fetch(new Request('http://t/healthz'));
    await app.fetch(new Request('http://t/nowhere/999'));

    const names = spans.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['POST /data/messages/:id/reply', 'GET unmatched']);
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      '12345',
    );
    const recorded = (await points('http.server.request.duration')).map((p) => p.attributes);
    expect(recorded).toContainEqual({
      'http.request.method': 'POST',
      'http.route': '/data/messages/:id/reply',
      'http.response.status_code': 201,
      server: 'setup',
    });
    expect(recorded).toContainEqual(expect.objectContaining({ 'http.route': '/healthz' }));
    expect(JSON.stringify(recorded)).not.toContain('999');
  });

  test('names a request answered by a catch-all after it', async () => {
    spans.reset();
    const app = new Hono();
    app.use(httpTelemetry('ui'));
    app.use('*', async (_c, next) => next());
    app.all('/data/*', (c) => c.json({}));
    await app.fetch(new Request('http://t/data/items/message_thread/42'));
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(['GET /data/*']);
  });

  test('continues the caller trace from traceparent', async () => {
    spans.reset();
    const app = new Hono();
    app.use(httpTelemetry('mcp'));
    app.get('/mcp', (c) => c.text('ok'));
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    await app.fetch(
      new Request('http://t/mcp', {
        headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
      }),
    );
    expect(spans.getFinishedSpans()[0]?.spanContext().traceId).toBe(traceId);
  });
});

describe('tools, sync and audit', () => {
  test('a tool result with isError counts as an error', async () => {
    const ok = instrumentTool('list_threads', async () => ({ content: [] }));
    const bad = instrumentTool('send_message', async () => ({ content: [], isError: true }));
    await ok();
    await bad();
    const recorded = (await points('aula_mcp.tool.duration')).map((p) => p.attributes);
    expect(recorded).toContainEqual({ tool: 'list_threads', outcome: 'ok' });
    expect(recorded).toContainEqual({ tool: 'send_message', outcome: 'error' });
  });

  test('a sync job records its items and a failure', async () => {
    await traceSyncJob('messages', 'schedule', async () => ({ fetched: 4, changed: 1 }));
    await expect(
      traceSyncJob('calendar', 'manual', async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const items = await points('aula_mcp.sync.items');
    expect(items).toContainEqual({
      attributes: { 'aula_mcp.sync.job': 'messages', kind: 'fetched' },
      value: 4,
    });
    expect(items).toContainEqual({
      attributes: { 'aula_mcp.sync.job': 'messages', kind: 'changed' },
      value: 1,
    });
    const runs = (await points('aula_mcp.sync.duration')).map((p) => p.attributes);
    expect(runs).toContainEqual({
      'aula_mcp.sync.job': 'calendar',
      'aula_mcp.sync.trigger': 'manual',
      outcome: 'error',
    });
  });

  test('audit entries are counted by category, action and outcome', async () => {
    countAuditEvent('aula', 'reply', true);
    expect(await points('aula_mcp.audit.events')).toContainEqual({
      attributes: { category: 'aula', action: 'reply', outcome: 'ok' },
      value: 1,
    });
  });
});

describe('logs', () => {
  test('sensitive fields are masked, tokens in URLs stripped', () => {
    expect(
      logAttributes({
        username: 'mor@example',
        sessionId: 'abc',
        snippet: 'Set-Cookie: x',
        url: 'https://www.aula.dk/api/?access_token=SECRET',
        expires_in: 3600,
        nested: { a: 1 },
      }),
    ).toEqual({
      username: '[masked]',
      sessionId: '[masked]',
      snippet: '[masked]',
      url: expect.not.stringContaining('SECRET'),
      expires_in: 3600,
      nested: '{"a":1}',
    });
  });

  test('info and up become log records; debug only with debug logs', () => {
    logRecords.reset();
    const logger = withTelemetryLogs(silentLogger);
    logger.debug('quiet');
    logger.info('sync.job_done', { job: 'messages', username: 'x' });
    const [record] = logRecords.getFinishedLogRecords();
    expect(logRecords.getFinishedLogRecords()).toHaveLength(1);
    expect(record?.body).toBe('sync.job_done');
    expect(record?.severityText).toBe('INFO');
    expect(record?.attributes).toEqual({ job: 'messages', username: '[masked]' });
  });
});
