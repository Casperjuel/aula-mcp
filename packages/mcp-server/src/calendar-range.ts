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
    timeZone: 'Europe/Copenhagen',
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
    timeZone: 'Europe/Copenhagen',
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
    timeZone: 'Europe/Copenhagen',
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
    timeZone: 'Europe/Copenhagen',
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

/**
 * Aula returns every timestamp as UTC (`…+00:00`) even though the school day
 * is planned in Europe/Copenhagen. Re-express an ISO instant as Copenhagen
 * wall-clock with its real offset (+02:00 in summer, +01:00 in winter):
 * "2026-09-15T06:20:00+00:00" → "2026-09-15T08:20:00+02:00".
 * Returns undefined when the input is not a parseable ISO timestamp.
 */
export function copenhagenIso(iso: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
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
  const hour = get('hour') === '24' ? '00' : get('hour');
  const offsetMin = copenhagenOffsetMinutes(d);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${sign}${oh}:${om}`;
}

/** Keys whose ISO string values get a `<key>Local` sibling. */
const LOCAL_TIME_KEY =
  /(dateTime|timestamp|publishAt|editedAt|expireAt|importantFrom|importantTo|responseDeadline|lastActivity|^date)$/i;

/**
 * Walk a JSON payload and, next to every timestamp-looking key that holds an
 * ISO string, add `<key>Local` in Copenhagen wall-clock form. Arrays and
 * nested objects are handled. The original UTC fields are kept untouched so
 * nothing downstream breaks; the agent is told (in discover `usage`) to
 * report the `*Local` value.
 */
export function addLocalTimes<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => addLocalTimes(v)) as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = addLocalTimes(v);
    if (typeof v === 'string' && LOCAL_TIME_KEY.test(k) && !k.endsWith('Local')) {
      const local = copenhagenIso(v);
      if (local) out[`${k}Local`] = local;
    }
  }
  return out as T;
}
