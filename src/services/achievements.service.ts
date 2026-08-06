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

const toPublic = (a: (typeof ACHIEVEMENTS)[number], earnedAt: Date): PublicAchievement => ({
    id: a.key,
    key: a.key,
    name: a.name,
    description: a.description,
    iconKey: a.iconKey,
    earned: true,
    earnedAt: earnedAt.toISOString(),
    progress: 100,
});

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

// Earned but not yet acknowledged via POST /achievements/ack — backs the
// notification bell, and lets a client catch up on unlocks it missed (e.g.
// earned on another device/tab).
export const listUnseen = async (userId: string): Promise<PublicAchievement[]> => {
    const rows = await repo.findUnseen(userId);
    return rows
        .map((u) => {
            const a = ACHIEVEMENT_BY_KEY.get(u.key);
            return a && u.earnedAt ? toPublic(a, u.earnedAt) : null;
        })
        .filter((a): a is PublicAchievement => a !== null);
};

// Marks unseen achievements as notified so they stop surfacing in the bell /
// as toasts. Omit `keys` to ack everything currently unseen. Returns the keys
// actually acked.
export const acknowledge = async (userId: string, keys?: string[]): Promise<string[]> => {
    const targetKeys = keys ?? (await repo.findUnseen(userId)).map((u) => u.key);
    if (targetKeys.length === 0) return [];
    await repo.markNotified(userId, targetKeys);
    return targetKeys;
};

/**
 * Re-evaluates every achievement whose triggers include `trigger`. Idempotent:
 * already-earned achievements are not re-stamped. Returns the newly earned
 * achievements (unseen, i.e. `notifiedAt` is null) so the caller can attach
 * them to its response and the FE can toast/bell them immediately.
 */
export const evaluate = async (
    userId: string,
    trigger: AchievementTriggers,
): Promise<PublicAchievement[]> => {
    const candidates = ACHIEVEMENTS.filter((a) => a.triggers.includes(trigger));
    if (candidates.length === 0) return [];

    const [unlocks, stats] = await Promise.all([
        repo.findUserAchievements(userId),
        collectStats(userId),
    ]);
    const unlockByKey = new Map(unlocks.map((u) => [u.key, u]));

    const newlyEarned: PublicAchievement[] = [];
    const now = new Date();

    for (const a of candidates) {
        const u = unlockByKey.get(a.key);
        const wasEarned = u?.earnedAt != null;
        const progress = a.progress(stats);
        const isEarnedNow = a.isEarned(stats);

        if (isEarnedNow && !wasEarned) {
            await repo.upsertProgress(userId, a.key, { earnedAt: now, progress: 100 });
            newlyEarned.push(toPublic(a, now));
        } else if (!wasEarned) {
            // Track progress so the UI can show a bar before the badge unlocks.
            await repo.upsertProgress(userId, a.key, { earnedAt: null, progress });
        }
    }
    return newlyEarned;
};

export const lookup = (key: string) => ACHIEVEMENT_BY_KEY.get(key);
