import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    runCreateDeck,
    runAddCards,
    resolveDeckLanguages,
    type UserLanguages,
} from '../src/services/chat.tools.js';
import * as aiService from '../src/services/ai.service.js';
import * as decksService from '../src/services/decks.service.js';
import * as cardsService from '../src/services/cards.service.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
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

const mAi = vi.mocked(aiService);
const mDecks = vi.mocked(decksService);
const mCards = vi.mocked(cardsService);
const mDecksRepo = vi.mocked(decksRepo);

const langs = (native: string | null, learning: string[] = []): UserLanguages => ({
    native,
    learning,
});
// Ukrainian speaker learning Spanish — the default profile for these tests.
const UK_ES = langs('uk', ['es']);

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
        const r = await runCreateDeck('u1', {}, UK_ES);
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toMatch(/topic.*words/i);
        expect(mAi.enrichWords).not.toHaveBeenCalled();
        expect(mAi.generateDeck).not.toHaveBeenCalled();
    });

    it('refuses when words is an empty array', async () => {
        const r = await runCreateDeck('u1', { words: [] }, UK_ES);
        expect(r.ok).toBe(false);
    });

    it('refuses when topic is just whitespace', async () => {
        const r = await runCreateDeck('u1', { topic: '   ' }, UK_ES);
        expect(r.ok).toBe(false);
    });
});

describe('chat.tools / resolveDeckLanguages', () => {
    it('uses native → definitions and the single learning language → words', () => {
        expect(resolveDeckLanguages({ userLangs: langs('uk', ['en']), locale: 'uk' })).toEqual({
            ok: true,
            sourceLanguage: 'uk',
            targetLanguage: 'en',
        });
    });

    it('native language beats the app locale for definitions', () => {
        expect(resolveDeckLanguages({ userLangs: langs('uk', ['de']), locale: 'en' })).toEqual({
            ok: true,
            sourceLanguage: 'uk',
            targetLanguage: 'de',
        });
    });

    it('falls back to the locale, then en, when native is not set', () => {
        const withLocale = resolveDeckLanguages({ userLangs: langs(null, ['de']), locale: 'uk' });
        expect(withLocale).toMatchObject({ sourceLanguage: 'uk' });
        const bare = resolveDeckLanguages({ userLangs: langs(null, ['de']) });
        expect(bare).toMatchObject({ sourceLanguage: 'en' });
    });

    it('asks instead of guessing when several learning languages remain', () => {
        expect(resolveDeckLanguages({ userLangs: langs('uk', ['en', 'de']) })).toEqual({
            ok: false,
            reason: 'WORDS_LANGUAGE_AMBIGUOUS',
            details: { options: ['en', 'de'] },
        });
    });

    it('asks instead of guessing when no learning language is set (no en/es fallback)', () => {
        expect(resolveDeckLanguages({ userLangs: langs('en'), locale: 'en' })).toEqual({
            ok: false,
            reason: 'WORDS_LANGUAGE_NEEDED',
            details: {},
        });
    });

    it('never picks the definitions language as the words language', () => {
        // Learning list contains the native language by mistake — skip it.
        expect(resolveDeckLanguages({ userLangs: langs('uk', ['uk', 'en']) })).toMatchObject({
            ok: true,
            sourceLanguage: 'uk',
            targetLanguage: 'en',
        });
        // Definitions explicitly English, the only learning language is English.
        expect(
            resolveDeckLanguages({ definitionsLanguage: 'en', userLangs: langs('uk', ['en']) }),
        ).toMatchObject({ ok: false, reason: 'WORDS_LANGUAGE_NEEDED' });
    });

    it('explicit languages win over the profile', () => {
        expect(
            resolveDeckLanguages({
                wordsLanguage: 'es',
                definitionsLanguage: 'pl',
                userLangs: langs('uk', ['en']),
                locale: 'uk',
            }),
        ).toEqual({ ok: true, sourceLanguage: 'pl', targetLanguage: 'es' });
    });

    it('normalizes explicit names and alias codes', () => {
        expect(
            resolveDeckLanguages({
                wordsLanguage: 'German',
                definitionsLanguage: 'ua',
                userLangs: langs(null),
            }),
        ).toEqual({ ok: true, sourceLanguage: 'uk', targetLanguage: 'de' });
    });

    it('rejects an unsupported explicit language instead of silently dropping it', () => {
        expect(
            resolveDeckLanguages({ wordsLanguage: 'Klingon', userLangs: langs('uk', ['en']) }),
        ).toEqual({
            ok: false,
            reason: 'UNSUPPORTED_LANGUAGE',
            details: { field: 'wordsLanguage', value: 'Klingon' },
        });
    });

    it('allows a same-language pair only when both sides are explicit', () => {
        expect(
            resolveDeckLanguages({
                wordsLanguage: 'en',
                definitionsLanguage: 'en',
                userLangs: langs('uk', ['en']),
            }),
        ).toEqual({ ok: true, sourceLanguage: 'en', targetLanguage: 'en' });
        // Model picked the user's own language as the words language.
        expect(
            resolveDeckLanguages({ wordsLanguage: 'uk', userLangs: langs('uk', ['en']) }),
        ).toEqual({ ok: false, reason: 'SAME_LANGUAGE_PAIR', details: { language: 'uk' } });
    });
});

describe('chat.tools / runCreateDeck — languages', () => {
    beforeEach(() => {
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'agua', definition: 'water' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);
    });

    it('uses profile languages when the model omits them', async () => {
        await runCreateDeck('u1', { words: ['agua'] }, langs('uk', ['pt']), 'en');
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'uk',
            targetLanguage: 'pt',
        });
    });

    it('maps the model-facing wordsLanguage/definitionsLanguage to target/source', async () => {
        await runCreateDeck(
            'u1',
            { words: ['agua'], wordsLanguage: 'ja', definitionsLanguage: 'en' },
            langs('uk', ['pt']),
        );
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', {
            words: ['agua'],
            sourceLanguage: 'en',
            targetLanguage: 'ja',
        });
    });

    it('returns a language failure (with details for the model) and creates nothing', async () => {
        const r = await runCreateDeck('u1', { topic: 'food' }, langs('uk', ['en', 'de']), 'uk');
        expect(r).toEqual({
            ok: false,
            reason: 'WORDS_LANGUAGE_AMBIGUOUS',
            details: { options: ['en', 'de'] },
        });
        expect(mAi.generateDeck).not.toHaveBeenCalled();
        expect(mDecks.create).not.toHaveBeenCalled();
    });
});

describe('chat.tools / runCreateDeck — words branch', () => {
    it('runs enrichWords → decks.create → cards.bulkCreate and returns the deck attachment', async () => {
        mAi.enrichWords.mockResolvedValue({
            cards: [
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ],
            meta: { requested: 2, enriched: 2, durationMs: 0, tokensInput: 10, tokensOutput: 4 },
        } as never);
        mDecks.create.mockResolvedValue(
            fakeDeck({
                id: 'deck-42',
                title: 'Spanish vocabulary',
                sourceLanguage: 'uk',
                targetLanguage: 'es',
            }),
        );

        const r = await runCreateDeck('u1', { words: ['agua', 'pan'] }, UK_ES);

        expect(r.ok).toBe(true);
        expect((r as { ok: true; attachment: unknown }).attachment).toEqual({
            type: 'deck',
            deckId: 'deck-42',
            title: 'Spanish vocabulary',
            cardCount: 2,
            action: 'created',
            sourceLanguage: 'uk',
            targetLanguage: 'es',
        });
        expect(mDecks.create).toHaveBeenCalledWith('u1', expect.objectContaining({
            title: 'Spanish vocabulary',
            sourceLanguage: 'uk',
            targetLanguage: 'es',
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
        await runCreateDeck('u1', { words: ['agua'], title: 'Spanish basics' }, UK_ES);
        expect(mDecks.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ title: 'Spanish basics' }),
        );
    });
});

describe('chat.tools / runCreateDeck — topic branch', () => {
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

        const r = await runCreateDeck('u1', { topic: 'Spanish café vocabulary', count: 2 }, UK_ES);

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
            sourceLanguage: 'en',
            targetLanguage: 'es',
        });
        expect((r as { ok: true; words: string[] }).words).toEqual(['café', 'leche']);
    });

    it('persists the resolved language pair, not the model\'s echo of it', async () => {
        mAi.generateDeck.mockResolvedValue({
            title: 'Школа',
            description: '',
            // Model misread "uk" as UK English and echoed en/en.
            sourceLanguage: 'en',
            targetLanguage: 'en',
            cards: [{ word: 'school', definition: 'заклад освіти' }],
        } as never);
        mDecks.create.mockResolvedValue(fakeDeck({ id: 'deck-9', title: 'Школа' }));

        await runCreateDeck('u1', { topic: 'school' }, langs(null, ['en']), 'uk');

        expect(mDecks.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ sourceLanguage: 'uk', targetLanguage: 'en' }),
        );
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

        const r = await runCreateDeck('u1', { topic: 'river parrots', count: 2 }, UK_ES);

        expect(mAi.generateDeck).toHaveBeenCalledTimes(2);
        expect(r.ok).toBe(true);
        expect((r as { ok: true; words: string[] }).words).toEqual(['a', 'b']);
    });
});

describe('chat.tools / runCreateDeck — error surface', () => {
    it('returns { ok:false, reason: AppError.code } on a known AppError', async () => {
        mAi.enrichWords.mockRejectedValue(new AiBudgetExceededError('enrich', 5));
        const r = await runCreateDeck('u1', { words: ['agua'] }, UK_ES);
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toBe('AI_BUDGET_EXCEEDED');
    });

    it('returns { ok:false, reason: "INTERNAL" } on an unknown error', async () => {
        mAi.enrichWords.mockRejectedValue(new Error('database imploded'));
        const r = await runCreateDeck('u1', { words: ['agua'] }, UK_ES);
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
            sourceLanguage: 'en',
            targetLanguage: 'fr',
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
