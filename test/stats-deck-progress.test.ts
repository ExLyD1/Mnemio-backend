import { describe, it, expect } from 'vitest';
import { deckProgressPct } from '../src/services/stats.service.js';

describe('deckProgressPct — graded progress toward mastery', () => {
    it('is 0 for an empty deck', () => {
        expect(deckProgressPct(0, 0)).toBe(0);
    });

    it('moves after a single same-day session, unlike masteryPct', () => {
        // 8 cards, repetitions [2,1,1,1,1,0,0,0] → 7 of 24 steps — the deck from
        // the bug report, which showed 0% mastered after studying it end-to-end.
        expect(deckProgressPct(7, 8)).toBe(29);
    });

    it('is 100 once every card is mastered', () => {
        expect(deckProgressPct(24, 8)).toBe(100);
    });

    it('never exceeds 100 even if cardCount lags behind the progress rows', () => {
        expect(deckProgressPct(30, 8)).toBe(100);
    });
});
