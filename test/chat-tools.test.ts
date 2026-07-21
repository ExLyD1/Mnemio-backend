import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCreateDeck, runAddCards } from '../src/services/chat.tools.js';
import * as aiService from '../src/services/ai.service.js';
import * as decksService from '../src/services/decks.service.js';
import * as cardsService from '../src/services/cards.service.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import * as prefsRepo from '../src/repositories/preferences.repository.js';
import { AiBudgetExceededError } from '../src/shared/errors.js';

vi.mock('../src/services/ai.service.js', () => ({
    enrichWords: vi.fn(),
    generateDeck: vi.fn(),
}));
vi.mock('../src/services/decks.service.js', () => ({
    create: vi.fn(),
}));
vi.mock('../src/services/cards.service.js', () => ({
    bulkCreate: vi.fn(),
}));
vi.mock('../src/repositories/decks.repository.js', () => ({
    findDeckById: vi.fn(),
}));
vi.mock('../src/repositories/preferences.repository.js', () => ({
    findOrCreate: vi.fn(),
}));

const mAi = vi.mocked(aiService);
const mDecks = vi.mocked(decksService);
const mCards = vi.mocked(cardsService);
const mDecksRepo = vi.mocked(decksRepo);
const mPrefs = vi.mocked(prefsRepo);

const fakePref = (overrides: Record<string, unknown> = {}) =>
    ({
        userId: 'u1',
        interests: [],
        goal: null,
        nativeLanguage: null,
        learningLanguages: [],
        avatarHue: null,
        mimiPlacement: null,
        favorites: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }) as never;

const fakeDeck = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'deck-1',
        ownerId: 'u1',
        title: 'Created deck',
        description: '',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        isPublic: false,
        cardCount: 0,
        coverColor: null,
        glyph: null,
        subject: null,
        featured: false,
        copyCount: 0,
        sourceDeckId: null,
        stats: { total: 0, mastered: 0, learning: 0, new: 0, due: 0, masteredPct: 0 },
        createdAt: '2026-06-10T00:00:00.000Z',
        updatedAt: '2026-06-10T00:00:00.000Z',
        ...overrides,
    }) as never;

beforeEach(() => {
    vi.resetAllMocks();
    mDecks.create.mockResolvedValue(fakeDeck());
    mCards.bulkCreate.mockResolvedValue({ created: 0 } as never);
});

describe('chat.tools / runCreateDeck — input validation', () => {
    it('refuses when neither topic nor words is provided', async () => {
        const r = await runCreateDeck('u1', {});
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toMatch(/topic.*words/i);
        expect(mAi.enrichWords).not.toHaveBeenCalled();
        expect(mAi.generateDeck).not.toHaveBeenCalled();
    });

    it('refuses when words is an empty array', async () => {
        const r = await runCreateDeck('u1', { words: [] });
        expect(r.ok).toBe(false);
    });

    it('refuses when topic is just whitespace', async () => {
        const r = await runCreateDeck('u1', { topic: '   ' });
        expect(r.ok).toBe(false);
    });
});

describe('chat.tools / runCreateDeck — language defaults', () => {
    beforeEach(() => {
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'agua', definition: 'water' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);
    });

    it('uses preference languages when input omits them', async () => {
        mPrefs.findOrCreate.mockResolvedValue(
            fakePref({ nativeLanguage: 'uk', learningLanguages: ['pt'] }),
        );
        await runCreateDeck('u1', { words: ['agua'] });
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'uk',
            targetLanguage: 'pt',
        });
    });

    it('falls back to en→es when preferences are empty', async () => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
        await runCreateDeck('u1', { words: ['agua'] });
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'en',
            targetLanguage: 'es',
        });
    });

    it('explicit input languages override preferences', async () => {
        mPrefs.findOrCreate.mockResolvedValue(
            fakePref({ nativeLanguage: 'uk', learningLanguages: ['pt'] }),
        );
        await runCreateDeck('u1', {
            words: ['agua'],
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        });
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        });
    });

    it('defaults source to the chat locale, and target falls back to it too when prefs are empty', async () => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
        await runCreateDeck('u1', { words: ['слово'] }, 'uk');
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['слово'],
            sourceLanguage: 'uk',
            targetLanguage: 'uk',
        });
    });

    it('locale sets the source but the learning-language preference still wins for target', async () => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref({ learningLanguages: ['fr'] }));
        await runCreateDeck('u1', { words: ['слово'] }, 'uk');
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['слово'],
            sourceLanguage: 'uk',
            targetLanguage: 'fr',
        });
    });

    it('an explicit model-provided language pair overrides the locale', async () => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
        await runCreateDeck(
            'u1',
            { words: ['palavra'], sourceLanguage: 'es', targetLanguage: 'pt' },
            'uk',
        );
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['palavra'],
            sourceLanguage: 'es',
            targetLanguage: 'pt',
        });
    });

    it('normalizes full language names / region tags to ISO codes', async () => {
        mPrefs.findOrCreate.mockResolvedValue(
            fakePref({ nativeLanguage: 'English', learningLanguages: ['uk-UA'] }),
        );
        await runCreateDeck('u1', { words: ['agua'] });
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'en',
            targetLanguage: 'uk',
        });
    });
});

describe('chat.tools / runCreateDeck — words branch', () => {
    beforeEach(() => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
    });

    it('runs enrichWords → decks.create → cards.bulkCreate and returns the deck attachment', async () => {
        mAi.enrichWords.mockResolvedValue({
            cards: [
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ],
            meta: { requested: 2, enriched: 2, durationMs: 0, tokensInput: 10, tokensOutput: 4 },
        } as never);
        mDecks.create.mockResolvedValue(
            fakeDeck({ id: 'deck-42', title: 'ES vocabulary' }),
        );

        const r = await runCreateDeck('u1', { words: ['agua', 'pan'] });

        expect(r.ok).toBe(true);
        expect((r as { ok: true; attachment: unknown }).attachment).toEqual({
            type: 'deck',
            deckId: 'deck-42',
            title: 'ES vocabulary',
            cardCount: 2,
            action: 'created',
        });
        expect(mDecks.create).toHaveBeenCalledWith('u1', expect.objectContaining({
            title: 'ES vocabulary',
        }));
        expect(mCards.bulkCreate).toHaveBeenCalledWith(
            'u1',
            'deck-42',
            expect.objectContaining({
                cards: expect.arrayContaining([
                    expect.objectContaining({ word: 'agua', definition: 'water' }),
                ]),
            }),
        );
        expect((r as { ok: true; words: string[] }).words).toEqual(['agua', 'pan']);
    });

    it('prefers the explicit input.title when given', async () => {
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'agua', definition: 'water' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);
        await runCreateDeck('u1', { words: ['agua'], title: 'Spanish basics' });
        expect(mDecks.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ title: 'Spanish basics' }),
        );
    });
});

describe('chat.tools / runCreateDeck — topic branch', () => {
    beforeEach(() => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
    });

    it('calls generateDeck and persists the returned draft', async () => {
        mAi.generateDeck.mockResolvedValue({
            title: 'Spanish café',
            description: 'Café vocabulary.',
            sourceLanguage: 'en',
            targetLanguage: 'es',
            cards: [
                { word: 'café', definition: 'coffee' },
                { word: 'leche', definition: 'milk' },
            ],
        } as never);
        mDecks.create.mockResolvedValue(
            fakeDeck({ id: 'deck-7', title: 'Spanish café' }),
        );

        const r = await runCreateDeck('u1', { topic: 'Spanish café vocabulary', count: 2 });

        expect(r.ok).toBe(true);
        expect(mAi.generateDeck).toHaveBeenCalledWith('u1', expect.objectContaining({
            topic: 'Spanish café vocabulary',
            count: 2,
        }));
        expect((r as { ok: true; attachment: unknown }).attachment).toEqual({
            type: 'deck',
            deckId: 'deck-7',
            title: 'Spanish café',
            cardCount: 2,
            action: 'created',
        });
        expect((r as { ok: true; words: string[] }).words).toEqual(['café', 'leche']);
    });

    it('retries once when the first draft fails the count sanity check, then persists the retry', async () => {
        mAi.generateDeck
            .mockResolvedValueOnce({
                title: 'Rivers',
                description: '',
                sourceLanguage: 'en',
                targetLanguage: 'es',
                cards: [],
            } as never)
            .mockResolvedValueOnce({
                title: 'Rivers',
                description: '',
                sourceLanguage: 'en',
                targetLanguage: 'es',
                cards: [
                    { word: 'a', definition: '1' },
                    { word: 'b', definition: '2' },
                ],
            } as never);
        mDecks.create.mockResolvedValue(fakeDeck({ id: 'deck-8', title: 'Rivers' }));

        const r = await runCreateDeck('u1', { topic: 'river parrots', count: 2 });

        expect(mAi.generateDeck).toHaveBeenCalledTimes(2);
        expect(r.ok).toBe(true);
        expect((r as { ok: true; words: string[] }).words).toEqual(['a', 'b']);
    });
});

describe('chat.tools / runCreateDeck — error surface', () => {
    beforeEach(() => {
        mPrefs.findOrCreate.mockResolvedValue(fakePref());
    });

    it('returns { ok:false, reason: AppError.code } on a known AppError', async () => {
        mAi.enrichWords.mockRejectedValue(new AiBudgetExceededError('enrich', 5));
        const r = await runCreateDeck('u1', { words: ['agua'] });
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toBe('AI_BUDGET_EXCEEDED');
    });

    it('returns { ok:false, reason: "INTERNAL" } on an unknown error', async () => {
        mAi.enrichWords.mockRejectedValue(new Error('database imploded'));
        const r = await runCreateDeck('u1', { words: ['agua'] });
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toBe('INTERNAL');
    });
});

const fakeDeckRow = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'deck-99',
        authorId: 'u1',
        title: 'My Spanish deck',
        description: '',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        isPublic: false,
        cardCount: 5,
        coverColor: null,
        glyph: null,
        subject: null,
        featured: false,
        copyCount: 0,
        sourceDeckId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }) as never;

describe('chat.tools / runAddCards — append to an existing deck', () => {
    it('uses the DECK\'s languages, appends via bulkCreate, returns an appended attachment', async () => {
        // 1st call = ownership + languages; 2nd = fresh cardCount after append.
        mDecksRepo.findDeckById
            .mockResolvedValueOnce(fakeDeckRow({ sourceLanguage: 'en', targetLanguage: 'fr', cardCount: 5 }))
            .mockResolvedValueOnce(fakeDeckRow({ sourceLanguage: 'en', targetLanguage: 'fr', cardCount: 7 }));
        mAi.enrichWords.mockResolvedValue({
            cards: [
                { word: 'eau', definition: 'water' },
                { word: 'pain', definition: 'bread' },
            ],
            meta: { requested: 2, enriched: 2, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);

        const r = await runAddCards('u1', 'deck-99', { words: ['eau', 'pain'] });

        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['eau', 'pain'],
            sourceLanguage: 'en',
            targetLanguage: 'fr', // the deck's languages, not user prefs
        });
        expect(mCards.bulkCreate).toHaveBeenCalledWith('u1', 'deck-99', expect.any(Object));
        expect(r.ok).toBe(true);
        expect((r as { ok: true; attachment: unknown }).attachment).toEqual({
            type: 'deck',
            deckId: 'deck-99',
            title: 'My Spanish deck',
            cardCount: 7,
            action: 'appended',
            addedCount: 2,
        });
    });

    it('returns DECK_NOT_FOUND when the deck is not owned / missing (no AI call)', async () => {
        mDecksRepo.findDeckById.mockResolvedValue(null);
        const r = await runAddCards('u1', 'deck-x', { words: ['eau'] });
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toBe('DECK_NOT_FOUND');
        expect(mAi.enrichWords).not.toHaveBeenCalled();
        expect(mCards.bulkCreate).not.toHaveBeenCalled();
    });

    it('returns NEEDS_WORDS_OR_TOPIC when neither words nor topic is given', async () => {
        const r = await runAddCards('u1', 'deck-99', {});
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toBe('NEEDS_WORDS_OR_TOPIC');
        expect(mDecksRepo.findDeckById).not.toHaveBeenCalled();
    });
});
