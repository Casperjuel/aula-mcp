/**
 * Aula calls as spans and a duration histogram, against in-memory exporters:
 * only the Aula method, HTTP method and status are recorded, never the URL
 * with its access token.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
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
import { AulaApiError } from './errors.ts';
import { tracedAulaCall } from './telemetry.ts';

const spans = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});
afterAll(() => {
  trace.disable();
  metrics.disable();
  context.disable();
});

async function points() {
  await reader.forceFlush();
  return metricExporter
    .getMetrics()
    .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
    .filter((m) => m.descriptor.name === 'aula.client.request.duration')
    .flatMap((m) => m.dataPoints.map((p) => p.attributes));
}

describe('tracedAulaCall', () => {
  test('records the method and status, never the URL', async () => {
    expect(await tracedAulaCall('messaging.getThreads', 'GET', async () => 'ok')).toBe('ok');
    await expect(
      tracedAulaCall('messaging.updateSubscriptionStatus', 'POST', async () => {
        throw new AulaApiError(
          'API returned status 400',
          400,
          'https://www.aula.dk/api/v23/?method=x&access_token=SECRET',
        );
      }),
    ).rejects.toThrow('status 400');

    const [ok, failed] = spans.getFinishedSpans();
    expect(ok?.name).toBe('aula messaging.getThreads');
    expect(failed?.attributes).toEqual({
      'aula.method': 'messaging.updateSubscriptionStatus',
      'http.request.method': 'POST',
      'http.response.status_code': 400,
      'error.type': 'AulaApiError',
    });
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      'SECRET',
    );
    expect(await points()).toContainEqual({
      'aula.method': 'messaging.updateSubscriptionStatus',
      'http.request.method': 'POST',
      'http.response.status_code': 400,
      outcome: 'error',
    });
  });

  test('folds anything but a plain method name', async () => {
    spans.reset();
    await tracedAulaCall('weird method?x=1', 'GET', async () => null);
    expect(spans.getFinishedSpans()[0]?.attributes['aula.method']).toBe('other');
  });
});
