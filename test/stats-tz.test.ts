import { describe, it, expect } from 'vitest';
import { tzDayKey, tzDayKeysEndingOn, tzWindowLowerBoundUtc } from '../src/services/tz.js';
import {
    bucketDurationByTzDay,
    aggregateDecksStudied,
} from '../src/services/stats.service.js';
import { resolveDurationMs } from '../src/services/sessions.service.js';

// A session finished at 02:30 UTC — the same instant lands on different local
// calendar days depending on the viewer's zone. This is the core boundary case
// the study-time and decks-studied aggregations must get right.
const LATE_NIGHT_UTC = new Date('2026-07-11T02:30:00.000Z');

describe('tzDayKey — local calendar day of an instant', () => {
    it('buckets by UTC day for UTC', () => {
        expect(tzDayKey(LATE_NIGHT_UTC, 'UTC')).toBe('2026-07-11');
    });

    it('rolls back a day for a negative-offset zone (New York, UTC-4 in July)', () => {
        // 02:30 UTC → 22:30 the previous evening in New York.
        expect(tzDayKey(LATE_NIGHT_UTC, 'America/New_York')).toBe('2026-07-10');
    });

    it('keeps the same day for a positive-offset zone (Tokyo, UTC+9)', () => {
        // 02:30 UTC → 11:30 same morning in Tokyo.
        expect(tzDayKey(LATE_NIGHT_UTC, 'Asia/Tokyo')).toBe('2026-07-11');
    });

    it('Kyiv (UTC+3 in July) keeps the same day', () => {
        expect(tzDayKey(LATE_NIGHT_UTC, 'Europe/Kyiv')).toBe('2026-07-11');
    });
});

describe('tzDayKeysEndingOn — series x-axis scaffold', () => {
    it('returns `days` consecutive labels, oldest first, ending on the local day', () => {
        const keys = tzDayKeysEndingOn(LATE_NIGHT_UTC, 'UTC', 3);
        expect(keys).toEqual(['2026-07-09', '2026-07-10', '2026-07-11']);
    });

    it('anchors on the local day, not the UTC day', () => {
        // New York local day is the 10th, so the window ends there.
        const keys = tzDayKeysEndingOn(LATE_NIGHT_UTC, 'America/New_York', 2);
        expect(keys).toEqual(['2026-07-09', '2026-07-10']);
    });

    it('crosses a month boundary without gaps or repeats', () => {
        const keys = tzDayKeysEndingOn(new Date('2026-03-02T12:00:00.000Z'), 'UTC', 4);
        expect(keys).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    });

    it('crosses a leap-day boundary', () => {
        const keys = tzDayKeysEndingOn(new Date('2028-03-01T12:00:00.000Z'), 'UTC', 3);
        expect(keys).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    });
});

describe('tzWindowLowerBoundUtc — loose DB scan bound', () => {
    it('is at or before the start of the window with a day of slack', () => {
        const lb = tzWindowLowerBoundUtc(LATE_NIGHT_UTC, 'UTC', 7);
        // Window starts 2026-07-05 (local); bound is one day earlier at UTC midnight.
        expect(lb.toISOString()).toBe('2026-07-04T00:00:00.000Z');
        // Never excludes an in-window session even for a far-east zone.
        expect(lb.getTime()).toBeLessThan(new Date('2026-07-05T00:00:00.000Z').getTime());
    });
});

describe('bucketDurationByTzDay (item 2) — study-time series', () => {
    const labels = tzDayKeysEndingOn(LATE_NIGHT_UTC, 'UTC', 3); // 07-09..07-11

    it('sums durations into the correct UTC-day buckets, zero-filling gaps', () => {
        const rows = [
            { durationMs: 60_000, completedAt: new Date('2026-07-11T02:30:00Z') },
            { durationMs: 90_000, completedAt: new Date('2026-07-11T20:00:00Z') },
            { durationMs: 30_000, completedAt: new Date('2026-07-09T08:00:00Z') },
        ];
        expect(bucketDurationByTzDay(rows, 'UTC', labels)).toEqual([
            { label: '2026-07-09', value: 30_000 },
            { label: '2026-07-10', value: 0 },
            { label: '2026-07-11', value: 150_000 },
        ]);
    });

    it('re-buckets the same rows differently under a negative-offset zone', () => {
        const nyLabels = tzDayKeysEndingOn(LATE_NIGHT_UTC, 'America/New_York', 3); // 07-08..07-10
        const rows = [{ durationMs: 60_000, completedAt: LATE_NIGHT_UTC }];
        // 02:30Z is the evening of the 10th in NY, so it lands on 07-10 there.
        expect(bucketDurationByTzDay(rows, 'America/New_York', nyLabels)).toEqual([
            { label: '2026-07-08', value: 0 },
            { label: '2026-07-09', value: 0 },
            { label: '2026-07-10', value: 60_000 },
        ]);
    });

    it('drops sessions outside the label window and clamps negatives', () => {
        const rows = [
            { durationMs: 100, completedAt: new Date('2026-07-01T00:00:00Z') }, // out of window
            { durationMs: -5, completedAt: new Date('2026-07-10T00:00:00Z') }, // clamped
        ];
        expect(bucketDurationByTzDay(rows, 'UTC', labels)).toEqual([
            { label: '2026-07-09', value: 0 },
            { label: '2026-07-10', value: 0 },
            { label: '2026-07-11', value: 0 },
        ]);
    });
});

describe('aggregateDecksStudied (item 4)', () => {
    const rows = [
        { deckId: 'a', title: 'Alpha', cardsStudied: 10, completedAt: new Date('2026-07-11T02:30:00Z') },
        { deckId: 'a', title: 'Alpha', cardsStudied: 5, completedAt: new Date('2026-07-09T09:00:00Z') },
        { deckId: 'b', title: 'Beta', cardsStudied: 8, completedAt: new Date('2026-07-10T12:00:00Z') },
    ];

    it('groups by deck: one row per session, summed cards, latest timestamp', () => {
        const items = aggregateDecksStudied(rows, 'UTC', new Set(tzDayKeysEndingOn(LATE_NIGHT_UTC, 'UTC', 7)));
        // Sorted by lastStudiedAt DESC → Alpha (07-11) before Beta (07-10).
        expect(items).toEqual([
            {
                deckId: 'a',
                title: 'Alpha',
                sessionCount: 2,
                cardsReviewed: 15,
                lastStudiedAt: '2026-07-11T02:30:00.000Z',
            },
            {
                deckId: 'b',
                title: 'Beta',
                sessionCount: 1,
                cardsReviewed: 8,
                lastStudiedAt: '2026-07-10T12:00:00.000Z',
            },
        ]);
    });

    it('respects the local-day window (New York excludes the 02:30Z session from a 07-11-only window)', () => {
        // Window = just the NY day 2026-07-11. The 02:30Z session is 07-10 in NY,
        // so only decks studied on 07-11 NY remain — none here.
        const nyJul11Only = new Set(['2026-07-11']);
        const items = aggregateDecksStudied(rows, 'America/New_York', nyJul11Only);
        expect(items).toEqual([]);
    });

    it("'all' range (labelSet null) counts every completed session", () => {
        const withOld = [
            ...rows,
            { deckId: 'c', title: 'Gamma', cardsStudied: 3, completedAt: new Date('2020-01-01T00:00:00Z') },
        ];
        const items = aggregateDecksStudied(withOld, 'UTC', null);
        expect(items.map((i) => i.deckId)).toEqual(['a', 'b', 'c']); // Gamma oldest, sorts last
        expect(items.find((i) => i.deckId === 'c')?.sessionCount).toBe(1);
    });
});

describe('resolveDurationMs (item 2 — persist on completion)', () => {
    const started = new Date('2026-07-11T10:00:00Z');

    it('prefers the client-reported active duration when present', () => {
        const now = new Date('2026-07-11T10:20:00Z');
        expect(resolveDurationMs(123_456, started, now)).toBe(123_456);
    });

    it('falls back to wall-clock elapsed when nothing was reported', () => {
        const now = new Date('2026-07-11T10:20:00Z'); // 20 min later
        expect(resolveDurationMs(0, started, now)).toBe(20 * 60_000);
    });

    it('never returns negative if clocks disagree', () => {
        const now = new Date('2026-07-11T09:59:00Z'); // before start
        expect(resolveDurationMs(0, started, now)).toBe(0);
    });
});
