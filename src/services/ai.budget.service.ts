import { env } from '../config/env.js';
import * as aiUsageRepo from '../repositories/ai-usage.repository.js';
import * as entitlementService from './entitlement.service.js';
import * as analytics from './analytics.service.js';
import { AiBudgetExceededError, ImportBudgetExceededError } from '../shared/errors.js';

// Map usage kinds to the frozen `ai_cap_reached` analytics contract (its
// feature names predate the decks/messages/actions split). Messages and
// imports are intentionally absent from that contract.
const AI_FEATURE_BY_KIND: Partial<
    Record<aiUsageRepo.AiUsageKind, 'generate_deck' | 'enrich_words' | 'suggestion'>
> = {
    deck: 'generate_deck',
    action: 'enrich_words',
    tip: 'suggestion',
};

export const capFor = (kind: aiUsageRepo.AiUsageKind, plan: 'free' | 'premium'): number => {
    const premium = plan === 'premium';
    switch (kind) {
        case 'deck':
            return premium ? env.MIMI_DECKS_PER_DAY_PREMIUM : env.MIMI_DECKS_PER_DAY_FREE;
        case 'message':
            return premium ? env.MIMI_MESSAGES_PER_DAY_PREMIUM : env.MIMI_MESSAGES_PER_DAY_FREE;
        case 'action':
            return premium ? env.MIMI_ACTIONS_PER_DAY_PREMIUM : env.MIMI_ACTIONS_PER_DAY_FREE;
        case 'tip':
            return env.MIMI_TIPS_PER_DAY;
        case 'import':
            return premium ? env.IMPORT_DAILY_CAP_PREMIUM_PER_USER : env.IMPORT_DAILY_CAP_PER_USER;
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
        const resetsAt = aiUsageRepo.nextResetAt().toISOString();
        // 'import' gets its own error code so the FE can distinguish AI vs
        // import quotas — the user might be capped on one and free on the other.
        if (kind === 'import') {
            throw new ImportBudgetExceededError(cap, resetsAt);
        }
        // Fire the paywall-funnel event at the un-bypassable guard — exactly
        // once, before the throw, for the three contract AI features.
        const aiFeature = AI_FEATURE_BY_KIND[kind];
        if (aiFeature) {
            analytics.track(userId, 'ai_cap_reached', { ai_feature: aiFeature, cap_per_day: cap });
        }
        throw new AiBudgetExceededError(kind, cap, resetsAt);
    }
};

export type UsageSnapshot = {
    plan: 'free' | 'premium';
    resetsAt: string;
    // `unlimited` = Premium: the cap is a hidden safety net, so the UI shows
    // no counter for it.
    kinds: Record<
        aiUsageRepo.AiUsageKind,
        { used: number; cap: number; remaining: number; unlimited: boolean }
    >;
};

const ALL_KINDS: aiUsageRepo.AiUsageKind[] = ['deck', 'message', 'action', 'tip', 'import'];

/**
 * Today's usage for every kind — what GET /ai/usage returns, and what the chat
 * system prompt reads so Mimi can state a real remaining count instead of
 * guessing at a limit.
 */
export const usageSnapshot = async (userId: string): Promise<UsageSnapshot> => {
    const [plan, counts] = await Promise.all([
        entitlementService.getPlan(userId),
        aiUsageRepo.findTodayCounts(userId),
    ]);
    const kinds = {} as UsageSnapshot['kinds'];
    for (const kind of ALL_KINDS) {
        const cap = capFor(kind, plan);
        const used = counts[kind] ?? 0;
        kinds[kind] = {
            used,
            cap,
            remaining: Math.max(0, cap - used),
            unlimited: plan === 'premium' && kind !== 'import',
        };
    }
    return { plan, resetsAt: aiUsageRepo.nextResetAt().toISOString(), kinds };
};

/**
 * Atomic +1 on the day's counter. Call AFTER a successful provider call —
 * we don't count failed calls against the user's cap.
 */
export const recordUse = (userId: string, kind: aiUsageRepo.AiUsageKind) =>
    aiUsageRepo.recordUse(userId, kind);

/** Check the limit, run `work`, and count it only if it succeeded. */
export const metered = async <T>(
    userId: string,
    kind: aiUsageRepo.AiUsageKind,
    work: () => Promise<T>,
): Promise<T> => {
    await assertWithinBudget(userId, kind);
    const result = await work();
    await recordUse(userId, kind);
    return result;
};

export type { AiUsageKind } from '../repositories/ai-usage.repository.js';
