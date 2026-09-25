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
import * as cardsRepo from '../src/repositories/cards.repository.js';
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
    listDeckTitles: vi.fn(),
}));
vi.mock('../src/repositories/cards.repository.js', () => ({
    listAllCardsForDeck: vi.fn(),
}));

const mAi = vi.mocked(aiService);
const mDecks = vi.mocked(decksService);
const mCards = vi.mocked(cardsService);
const mDecksRepo = vi.mocked(decksRepo);
const mCardsRepo = vi.mocked(cardsRepo);

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
    // Default: the deck is empty and the user owns no other decks, so neither
    // the duplicate filter nor the wrong-deck guard fires unless a test says so.
    mCardsRepo.listAllCardsForDeck.mockResolvedValue([] as never);
    mDecksRepo.listDeckTitles.mockResolvedValue([] as never);
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

// QA found cards landing in the deck that happened to be open while the reply
// said "Done!" without naming it. The tool now refuses instead, before it
// spends any AI budget or writes anything.
describe('chat.tools / runAddCards — wrong-deck guard', () => {
    const openDeck = () =>
        mDecksRepo.findDeckById.mockResolvedValue(
            fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits' }),
        );

    it('refuses when the model names a deck other than the open one', async () => {
        openDeck();
        const r = await runAddCards('u1', 'deck-99', {
            words: ['zebra'],
            deckTitle: 'QA-Animals',
        });
        expect(r).toMatchObject({
            ok: false,
            reason: 'DECK_MISMATCH',
            details: { openDeck: 'QA-Fruits', requestedDeck: 'QA-Animals' },
        });
        expect(mAi.enrichWords).not.toHaveBeenCalled();
        expect(mCards.bulkCreate).not.toHaveBeenCalled();
    });

    it("refuses when the user's own message names another deck they own", async () => {
        openDeck();
        mDecksRepo.listDeckTitles.mockResolvedValue([
            { id: 'deck-99', title: 'QA-Fruits' },
            { id: 'deck-7', title: 'QA-Animals' },
        ] as never);
        // The model omitted deckTitle (or echoed the open deck) — the message
        // itself is the second, independent check.
        const r = await runAddCards(
            'u1',
            'deck-99',
            { words: ['zebra'], deckTitle: 'QA-Fruits' },
            { userMessage: "Add 'zebra' and 'koala' to my QA-Animals deck" },
        );
        expect(r).toMatchObject({ ok: false, reason: 'DECK_MISMATCH' });
        expect(mCards.bulkCreate).not.toHaveBeenCalled();
    });

    it('allows the open deck through punctuation and case differences', async () => {
        mDecksRepo.findDeckById
            .mockResolvedValueOnce(fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits' }))
            .mockResolvedValueOnce(
                fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits', cardCount: 6 }),
            );
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'pear', definition: 'fruit' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);

        const r = await runAddCards(
            'u1',
            'deck-99',
            { words: ['pear'], deckTitle: '«qa fruits»' },
            { userMessage: 'add pear to this deck' },
        );
        expect(r.ok).toBe(true);
    });
});

describe('chat.tools / runAddCards — duplicates', () => {
    const deckWithApple = () => {
        mDecksRepo.findDeckById
            .mockResolvedValueOnce(fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits', cardCount: 1 }))
            .mockResolvedValueOnce(fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits', cardCount: 2 }));
        mCardsRepo.listAllCardsForDeck.mockResolvedValue([{ word: 'Apple ' }] as never);
    };

    it('skips a word already in the deck and reports it', async () => {
        deckWithApple();
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'peach', definition: 'fruit' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);

        const r = await runAddCards('u1', 'deck-99', {
            words: ['apple', 'peach'],
            deckTitle: 'QA-Fruits',
        });

        // Only the new word is sent for enrichment — no AI spend on a duplicate.
        expect(mAi.enrichWords).toHaveBeenCalledWith('u1', expect.objectContaining({
            words: ['peach'],
        }));
        expect(r).toMatchObject({
            ok: true,
            skipped: ['apple'],
            attachment: { addedCount: 1, skippedCount: 1 },
        });
    });

    it('writes nothing when every requested word is already there', async () => {
        mDecksRepo.findDeckById.mockResolvedValue(
            fakeDeckRow({ id: 'deck-99', title: 'QA-Fruits', cardCount: 1 }),
        );
        mCardsRepo.listAllCardsForDeck.mockResolvedValue([{ word: 'apple' }] as never);

        const r = await runAddCards('u1', 'deck-99', {
            words: ['apple', 'APPLE'],
            deckTitle: 'QA-Fruits',
        });

        expect(r).toMatchObject({ ok: false, reason: 'ALL_DUPLICATES' });
        expect(mAi.enrichWords).not.toHaveBeenCalled();
        expect(mCards.bulkCreate).not.toHaveBeenCalled();
    });

    it('tells the topic generator which words the deck already has', async () => {
        mDecksRepo.findDeckById
            .mockResolvedValueOnce(fakeDeckRow({ id: 'deck-99', cardCount: 2 }))
            .mockResolvedValueOnce(fakeDeckRow({ id: 'deck-99', cardCount: 4 }));
        mCardsRepo.listAllCardsForDeck.mockResolvedValue([
            { word: 'apple' },
            { word: 'pear' },
        ] as never);
        mAi.generateDeck.mockResolvedValue({
            title: 'more fruit',
            description: '',
            cards: [
                { word: 'apple', definition: 'dupe the model produced anyway' },
                { word: 'plum', definition: 'fruit' },
            ],
        } as never);

        const r = await runAddCards('u1', 'deck-99', {
            topic: 'more fruit',
            deckTitle: 'My Spanish deck',
        });

        expect(mAi.generateDeck).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ exclude: ['apple', 'pear'] }),
        );
        // The generator ignored the exclusion for 'apple'; the final net drops it.
        expect(r).toMatchObject({ ok: true, attachment: { addedCount: 1 } });
        expect((r as { words: string[] }).words).toEqual(['plum']);
    });
});

describe('chat.tools / failure details', () => {
    it('passes the cap and reset time to the model instead of a bare code', async () => {
        mDecksRepo.findDeckById.mockResolvedValue(fakeDeckRow({ id: 'deck-99' }));
        mAi.enrichWords.mockRejectedValue(
            new AiBudgetExceededError('enrich', 5, '2026-06-11T00:00:00.000Z'),
        );

        const r = await runAddCards('u1', 'deck-99', {
            words: ['pomme'],
            deckTitle: 'My Spanish deck',
        });

        expect(r).toMatchObject({
            ok: false,
            reason: 'AI_BUDGET_EXCEEDED',
            details: {
                kind: 'enrich',
                capPerDay: 5,
                resetsAt: '2026-06-11T00:00:00.000Z',
                // Nothing is retried in the background — the model used to
                // promise "try again in a moment" / "your request is queued".
                retryable: false,
            },
        });
    });
});

describe('chat.tools / deck title', () => {
    it("keeps the name the user quoted instead of the model's embellishment", async () => {
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'hola', definition: 'hello' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);

        await runCreateDeck(
            'u1',
            { words: ['hola'], title: 'Spanish vocabulary — QA-ES-PT' },
            UK_ES,
            'en',
            { userMessage: 'Deck "QA-ES-PT": 5 Spanish words with Portuguese definitions' },
        );

        expect(mDecks.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ title: 'QA-ES-PT' }),
        );
    });

    it('caps an over-long title rather than passing it straight to the DB', async () => {
        mAi.enrichWords.mockResolvedValue({
            cards: [{ word: 'hola', definition: 'hello' }],
            meta: { requested: 1, enriched: 1, durationMs: 0, tokensInput: 0, tokensOutput: 0 },
        } as never);

        await runCreateDeck('u1', { words: ['hola'], title: 'x'.repeat(300) }, UK_ES, 'en');

        const title = (mDecks.create.mock.calls[0]?.[1] as { title: string }).title;
        expect(title.length).toBeLessThanOrEqual(120);
    });
});
