import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    asU32,
    constrainedFuzzBounds,
    DAY,
    defaultContext,
    fuzzFactorFor,
    LearningSteps,
    learningIvlWithFuzz,
    leechThresholdMet,
    maybeRoundInDays,
    minimumReviewFuzzInterval,
    nextStates,
    passingReviewIntervals,
    reviewState,
    rustRound,
    withReviewFuzz,
    type CardState,
    type StateContext,
} from '../src/services/anki-scheduler.js';

const golden = JSON.parse(
    readFileSync(new URL('./fixtures/anki/anki-golden.json', import.meta.url), 'utf8'),
) as { cases: { state: CardState; ctx: StateContext; next: Record<string, CardState> }[] };
describe('Anki golden transitions (exact f32 doubles)', () => {
    it.each(golden.cases.map((entry, i) => [i, entry] as const))('case %i', (_i, entry) => {
        const { current, ...answers } = nextStates(entry.state, entry.ctx);
        expect(current).toEqual(entry.state);
        expect(answers).toEqual(entry.next);
    });
});
describe('Anki fuzz', () => {
    it.each([
        [1, 1, 1000, 1, 1, 1],
        [2.49, 1, 1000, 2, 2, 2],
        [2.5, 1, 1000, 2, 3, 4],
        [7, 1, 1000, 5, 7, 9],
        [17, 1, 1000, 14, 17, 20],
        [37, 1, 1000, 33, 37, 41],
        [2, 2, 1000, 2, 2, 2],
        [2, 3, 1000, 3, 4, 4],
        [2, 3, 3, 3, 3, 3],
        [6.9, 3, 1000, 5, 7, 9],
        [7, 3, 1000, 5, 7, 9],
        [7.1, 3, 1000, 5, 7, 9],
        [19.9, 3, 1000, 17, 20, 23],
        [20, 3, 1000, 17, 20, 23],
        [20.1, 3, 1000, 17, 20, 23],
        [100, 101, 1000, 101, 105, 108],
        [100, 1, 99, 92, 96, 99],
        [100, 97, 103, 97, 100, 103],
    ])('bounds %s %s %s', (interval, min, max, a, b, c) => {
        expect([0, 0.5, 0.99].map((f) => withReviewFuzz(f, interval, min, max))).toEqual([a, b, c]);
    });
    it('rounds without fuzz, handles reversed bounds, preserves prior interval only within range', () => {
        expect(withReviewFuzz(null, 1.5, 1, 100)).toBe(2);
        expect(withReviewFuzz(null, 0.1, 1, 100)).toBe(1);
        expect(withReviewFuzz(null, 101, 1, 100)).toBe(100);
        expect(() => constrainedFuzzBounds(1, 3, 2)).not.toThrow();
        expect(minimumReviewFuzzInterval(2.7269483, 4, 36500)).toBe(4);
        expect(minimumReviewFuzzInterval(2.7269483, 5, 36500)).toBe(0);
        expect(minimumReviewFuzzInterval(4.591988, 4, 36500)).toBe(5);
    });
    it.each([
        [0, 0],
        [1, 0],
        [3, 0],
        [4, 1],
        [60, 15],
        [600, 150],
        [1200, 300],
        [86400, 300],
    ])('learning range %s', (secs, width) => {
        expect(learningIvlWithFuzz(null, secs)).toBe(secs);
        expect(learningIvlWithFuzz(0, secs)).toBe(secs);
        expect(learningIvlWithFuzz(0.5, secs)).toBe(secs + Math.floor(width / 2));
        expect(learningIvlWithFuzz(1 - Number.EPSILON, secs)).toBe(secs + Math.max(width - 1, 0));
    });
    it.each([-0.1, 1, NaN, Infinity])('rejects invalid factor %s', (f) => {
        expect(() => withReviewFuzz(f, 10, 1, 100)).toThrow();
        expect(() => learningIvlWithFuzz(f, 60)).toThrow();
    });
    it('uses the hash of card id and answers before this answer', () => {
        const expected = Math.fround(
            createHash('sha256').update('card:2').digest().readUInt32BE(0) / 2 ** 32,
        );
        expect(fuzzFactorFor('card', 2)).toBe(expected);
        expect(fuzzFactorFor('card', 3)).not.toBe(expected);
    });
});
describe('Anki steps, lapses, early/late reviews', () => {
    it.each([
        [[10], 1, 600, 900, null],
        [[4320], 1, 3 * DAY, 4 * DAY, null],
        [[1, 10], 2, 60, 330, 600],
        [[1, 10], 1, 60, 600, null],
        [[1, 10, 100], 3, 60, 330, 600],
        [[1, 10, 100], 2, 60, 600, 6000],
        [[1, 10, 100], 1, 60, 6000, null],
    ] as const)('steps %j remaining %s', (minutes, remaining, again, hard, good) => {
        const steps = new LearningSteps(minutes);
        expect([
            steps.againDelaySecsLearn(),
            steps.hardDelaySecs(remaining),
            steps.goodDelaySecs(remaining),
        ]).toEqual([again, hard, good]);
    });
    it('encodes today steps, truncates fractional minutes, handles no steps and interday rounding', () => {
        const s = new LearningSteps([0.025, 10]);
        expect(s.againDelaySecsLearn()).toBe(1);
        expect([2002, 99, 2001, 0].map((n) => s.getIndex(n))).toEqual([0, 0, 1, 1]);
        expect(s.currentDelaySecs(2001)).toBe(600);
        expect(s.remainingForGood(2002)).toBe(1);
        expect(new LearningSteps().hardDelaySecs(1001)).toBeNull();
        expect(new LearningSteps().remainingForGood(1001)).toBe(0);
        expect(new LearningSteps([1440, 2880]).hardDelaySecs(2)).toBe(2 * DAY);
        expect(maybeRoundInDays(1.5 * DAY)).toBe(2 * DAY);
        expect(maybeRoundInDays(DAY - 1)).toBe(DAY - 1);
    });
    it('leech events repeat at half-threshold, not every lapse', () => {
        expect(Array.from({ length: 8 }, (_, n) => leechThresholdMet(n, 3))).toEqual([
            false,
            false,
            false,
            true,
            false,
            true,
            false,
            true,
        ]);
        expect(Array.from({ length: 7 }, (_, n) => leechThresholdMet(n + 7, 8))).toEqual([
            false,
            true,
            false,
            false,
            false,
            true,
            false,
        ]);
        expect(leechThresholdMet(0, 0)).toBe(false);
        expect(leechThresholdMet(0, 1)).toBe(false);
        for (const n of [1, 2, 3]) {
            expect(leechThresholdMet(n, 1)).toBe(true);
        }
    });
    it.each([
        [0, [6, 10, 12]],
        [2, [6, 10, 12]],
        [9, [11, 23, 26]],
        [10, [12, 25, 33]],
        [14, [12, 30, 46]],
        [20, [12, 38, 65]],
    ] as const)('elapsed %i', (elapsed, expected) => {
        expect(
            passingReviewIntervals(
                reviewState({ scheduled_days: 10, elapsed_days: elapsed }),
                defaultContext(),
            ),
        ).toEqual(expected);
    });
    it('early review ignores fuzz but respects modifier and maximum', () => {
        for (const f of [null, 0, 0.99]) {
            const ctx = defaultContext({ fuzz_factor: f, interval_multiplier: 2 });
            expect(
                passingReviewIntervals(reviewState({ scheduled_days: 10, elapsed_days: 2 }), ctx),
            ).toEqual([12, 20, 23]);
            expect(
                passingReviewIntervals(reviewState({ scheduled_days: 10, elapsed_days: 2 }), {
                    ...ctx,
                    maximum_review_interval: 15,
                }),
            ).toEqual([12, 15, 15]);
        }
    });
    it('rounding is half away from zero and unsigned casts saturate', () => {
        expect([-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map(rustRound)).toEqual([-3, -2, -1, 1, 2, 3]);
        expect([-1.5, NaN, -Infinity, 1.9, Infinity, 2 ** 32 + 100].map(asU32)).toEqual([
            0,
            0,
            0,
            1,
            2 ** 32 - 1,
            2 ** 32 - 1,
        ]);
        expect(maybeRoundInDays(2 ** 32 - 1)).toBe(49710 * DAY);
        expect(new LearningSteps([Infinity]).againDelaySecsLearn()).toBe(2 ** 32 - 1);
    });
});
