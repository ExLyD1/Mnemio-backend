import type { DeckModel } from '../../generated/prisma/models/Deck.js';
import type { CardModel } from '../../generated/prisma/models/Card.js';
import { isSubject, type Subject } from './subjects.js';

export type DeckStats = {
    total: number; // = cardCount
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
    coverColor: string | null;
    glyph: string | null;
    subject: Subject;
    featured: boolean;
    copyCount: number;
    sourceDeckId: string | null;
    // Where the deck was imported from; null for decks made in Mnemio.
    importedFrom: 'anki' | null;
    stats: DeckStats;
    createdAt: string;
    updatedAt: string;
};

// `Deck + author summary` for Discover listings — keeps the FE from doing a
// second roundtrip just to render a username.
export type PublicDeckWithAuthor = PublicDeck & {
    author: { id: string; username: string | null; fullName: string | null };
};

export type CardDifficulty = 'easy' | 'medium' | 'hard';
export type CardType = 'basic' | 'cloze' | 'image';

export type PublicCard = {
    id: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    reading: string | null;
    partOfSpeech: string | null;
    example: string | null;
    exampleTranslation: string | null;
    tags: string[];
    difficulty: CardDifficulty;
    type: CardType;
    audioUrl: string | null;
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

// .apkg imports keep the original Anki data under `sourceData.anki`.
const importedFrom = (sourceData: DeckModel['sourceData']): 'anki' | null =>
    sourceData !== null &&
    typeof sourceData === 'object' &&
    !Array.isArray(sourceData) &&
    'anki' in sourceData
        ? 'anki'
        : null;

export const toPublicDeck = (deck: DeckModel, stats?: DeckStats): PublicDeck => ({
    id: deck.id,
    ownerId: deck.authorId,
    title: deck.title,
    description: deck.description,
    sourceLanguage: deck.sourceLanguage,
    targetLanguage: deck.targetLanguage,
    isPublic: deck.isPublic,
    cardCount: deck.cardCount,
    coverColor: deck.coverColor,
    glyph: deck.glyph,
    // Every write path validates; the guard only covers a row a hand-run SQL
    // edit left invalid — never leak a non-taxonomy value.
    subject: isSubject(deck.subject) ? deck.subject : 'other',
    featured: deck.featured,
    copyCount: deck.copyCount,
    sourceDeckId: deck.sourceDeckId,
    importedFrom: importedFrom(deck.sourceData),
    stats: stats ?? zeroStats(deck.cardCount),
    createdAt: deck.createdAt.toISOString(),
    updatedAt: deck.updatedAt.toISOString(),
});

export const toPublicDeckWithAuthor = (
    deck: DeckModel & { author: { id: string; username: string | null; fullName: string | null } },
    stats?: DeckStats,
): PublicDeckWithAuthor => ({
    ...toPublicDeck(deck, stats),
    author: deck.author,
});

export const toPublicCard = (card: CardModel): PublicCard => ({
    id: card.id,
    deckId: card.deckId,
    word: card.word,
    definition: card.definition,
    phonetic: card.phonetic,
    reading: card.reading,
    partOfSpeech: card.partOfSpeech,
    example: card.example,
    exampleTranslation: card.exampleTranslation,
    tags: card.tags,
    difficulty: card.difficulty as CardDifficulty,
    type: card.type as CardType,
    audioUrl: card.audioUrl,
    imageUrl: card.imageUrl,
    position: card.position,
    createdAt: card.createdAt.toISOString(),
    updatedAt: card.updatedAt.toISOString(),
});

// `GET /library` item: a deck with its author, the REQUESTER's stats, and how
// far the requester got in it.
export type PublicLibraryDeck = PublicDeckWithAuthor & {
    isOwner: boolean;
    studiedCount: number;
    lastStudiedAt: string | null;
};

export const toLibraryDeck = (
    deck: DeckModel & { author: { id: string; username: string | null; fullName: string | null } },
    viewerId: string,
    stats: DeckStats | undefined,
    progress: { studiedCount: number | null; lastStudiedAt: Date | null },
): PublicLibraryDeck => ({
    ...toPublicDeckWithAuthor(deck, stats),
    isOwner: deck.authorId === viewerId,
    studiedCount: progress.studiedCount ?? 0,
    lastStudiedAt: progress.lastStudiedAt ? progress.lastStudiedAt.toISOString() : null,
});
