/**
 * Background token keep-alive. Renews the access token shortly before it
 * expires, even when no tool is being called, so the refresh_token chain stays
 * warm across idle periods instead of going stale until the next request.
 *
 * Renewal goes through the server's shared AulaContext, so the keep-alive and
 * tool calls share one refresh path and never spend the same refresh token.
 *
 * This extends how long one MitID login lasts; it cannot make it permanent.
 * Aula's OAuth server still decides when the refresh_token chain ends, and
 * then `aula login` is needed again.
 */

import { type Logger, silentLogger } from '@aula-mcp/aula-auth';
import type { AulaContext } from './aula-context.ts';

/** How often to check the token. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Renew when the access token has less than this left (tokens last ~60 min). */
const DEFAULT_RENEW_WITHIN_SECONDS = 15 * 60;

/** Starts a repeating timer and returns a function that stops it. */
export type Schedule = (fn: () => void, intervalMs: number) => () => void;

const realSchedule: Schedule = (fn, intervalMs) => {
  const timer = setInterval(fn, intervalMs);
  // Don't keep the process alive just for this timer.
  timer.unref();
  return () => clearInterval(timer);
};

export interface TokenKeepAliveOptions {
  context: Pick<AulaContext, 'refreshIfExpiringWithin'>;
  logger?: Logger;
  intervalMs?: number;
  renewWithinSeconds?: number;
  /** Timer to use; tests inject one so the suite never starts a real interval. */
  schedule?: Schedule;
  /** Run one check right away. Default true. */
  checkOnStart?: boolean;
}

export interface TokenKeepAlive {
  /** Run one check now. Resolves to true when a renewal happened. */
  tick(): Promise<boolean>;
  stop(): void;
}

export function startTokenKeepAlive(options: TokenKeepAliveOptions): TokenKeepAlive {
  const logger = options.logger ?? silentLogger;
  const renewWithin = options.renewWithinSeconds ?? DEFAULT_RENEW_WITHIN_SECONDS;
  let running = false;

  const tick = async (): Promise<boolean> => {
    // Skip if the previous check is still in flight (slow network).
    if (running) return false;
    running = true;
    try {
      const renewed = await options.context.refreshIfExpiringWithin(renewWithin);
      if (renewed) logger.info('token-keepalive.renewed');
      return renewed;
    } catch (err) {
      // Never crash the server over a failed renewal; the next tick retries
      // and getClient() still refreshes on demand.
      logger.warn('token-keepalive.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      running = false;
    }
  };

  const schedule = options.schedule ?? realSchedule;
  const stop = schedule(() => void tick(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (options.checkOnStart !== false) void tick();

  return { tick, stop };
}
