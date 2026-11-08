/**
 * Background token keep-alive. Renews the access token shortly before it
 * expires, even when no tool is being called, so the refresh_token chain stays
 * warm across idle periods instead of going stale until the next request.
 *
 * This extends how long one MitID login lasts; it cannot make it permanent.
 * Aula's OAuth server still decides when the refresh_token chain ends, and
 * then `aula login` is needed again.
 */

import {
  AulaHttpClient,
  isTokenExpired,
  type Logger,
  silentLogger,
  type TokenStore,
  withFreshTokens,
} from '@aula-mcp/aula-auth';

/** How often to check the token. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/** Renew when the access token has less than this left (tokens last ~60 min). */
const DEFAULT_RENEW_WITHIN_SECONDS = 15 * 60;

export interface TokenKeepAliveOptions {
  store: TokenStore;
  logger?: Logger;
  http?: AulaHttpClient;
  intervalMs?: number;
  renewWithinSeconds?: number;
}

export interface TokenKeepAlive {
  /** Run one check now. Resolves to true when a renewal happened. */
  tick(): Promise<boolean>;
  stop(): void;
}

export function startTokenKeepAlive(options: TokenKeepAliveOptions): TokenKeepAlive {
  const logger = options.logger ?? silentLogger;
  const http = options.http ?? new AulaHttpClient({ logger });
  const renewWithin = options.renewWithinSeconds ?? DEFAULT_RENEW_WITHIN_SECONDS;
  let running = false;

  const tick = async (): Promise<boolean> => {
    // Skip if the previous check is still in flight (slow network).
    if (running) return false;
    running = true;
    try {
      const record = await options.store.load();
      // No login yet, or still fresh enough: nothing to do.
      if (!record || !isTokenExpired(record.tokens, renewWithin)) return false;
      await withFreshTokens({
        store: options.store,
        http,
        logger,
        refreshBufferSeconds: renewWithin,
      });
      logger.info('token-keepalive.renewed');
      return true;
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

  const timer = setInterval(() => void tick(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Don't keep the process alive just for this timer.
  timer.unref();
  void tick();

  return { tick, stop: () => clearInterval(timer) };
}
