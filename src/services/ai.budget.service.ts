import { env } from '../config/env.js';
import * as aiUsageRepo from '../repositories/ai-usage.repository.js';
import * as entitlementService from './entitlement.service.js';
import * as analytics from './analytics.service.js';
import { AiBudgetExceededError, ImportBudgetExceededError } from '../shared/errors.js';

// Map internal usage kinds to the frozen `ai_cap_reached` contract. Only these
// three AI features fire the event; 'chat' and 'import' have separate quotas /
// error codes and are intentionally absent from the analytics contract.
const AI_FEATURE_BY_KIND: Partial<
    Record<aiUsageRepo.AiUsageKind, 'generate_deck' | 'enrich_words' | 'suggestion'>
> = {
    enrich: 'enrich_words',
    generate: 'generate_deck',
    suggest: 'suggestion',
};

const capFor = (kind: aiUsageRepo.AiUsageKind, plan: 'free' | 'premium'): number => {
    if (plan === 'premium') {
        switch (kind) {
            case 'enrich':
                return env.AI_DAILY_ENRICH_CAP_PREMIUM_PER_USER;
            case 'generate':
                return env.AI_DAILY_GENERATE_CAP_PREMIUM_PER_USER;
            case 'suggest':
                return env.AI_DAILY_SUGGEST_CAP_PREMIUM_PER_USER;
            case 'import':
                return env.IMPORT_DAILY_CAP_PREMIUM_PER_USER;
            case 'chat':
                return env.AI_DAILY_CHAT_CAP_PREMIUM_PER_USER;
        }
    }
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
    const [plan, used] = await Promise.all([
        entitlementService.getPlan(userId),
        aiUsageRepo.findTodayCount(userId, kind),
    ]);
    const cap = capFor(kind, plan);
    if (used >= cap) {
        // 'import' gets its own error code so the FE can distinguish AI vs
        // import quotas — the user might be capped on one and free on the other.
        if (kind === 'import') throw new ImportBudgetExceededError(cap);
        // Fire the paywall-funnel event at the un-bypassable guard — exactly
        // once, before the throw, for the three contract AI features.
        const aiFeature = AI_FEATURE_BY_KIND[kind];
        if (aiFeature) {
            analytics.track(userId, 'ai_cap_reached', { ai_feature: aiFeature, cap_per_day: cap });
        }
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
