import type { DeckModel } from '../../generated/prisma/models/Deck.js';
import type { CardModel } from '../../generated/prisma/models/Card.js';

export type DeckStats = {
    total: number;       // = cardCount
    mastered: number;
    learning: number;
    new: number;
    due: number;
    masteredPct: number; // 0–100, rounded
};

export type PublicDeck = {
    id: string;
    ownerId: string;
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    isPublic: boolean;
    cardCount: number;
    stats: DeckStats;
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

export const zeroStats = (total: number): DeckStats => ({
    total,
    mastered: 0,
    learning: 0,
    new: total,
    due: 0,
    masteredPct: 0,
});

export const buildStats = (
    cardCount: number,
    agg: { mastered: number; learning: number; due: number } | undefined,
): DeckStats => {
    const mastered = agg?.mastered ?? 0;
    const learning = agg?.learning ?? 0;
    const due = agg?.due ?? 0;
    const newCount = Math.max(0, cardCount - mastered - learning);
    const masteredPct = cardCount > 0 ? Math.round((mastered / cardCount) * 100) : 0;
    return { total: cardCount, mastered, learning, new: newCount, due, masteredPct };
};

export const toPublicDeck = (deck: DeckModel, stats?: DeckStats): PublicDeck => ({
    id: deck.id,
    ownerId: deck.authorId,
    title: deck.title,
    description: deck.description,
    sourceLanguage: deck.sourceLanguage,
    targetLanguage: deck.targetLanguage,
    isPublic: deck.isPublic,
    cardCount: deck.cardCount,
    stats: stats ?? zeroStats(deck.cardCount),
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
