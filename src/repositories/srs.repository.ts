import { prisma } from '../db/prisma.js';

export const findProgress = (userId: string, cardId: string) =>
    prisma.cardProgress.findUnique({ where: { userId_cardId: { userId, cardId } } });

// Count of distinct reviewed cards — used to detect the first-review milestone.
export const countProgress = (userId: string): Promise<number> =>
    prisma.cardProgress.count({ where: { userId } });

export const upsertProgress = (data: {
    userId: string;
    cardId: string;
    repetitions: number;
    interval: number;
    easeFactor: number;
    lastReviewedAt: Date | null;
    nextReviewAt: Date;
    // Set-once: the caller passes the preserved existing value (or the new
    // first-crossing time). Written verbatim so it is never cleared on lapse.
    masteredAt: Date | null;
}) =>
    prisma.cardProgress.upsert({
        where: { userId_cardId: { userId: data.userId, cardId: data.cardId } },
        update: {
            repetitions: data.repetitions,
            interval: data.interval,
            easeFactor: data.easeFactor,
            lastReviewedAt: data.lastReviewedAt,
            nextReviewAt: data.nextReviewAt,
            masteredAt: data.masteredAt,
        },
        create: {
            userId: data.userId,
            cardId: data.cardId,
            repetitions: data.repetitions,
            interval: data.interval,
            easeFactor: data.easeFactor,
            lastReviewedAt: data.lastReviewedAt,
            nextReviewAt: data.nextReviewAt,
            masteredAt: data.masteredAt,
        },
    });

export type DueCard = {
    cardId: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    nextReviewAt: Date;
    interval: number;
    easeFactor: number;
    repetitions: number;
};

// Fetches cards due now for a user. A card is "due" if:
//   (a) the user has a CardProgress row with nextReviewAt <= now, OR
//   (b) the user owns the deck and never reviewed the card (no progress row).
// Frontend dashboard only shows (a). The simpler MVP query: union both via raw SQL.
export const findDueCards = async (userId: string, limit: number): Promise<DueCard[]> => {
    return prisma.$queryRaw<DueCard[]>`
        SELECT cp."cardId"     AS "cardId",
               c."deckId"      AS "deckId",
               c."word"        AS "word",
               c."definition"  AS "definition",
               c."phonetic"    AS "phonetic",
               cp."nextReviewAt" AS "nextReviewAt",
               cp."interval"   AS "interval",
               cp."easeFactor" AS "easeFactor",
               cp."repetitions" AS "repetitions"
          FROM card_progresses cp
          JOIN cards c ON c.id = cp."cardId"
          JOIN decks d ON d.id = c."deckId"
         WHERE cp."userId" = ${userId}
           AND (d."authorId" = ${userId} OR d."isPublic" = true)
           AND cp."nextReviewAt" <= now()
         ORDER BY cp."nextReviewAt" ASC
         LIMIT ${limit}
    `;
};

export const findAllProgress = (userId: string, limit: number) =>
    prisma.cardProgress.findMany({
        where: { userId },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
    });

// Every set masteredAt for the user, powering the cumulative mastery curve
// (GET /stats/card-series). No lower bound — the curve's baseline needs
// masteries from *before* the requested window. The caller buckets these by the
// viewer's local day.
export const findMasteredAtTimestamps = async (userId: string): Promise<Date[]> => {
    const rows = await prisma.cardProgress.findMany({
        where: { userId, masteredAt: { not: null } },
        select: { masteredAt: true },
    });
    return rows.map((r) => r.masteredAt).filter((d): d is Date => d !== null);
};

export const countDueCards = async (userId: string): Promise<number> => {
    const result = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
          FROM card_progresses cp
          JOIN cards c ON c.id = cp."cardId"
          JOIN decks d ON d.id = c."deckId"
         WHERE cp."userId" = ${userId}
           AND (d."authorId" = ${userId} OR d."isPublic" = true)
           AND cp."nextReviewAt" <= now()
    `;
    return Number(result[0]?.count ?? 0n);
};
