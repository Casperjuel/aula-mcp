/**
 * Date-range helpers for `aula.calendar.events`.
 *
 * Aula expects timestamps in `YYYY-MM-DD HH:MM:SS.0000+ZZZZ` format,
 * Europe/Copenhagen wall-clock time (which is +0100 in winter, +0200 in
 * summer). The school day boundary is local midnight.
 *
 * Extracted into its own module so the helpers are unit-testable without
 * having to drive the full tool registration path.
 *
 * The `Intl.DateTimeFormat` locale is `da-DK` for readability — we read
 * numeric `formatToParts` so the locale is otherwise a no-op.
 */

/** The time zone Aula runs in: every institution keeps Danish school time. */
export const AULA_TIME_ZONE = 'Europe/Copenhagen';

export type CalendarRange = 'today' | 'tomorrow' | 'this_week' | 'next_week';

export interface CalendarWindow {
  start: string;
  end: string;
}

/**
 * Resolve a friendly preset to Aula's expected timestamp window.
 * The optional `now` arg is for tests to pin the clock.
 */
export function resolveCalendarRange(range: CalendarRange, now: Date = new Date()): CalendarWindow {
  const today = startOfDayCopenhagen(now);
  switch (range) {
    case 'today':
      return { start: aulaTs(today), end: aulaTs(addDays(today, 1)) };
    case 'tomorrow': {
      const t = addDays(today, 1);
      return { start: aulaTs(t), end: aulaTs(addDays(t, 1)) };
    }
    case 'this_week': {
      const monday = startOfWeekMondayCopenhagen(today);
      return { start: aulaTs(monday), end: aulaTs(addDays(monday, 7)) };
    }
    case 'next_week': {
      const monday = addDays(startOfWeekMondayCopenhagen(today), 7);
      return { start: aulaTs(monday), end: aulaTs(addDays(monday, 7)) };
    }
  }
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/** Midnight of the given calendar day in Europe/Copenhagen, as a UTC instant. */
export function startOfDayCopenhagen(d: Date): Date {
  // Step 1: identify the calendar day in Copenhagen for `d`.
  const dayFmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: AULA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dayFmt.formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  // Step 2: walk back from UTC midnight to Copenhagen midnight by subtracting
  // the offset Copenhagen has at that point in time.
  const utcMidnight = new Date(`${y}-${m}-${day}T00:00:00Z`);
  const offsetMin = copenhagenOffsetMinutes(utcMidnight);
  return new Date(utcMidnight.getTime() - offsetMin * 60_000);
}

/** Minutes east-of-UTC that Europe/Copenhagen has at the given instant. */
export function copenhagenOffsetMinutes(d: Date): number {
  const fmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: AULA_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '00';
  // Intl can return hour "24" for midnight in some locales; normalise.
  const cphHour = hourStr === '24' ? 0 : Number(hourStr);
  const cphMin = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const cphMinOfDay = cphHour * 60 + cphMin;
  const utcMinOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  let diff = cphMinOfDay - utcMinOfDay;
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}

/** Monday 00:00 of the week containing `d` (Copenhagen). */
export function startOfWeekMondayCopenhagen(d: Date): Date {
  // We need the day-of-week _in Copenhagen_ — a UTC-midnight Date for a
  // Sunday in Copenhagen reads as Saturday in UTC, so getUTCDay() lies.
  const day = copenhagenDayOfWeek(d);
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(d, offset);
}

/** Day-of-week as Copenhagen sees it: 0 = Sun, 1 = Mon, …, 6 = Sat. */
export function copenhagenDayOfWeek(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: AULA_TIME_ZONE,
    weekday: 'short',
  });
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[fmt.format(d)] ?? 0;
}

/** Format `YYYY-MM-DD HH:MM:SS.0000+ZZZZ` in Europe/Copenhagen. */
export function aulaTs(d: Date): string {
  const fmt = new Intl.DateTimeFormat('da-DK', {
    timeZone: AULA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  // `da-DK` formats midnight as "24" rather than "00"; normalise so our
  // assembled string follows the conventional 00–23 range.
  const hourPart = get('hour') === '24' ? '00' : get('hour');
  const cphHour = Number(hourPart);
  const utcHour = d.getUTCHours();
  let offsetH = cphHour - utcHour;
  if (offsetH > 12) offsetH -= 24;
  if (offsetH < -12) offsetH += 24;
  const sign = offsetH >= 0 ? '+' : '-';
  const hh = String(Math.abs(offsetH)).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${hourPart}:${get('minute')}:${get('second')}.0000${sign}${hh}00`;
}
