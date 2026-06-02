import { prisma } from '../db/prisma.js';

export const findUserAchievements = (userId: string) =>
    prisma.userAchievement.findMany({ where: { userId } });

export const upsertProgress = (
    userId: string,
    key: string,
    data: { earnedAt: Date | null; progress: number },
) =>
    prisma.userAchievement.upsert({
        where: { userId_key: { userId, key } },
        update: data,
        create: { userId, key, ...data },
    });

// ---------- Stats sources ----------

export const countSessionsCompleted = (userId: string) =>
    prisma.studySession.count({ where: { userId, status: 'complete' } });

export const countPerfectSessions = async (userId: string): Promise<number> => {
    // "Perfect" = at least 5 cards and 100% accuracy.
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
          FROM study_sessions
         WHERE "userId" = ${userId}
           AND "status" = 'complete'
           AND "cardsStudied" >= 5
           AND "correctAnswers" = "cardsStudied"
    `;
    return Number(rows[0]?.count ?? 0n);
};

export const countCardsRated = async (userId: string): Promise<number> => {
    // Each CardProgress row is one rated card. (Multiple ratings overwrite the
    // same row — this counts unique cards rated, not total ratings. Close enough
    // for milestone gating; can swap for a `ratings` table later.)
    return prisma.cardProgress.count({ where: { userId } });
};

export const countCardsCreated = (userId: string) =>
    prisma.card.count({ where: { userId } });

export const countDistinctTargetLanguages = async (userId: string): Promise<number> => {
    const rows = await prisma.deck.findMany({
        where: { authorId: userId },
        select: { targetLanguage: true },
        distinct: ['targetLanguage'],
    });
    return rows.length;
};
