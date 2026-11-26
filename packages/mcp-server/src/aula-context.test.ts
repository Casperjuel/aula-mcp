/**
 * Unit tests for AulaContext's own caching, as opposed to tools.test.ts and
 * friends, which fake the whole AulaContext.
 *
 * Every context uses `store: new MemoryTokenStore()`: it has no `filePath`,
 * so watchTokenFile() never touches the real ~/.config/aula-mcp/tokens.json.
 * getClient() is swapped for a fake that returns a new client on "refresh",
 * exactly as the real getClient() builds a new AulaClient once the access
 * token expires.
 */

import { describe, expect, test } from 'bun:test';
import { MemoryTokenStore, silentLogger } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import { AulaContext } from './aula-context.ts';

function contextWithSwappableClient() {
  const context = new AulaContext({ store: new MemoryTokenStore(), logger: silentLogger });
  const widgetTokenCalls: string[] = [];
  const primed: string[] = [];
  const makeClient = (tag: string) =>
    ({
      async getWidgetToken(widgetId: string) {
        widgetTokenCalls.push(`${tag}:${widgetId}`);
        return `widget-token-from-${tag}`;
      },
      async getProfileContext() {
        primed.push(tag);
        return { userId: 4242 };
      },
    }) as unknown as AulaClient;
  let current = makeClient('first');
  context.getClient = async () => current;
  return {
    context,
    widgetTokenCalls,
    primed,
    refresh: (tag: string) => {
      current = makeClient(tag);
    },
  };
}

describe('AulaContext.getWidgetManager — follows the current client (#164)', () => {
  test('the same client keeps the same manager', async () => {
    const { context } = contextWithSwappableClient();
    expect(await context.getWidgetManager()).toBe(await context.getWidgetManager());
  });

  test('after a token refresh, widget tokens come from the new client', async () => {
    // #164: the manager outlived the client it was built with, so every
    // aulaToken.getAulaToken after the first refresh went out on the expired
    // access token and got 403 until restart.
    const { context, widgetTokenCalls, refresh } = contextWithSwappableClient();
    expect(await (await context.getWidgetManager()).get('0029')).toBe('widget-token-from-first');

    refresh('after-refresh');
    expect(await (await context.getWidgetManager()).get('0029')).toBe(
      'widget-token-from-after-refresh',
    );
    expect(widgetTokenCalls).toEqual(['first:0029', 'after-refresh:0029']);
  });
});

describe('AulaContext.getGuardianUserId — primes once per client', () => {
  test('the same client is primed once', async () => {
    const { context, primed } = contextWithSwappableClient();
    expect(await context.getGuardianUserId()).toBe('4242');
    expect(await context.getGuardianUserId()).toBe('4242');
    expect(primed).toEqual(['first']);
  });

  test('a new client after a token refresh is primed again', async () => {
    // getProfileContext also activates the guardian profile for the access
    // token it is called with; a cached id must not skip that for a new token.
    const { context, primed, refresh } = contextWithSwappableClient();
    await context.getGuardianUserId();
    refresh('after-refresh');
    await context.getGuardianUserId();
    expect(primed).toEqual(['first', 'after-refresh']);
  });
});
