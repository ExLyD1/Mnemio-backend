import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    capFor,
    metered,
    release,
    reserve,
    usageSnapshot,
} from '../src/services/ai.budget.service.js';
import * as repo from '../src/repositories/ai-usage.repository.js';
import * as entitlement from '../src/services/entitlement.service.js';
import * as analytics from '../src/services/analytics.service.js';
import { env } from '../src/config/env.js';
import { AiBudgetExceededError, ImportBudgetExceededError } from '../src/shared/errors.js';

vi.mock('../src/repositories/ai-usage.repository.js', async (actual) => ({
    ...(await actual<typeof repo>()),
    reserveUse: vi.fn(),
    releaseUse: vi.fn(),
    findTodayCounts: vi.fn(),
}));
vi.mock('../src/services/entitlement.service.js', () => ({ getPlan: vi.fn() }));
vi.mock('../src/services/analytics.service.js', () => ({ track: vi.fn() }));
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(entitlement.getPlan).mockResolvedValue('free');
    vi.mocked(repo.reserveUse).mockResolvedValue(1);
});

describe('caps', () => {
    it('counts what the user sees, each kind with its own cap', () => {
        expect(capFor('deck', 'free')).toBe(env.MIMI_DECKS_PER_DAY_FREE);
        expect(capFor('message', 'free')).toBe(env.MIMI_MESSAGES_PER_DAY_FREE);
        expect(capFor('action', 'free')).toBe(env.MIMI_ACTIONS_PER_DAY_FREE);
        expect(capFor('tip', 'free')).toBe(env.MIMI_TIPS_PER_DAY);
        expect(capFor('deck', 'premium')).toBe(env.MIMI_DECKS_PER_DAY_PREMIUM);
        expect(capFor('message', 'premium')).toBe(env.MIMI_MESSAGES_PER_DAY_PREMIUM);
        expect(capFor('action', 'premium')).toBe(env.MIMI_ACTIONS_PER_DAY_PREMIUM);
    });
});

describe('atomic daily budget', () => {
    it.each(['deck', 'message', 'action', 'tip', 'import'] as const)(
        'reserves %s with the resolved plan cap',
        async (kind) => {
            vi.mocked(entitlement.getPlan).mockResolvedValue('premium');
            await expect(reserve('u', kind)).resolves.toBeUndefined();
            expect(repo.reserveUse).toHaveBeenCalledWith('u', kind, capFor(kind, 'premium'));
            expect(repo.releaseUse).not.toHaveBeenCalled();
        },
    );
    it.each(['deck', 'message', 'action', 'tip'] as const)(
        'keeps the %s cap error contract',
        async (kind) => {
            vi.mocked(repo.reserveUse).mockResolvedValue(null);
            await expect(reserve('u', kind)).rejects.toBeInstanceOf(AiBudgetExceededError);
            await expect(reserve('u', kind)).rejects.toMatchObject({
                code: 'AI_BUDGET_EXCEEDED',
                details: {
                    kind,
                    capPerDay: capFor(kind, 'free'),
                    resetsAt: expect.any(String),
                },
            });
            expect(repo.releaseUse).not.toHaveBeenCalled();
        },
    );
    it('keeps the import error and excludes it from AI analytics', async () => {
        vi.mocked(repo.reserveUse).mockResolvedValue(null);
        await expect(reserve('u', 'import')).rejects.toBeInstanceOf(ImportBudgetExceededError);
        expect(analytics.track).not.toHaveBeenCalled();
    });
    it.each([
        ['deck', 'generate_deck'],
        ['action', 'enrich_words'],
        ['tip', 'suggestion'],
    ] as const)('emits the existing analytics event once for %s', async (kind, feature) => {
        vi.mocked(repo.reserveUse).mockResolvedValue(null);
        await expect(reserve('u', kind)).rejects.toBeDefined();
        expect(analytics.track).toHaveBeenCalledExactlyOnceWith('u', 'ai_cap_reached', {
            ai_feature: feature,
            cap_per_day: capFor(kind, 'free'),
        });
    });
    it('sends no analytics event for messages', async () => {
        vi.mocked(repo.reserveUse).mockResolvedValue(null);
        await expect(reserve('u', 'message')).rejects.toBeDefined();
        expect(analytics.track).not.toHaveBeenCalled();
    });
    it('releases a reservation through the repository', async () => {
        await release('u', 'message');
        expect(repo.releaseUse).toHaveBeenCalledExactlyOnceWith('u', 'message');
    });
});

describe('metered', () => {
    it('keeps the reservation when the work succeeds', async () => {
        await expect(metered('u', 'deck', async () => 'ok')).resolves.toBe('ok');
        expect(repo.reserveUse).toHaveBeenCalledWith('u', 'deck', capFor('deck', 'free'));
        expect(repo.releaseUse).not.toHaveBeenCalled();
    });

    it('gives the slot back when the work fails', async () => {
        await expect(
            metered('u', 'deck', async () => {
                throw new Error('provider down');
            }),
        ).rejects.toThrow('provider down');
        expect(repo.releaseUse).toHaveBeenCalledExactlyOnceWith('u', 'deck');
    });

    it('never runs the work when the cap is reached', async () => {
        vi.mocked(repo.reserveUse).mockResolvedValue(null);
        const work = vi.fn();
        await expect(metered('u', 'deck', work)).rejects.toBeInstanceOf(AiBudgetExceededError);
        expect(work).not.toHaveBeenCalled();
        expect(repo.releaseUse).not.toHaveBeenCalled();
    });
});

describe('usageSnapshot', () => {
    beforeEach(() => {
        vi.mocked(repo.findTodayCounts).mockResolvedValue({ deck: 1 });
    });

    it('free users get real caps and are not unlimited', async () => {
        const snap = await usageSnapshot('u');
        expect(snap.kinds.deck).toEqual({
            used: 1,
            cap: env.MIMI_DECKS_PER_DAY_FREE,
            remaining: env.MIMI_DECKS_PER_DAY_FREE - 1,
            unlimited: false,
        });
        expect(snap.freeCaps.deck).toBe(env.MIMI_DECKS_PER_DAY_FREE);
    });

    it('Premium users are flagged unlimited so the UI shows no counter', async () => {
        vi.mocked(entitlement.getPlan).mockResolvedValue('premium');
        const snap = await usageSnapshot('u');
        expect(snap.kinds.deck.unlimited).toBe(true);
        expect(snap.kinds.message.unlimited).toBe(true);
        expect(snap.kinds.action.unlimited).toBe(true);
        expect(snap.kinds.import.unlimited).toBe(false);
        // The free caps still ride along, so the UI can show what Free offers.
        expect(snap.freeCaps.message).toBe(env.MIMI_MESSAGES_PER_DAY_FREE);
    });
});
