import { describe, it, expect } from 'vitest';
import type { DeckModel } from '../generated/prisma/models/Deck.js';
import { toPublicDeck } from '../src/shared/mappers.deck.js';

const deck = (sourceData: DeckModel['sourceData']): DeckModel => ({
    id: 'd1',
    authorId: 'u1',
    title: 'Deck',
    description: '',
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    isPublic: false,
    cardCount: 0,
    sourceData,
    coverColor: null,
    glyph: null,
    subject: null,
    featured: false,
    copyCount: 0,
    sourceDeckId: null,
    createdAt: new Date('2026-10-19T00:00:00Z'),
    updatedAt: new Date('2026-10-19T00:00:00Z'),
});

describe('mappers.deck / importedFrom', () => {
    it('marks .apkg imports as anki and nothing else', () => {
        expect(toPublicDeck(deck({ anki: { deckId: 1 } })).importedFrom).toBe('anki');
        expect(toPublicDeck(deck(null)).importedFrom).toBeNull();
        expect(toPublicDeck(deck({ other: true })).importedFrom).toBeNull();
        expect(toPublicDeck(deck(['anki'])).importedFrom).toBeNull();
    });
});
