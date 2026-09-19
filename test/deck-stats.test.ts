import { describe, expect, it } from 'vitest';
import { buildStats } from '../src/shared/mappers.deck.js';

// buildStats feeds every deck DTO the app serves (list, detail, discover,
// public pages) and had no direct cover.
describe('mappers / buildStats', () => {
    it('reports an empty deck as all-zero without dividing by zero', () => {
        expect(buildStats(0, undefined)).toEqual({
            total: 0,
            mastered: 0,
            learning: 0,
            new: 0,
            due: 0,
            masteredPct: 0,
        });
    });

    it('treats a deck with no progress rows as entirely new', () => {
        const s = buildStats(10, undefined);
        expect(s.new).toBe(10);
        expect(s.masteredPct).toBe(0);
    });

    it('derives `new` as the remainder of counted cards', () => {
        const s = buildStats(10, { mastered: 3, learning: 2, due: 1 });
        expect(s.new).toBe(5);
        expect(s.mastered).toBe(3);
        expect(s.learning).toBe(2);
        expect(s.due).toBe(1);
    });

    it('never reports a negative `new` when aggregates exceed the card count', () => {
        // Can happen transiently: progress rows outlive a deleted card until
        // the cardCount recompute lands.
        expect(buildStats(2, { mastered: 3, learning: 1, due: 0 }).new).toBe(0);
    });

    it('rounds masteredPct to a whole percent', () => {
        expect(buildStats(3, { mastered: 1, learning: 0, due: 0 }).masteredPct).toBe(33);
        expect(buildStats(8, { mastered: 1, learning: 0, due: 0 }).masteredPct).toBe(13);
    });

    it('reports 100% only when every card is mastered', () => {
        expect(buildStats(4, { mastered: 4, learning: 0, due: 0 }).masteredPct).toBe(100);
        expect(buildStats(4, { mastered: 3, learning: 1, due: 0 }).masteredPct).toBe(75);
    });
});
