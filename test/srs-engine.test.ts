import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    DAY_SECS,
    SRS_DEFAULTS,
    answerOptions,
    fuzzFactor,
    fuzzRange,
    hardStepSecs,
    isLeech,
    jitterStep,
    newMemory,
    nextStepSecs,
    pickInterval,
    reviewIntervals,
    type Rating,
} from '../src/services/srs-engine.js';
import {
    comparable,
    memoryFrom,
    settingsFrom,
    type RefCase,
} from './fixtures/anki/golden-adapter.js';

const reference = JSON.parse(
    readFileSync(new URL('./fixtures/anki/anki-golden.json', import.meta.url), 'utf8'),
) as { cases: RefCase[] };

// Anki multiplies in binary32, where 1.3 is 1.2999999523: 95 × that = 123.4999 → 123.
// Mnemio keeps ease as a plain decimal, so 95 × 1.3 = 123.5 → 124. Known, intended.
const BINARY32_ONLY = new Set(['case 676 good']);

describe('reference transitions recorded from Anki', () => {
    it.each(reference.cases.map((entry, i) => [i, entry] as const))('case %i', (i, entry) => {
        const settings = settingsFrom(entry.ctx);
        const options = answerOptions(
            memoryFrom(entry.state, settings.startingEase),
            settings,
            entry.ctx.fuzz_factor,
        );
        for (const rating of ['again', 'hard', 'good', 'easy'] as Rating[]) {
            if (BINARY32_ONLY.has(`case ${i} ${rating}`)) {
                continue;
            }
            expect(comparable(options[rating]), rating).toEqual(
                comparable(memoryFrom(entry.next[rating], settings.startingEase)),
            );
        }
    });
});

describe('fuzz', () => {
    it.each([
        [1, 1, 1000, 1, 1, 1],
        [2.49, 1, 1000, 2, 2, 2],
        [2.5, 1, 1000, 2, 3, 4],
        [7, 1, 1000, 5, 7, 9],
        [17, 1, 1000, 14, 17, 20],
        [37, 1, 1000, 33, 37, 41],
        [2, 3, 1000, 3, 4, 4],
        [20, 3, 1000, 17, 20, 23],
        [100, 101, 1000, 101, 105, 108],
        [100, 1, 99, 92, 96, 99],
        [100, 97, 103, 97, 100, 103],
    ])('interval %s within [%s, %s]', (days, min, max, a, b, c) => {
        expect([0, 0.5, 0.99].map((f) => pickInterval(days, min, max, f))).toEqual([a, b, c]);
    });

    it('rounds without fuzz and tolerates min above max', () => {
        expect(pickInterval(1.5, 1, 100, null)).toBe(2);
        expect(pickInterval(0.1, 1, 100, null)).toBe(1);
        expect(pickInterval(101, 1, 100, null)).toBe(100);
        expect(fuzzRange(1, 3, 2)).toEqual([2, 2]);
    });

    it.each([
        [60, 15],
        [600, 150],
        [1200, 300],
        [3, 0],
    ])('learning delay %s gets up to %s extra seconds', (secs, width) => {
        expect(jitterStep(secs, null)).toBe(secs);
        expect(jitterStep(secs, 0)).toBe(secs);
        expect(jitterStep(secs, 1 - Number.EPSILON)).toBe(secs + Math.max(width - 1, 0));
    });

    it.each([-0.1, 1, NaN, Infinity])('rejects factor %s', (f) => {
        expect(() => pickInterval(10, 1, 100, f)).toThrow();
        expect(() => jitterStep(60, f)).toThrow();
    });

    it('derives the factor from card id and answer count', () => {
        const expected = createHash('sha256').update('card:2').digest().readUInt32BE(0) / 2 ** 32;
        expect(fuzzFactor('card', 2)).toBe(expected);
        expect(fuzzFactor('card', 3)).not.toBe(expected);
    });
});

describe('learning steps', () => {
    it.each([
        [[10], 1, 900, null],
        [[4320], 1, 4 * DAY_SECS, null],
        [[1, 10], 2, 330, 600],
        [[1, 10], 1, 600, null],
        [[1, 10, 100], 3, 330, 600],
        [[1, 10, 100], 2, 600, 6000],
        [[1, 10, 100], 1, 6000, null],
        [[1440, 2880], 2, 2 * DAY_SECS, 2 * DAY_SECS],
    ] as const)('steps %j with %s left: hard %s, good %s', (steps, left, hard, good) => {
        expect([hardStepSecs(steps, left), nextStepSecs(steps, left)]).toEqual([hard, good]);
    });

    it('truncates fractional seconds and handles no steps', () => {
        expect(hardStepSecs([0.025, 10], 2)).toBe(300);
        expect(hardStepSecs([], 1)).toBeNull();
        expect(nextStepSecs([], 1)).toBeNull();
    });

    it('walks a new card through 1m → 10m → 1 day', () => {
        const fresh = newMemory();
        const second = answerOptions(fresh).good;
        expect(second).toMatchObject({ phase: 'learning', stepsLeft: 1, stepSecs: 600 });
        expect(answerOptions(second).good).toMatchObject({
            phase: 'review',
            intervalDays: 1,
            ease: 2.5,
        });
        expect(answerOptions(fresh).easy).toMatchObject({ phase: 'review', intervalDays: 4 });
    });
});

describe('reviews and lapses', () => {
    it('flags leeches at the threshold, then every half threshold', () => {
        expect(Array.from({ length: 8 }, (_, n) => isLeech(n, 3))).toEqual([
            false,
            false,
            false,
            true,
            false,
            true,
            false,
            true,
        ]);
        expect([8, 9, 12, 16].map((n) => isLeech(n, 8))).toEqual([true, false, true, true]);
        expect(isLeech(0, 0)).toBe(false);
    });

    it.each([
        [0, [6, 10, 12]],
        [9, [11, 23, 26]],
        [10, [12, 25, 33]],
        [14, [12, 30, 46]],
        [20, [12, 38, 65]],
    ] as const)('10-day interval answered after %i days', (elapsed, expected) => {
        expect(
            reviewIntervals(
                { intervalDays: 10, daysSinceReview: elapsed, ease: 2.5 },
                SRS_DEFAULTS,
                null,
            ),
        ).toEqual(expected);
    });

    it('early reviews ignore fuzz but respect the modifier and maximum', () => {
        const s = { ...SRS_DEFAULTS, intervalModifier: 2 };
        const card = { intervalDays: 10, daysSinceReview: 2, ease: 2.5 };
        expect(reviewIntervals(card, s, 0.99)).toEqual([12, 20, 23]);
        expect(reviewIntervals(card, { ...s, maximumInterval: 15 }, 0.99)).toEqual([12, 15, 15]);
    });

    it('keeps ease a clean decimal', () => {
        const card = {
            phase: 'review' as const,
            stepsLeft: 0,
            stepSecs: 0,
            intervalDays: 10,
            daysSinceReview: 10,
            ease: 2.2999999523162842,
            lapses: 0,
            leeched: false,
        };
        expect(answerOptions(card).hard.ease).toBe(2.15);
        expect(answerOptions(card).again).toMatchObject({
            phase: 'relearning',
            ease: 2.1,
            lapses: 1,
        });
        expect(answerOptions({ ...card, ease: 1.35 }).again.ease).toBe(1.3);
    });
});
