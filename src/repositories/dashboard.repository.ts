import { prisma } from '../db/prisma.js';
import type { DeckModel } from '../../generated/prisma/models/Deck.js';

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

// The deck behind the user's most recent study session, regardless of status.
// Powers the home "Quick continue" CTA: the FE resumes `continueStudying` if
// it exists, otherwise starts a fresh session on this deck.
export const fetchLastPracticedDeck = async (userId: string): Promise<DeckModel | null> => {
    const session = await prisma.studySession.findFirst({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        select: { deckId: true },
    });
    if (!session) return null;
    return prisma.deck.findUnique({ where: { id: session.deckId } });
};

// The user's most-practiced decks, ranked by number of study sessions
// (ties broken by most recent session). Powers the home quick-start block.
export const fetchMostPracticedDecks = async (
    userId: string,
    limit = 4,
): Promise<DeckModel[]> => {
    const grouped = await prisma.studySession.groupBy({
        by: ['deckId'],
        where: { userId },
        _count: { deckId: true },
        _max: { startedAt: true },
        orderBy: [{ _count: { deckId: 'desc' } }, { _max: { startedAt: 'desc' } }],
        take: limit,
    });

    const ids = grouped.map((g) => g.deckId);
    if (ids.length === 0) return [];

    const decks = await prisma.deck.findMany({ where: { id: { in: ids } } });
    const byId = new Map(decks.map((d) => [d.id, d]));
    // Preserve the groupBy ranking; drop any deck that no longer exists.
    return ids.map((id) => byId.get(id)).filter((d): d is DeckModel => d !== undefined);
};
