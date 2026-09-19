import { describe, it, expect } from 'vitest';
import { initialState, review } from '../src/services/sm2.js';
import { RATING_TO_QUALITY } from '../src/schemas/srs.schema.js';
import { MASTERY_THRESHOLD, resolveMasteredAt } from '../src/services/srs.service.js';

/**
 * Regression for BUG-0706-12 / -21: "deck shows 0% learned after several passes".
 *
 * Root cause was a threshold mismatch — the deck-stats query counted a card as
 * `mastered` only at `interval >= 21`, while the frontend marks a card's status
 * dot mastered at `repetitions >= 3`. A user who studied a card 3 times in a row
 * would see the card's dot flip to mastered while the deck's mastered-% stayed 0.
 *
 * `aggregateDeckStats` now keys mastery on `repetitions >= 3`. These pure SM-2
 * assertions lock in the behaviour that motivated the change (no DB needed).
 */
const REF_NOW = new Date('2026-06-01T12:00:00.000Z');

const applyGoods = (passes: number) => {
    let state = initialState(REF_NOW);
    for (let i = 0; i < passes; i++) {
        state = review(state, RATING_TO_QUALITY.good, REF_NOW);
    }
    return state;
};

describe('deck mastery threshold (BUG-0706-12/-21)', () => {
    it('3 consecutive "good" passes reach repetitions >= 3 (mastered under the new rule)', () => {
        const state = applyGoods(3);
        expect(state.repetitions).toBe(3);
        // Exercise the production predicate rather than restating the line
        // above: resolveMasteredAt is what actually stamps mastery.
        expect(resolveMasteredAt(null, state.repetitions, REF_NOW)).toEqual(REF_NOW);
    });

    it('two passes are not yet mastery — the threshold is exactly 3', () => {
        const state = applyGoods(2);
        expect(state.repetitions).toBe(MASTERY_THRESHOLD - 1);
        expect(resolveMasteredAt(null, state.repetitions, REF_NOW)).toBeNull();
    });

    it('after 3 passes the interval is still < 21 — why the old interval-based rule showed 0%', () => {
        const state = applyGoods(3);
        // Demonstrates the old bug: interval never reached the old >= 21 gate,
        // so the deck read 0% mastered even though the card was clearly learned.
        expect(state.interval).toBeLessThan(21);
    });

    it('a single "again" resets repetitions below the mastery threshold', () => {
        let state = applyGoods(3);
        state = review(state, RATING_TO_QUALITY.again, REF_NOW);
        expect(state.repetitions).toBe(0);
        // A fresh card at 0 repetitions would not be stamped...
        expect(resolveMasteredAt(null, state.repetitions, REF_NOW)).toBeNull();
        // ...but mastery already earned is never revoked (the curve is
        // "ever mastered", so it must stay monotonic across a lapse).
        const earlier = new Date('2026-05-01T00:00:00.000Z');
        expect(resolveMasteredAt(earlier, state.repetitions, REF_NOW)).toEqual(earlier);
    });
});
