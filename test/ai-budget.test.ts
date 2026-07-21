import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertWithinBudget, recordUse } from '../src/services/ai.budget.service.js';
import { AiBudgetExceededError } from '../src/shared/errors.js';
import * as aiUsageRepo from '../src/repositories/ai-usage.repository.js';
import { env } from '../src/config/env.js';

vi.mock('../src/repositories/ai-usage.repository.js', async () => {
    const actual =
        await vi.importActual<typeof aiUsageRepo>('../src/repositories/ai-usage.repository.js');
    return {
        ...actual,
        findTodayCount: vi.fn(),
        recordUse: vi.fn(),
    };
});

const mockedRepo = vi.mocked(aiUsageRepo);

describe('ai.budget.service / assertWithinBudget', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('passes when usage is below cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_ENRICH_CAP_PER_USER - 1);
        await expect(assertWithinBudget('user-1', 'enrich')).resolves.toBeUndefined();
    });

    it('throws AI_BUDGET_EXCEEDED at exactly the cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_ENRICH_CAP_PER_USER);
        await expect(assertWithinBudget('user-1', 'enrich')).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
    });

    it('throws when over cap', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_ENRICH_CAP_PER_USER + 100);
        await expect(assertWithinBudget('user-1', 'enrich')).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
    });

    it('uses the right cap per kind (caps are not shared)', async () => {
        // suggest cap > enrich cap; usage of (enrich cap - 1) should NOT trip suggest.
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_ENRICH_CAP_PER_USER - 1);
        await expect(assertWithinBudget('u', 'suggest')).resolves.toBeUndefined();
        // But would trip enrich if it was at cap.
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_ENRICH_CAP_PER_USER);
        await expect(assertWithinBudget('u', 'enrich')).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
    });

    it('error payload carries kind + capPerDay so the FE can render "X of Y used"', async () => {
        mockedRepo.findTodayCount.mockResolvedValue(env.AI_DAILY_GENERATE_CAP_PER_USER);
        try {
            await assertWithinBudget('u', 'generate');
            expect.fail('should have thrown');
        } catch (err) {
            const payload = (err as AiBudgetExceededError).toPayload();
            expect(payload.code).toBe('AI_BUDGET_EXCEEDED');
            expect(payload.details).toEqual({
                kind: 'generate',
                capPerDay: env.AI_DAILY_GENERATE_CAP_PER_USER,
            });
        }
    });
});

describe('ai.budget.service / recordUse', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('delegates to the repo upsert', async () => {
        mockedRepo.recordUse.mockResolvedValue(3);
        const next = await recordUse('user-1', 'enrich');
        expect(next).toBe(3);
        expect(mockedRepo.recordUse).toHaveBeenCalledWith('user-1', 'enrich');
    });
});
