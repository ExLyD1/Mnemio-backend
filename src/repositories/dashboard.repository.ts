import { prisma } from '../db/prisma.js';

export type DashboardStats = {
    decks: number;
    cards: number;
    xp: number;
};

export const fetchStats = async (userId: string): Promise<DashboardStats> => {
    const rows = await prisma.$queryRaw<{ decks: bigint; cards: bigint; xp: number }[]>`
        SELECT
            (SELECT COUNT(*) FROM decks WHERE "authorId" = ${userId})         AS decks,
            (SELECT COALESCE(SUM("cardCount"), 0) FROM decks WHERE "authorId" = ${userId}) AS cards,
            (SELECT xp FROM users WHERE id = ${userId})                       AS xp
    `;
    const r = rows[0];
    return {
        decks: Number(r?.decks ?? 0n),
        cards: Number(r?.cards ?? 0n),
        xp: Number(r?.xp ?? 0),
    };
};

export const fetchRecentDecks = (userId: string, limit = 5) =>
    prisma.deck.findMany({
        where: { authorId: userId },
        orderBy: { updatedAt: 'desc' },
        take: limit,
    });
