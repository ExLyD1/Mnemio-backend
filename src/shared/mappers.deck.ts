import type { DeckModel } from '../../generated/prisma/models/Deck.js';
import type { CardModel } from '../../generated/prisma/models/Card.js';

export type PublicDeck = {
    id: string;
    ownerId: string;
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    isPublic: boolean;
    cardCount: number;
    createdAt: string;
    updatedAt: string;
};

export type PublicCard = {
    id: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    imageUrl: string | null;
    position: number;
    createdAt: string;
    updatedAt: string;
};

export const toPublicDeck = (deck: DeckModel): PublicDeck => ({
    id: deck.id,
    ownerId: deck.authorId,
    title: deck.title,
    description: deck.description,
    sourceLanguage: deck.sourceLanguage,
    targetLanguage: deck.targetLanguage,
    isPublic: deck.isPublic,
    cardCount: deck.cardCount,
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
});

export const toPublicCard = (card: CardModel): PublicCard => ({
    id: card.id,
    deckId: card.deckId,
    word: card.word,
    definition: card.definition,
    phonetic: card.phonetic,
    imageUrl: card.imageUrl,
    position: card.position,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
});
