import { describe, expect, test } from 'bun:test';
import { type Schedule, startTokenKeepAlive } from './token-keepalive.ts';

/** Captures the scheduled callback instead of starting a real interval. */
function fakeSchedule(): Schedule & { fire: () => void; stopped: boolean; intervalMs?: number } {
  let fn: (() => void) | undefined;
  const schedule = ((cb: () => void, intervalMs: number) => {
    fn = cb;
    schedule.intervalMs = intervalMs;
    return () => {
      schedule.stopped = true;
    };
  }) as Schedule & { fire: () => void; stopped: boolean; intervalMs?: number };
  schedule.stopped = false;
  schedule.fire = () => fn?.();
  return schedule;
}

function contextReturning(result: boolean | Error) {
  const calls: number[] = [];
  return {
    calls,
    async refreshIfExpiringWithin(seconds: number) {
      calls.push(seconds);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('startTokenKeepAlive', () => {
  test('asks the shared context to renew within the window', async () => {
    const context = contextReturning(true);
    const ka = startTokenKeepAlive({
      context,
      schedule: fakeSchedule(),
      checkOnStart: false,
      renewWithinSeconds: 600,
    });
    expect(await ka.tick()).toBe(true);
    expect(context.calls).toEqual([600]);
  });

  test('checks once on start and on every scheduled tick', async () => {
    const context = contextReturning(false);
    const schedule = fakeSchedule();
    startTokenKeepAlive({ context, schedule, intervalMs: 1234 });
    expect(schedule.intervalMs).toBe(1234);
    expect(context.calls).toHaveLength(1);
    // Let the start-up check finish so the next tick isn't skipped as overlapping.
    await new Promise((r) => setTimeout(r, 0));
    schedule.fire();
    expect(context.calls).toHaveLength(2);
  });

  test('swallows a failed renewal instead of throwing', async () => {
    const ka = startTokenKeepAlive({
      context: contextReturning(new Error('refresh failed')),
      schedule: fakeSchedule(),
      checkOnStart: false,
    });
    expect(await ka.tick()).toBe(false);
  });

  test('stop() stops the timer', () => {
    const schedule = fakeSchedule();
    const ka = startTokenKeepAlive({
      context: contextReturning(false),
      schedule,
      checkOnStart: false,
    });
    ka.stop();
    expect(schedule.stopped).toBe(true);
  });

  test('checks every context, and one failing renewal does not stop the rest', async () => {
    const failing = contextReturning(new Error('refresh failed'));
    const renewing = contextReturning(true);
    let listed = 0;
    const ka = startTokenKeepAlive({
      contexts: async () => {
        listed++;
        return [failing, renewing];
      },
      schedule: fakeSchedule(),
      checkOnStart: false,
    });
    expect(await ka.tick()).toBe(true);
    expect(await ka.tick()).toBe(true);
    expect(failing.calls).toHaveLength(2);
    expect(renewing.calls).toHaveLength(2);
    // Looked up again on every check, so parents who log in later are kept alive.
    expect(listed).toBe(2);
  });

  test('a failing lookup is swallowed too', async () => {
    const ka = startTokenKeepAlive({
      contexts: async () => {
        throw new Error('EACCES');
      },
      schedule: fakeSchedule(),
      checkOnStart: false,
    });
    expect(await ka.tick()).toBe(false);
  });
});
