import { prisma } from '../db/prisma.js';

// Records that `userId` has studied `cardIds` of `deckId`. One statement, so
// two devices studying the same deck at once can't lose each other's cards:
// the stored array is unioned (DISTINCT) with the new ids in the database, and
// the count is derived from the result.
export const recordStudied = async (
    userId: string,
    deckId: string,
    cardIds: string[],
): Promise<void> => {
    const ids = [...new Set(cardIds)];
    if (ids.length === 0) {
        return;
    }
    await prisma.$executeRaw`
        INSERT INTO "user_decks"
            ("userId", "deckId", "studiedCardIds", "studiedCount", "lastStudiedAt", "createdAt", "updatedAt")
        VALUES (${userId}, ${deckId}, ${ids}::text[], ${ids.length}, now(), now(), now())
        ON CONFLICT ("userId", "deckId") DO UPDATE SET
            "studiedCardIds" = (
                SELECT COALESCE(array_agg(DISTINCT c), ARRAY[]::text[])
                  FROM unnest("user_decks"."studiedCardIds" || EXCLUDED."studiedCardIds") AS c
            ),
            "studiedCount" = (
                SELECT count(DISTINCT c)::int
                  FROM unnest("user_decks"."studiedCardIds" || EXCLUDED."studiedCardIds") AS c
            ),
            "lastStudiedAt" = now(),
            "updatedAt" = now()
    `;
};
