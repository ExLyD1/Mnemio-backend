import { prisma } from '../db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';

// Which decks a queue covers: one deck (its new cards included), a set of decks
// (due only), or every accessible deck the user has progress in.
export type DeckScope = string | string[] | undefined;

export const accessibleCardScope = (userId: string, scope: DeckScope): Prisma.CardWhereInput => ({
    deck: { OR: [{ authorId: userId }, { isPublic: true }] },
    ...(typeof scope === 'string'
        ? { deckId: scope }
        : {
              ...(scope ? { deckId: { in: scope } } : {}),
              cardProgresses: { some: { userId } },
          }),
});

export const queueData = async (
    userId: string,
    scope: DeckScope,
    now: Date,
    ahead: Date,
    newLimit: number,
    reviewLimit: number,
) => {
    const card = accessibleCardScope(userId, scope);
    const where = { userId, card };
    // New cards only ever come from a single-deck scope.
    const single = typeof scope === 'string';
    const learning = { state: { in: ['learning', 'relearning'] } };
    const orderBy = [{ nextReviewAt: 'asc' as const }, { cardId: 'asc' as const }];
    // Deck title rides along so the review page needs no per-deck fetches.
    const include = { card: { include: { deck: { select: { id: true, title: true } } } } };
    const [dueLearning, reviews, learnAhead, newCards, newTotal] = await Promise.all([
        prisma.cardProgress.findMany({
            where: { ...where, ...learning, nextReviewAt: { lte: now } },
            include,
            orderBy,
        }),
        prisma.cardProgress.findMany({
            where: { ...where, state: 'review', nextReviewAt: { lte: now } },
            include,
            orderBy,
            take: reviewLimit,
        }),
        prisma.cardProgress.findMany({
            where: {
                ...where,
                ...learning,
                learningStepSecs: { lt: 86400 },
                nextReviewAt: { gt: now, lte: ahead },
            },
            include,
            orderBy,
        }),
        single
            ? prisma.card.findMany({
                  where: { ...card, cardProgresses: { none: { userId } } },
                  include: { deck: { select: { id: true, title: true } } },
                  orderBy: [{ position: 'asc' }, { id: 'asc' }],
                  take: newLimit,
              })
            : [],
        single
            ? prisma.card.count({ where: { ...card, cardProgresses: { none: { userId } } } })
            : 0,
    ]);
    return { dueLearning, reviews, learnAhead, newCards, newTotal };
};
export const newIntroducedToday = (userId: string, scope: DeckScope, since: Date) =>
    prisma.cardProgress.count({
        where: { userId, card: accessibleCardScope(userId, scope), createdAt: { gte: since } },
    });

export const nextFutureDue = (userId: string, scope: DeckScope, now: Date, returnedIds: string[]) =>
    prisma.cardProgress.findFirst({
        where: {
            userId,
            card: accessibleCardScope(userId, scope),
            nextReviewAt: { gt: now },
            cardId: { notIn: returnedIds },
        },
        orderBy: { nextReviewAt: 'asc' },
        select: { nextReviewAt: true },
    });

export type DeckDueRow = {
    deckId: string;
    deckTitle: string;
    coverColor: string | null;
    glyph: string | null;
    due: number;
};

// Per-deck count of the cards queueData would return as due, ignoring its review
// cap: due reviews and (re)learning, plus intraday learning inside the learn-ahead
// window. New cards never count. Same access rule as accessibleCardScope.
export const dueByDeck = (
    userId: string,
    scope: DeckScope,
    now: Date,
    ahead: Date,
): Promise<DeckDueRow[]> => {
    const deckIds = scope === undefined ? null : typeof scope === 'string' ? [scope] : scope;
    return prisma.$queryRaw<DeckDueRow[]>`
        SELECT d.id            AS "deckId",
               d.title         AS "deckTitle",
               d."coverColor"  AS "coverColor",
               d.glyph         AS "glyph",
               COUNT(*)::int   AS "due"
          FROM card_progresses cp
          JOIN cards c ON c.id = cp."cardId"
          JOIN decks d ON d.id = c."deckId"
         WHERE cp."userId" = ${userId}
           AND (d."authorId" = ${userId} OR d."isPublic" = true)
           AND (${deckIds}::text[] IS NULL OR c."deckId" = ANY(${deckIds}::text[]))
           AND (
                (cp.state = 'review' AND cp."nextReviewAt" <= ${now})
             OR (cp.state IN ('learning', 'relearning')
                 AND (cp."nextReviewAt" <= ${now}
                      OR (cp."learningStepSecs" < 86400 AND cp."nextReviewAt" <= ${ahead})))
           )
         GROUP BY d.id
         ORDER BY "due" DESC, d.title ASC, d.id ASC
    `;
};

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
    masteredAt: Date | null;
    state: string;
    remainingSteps: number;
    lapses: number;
    leeched: boolean;
    reps: number;
    learningStepSecs: number;
}) => {
    const { userId, cardId, ...update } = data;
    return prisma.cardProgress.upsert({
        where: { userId_cardId: { userId, cardId } },
        update,
        create: data,
    });
};

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

// `deckId` comes along via the card relation. Without it the FE could not tell
// which deck a progress row belonged to, so it fetched every deck individually
// to rebuild a card->deck map — 21 requests per /review mount, and any deck past
// the first page of 20 was simply missing from the due queue.
export const findAllProgress = (userId: string, limit: number) =>
    prisma.cardProgress.findMany({
        where: { userId },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
        include: { card: { select: { deckId: true } } },
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
