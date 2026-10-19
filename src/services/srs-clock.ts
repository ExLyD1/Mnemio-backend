import { DAY_SECS, SRS_DEFAULTS } from './srs-engine.js';

const parts = (instant: Date, tz: string) => {
    const values = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
        Number(values.find((p) => p.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second'),
    };
};

/** Calendar arithmetic in the study timezone, with the day beginning at local 04:00.
 * Subtract four wall-clock hours, not elapsed hours across a DST transition.
 */
export const dayNumber = (instant: Date, tz = 'UTC'): number => {
    const p = parts(instant, tz);
    return Math.floor(
        Date.UTC(p.year, p.month - 1, p.day, p.hour - SRS_DEFAULTS.rolloverHour) /
            (DAY_SECS * 1000),
    );
};

export const rollover = (day: number, tz = 'UTC'): Date => {
    const target = day * DAY_SECS * 1000 + SRS_DEFAULTS.rolloverHour * 3600_000;
    let candidate = target;
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) {
        const p = parts(new Date(candidate), tz);
        const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        const delta = target - actual;
        if (delta === 0) {
            return new Date(candidate);
        }
        seen.add(candidate);
        const next = candidate + delta;
        // A gap at 04:00: choose the first corresponding instant after the gap.
        if (seen.has(next)) {
            return new Date(Math.max(candidate, next));
        }
        candidate = next;
    }
    throw new RangeError('Cannot resolve timezone rollover');
};

export const dueForDays = (now: Date, days: number, tz = 'UTC'): Date =>
    rollover(dayNumber(now, tz) + days, tz);
export const dueForStep = (now: Date, secs: number, tz = 'UTC'): Date =>
    secs >= DAY_SECS
        ? dueForDays(now, Math.round(secs / DAY_SECS), tz)
        : new Date(now.getTime() + secs * 1000);
