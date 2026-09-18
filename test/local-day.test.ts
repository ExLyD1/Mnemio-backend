import { describe, expect, it } from 'vitest';
import {
    computeStreak,
    dayKeyToDate,
    localDayDate,
    normalizeTz,
} from '../src/services/tz.js';
import { buildDailySeries, overviewWindows } from '../src/services/stats.service.js';

// Owner decision (Sep 2026): streaks / practice days / daily series follow the
// user's local calendar day, not UTC.
describe('local-day bucketing for DailyActivity', () => {
    it('a review at 01:30 in Kyiv lands on the Kyiv day, not the previous UTC day', () => {
        const at = new Date('2026-09-17T22:30:00Z'); // 01:30 on the 18th in Kyiv (UTC+3)
        expect(localDayDate(at, 'Europe/Kyiv').toISOString()).toBe('2026-09-18T00:00:00.000Z');
        expect(localDayDate(at, 'UTC').toISOString()).toBe('2026-09-17T00:00:00.000Z');
    });

    it('invalid or missing zones fall back to UTC', () => {
        expect(normalizeTz(undefined)).toBe('UTC');
        expect(normalizeTz('')).toBe('UTC');
        expect(normalizeTz('Mars/Olympus')).toBe('UTC');
        expect(normalizeTz(' Europe/Kyiv ')).toBe('Europe/Kyiv');
    });

    it('streak counts consecutive local days ending today (or yesterday)', () => {
        const rows = ['2026-09-15', '2026-09-16', '2026-09-17'].map((k) => ({
            date: dayKeyToDate(k),
            reviews: 5,
        }));
        expect(computeStreak(rows, '2026-09-17')).toBe(3);
        expect(computeStreak(rows, '2026-09-18')).toBe(3); // today not studied yet
        expect(computeStreak(rows, '2026-09-19')).toBe(0);
        expect(computeStreak([], '2026-09-19')).toBe(0);
    });

    it('streak ignores zero-review rows', () => {
        const rows = [
            { date: dayKeyToDate('2026-09-16'), reviews: 3 },
            { date: dayKeyToDate('2026-09-17'), reviews: 0 },
        ];
        expect(computeStreak(rows, '2026-09-17')).toBe(1);
    });

    it('daily series fills the local-day scaffold with zeros', () => {
        const pts = buildDailySeries(
            [{ date: dayKeyToDate('2026-09-17'), reviews: 7 }],
            ['2026-09-16', '2026-09-17', '2026-09-18'],
        );
        expect(pts).toEqual([
            { label: '2026-09-16', value: 0 },
            { label: '2026-09-17', value: 7 },
            { label: '2026-09-18', value: 0 },
        ]);
    });

    it('overview windows are consecutive local days ending on local today', () => {
        const now = new Date('2026-09-17T22:30:00Z'); // already the 18th in Kyiv
        const w = overviewWindows(now, 'Europe/Kyiv', 7);
        expect(w.current[w.current.length - 1]).toBe('2026-09-18');
        expect(w.current[0]).toBe('2026-09-12');
        expect(w.previous).toHaveLength(7);
        expect(w.previous[6]).toBe('2026-09-11');
    });
});
