import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as decksRepo from '../src/repositories/decks.repository.js';
import * as cardsRepo from '../src/repositories/cards.repository.js';
import * as deckStatsRepo from '../src/repositories/deck-stats.repository.js';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as srsRepo from '../src/repositories/srs.repository.js';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as achievementsService from '../src/services/achievements.service.js';
import * as milestone from '../src/services/milestone.service.js';
import * as decksService from '../src/services/decks.service.js';
import * as sessionsService from '../src/services/sessions.service.js';
import * as srsService from '../src/services/srs.service.js';
import { NotFoundError, ForbiddenError } from '../src/shared/errors.js';

vi.mock('../src/repositories/decks.repository.js', () => ({
    findDeckByIdUnscoped: vi.fn(),
    findDeckById: vi.fn(),
}));
vi.mock('../src/repositories/cards.repository.js', () => ({
    listAllCardsForDeck: vi.fn(),
    findCardWithOwner: vi.fn(),
}));
vi.mock('../src/repositories/deck-stats.repository.js', () => ({
    aggregateDeckStats: vi.fn(),
}));
vi.mock('../src/repositories/sessions.repository.js', () => ({
    listDeckCardIds: vi.fn(),
    startSession: vi.fn(),
}));
vi.mock('../src/repositories/srs.repository.js', () => ({
    findProgress: vi.fn(),
    upsertProgress: vi.fn(),
}));
vi.mock('../src/repositories/activity.repository.js', () => ({
    recordReview: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/services/achievements.service.js', () => ({
    evaluate: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/services/milestone.service.js', () => ({
    checkFirstReview: vi.fn(),
}));

const mDecks = vi.mocked(decksRepo);
const mCards = vi.mocked(cardsRepo);
const mStats = vi.mocked(deckStatsRepo);
const mSessions = vi.mocked(sessionsRepo);
const mSrs = vi.mocked(srsRepo);

const OWNER = 'owner-1';
const VIEWER = 'viewer-2';

const deckRow = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'deck-1',
        authorId: OWNER,
        title: 'Spanish',
        description: '',
        sourceLanguage: 'en',
        targetLanguage: 'es',
        isPublic: true,
        cardCount: 3,
        coverColor: null,
        glyph: null,
        subject: null,
        featured: false,
        copyCount: 0,
        sourceDeckId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('decks.service.getOne — public-deck read access', () => {
    beforeEach(() => {
        mCards.listAllCardsForDeck.mockResolvedValue([]);
        mStats.aggregateDeckStats.mockResolvedValue([
            { deckId: 'deck-1', mastered: 1, learning: 0, due: 0 },
        ]);
    });

    it('returns role=owner for the deck owner', async () => {
        mDecks.findDeckByIdUnscoped.mockResolvedValue(deckRow({ authorId: OWNER }));
        const res = await decksService.getOne(OWNER, 'deck-1', {});
        expect(res.role).toBe('owner');
        expect(res.isOwner).toBe(true);
    });

    it('returns role=viewer for a non-owner on a PUBLIC deck, with the viewer’s stats', async () => {
        mDecks.findDeckByIdUnscoped.mockResolvedValue(deckRow({ authorId: OWNER, isPublic: true }));
        const res = await decksService.getOne(VIEWER, 'deck-1', {});
        expect(res.role).toBe('viewer');
        expect(res.isOwner).toBe(false);
        // Stats are computed for the requesting VIEWER, never the owner.
        expect(mStats.aggregateDeckStats).toHaveBeenCalledWith(VIEWER, ['deck-1']);
    });

    it('404s for a non-owner on a PRIVATE deck (no leak)', async () => {
        mDecks.findDeckByIdUnscoped.mockResolvedValue(deckRow({ authorId: OWNER, isPublic: false }));
        await expect(decksService.getOne(VIEWER, 'deck-1', {})).rejects.toBeInstanceOf(NotFoundError);
    });
});

describe('sessions.service.start — public-deck study', () => {
    beforeEach(() => {
        mSessions.listDeckCardIds.mockResolvedValue([{ id: 'card-1' }, { id: 'card-2' }]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mSessions.startSession.mockResolvedValue({
            id: 'sess-1',
            userId: VIEWER,
            deckId: 'deck-1',
            mode: 'study',
            status: 'active',
            cardIds: ['card-1', 'card-2'],
            cardIndex: 0,
            correct: 0,
            xpAwarded: 0,
            cardsStudied: 0,
            correctAnswers: 0,
            countsAgain: 0,
            countsHard: 0,
            countsGood: 0,
            countsEasy: 0,
            revisitCardIds: [],
            durationMs: 0,
            startedAt: new Date('2026-01-01T00:00:00Z'),
            endedAt: null,
            completedAt: new Date('2026-01-01T00:00:00Z'),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
    });

    it('lets a non-owner start a session on a PUBLIC deck (session belongs to them)', async () => {
        mDecks.findDeckByIdUnscoped.mockResolvedValue(deckRow({ authorId: OWNER, isPublic: true }));
        await sessionsService.start(VIEWER, { deckId: 'deck-1', mode: 'study' });
        expect(mSessions.startSession).toHaveBeenCalledWith(
            expect.objectContaining({ userId: VIEWER, deckId: 'deck-1' }),
        );
    });

    it('404s for a non-owner on a PRIVATE deck', async () => {
        mDecks.findDeckByIdUnscoped.mockResolvedValue(deckRow({ authorId: OWNER, isPublic: false }));
        await expect(
            sessionsService.start(VIEWER, { deckId: 'deck-1', mode: 'study' }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(mSessions.startSession).not.toHaveBeenCalled();
    });
});

describe('srs.service.rate — independent SRS on shared public decks', () => {
    const publicCard = (isPublic: boolean) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ({ id: 'card-1', deck: { authorId: OWNER, isPublic } }) as any;

    it('keys the viewer’s progress by their OWN userId on a public deck', async () => {
        mCards.findCardWithOwner.mockResolvedValue(publicCard(true));
        mSrs.findProgress.mockResolvedValue(null); // first review of this card
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mSrs.upsertProgress.mockImplementation(async (data: any) => ({
            ...data,
            nextReviewAt: data.nextReviewAt ?? new Date(),
            lastReviewedAt: data.lastReviewedAt ?? null,
        }));

        await srsService.rate(VIEWER, { cardId: 'card-1', rating: 'good' });

        // The progress row is written under the VIEWER, never the owner.
        expect(mSrs.upsertProgress).toHaveBeenCalledWith(
            expect.objectContaining({ userId: VIEWER, cardId: 'card-1' }),
        );
    });

    it('403s for a non-owner rating a card in a PRIVATE deck', async () => {
        mCards.findCardWithOwner.mockResolvedValue(publicCard(false));
        await expect(
            srsService.rate(VIEWER, { cardId: 'card-1', rating: 'good' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(mSrs.upsertProgress).not.toHaveBeenCalled();
    });
});
