import { describe, it, expect } from 'vitest';
import { computeXp } from '../src/services/sessions.service.js';

describe('Session XP formula (server-authoritative)', () => {
    // Locked by backend-plan.md §Reconciliations #5 and frontend's computeXp.
    // Formula: correct * 10 + (completed ? 25 : 0)

    it('zero correct, completed → 25 (completion bonus only)', () => {
        expect(computeXp(0, true)).toBe(25);
    });

    it('zero correct, not completed → 0', () => {
        expect(computeXp(0, false)).toBe(0);
    });

    it('1 correct, completed → 35', () => {
        expect(computeXp(1, true)).toBe(35);
    });

    it('1 correct, not completed → 10', () => {
        expect(computeXp(1, false)).toBe(10);
    });

    it('10 correct, completed → 125', () => {
        expect(computeXp(10, true)).toBe(125);
    });

    it('10 correct, not completed → 100', () => {
        expect(computeXp(10, false)).toBe(100);
    });

    it('linear in correct count', () => {
        for (let n = 0; n < 50; n++) {
            expect(computeXp(n, true)).toBe(n * 10 + 25);
            expect(computeXp(n, false)).toBe(n * 10);
        }
    });
});
