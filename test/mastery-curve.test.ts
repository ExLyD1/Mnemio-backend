import { describe, it, expect } from 'vitest';
import { resolveMasteredAt } from '../src/services/srs.service.js';
import {
    buildCumulativeMasteredSeries,
    CARD_SERIES_METRIC,
} from '../src/services/stats.service.js';

const D = (iso: string) => new Date(iso);
const NOW = D('2026-07-10T12:00:00.000Z');

describe('resolveMasteredAt — set-once mastery timestamp', () => {
    it('sets now on first crossing (reps reaches 3)', () => {
        expect(resolveMasteredAt(null, 3, NOW)).toBe(NOW);
    });

    it('stays null before the threshold', () => {
        expect(resolveMasteredAt(null, 2, NOW)).toBeNull();
        expect(resolveMasteredAt(null, 0, NOW)).toBeNull();
    });

    it('sets now when crossing past the threshold (reps > 3)', () => {
        expect(resolveMasteredAt(null, 5, NOW)).toBe(NOW);
    });

    it('is NOT overwritten on a later rating', () => {
        const first = D('2026-06-01T00:00:00Z');
        expect(resolveMasteredAt(first, 5, NOW)).toBe(first);
        expect(resolveMasteredAt(first, 4, NOW)).toBe(first);
    });

    it('is NOT cleared when the card lapses below the threshold', () => {
        const first = D('2026-06-01T00:00:00Z');
        expect(resolveMasteredAt(first, 0, NOW)).toBe(first); // 'again' reset
        expect(resolveMasteredAt(first, 2, NOW)).toBe(first);
    });
});

describe('backfill precedence — COALESCE(lastReviewedAt, updatedAt, createdAt)', () => {
    // Mirrors the migration's backfill UPDATE for existing mastered rows.
    const coalesce = (
        lastReviewedAt: Date | null,
        updatedAt: Date,
        createdAt: Date,
    ): Date => lastReviewedAt ?? updatedAt ?? createdAt;

    const lr = D('2026-05-01T00:00:00Z');
    const up = D('2026-05-02T00:00:00Z');
    const cr = D('2026-05-03T00:00:00Z');

    it('prefers lastReviewedAt when present', () => {
        expect(coalesce(lr, up, cr)).toBe(lr);
    });

    it('falls back to updatedAt when lastReviewedAt is null', () => {
        expect(coalesce(null, up, cr)).toBe(up);
    });
});

describe('buildCumulativeMasteredSeries — the mastery curve', () => {
    it('exposes the final metric string', () => {
        expect(CARD_SERIES_METRIC).toBe('cumulative_mastered');
    });

    it('empty window → empty series', () => {
        expect(buildCumulativeMasteredSeries([], 'UTC', [])).toEqual([]);
    });

    it('baseline includes cards mastered before the window; then a running total', () => {
        const labels = ['2026-07-08', '2026-07-09', '2026-07-10'];
        const masteredAt = [
            D('2026-07-01T00:00:00Z'), // before window → baseline
            D('2026-07-08T09:00:00Z'), // day 08
            D('2026-07-10T01:00:00Z'), // day 10
            D('2026-07-10T20:00:00Z'), // day 10
        ];
        // baseline 1 → 08: +1 = 2 → 09: +0 = 2 → 10: +2 = 4
        expect(buildCumulativeMasteredSeries(masteredAt, 'UTC', labels)).toEqual([
            { label: '2026-07-08', value: 2 },
            { label: '2026-07-09', value: 2 },
            { label: '2026-07-10', value: 4 },
        ]);
    });

    it('point[0] equals count of masteredAt on or before the first day', () => {
        const labels = ['2026-07-08', '2026-07-09'];
        const masteredAt = [
            D('2026-06-15T00:00:00Z'),
            D('2026-07-01T00:00:00Z'),
            D('2026-07-08T23:00:00Z'), // on the first day
        ];
        const points = buildCumulativeMasteredSeries(masteredAt, 'UTC', labels);
        expect(points[0]!.value).toBe(3); // 2 pre-window + 1 on day 0
    });

    it('is monotonic non-decreasing', () => {
        const labels = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
        const masteredAt = [
            D('2026-05-01T00:00:00Z'),
            D('2026-07-06T00:00:00Z'),
            D('2026-07-08T00:00:00Z'),
            D('2026-07-08T00:00:01Z'),
            D('2026-07-10T00:00:00Z'),
        ];
        const points = buildCumulativeMasteredSeries(masteredAt, 'UTC', labels);
        for (let i = 1; i < points.length; i++) {
            expect(points[i]!.value).toBeGreaterThanOrEqual(points[i - 1]!.value);
        }
        expect(points.at(-1)!.value).toBe(5); // all masteries counted by today
    });

    it('all-pre-window masteries → flat non-zero curve', () => {
        const labels = ['2026-07-09', '2026-07-10'];
        const masteredAt = [D('2026-06-01T00:00:00Z'), D('2026-06-02T00:00:00Z')];
        expect(buildCumulativeMasteredSeries(masteredAt, 'UTC', labels)).toEqual([
            { label: '2026-07-09', value: 2 },
            { label: '2026-07-10', value: 2 },
        ]);
    });

    describe('local-day bucketing', () => {
        // 02:30Z is late evening of the 10th in New York (UTC-4), but the 11th
        // in Tokyo (UTC+9) — the mastery lands on a different local day.
        const lateNight = [D('2026-07-11T02:30:00.000Z')];

        it('buckets into the previous local day for a negative-offset zone', () => {
            const points = buildCumulativeMasteredSeries(
                lateNight,
                'America/New_York',
                ['2026-07-09', '2026-07-10', '2026-07-11'],
            );
            expect(points).toEqual([
                { label: '2026-07-09', value: 0 },
                { label: '2026-07-10', value: 1 }, // lands on the 10th in NY
                { label: '2026-07-11', value: 1 },
            ]);
        });

        it('buckets into the same UTC day for a positive-offset zone', () => {
            const points = buildCumulativeMasteredSeries(
                lateNight,
                'Asia/Tokyo',
                ['2026-07-09', '2026-07-10', '2026-07-11'],
            );
            expect(points).toEqual([
                { label: '2026-07-09', value: 0 },
                { label: '2026-07-10', value: 0 },
                { label: '2026-07-11', value: 1 }, // lands on the 11th in Tokyo
            ]);
        });
    });
});
