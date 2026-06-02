import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

export const findCardById = (id: string) => prisma.card.findUnique({ where: { id } });

export const findCardWithOwner = (id: string) =>
    prisma.card.findUnique({
        where: { id },
        include: { deck: { select: { authorId: true } } },
    });

export type ListCardsParams = {
    deckId: string;
    limit: number;
    cursor: { ts: string; id: string } | null;
};

// Cards paginate by (position ASC, id ASC). ts in cursor is position-as-string.
export const listCardsByPosition = ({ deckId, limit, cursor }: ListCardsParams) => {
    const where: Prisma.CardWhereInput = { deckId };

    if (cursor) {
        const pos = Number.parseInt(cursor.ts, 10);
        where.AND = [
            {
                OR: [
                    { position: { gt: pos } },
                    { position: pos, id: { gt: cursor.id } },
                ],
            },
        ];
    }

    return prisma.card.findMany({
        where,
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: limit + 1,
    });
};

// FE Deck Detail / study queue / Add Card need every card up front (≤1000/deck
// per the FE perf budget). Listed inline by GET /decks/:id.
export const listAllCardsForDeck = (deckId: string, max = 1000) =>
    prisma.card.findMany({
        where: { deckId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: max,
    });

export const nextPositionForDeck = async (deckId: string): Promise<number> => {
    const last = await prisma.card.findFirst({
        where: { deckId },
        orderBy: { position: 'desc' },
        select: { position: true },
    });
    return last ? last.position + 1 : 0;
};

export type CardCreate = {
    userId: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    reading: string | null;
    partOfSpeech: string | null;
    example: string | null;
    exampleTranslation: string | null;
    tags: string[];
    difficulty: string;
    type: string;
    audioUrl: string | null;
    imageUrl: string | null;
    position: number;
};

export type CardUpdate = Partial<{
    word: string;
    definition: string;
    phonetic: string | null;
    reading: string | null;
    partOfSpeech: string | null;
    example: string | null;
    exampleTranslation: string | null;
    tags: string[];
    difficulty: string;
    type: string;
    audioUrl: string | null;
    imageUrl: string | null;
    position: number;
}>;

export const createCard = (data: CardCreate) =>
    prisma.card.create({ data });

export const createCardsBulk = (rows: CardCreate[]) =>
    prisma.card.createMany({ data: rows });

export const updateCard = (id: string, patch: CardUpdate) =>
    prisma.card.update({ where: { id }, data: patch });

export const deleteCard = (id: string) => prisma.card.delete({ where: { id } });
