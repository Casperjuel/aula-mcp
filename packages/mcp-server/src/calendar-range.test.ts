import { describe, expect, test } from 'bun:test';
import {
  addDays,
  addLocalTimes,
  aulaTs,
  copenhagenIso,
  resolveCalendarRange,
  startOfDayCopenhagen,
  startOfWeekMondayCopenhagen,
} from './calendar-range.ts';

// Pin a Tuesday in spring to exercise CET (+0200) and the in-week math.
const TUE_CEST_NOON = new Date('2026-05-05T10:00:00Z'); // 12:00 in Copenhagen (CEST = +0200)
// Pin a Saturday in winter to exercise CET (+0100) and the weekend wrap.
const SAT_CET_AFTERNOON = new Date('2026-01-10T14:00:00Z'); // 15:00 Copenhagen (CET = +0100)

describe('aulaTs', () => {
  test('formats CEST (+0200) instants correctly', () => {
    expect(aulaTs(TUE_CEST_NOON)).toBe('2026-05-05 12:00:00.0000+0200');
  });

  test('formats CET (+0100) instants correctly', () => {
    expect(aulaTs(SAT_CET_AFTERNOON)).toBe('2026-01-10 15:00:00.0000+0100');
  });

  test('handles the DST spring-forward day (last Sunday in March)', () => {
    // 02:30 UTC on the Sunday after spring-forward → 04:30 CEST.
    const t = new Date('2026-03-29T02:30:00Z');
    expect(aulaTs(t)).toBe('2026-03-29 04:30:00.0000+0200');
  });

  test('handles the DST fall-back day (last Sunday in October)', () => {
    // 02:30 UTC on the Sunday after fall-back → 03:30 CET.
    const t = new Date('2026-10-25T02:30:00Z');
    expect(aulaTs(t)).toBe('2026-10-25 03:30:00.0000+0100');
  });
});

describe('startOfDayCopenhagen', () => {
  test('returns the instant that *represents* midnight in Copenhagen', () => {
    // 23:30 UTC on May 5 = 01:30 Copenhagen on May 6 → CPH midnight May 6
    // = 22:00Z May 5 (since CEST is +0200).
    const t = new Date('2026-05-05T23:30:00Z');
    const out = startOfDayCopenhagen(t);
    expect(aulaTs(out)).toBe('2026-05-06 00:00:00.0000+0200');
  });

  test('handles winter (CET, +0100)', () => {
    // 23:30 UTC on Jan 9 = 00:30 Jan 10 CPH → midnight Jan 10 CPH = 23:00Z Jan 9
    const t = new Date('2026-01-09T23:30:00Z');
    const out = startOfDayCopenhagen(t);
    expect(aulaTs(out)).toBe('2026-01-10 00:00:00.0000+0100');
  });
});

describe('startOfWeekMondayCopenhagen', () => {
  // Note: assertions go through aulaTs because the function returns a UTC
  // instant that *represents* Copenhagen midnight — its toISOString() is
  // typically the previous day in UTC during CEST.

  test('Tuesday → previous Monday', () => {
    // Tue May 5 2026 → Mon May 4 2026.
    const today = startOfDayCopenhagen(TUE_CEST_NOON);
    const monday = startOfWeekMondayCopenhagen(today);
    expect(aulaTs(monday)).toBe('2026-05-04 00:00:00.0000+0200');
  });

  test('Sunday → Monday of the previous week', () => {
    // Sun Jan 11 2026 in Copenhagen — for that we want the instant of
    // Copenhagen midnight Sunday, then walk back to Monday Jan 5.
    const sunday = startOfDayCopenhagen(new Date('2026-01-11T12:00:00Z'));
    const monday = startOfWeekMondayCopenhagen(sunday);
    expect(aulaTs(monday)).toBe('2026-01-05 00:00:00.0000+0100');
  });

  test('Monday → itself', () => {
    const monday = startOfDayCopenhagen(new Date('2026-05-04T12:00:00Z'));
    expect(aulaTs(startOfWeekMondayCopenhagen(monday))).toBe('2026-05-04 00:00:00.0000+0200');
  });
});

describe('addDays', () => {
  test('moves the date forward across month boundaries', () => {
    const d = new Date('2026-05-30T12:00:00Z');
    expect(addDays(d, 5).toISOString().slice(0, 10)).toBe('2026-06-04');
  });
  test('handles negative offsets', () => {
    const d = new Date('2026-05-05T00:00:00Z');
    expect(addDays(d, -7).toISOString().slice(0, 10)).toBe('2026-04-28');
  });
});

describe('resolveCalendarRange', () => {
  test('today: 24h window starting at Copenhagen midnight', () => {
    const r = resolveCalendarRange('today', TUE_CEST_NOON);
    expect(r.start).toBe('2026-05-05 00:00:00.0000+0200');
    expect(r.end).toBe('2026-05-06 00:00:00.0000+0200');
  });

  test('tomorrow: shifted by 1 day', () => {
    const r = resolveCalendarRange('tomorrow', TUE_CEST_NOON);
    expect(r.start).toBe('2026-05-06 00:00:00.0000+0200');
    expect(r.end).toBe('2026-05-07 00:00:00.0000+0200');
  });

  test('this_week: Monday to following Monday', () => {
    const r = resolveCalendarRange('this_week', TUE_CEST_NOON);
    expect(r.start).toBe('2026-05-04 00:00:00.0000+0200');
    expect(r.end).toBe('2026-05-11 00:00:00.0000+0200');
  });

  test('next_week: Monday-after-this Monday for 7 days', () => {
    const r = resolveCalendarRange('next_week', TUE_CEST_NOON);
    expect(r.start).toBe('2026-05-11 00:00:00.0000+0200');
    expect(r.end).toBe('2026-05-18 00:00:00.0000+0200');
  });

  test('this_week from a Sunday rolls back to Monday of prior week', () => {
    const sunday = new Date('2026-05-10T15:00:00Z'); // Sun May 10 2026 17:00 CPH
    const r = resolveCalendarRange('this_week', sunday);
    expect(r.start).toBe('2026-05-04 00:00:00.0000+0200');
    expect(r.end).toBe('2026-05-11 00:00:00.0000+0200');
  });
});

describe('copenhagenIso', () => {
  test('re-expresses a UTC instant as Copenhagen wall-clock in summer (+02:00)', () => {
    expect(copenhagenIso('2026-09-15T06:20:00+00:00')).toBe('2026-09-15T08:20:00+02:00');
  });

  test('uses +01:00 in winter', () => {
    expect(copenhagenIso('2026-01-10T14:00:00+00:00')).toBe('2026-01-10T15:00:00+01:00');
  });

  test('accepts Z and other offsets', () => {
    expect(copenhagenIso('2026-09-15T06:20:00Z')).toBe('2026-09-15T08:20:00+02:00');
    expect(copenhagenIso('2026-09-15T08:20:00+02:00')).toBe('2026-09-15T08:20:00+02:00');
  });

  test('rejects non-timestamps', () => {
    expect(copenhagenIso('2026-09-15')).toBeUndefined();
    expect(copenhagenIso('Ugeplan')).toBeUndefined();
    expect(copenhagenIso('2026-99-99T99:99:00Z')).toBeUndefined();
  });
});

describe('addLocalTimes', () => {
  test('adds *Local siblings next to timestamp keys, recursively, keeping originals', () => {
    // Loose type on purpose: the added `*Local` keys are not in the input type.
    type Loose = {
      events: Record<string, string>[];
      latestMessage: Record<string, string>;
    } & Record<string, unknown>;
    const out = addLocalTimes<Loose>({
      events: [{ startDateTime: '2026-09-15T06:20:00+00:00', title: 'Morgentilsyn' }],
      latestMessage: { sendDateTime: '2026-09-11T14:34:14+00:00' },
      date: '2026-09-06T08:00:00+00:00',
      count: 3,
    });
    expect(out.events[0]).toEqual({
      startDateTime: '2026-09-15T06:20:00+00:00',
      startDateTimeLocal: '2026-09-15T08:20:00+02:00',
      title: 'Morgentilsyn',
    });
    expect(out.latestMessage.sendDateTimeLocal).toBe('2026-09-11T16:34:14+02:00');
    expect(out.dateLocal).toBe('2026-09-06T10:00:00+02:00');
    expect(out.count).toBe(3);
  });

  test('leaves non-timestamp strings and non-matching keys alone', () => {
    const out = addLocalTimes({ title: '2026-09-15T06:20:00Z', startDateTime: 'i dag' });
    expect(out).toEqual({ title: '2026-09-15T06:20:00Z', startDateTime: 'i dag' });
  });

  test('passes primitives and null through', () => {
    expect(addLocalTimes(null)).toBeNull();
    expect(addLocalTimes('x')).toBe('x');
    expect(addLocalTimes(undefined)).toBeUndefined();
  });
});
