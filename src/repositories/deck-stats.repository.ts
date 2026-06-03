import { prisma } from '../db/prisma.js';

export type DeckStatsRow = {
    deckId: string;
    mastered: number;
    learning: number;
    due: number;
};

/**
 * Aggregates per-deck SRS counts for a given user across the supplied deck ids.
 * Returns one row per deck — decks without any CardProgress yet still appear
 * with zeros (LEFT JOIN). `mastered`/`learning`/`due` derive from
 * CardProgress rows scoped to {userId, deckId}; `new` is computed in the
 * service layer as `cardCount - (mastered + learning)`.
 */
export const aggregateDeckStats = async (
    userId: string,
    deckIds: string[],
): Promise<DeckStatsRow[]> => {
    if (deckIds.length === 0) return [];

    const rows = await prisma.$queryRaw<
        { deckId: string; mastered: bigint; learning: bigint; due: bigint }[]
    >`
        SELECT
            c."deckId" AS "deckId",
            COUNT(*) FILTER (WHERE cp."interval" >= 21)                              AS mastered,
            COUNT(*) FILTER (WHERE cp."interval" > 0 AND cp."interval" < 21)         AS learning,
            COUNT(*) FILTER (WHERE cp."nextReviewAt" <= now())                       AS due
          FROM cards c
          JOIN card_progresses cp
            ON cp."cardId" = c.id AND cp."userId" = ${userId}
         WHERE c."deckId" = ANY(${deckIds}::text[])
         GROUP BY c."deckId"
    `;

    return rows.map((r) => ({
        deckId: r.deckId,
        mastered: Number(r.mastered),
        learning: Number(r.learning),
        due: Number(r.due),
    }));
};
