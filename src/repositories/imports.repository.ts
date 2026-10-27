import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

export type ImportedDeck = {
    title: string;
    description: string;
    sourceData: Prisma.InputJsonObject;
    cards: Omit<Prisma.CardCreateManyInput, 'deckId' | 'userId' | 'position'>[];
};
export const createApkgDecks = (
    userId: string,
    languages: { sourceLanguage: string; targetLanguage: string },
    decks: ImportedDeck[],
) =>
    prisma.$transaction(
        async (tx) => {
            const result: { id: string; title: string; cardCount: number }[] = [];
            for (const input of decks) {
                const deck = await tx.deck.create({
                    data: {
                        authorId: userId,
                        title: input.title,
                        description: input.description,
                        ...languages,
                        sourceData: input.sourceData,
                        cardCount: input.cards.length,
                    },
                    select: { id: true, title: true, cardCount: true },
                });
                // Keep each statement below PostgreSQL's bind parameter limit.
                for (let start = 0; start < input.cards.length; start += 500) {
                    await tx.card.createMany({
                        data: input.cards.slice(start, start + 500).map((card, i) => ({
                            ...card,
                            userId,
                            deckId: deck.id,
                            position: start + i,
                        })),
                    });
                }
                result.push(deck);
            }
            return result;
        },
        { timeout: 60_000 },
    );
