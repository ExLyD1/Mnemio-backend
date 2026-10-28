import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as srsRepo from '../src/repositories/srs.repository.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import { queue } from '../src/services/srs.service.js';
import { queueQuerySchema } from '../src/schemas/srs.schema.js';
import { SRS_DEFAULTS } from '../src/services/srs-engine.js';

vi.mock('../src/repositories/srs.repository.js', async () => {
    const actual = await vi.importActual<typeof srsRepo>('../src/repositories/srs.repository.js');
    return {
        ...actual,
        queueData: vi.fn(),
        newIntroducedToday: vi.fn(),
        nextFutureDue: vi.fn(),
    };
});
vi.mock('../src/repositories/decks.repository.js', async () => {
    const actual = await vi.importActual<typeof decksRepo>(
        '../src/repositories/decks.repository.js',
    );
    return { ...actual, findReadableDeckIds: vi.fn(), findDeckByIdUnscoped: vi.fn() };
});

const mockedSrs = vi.mocked(srsRepo);
const mockedDecks = vi.mocked(decksRepo);

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const card = (id: string, deckId: string) => ({
    id,
    userId: 'author',
    deckId,
    word: id,
    definition: 'def',
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
    sourceData: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deck: { id: deckId, title: `Deck ${deckId.slice(-1)}` },
});

const progress = (cardId: string, deckId: string) => ({
    userId: 'u1',
    cardId,
    interval: 3,
    easeFactor: 2.5,
    repetitions: 2,
    state: 'review',
    remainingSteps: 0,
    lapses: 0,
    leeched: false,
    reps: 2,
    learningStepSecs: 0,
    nextReviewAt: new Date(Date.now() - 60_000),
    lastReviewedAt: new Date(Date.now() - 3 * 86_400_000),
    masteredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    card: card(cardId, deckId),
});

const parse = (q: Record<string, string>) => queueQuerySchema.parse(q);

describe('srs.service / queue with deckIds', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSrs.newIntroducedToday.mockResolvedValue(4);
        mockedSrs.nextFutureDue.mockResolvedValue(null);
        mockedSrs.queueData.mockResolvedValue({
            dueLearning: [],
            reviews: [progress('c1', A), progress('c2', B)],
            learnAhead: [],
            newCards: [],
            newTotal: 0,
        } as never);
    });

    it('narrows every query to the selected decks and ignores extraNew', async () => {
        mockedDecks.findReadableDeckIds.mockResolvedValue([A, B]);
        const res = await queue('u1', parse({ deckIds: `${A},${B}`, extraNew: '50' }));

        expect(mockedDecks.findReadableDeckIds).toHaveBeenCalledWith('u1', [A, B]);
        const [, scope, , , newLimit, reviewLimit] = mockedSrs.queueData.mock.calls[0]!;
        expect(scope).toEqual([A, B]);
        expect(newLimit).toBe(SRS_DEFAULTS.newPerDay - 4);
        expect(reviewLimit).toBe(SRS_DEFAULTS.reviewsPerDay);
        expect(mockedSrs.newIntroducedToday.mock.calls[0]![1]).toEqual([A, B]);
        expect(mockedSrs.nextFutureDue.mock.calls[0]![1]).toEqual([A, B]);
        expect(mockedDecks.findDeckByIdUnscoped).not.toHaveBeenCalled();
        expect(res.items.map((i) => i.deckId)).toEqual([A, B]);
        expect(res.counts.new).toBe(0);
    });

    it('passes the limit through to the review cap', async () => {
        mockedDecks.findReadableDeckIds.mockResolvedValue([A]);
        await queue('u1', parse({ deckIds: A, limit: '500' }));
        expect(mockedSrs.queueData.mock.calls[0]![5]).toBe(500);
    });

    it('404s when any selected deck is missing or private-not-owned', async () => {
        // findReadableDeckIds drops both missing and private-not-owned decks.
        mockedDecks.findReadableDeckIds.mockResolvedValue([A]);
        await expect(queue('u1', parse({ deckIds: `${A},${B}` }))).rejects.toMatchObject({
            code: 'DECK_NOT_FOUND',
            statusCode: 404,
        });
        expect(mockedSrs.queueData).not.toHaveBeenCalled();
    });

    it("allows someone else's public deck", async () => {
        mockedDecks.findReadableDeckIds.mockResolvedValue([B]);
        await expect(queue('u1', parse({ deckIds: B }))).resolves.toBeDefined();
    });

    it('keeps the single-deck path on its existing access check', async () => {
        mockedDecks.findDeckByIdUnscoped.mockResolvedValue({
            id: A,
            authorId: 'other',
            isPublic: false,
        } as never);
        await expect(queue('u1', parse({ deckId: A }))).rejects.toMatchObject({
            code: 'CARD_FORBIDDEN',
        });
        expect(mockedDecks.findReadableDeckIds).not.toHaveBeenCalled();
    });

    it('unscoped: no deck lookups, undefined scope', async () => {
        await queue('u1', parse({}));
        expect(mockedSrs.queueData.mock.calls[0]![1]).toBeUndefined();
        expect(mockedDecks.findReadableDeckIds).not.toHaveBeenCalled();
    });
});

describe('srs.repository / accessibleCardScope', () => {
    const access = { OR: [{ authorId: 'u1' }, { isPublic: true }] };

    it('single deck: that deck, new cards reachable', () => {
        expect(srsRepo.accessibleCardScope('u1', A)).toEqual({ deck: access, deckId: A });
    });

    it('deck set: those decks, progress rows only', () => {
        expect(srsRepo.accessibleCardScope('u1', [A, B])).toEqual({
            deck: access,
            deckId: { in: [A, B] },
            cardProgresses: { some: { userId: 'u1' } },
        });
    });

    it('unscoped: every accessible deck with progress', () => {
        expect(srsRepo.accessibleCardScope('u1', undefined)).toEqual({
            deck: access,
            cardProgresses: { some: { userId: 'u1' } },
        });
    });
});
