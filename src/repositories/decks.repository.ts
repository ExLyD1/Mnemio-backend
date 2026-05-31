import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

export type ListDecksParams = {
    ownerId: string;
    limit: number;
    cursor: { ts: string; id: string } | null;
    q: string | undefined;
};

export const listDecks = ({ ownerId, limit, cursor, q }: ListDecksParams) => {
    const where: Prisma.DeckWhereInput = { authorId: ownerId };

    if (q && q.length > 0) {
        where.OR = [
            { title: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
        ];
    }

    if (cursor) {
        const ts = new Date(cursor.ts);
        where.OR = [
            ...(where.OR ?? []),
        ];
        // Keyset: rows with updatedAt < cursor.ts OR (updatedAt = ts AND id < cursor.id)
        where.AND = [
            {
                OR: [
                    { updatedAt: { lt: ts } },
                    { updatedAt: ts, id: { lt: cursor.id } },
                ],
            },
        ];
    }

    return prisma.deck.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, // +1 to detect "hasMore"
    });
};

export const findDeckById = (id: string, ownerId: string) =>
    prisma.deck.findFirst({ where: { id, authorId: ownerId } });

export const createDeck = (
    ownerId: string,
    data: {
        title: string;
        description: string;
        sourceLanguage: string;
        targetLanguage: string;
    },
) =>
    prisma.deck.create({
        data: {
            authorId: ownerId,
            title: data.title,
            description: data.description,
            sourceLanguage: data.sourceLanguage,
            targetLanguage: data.targetLanguage,
        },
    });

export const updateDeck = (
    id: string,
    ownerId: string,
    patch: Partial<{
        title: string;
        description: string;
        sourceLanguage: string;
        targetLanguage: string;
    }>,
) =>
    prisma.deck.updateMany({
        where: { id, authorId: ownerId },
        data: patch,
    });

export const deleteDeck = (id: string, ownerId: string) =>
    prisma.deck.deleteMany({ where: { id, authorId: ownerId } });

export const recomputeCardCount = (deckId: string) =>
    prisma.$executeRaw`
        UPDATE decks
           SET "cardCount" = (SELECT COUNT(*)::int FROM cards WHERE "deckId" = ${deckId}),
               "updatedAt" = now()
         WHERE id = ${deckId}
    `;
