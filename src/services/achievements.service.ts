import * as repo from '../repositories/achievements.repository.js';
import {
    ACHIEVEMENTS,
    ACHIEVEMENT_BY_KEY,
    type AchievementStats,
    type AchievementTriggers,
} from './achievements.catalog.js';

export type PublicAchievement = {
    id: string;        // = key (FE has no need for a UUID here)
    key: string;
    name: string;
    description: string;
    iconKey: string;
    earned: boolean;
    earnedAt: string | null;
    progress: number;  // 0..100
};

const collectStats = async (userId: string): Promise<AchievementStats> => {
    const [
        sessionsCompleted,
        perfectSessions,
        cardsRated,
        cardsCreated,
        distinctTargetLanguages,
    ] = await Promise.all([
        repo.countSessionsCompleted(userId),
        repo.countPerfectSessions(userId),
        repo.countCardsRated(userId),
        repo.countCardsCreated(userId),
        repo.countDistinctTargetLanguages(userId),
    ]);
    return {
        sessionsCompleted,
        perfectSessions,
        cardsRated,
        cardsCreated,
        distinctTargetLanguages,
    };
};

export const list = async (userId: string): Promise<PublicAchievement[]> => {
    const [unlocks, stats] = await Promise.all([
        repo.findUserAchievements(userId),
        collectStats(userId),
    ]);
    const unlockByKey = new Map(unlocks.map((u) => [u.key, u]));

    return ACHIEVEMENTS.map((a) => {
        const u = unlockByKey.get(a.key);
        const earnedAt = u?.earnedAt ?? null;
        const computedProgress = a.progress(stats);
        return {
            id: a.key,
            key: a.key,
            name: a.name,
            description: a.description,
            iconKey: a.iconKey,
            earned: earnedAt !== null,
            earnedAt: earnedAt ? earnedAt.toISOString() : null,
            progress: earnedAt ? 100 : computedProgress,
        };
    });
};

/**
 * Re-evaluates every achievement whose triggers include `trigger`. Idempotent:
 * already-earned achievements are not re-stamped. Returns the list of newly
 * earned keys so the caller can push a toast.
 */
export const evaluate = async (
    userId: string,
    trigger: AchievementTriggers,
): Promise<string[]> => {
    const candidates = ACHIEVEMENTS.filter((a) => a.triggers.includes(trigger));
    if (candidates.length === 0) return [];

    const [unlocks, stats] = await Promise.all([
        repo.findUserAchievements(userId),
        collectStats(userId),
    ]);
    const unlockByKey = new Map(unlocks.map((u) => [u.key, u]));

    const newlyEarned: string[] = [];
    const now = new Date();

    for (const a of candidates) {
        const u = unlockByKey.get(a.key);
        const wasEarned = u?.earnedAt != null;
        const progress = a.progress(stats);
        const isEarnedNow = a.isEarned(stats);

        if (isEarnedNow && !wasEarned) {
            await repo.upsertProgress(userId, a.key, { earnedAt: now, progress: 100 });
            newlyEarned.push(a.key);
        } else if (!wasEarned) {
            // Track progress so the UI can show a bar before the badge unlocks.
            await repo.upsertProgress(userId, a.key, { earnedAt: null, progress });
        }
    }
    return newlyEarned;
};

export const lookup = (key: string) => ACHIEVEMENT_BY_KEY.get(key);
