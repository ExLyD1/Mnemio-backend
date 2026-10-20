import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reserve, release, capFor } from '../src/services/ai.budget.service.js';
import * as repo from '../src/repositories/ai-usage.repository.js';
import * as entitlement from '../src/services/entitlement.service.js';
import * as analytics from '../src/services/analytics.service.js';
import { AiBudgetExceededError, ImportBudgetExceededError } from '../src/shared/errors.js';

vi.mock('../src/repositories/ai-usage.repository.js', async (actual) => ({
    ...(await actual<typeof repo>()),
    reserveUse: vi.fn(),
    releaseUse: vi.fn(),
}));
vi.mock('../src/services/entitlement.service.js', () => ({ getPlan: vi.fn() }));
vi.mock('../src/services/analytics.service.js', () => ({ track: vi.fn() }));
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(entitlement.getPlan).mockResolvedValue('free');
    vi.mocked(repo.reserveUse).mockResolvedValue(1);
});
describe('atomic daily budget', () => {
    it.each(['enrich', 'generate', 'suggest', 'import', 'chat', 'image'] as const)(
        'reserves %s with the resolved plan cap',
        async (kind) => {
            vi.mocked(entitlement.getPlan).mockResolvedValue('premium');
            await expect(reserve('u', kind)).resolves.toBeUndefined();
            expect(repo.reserveUse).toHaveBeenCalledWith('u', kind, capFor(kind, 'premium'));
            expect(repo.releaseUse).not.toHaveBeenCalled();
        },
    );
    it.each(['enrich', 'generate', 'suggest', 'chat', 'image'] as const)(
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
        ['enrich', 'enrich_words'],
        ['generate', 'generate_deck'],
        ['suggest', 'suggestion'],
    ] as const)('emits the existing analytics event once for %s', async (kind, feature) => {
        vi.mocked(repo.reserveUse).mockResolvedValue(null);
        await expect(reserve('u', kind)).rejects.toBeDefined();
        expect(analytics.track).toHaveBeenCalledExactlyOnceWith('u', 'ai_cap_reached', {
            ai_feature: feature,
            cap_per_day: capFor(kind, 'free'),
        });
    });
    it('releases a reservation through the repository', async () => {
        await release('u', 'chat');
        expect(repo.releaseUse).toHaveBeenCalledExactlyOnceWith('u', 'chat');
    });
});
