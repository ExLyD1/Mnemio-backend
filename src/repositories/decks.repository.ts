import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

export type ListDecksParams = {
    ownerId: string;
    limit: number;
    cursor: { ts: string; id: string } | null;
    q: string | undefined;
};

const buildListWhere = ({ ownerId, cursor, q }: Omit<ListDecksParams, 'limit'>) => {
    const where: Prisma.DeckWhereInput = { authorId: ownerId };

    if (q && q.length > 0) {
        where.OR = [
            { title: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
        ];
    }

    if (cursor) {
        const ts = new Date(cursor.ts);
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
    return where;
};

export const listDecks = ({ ownerId, limit, cursor, q }: ListDecksParams) =>
    prisma.deck.findMany({
        where: buildListWhere({ ownerId, cursor, q }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1, // +1 to detect "hasMore"
    });

// Total count for the filter (ignores cursor — that's the page boundary, not
// part of the matching set).
export const countDecks = ({ ownerId, q }: Pick<ListDecksParams, 'ownerId' | 'q'>) =>
    prisma.deck.count({
        where: buildListWhere({ ownerId, cursor: null, q }),
    });

export const findDeckById = (id: string, ownerId: string) =>
    prisma.deck.findFirst({ where: { id, authorId: ownerId } });

export type DeckCreateData = {
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    isPublic?: boolean;
    coverColor?: string | null;
    glyph?: string | null;
    subject?: string | null;
    sourceDeckId?: string | null;
};

export type DeckUpdateData = Partial<{
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    isPublic: boolean;
    coverColor: string | null;
    glyph: string | null;
    subject: string | null;
}>;

export const createDeck = (ownerId: string, data: DeckCreateData) =>
    prisma.deck.create({
        data: {
            authorId: ownerId,
            title: data.title,
            description: data.description,
            sourceLanguage: data.sourceLanguage,
            targetLanguage: data.targetLanguage,
            isPublic: data.isPublic ?? false,
            coverColor: data.coverColor ?? null,
            glyph: data.glyph ?? null,
            subject: data.subject ?? null,
            sourceDeckId: data.sourceDeckId ?? null,
        },
    });

export const updateDeck = (id: string, ownerId: string, patch: DeckUpdateData) =>
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
