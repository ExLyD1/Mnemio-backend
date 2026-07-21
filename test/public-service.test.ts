import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as discoverRepo from '../src/repositories/discover.repository.js';
import * as cardsRepo from '../src/repositories/cards.repository.js';
import {
    getPublicDeck,
    listPublicDecks,
    publicCategories,
    sitemapDecks,
} from '../src/services/public.service.js';
import { NotFoundError } from '../src/shared/errors.js';

vi.mock('../src/repositories/discover.repository.js', () => ({
    listPublicDecks: vi.fn(),
    countPublicDecks: vi.fn(),
    categories: vi.fn(),
    findPublicDeckById: vi.fn(),
    listAllPublicDeckIds: vi.fn(),
}));
vi.mock('../src/repositories/cards.repository.js', () => ({
    listAllCardsForDeck: vi.fn(),
}));

const mDisc = vi.mocked(discoverRepo);
const mCards = vi.mocked(cardsRepo);

const deckRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'deck-1',
    authorId: 'user-1',
    title: 'Spanish basics',
    description: '',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    isPublic: true,
    cardCount: 10,
    coverColor: null,
    glyph: null,
    subject: 'languages',
    featured: false,
    copyCount: 0,
    sourceDeckId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-10T00:00:00Z'),
    author: { id: 'user-1', username: 'alice', fullName: 'Alice' },
    ...overrides,
});

beforeEach(() => {
    vi.resetAllMocks();
});

describe('public.service / listPublicDecks', () => {
    it('returns PageWithTotal shape and stats are neutral (no viewer)', async () => {
        mDisc.listPublicDecks.mockResolvedValue([deckRow() as never]);
        mDisc.countPublicDecks.mockResolvedValue(1);

        const r = await listPublicDecks({});
        expect(r.total).toBe(1);
        expect(r.items).toHaveLength(1);
        // No per-user mastery in a no-viewer call.
        expect(r.items[0]?.stats.mastered).toBe(0);
        expect(r.items[0]?.stats.learning).toBe(0);
        expect(r.items[0]?.stats.due).toBe(0);
    });

    it('emits a nextCursor only when the repo returned limit+1 rows', async () => {
        mDisc.listPublicDecks.mockResolvedValue([deckRow(), deckRow({ id: 'd2' })] as never);
        mDisc.countPublicDecks.mockResolvedValue(2);

        const r = await listPublicDecks({ limit: 1 });
        expect(r.items).toHaveLength(1);
        expect(r.nextCursor).not.toBeNull();
    });
});

describe('public.service / publicCategories', () => {
    it('passes the repo result through unchanged', async () => {
        mDisc.categories.mockResolvedValue([{ subject: 'languages', count: 12 }]);
        const r = await publicCategories();
        expect(r.items).toEqual([{ subject: 'languages', count: 12 }]);
    });
});

describe('public.service / getPublicDeck', () => {
    it('returns deck + inline cards on a public deck', async () => {
        mDisc.findPublicDeckById.mockResolvedValue(deckRow() as never);
        mCards.listAllCardsForDeck.mockResolvedValue([
            {
                id: 'c1',
                deckId: 'deck-1',
                userId: 'user-1',
                word: 'agua',
                definition: 'water',
                phonetic: null,
                reading: null,
                partOfSpeech: null,
                example: null,
                exampleTranslation: null,
                tags: [],
                difficulty: 'medium',
                type: 'basic',
                audioUrl: null,
                imageUrl: null,
                position: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ] as never);

        const r = await getPublicDeck('deck-1');
        expect(r.deck.id).toBe('deck-1');
        expect(r.cards).toHaveLength(1);
        expect(r.cards[0]?.word).toBe('agua');
    });

    it('throws DECK_NOT_FOUND when the deck is private/missing', async () => {
        mDisc.findPublicDeckById.mockResolvedValue(null);
        await expect(getPublicDeck('whatever')).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('public.service / sitemapDecks', () => {
    it('returns id + ISO updatedAt only, ordered by the repo', async () => {
        mDisc.listAllPublicDeckIds.mockResolvedValue([
            { id: 'd1', updatedAt: new Date('2026-06-10T00:00:00Z') },
            { id: 'd2', updatedAt: new Date('2026-06-01T00:00:00Z') },
        ] as never);
        const r = await sitemapDecks();
        expect(r.items).toEqual([
            { id: 'd1', updatedAt: '2026-06-10T00:00:00.000Z' },
            { id: 'd2', updatedAt: '2026-06-01T00:00:00.000Z' },
        ]);
    });

    it('returns an empty array when no public decks exist (no crash)', async () => {
        mDisc.listAllPublicDeckIds.mockResolvedValue([]);
        const r = await sitemapDecks();
        expect(r.items).toEqual([]);
    });
});
