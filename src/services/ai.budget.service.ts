import { env } from '../config/env.js';
import * as aiUsageRepo from '../repositories/ai-usage.repository.js';
import { AiBudgetExceededError, ImportBudgetExceededError } from '../shared/errors.js';

const capFor = (kind: aiUsageRepo.AiUsageKind): number => {
    switch (kind) {
        case 'enrich':
            return env.AI_DAILY_ENRICH_CAP_PER_USER;
        case 'generate':
            return env.AI_DAILY_GENERATE_CAP_PER_USER;
        case 'suggest':
            return env.AI_DAILY_SUGGEST_CAP_PER_USER;
        case 'import':
            return env.IMPORT_DAILY_CAP_PER_USER;
        case 'chat':
            return env.AI_DAILY_CHAT_CAP_PER_USER;
    }
};

/**
 * Throws `AI_BUDGET_EXCEEDED` (HTTP 429) when the user is at or above their
 * daily cap for the given kind. Must run BEFORE the provider call so we
 * don't burn LLM credits on a call we won't return.
 */
export const assertWithinBudget = async (
    userId: string,
    kind: aiUsageRepo.AiUsageKind,
): Promise<void> => {
    const cap = capFor(kind);
    const used = await aiUsageRepo.findTodayCount(userId, kind);
    if (used >= cap) {
        // 'import' gets its own error code so the FE can distinguish AI vs
        // import quotas — the user might be capped on one and free on the other.
        if (kind === 'import') throw new ImportBudgetExceededError(cap);
        throw new AiBudgetExceededError(kind, cap);
    }
};

/**
 * Atomic +1 on the day's counter. Call AFTER a successful provider call —
 * we don't count failed calls against the user's cap.
 */
export const recordUse = (userId: string, kind: aiUsageRepo.AiUsageKind) =>
    aiUsageRepo.recordUse(userId, kind);

export type { AiUsageKind } from '../repositories/ai-usage.repository.js';
