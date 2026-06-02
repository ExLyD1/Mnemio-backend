import { describe, it, expect } from 'vitest';
import { initialState, review, type Quality } from '../src/services/sm2.js';
import { RATING_TO_QUALITY } from '../src/schemas/srs.schema.js';

const REF_NOW = new Date('2026-06-01T12:00:00.000Z');
const dayAfter = (n: number) => {
    const d = new Date(REF_NOW);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
};

describe('SM-2 (matches frontend useSpacedRepetition.ts)', () => {
    describe('rating → quality mapping', () => {
        it.each([
            ['again', 0],
            ['hard', 2],
            ['good', 3],
            ['easy', 5],
        ] as const)('%s → quality %i', (rating, expected) => {
            expect(RATING_TO_QUALITY[rating]).toBe(expected);
        });
    });

    describe('failure path (quality < 3)', () => {
        it('again on a fresh card resets to 1-day interval and EF=2.3', () => {
            const result = review(initialState(REF_NOW), 0, REF_NOW);
            expect(result.repetitions).toBe(0);
            expect(result.interval).toBe(1);
            expect(result.easeFactor).toBeCloseTo(2.3, 5); // 2.5 - 0.2
            expect(result.nextReviewAt.getTime()).toBe(dayAfter(1).getTime());
            expect(result.lastReviewedAt).toEqual(REF_NOW);
        });

        it('hard (quality 2) also resets — treated as recall failure', () => {
            const advanced = review(initialState(REF_NOW), 5, REF_NOW);
            // 'hard' the next day
            const next = review(advanced, 2, REF_NOW);
            expect(next.repetitions).toBe(0);
            expect(next.interval).toBe(1);
            expect(next.nextReviewAt.getTime()).toBe(dayAfter(1).getTime());
        });

        it('easeFactor is floored at 1.3', () => {
            // Force EF down by failing many times.
            let s = initialState(REF_NOW);
            for (let i = 0; i < 20; i++) s = review(s, 0, REF_NOW);
            expect(s.easeFactor).toBe(1.3);
        });
    });

    describe('success path (quality >= 3)', () => {
        it('good (3) on a fresh card → interval 1', () => {
            const r = review(initialState(REF_NOW), 3, REF_NOW);
            expect(r.repetitions).toBe(1);
            expect(r.interval).toBe(1);
            expect(r.nextReviewAt.getTime()).toBe(dayAfter(1).getTime());
        });

        it('second consecutive good → interval 6', () => {
            const first = review(initialState(REF_NOW), 3, REF_NOW);
            const second = review(first, 3, REF_NOW);
            expect(second.repetitions).toBe(2);
            expect(second.interval).toBe(6);
            expect(second.nextReviewAt.getTime()).toBe(dayAfter(6).getTime());
        });

        it('third good → round(prevInterval × prevEF)', () => {
            let s = initialState(REF_NOW);
            s = review(s, 3, REF_NOW); // interval 1; EF 2.36
            const efBeforeThird = s.easeFactor;
            s = review(s, 3, REF_NOW); // interval 6; EF 2.22
            const intervalBeforeThird = s.interval;
            const efBeforeThirdReview = s.easeFactor;
            const third = review(s, 3, REF_NOW);
            expect(third.repetitions).toBe(3);
            // Interval uses the EF that was in state *before* this review's adjustment.
            expect(third.interval).toBe(Math.round(intervalBeforeThird * efBeforeThirdReview));
            expect(efBeforeThird).toBeGreaterThan(efBeforeThirdReview); // EF decays under 'good'
        });

        it('easy (5) boosts easeFactor by +0.1', () => {
            const r = review(initialState(REF_NOW), 5, REF_NOW);
            expect(r.repetitions).toBe(1);
            expect(r.interval).toBe(1);
            expect(r.easeFactor).toBeCloseTo(2.6, 5);
        });

        it('good (3) decreases easeFactor by -0.14 (standard SM-2 curve)', () => {
            const r = review(initialState(REF_NOW), 3, REF_NOW);
            // Standard SuperMemo-2: ΔEF = 0.1 - (5-q)(0.08 + (5-q)*0.02)
            //                     q=3 → 0.1 - 2*(0.08 + 2*0.02) = -0.14
            expect(r.easeFactor).toBeCloseTo(2.36, 5);
        });
    });

    describe('contract-table cases', () => {
        // Reproduces the rows in api-contract.md "Rating → SM-2 quality" table.
        it.each([
            ['again', 0, { repetitions: 0, interval: 1 }],
            ['hard', 2, { repetitions: 0, interval: 1 }],
            ['good', 3, { repetitions: 1, interval: 1 }],
            ['easy', 5, { repetitions: 1, interval: 1 }],
        ])('first review with %s → r=%d', (_rating, q, expected) => {
            const r = review(initialState(REF_NOW), q as Quality, REF_NOW);
            expect(r.repetitions).toBe(expected.repetitions);
            expect(r.interval).toBe(expected.interval);
        });
    });
});
