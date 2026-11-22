/**
 * Spans and a duration histogram for calls to Aula's API, through the global
 * OpenTelemetry API: a no-op unless the server has started telemetry. Only
 * the Aula method name, the HTTP method and the status code are recorded;
 * never the URL (it carries the access token), the query or the body.
 */

import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AulaApiError } from './errors.ts';

const SCOPE = '@aula-mcp/aula-client';
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

let histogram: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | undefined;
let madeFor: unknown;
// The metrics API has no proxy provider: make it again if the provider changed.
const duration = () => {
  const provider = metrics.getMeterProvider();
  if (!histogram || madeFor !== provider) {
    histogram = metrics.getMeter(SCOPE).createHistogram('aula.client.request.duration', {
      unit: 's',
      description: "Calls to Aula's API, by Aula method and status.",
      advice: { explicitBucketBoundaries: BUCKETS },
    });
    madeFor = provider;
  }
  return histogram;
};

/** Aula method names are short dotted identifiers; anything else is folded. */
const methodLabel = (method: string) => (/^[A-Za-z]+\.[A-Za-z]+$/.test(method) ? method : 'other');

export async function tracedAulaCall<T>(
  aulaMethod: string,
  httpMethod: 'GET' | 'POST',
  run: () => Promise<T>,
): Promise<T> {
  const method = methodLabel(aulaMethod);
  const started = performance.now();
  let status = 0;
  return trace.getTracer(SCOPE).startActiveSpan(
    `aula ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'aula.method': method, 'http.request.method': httpMethod },
    },
    async (span) => {
      try {
        const result = await run();
        status = 200;
        return result;
      } catch (err) {
        status = err instanceof AulaApiError ? err.status : 0;
        const type = err instanceof Error ? err.name : 'Error';
        span.setStatus({ code: SpanStatusCode.ERROR, message: type });
        span.setAttribute('error.type', type);
        throw err;
      } finally {
        if (status) span.setAttribute('http.response.status_code', status);
        span.end();
        duration().record((performance.now() - started) / 1000, {
          'aula.method': method,
          'http.request.method': httpMethod,
          'http.response.status_code': status,
          outcome: status === 200 ? 'ok' : 'error',
        });
      }
    },
  );
}
