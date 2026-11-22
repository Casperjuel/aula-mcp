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
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Renew when the access token has less than this left (tokens last ~60 min). */
export const DEFAULT_RENEW_WITHIN_SECONDS = 15 * 60;

/** Starts a repeating timer and returns a function that stops it. */
export type Schedule = (fn: () => void, intervalMs: number) => () => void;

const realSchedule: Schedule = (fn, intervalMs) => {
  const timer = setInterval(fn, intervalMs);
  // Don't keep the process alive just for this timer.
  timer.unref();
  return () => clearInterval(timer);
};

type RenewableContext = Pick<AulaContext, 'refreshIfExpiringWithin'>;

export type TokenKeepAliveOptions = (
  | { context: RenewableContext }
  /** Multi-parent mode: every parent's context, looked up again on each check
   *  so parents who log in later are kept alive too. */
  | { contexts: () => RenewableContext[] | Promise<RenewableContext[]> }
) & {
  logger?: Logger;
  intervalMs?: number;
  renewWithinSeconds?: number;
  /** Timer to use; tests inject one so the suite never starts a real interval. */
  schedule?: Schedule;
  /** Run one check right away. Default true. */
  checkOnStart?: boolean;
};

export interface TokenKeepAlive {
  /** Run one check now. Resolves to true when any renewal happened. */
  tick(): Promise<boolean>;
  stop(): void;
}

export function startTokenKeepAlive(options: TokenKeepAliveOptions): TokenKeepAlive {
  const logger = options.logger ?? silentLogger;
  const renewWithin = options.renewWithinSeconds ?? DEFAULT_RENEW_WITHIN_SECONDS;
  const contexts = 'contexts' in options ? options.contexts : () => [options.context];
  let running = false;

  const failed = (err: unknown) => {
    // Never crash the server over a failed renewal; the next tick retries
    // and getClient() still refreshes on demand.
    logger.warn('token-keepalive.failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  };

  const tick = async (): Promise<boolean> => {
    // Skip if the previous check is still in flight (slow network).
    if (running) return false;
    running = true;
    try {
      let renewed = false;
      // One at a time: a parent whose renewal fails doesn't hold up the rest.
      // A single context is checked without a detour through a promise.
      const listed = contexts();
      for (const context of Array.isArray(listed) ? listed : await listed) {
        try {
          if (await context.refreshIfExpiringWithin(renewWithin)) {
            logger.info('token-keepalive.renewed');
            renewed = true;
          }
        } catch (err) {
          failed(err);
        }
      }
      return renewed;
    } catch (err) {
      failed(err);
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
