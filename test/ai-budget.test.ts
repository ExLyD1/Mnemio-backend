import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    assertWithinBudget,
    metered,
    recordUse,
    usageSnapshot,
} from '../src/services/ai.budget.service.js';
import { AiBudgetExceededError } from '../src/shared/errors.js';
import * as aiUsageRepo from '../src/repositories/ai-usage.repository.js';
import { env } from '../src/config/env.js';
import * as subscriptionRepo from '../src/repositories/subscription.repository.js';

vi.mock('../src/repositories/ai-usage.repository.js', async () => {
    const actual = await vi.importActual<typeof aiUsageRepo>(
        '../src/repositories/ai-usage.repository.js',
    );
    return {
        ...actual,
        findTodayCount: vi.fn(),
        findTodayCounts: vi.fn(),
        recordUse: vi.fn(),
    };
});

// The budget check looks up the user's plan (free vs premium caps) via the
// subscription repository. Unmocked, that hit a real database and every test
// here failed with a PrismaClientKnownRequestError. These tests cover the
// free-tier caps, so the user is never entitled.
vi.mock('../src/repositories/subscription.repository.js', async () => {
    const actual = await vi.importActual<typeof subscriptionRepo>(
        '../src/repositories/subscription.repository.js',
    );
    return { ...actual, isEntitled: vi.fn() };
});

const mockedRepo = vi.mocked(aiUsageRepo);
const mockedSubs = vi.mocked(subscriptionRepo);

describe('ai.budget.service / assertWithinBudget', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSubs.isEntitled.mockResolvedValue(false);
    });

    it('passes when usage is below cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_ACTIONS_PER_DAY_FREE - 1);
        await expect(assertWithinBudget('user-1', 'action')).resolves.toBeUndefined();
    });

    it('throws AI_BUDGET_EXCEEDED at exactly the cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_ACTIONS_PER_DAY_FREE);
        await expect(assertWithinBudget('user-1', 'action')).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
    });

    it('throws when over cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_ACTIONS_PER_DAY_FREE + 100);
        await expect(assertWithinBudget('user-1', 'action')).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
    });

    it('uses the right cap per kind (caps are not shared)', async () => {
        // message cap > deck cap; usage at the deck cap should NOT trip messages.
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_DECKS_PER_DAY_FREE);
        await expect(assertWithinBudget('u', 'message')).resolves.toBeUndefined();
        await expect(assertWithinBudget('u', 'deck')).rejects.toBeInstanceOf(AiBudgetExceededError);
    });

    it('premium users get the premium caps', async () => {
        mockedSubs.isEntitled.mockResolvedValue(true);
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_DECKS_PER_DAY_FREE);
        await expect(assertWithinBudget('u', 'deck')).resolves.toBeUndefined();
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_DECKS_PER_DAY_PREMIUM);
        await expect(assertWithinBudget('u', 'deck')).rejects.toBeInstanceOf(AiBudgetExceededError);
    });

    it('error payload carries kind + capPerDay so the FE can render "X of Y used"', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_DECKS_PER_DAY_FREE);
        try {
            await assertWithinBudget('u', 'deck');
            expect.fail('should have thrown');
        } catch (err) {
            const payload = (err as AiBudgetExceededError).toPayload();
            expect(payload.code).toBe('AI_BUDGET_EXCEEDED');
            // resetsAt lets the FE say "resets at 3:00" instead of the
            // assistant guessing "try again in a moment".
            expect(payload.details).toMatchObject({
                kind: 'deck',
                capPerDay: env.MIMI_DECKS_PER_DAY_FREE,
            });
            expect(new Date(payload.details?.resetsAt as string).getTime()).toBeGreaterThan(
                Date.now(),
            );
        }
    });
});

describe('ai.budget.service / usageSnapshot', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedRepo.findTodayCounts.mockResolvedValue({ deck: 1 });
    });

    it('free users get real caps and are not unlimited', async () => {
        mockedSubs.isEntitled.mockResolvedValue(false);
        const snap = await usageSnapshot('u');
        expect(snap.kinds.deck).toEqual({
            used: 1,
            cap: env.MIMI_DECKS_PER_DAY_FREE,
            remaining: env.MIMI_DECKS_PER_DAY_FREE - 1,
            unlimited: false,
        });
    });

    it('Premium users are flagged unlimited so the UI shows no counter', async () => {
        mockedSubs.isEntitled.mockResolvedValue(true);
        const snap = await usageSnapshot('u');
        expect(snap.kinds.deck.unlimited).toBe(true);
        expect(snap.kinds.message.unlimited).toBe(true);
        expect(snap.kinds.action.unlimited).toBe(true);
    });
});

describe('ai.budget.service / metered', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSubs.isEntitled.mockResolvedValue(false);
    });

    it('counts the use only after the work succeeds', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(0);
        await expect(metered('u', 'deck', async () => 'ok')).resolves.toBe('ok');
        expect(mockedRepo.recordUse).toHaveBeenCalledWith('u', 'deck');
    });

    it('does not count a failed call', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(0);
        await expect(
            metered('u', 'deck', async () => {
                throw new Error('provider down');
            }),
        ).rejects.toThrow('provider down');
        expect(mockedRepo.recordUse).not.toHaveBeenCalled();
    });

    it('never runs the work when the cap is reached', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.MIMI_DECKS_PER_DAY_FREE);
        const work = vi.fn();
        await expect(metered('u', 'deck', work)).rejects.toBeInstanceOf(AiBudgetExceededError);
        expect(work).not.toHaveBeenCalled();
    });
});

describe('ai.budget.service / recordUse', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSubs.isEntitled.mockResolvedValue(false);
    });

    it('delegates to the repo upsert', async () => {
        mockedRepo.recordUse.mockResolvedValue(3);
        const next = await recordUse('user-1', 'action');
        expect(next).toBe(3);
        expect(mockedRepo.recordUse).toHaveBeenCalledWith('user-1', 'action');
    });
});
