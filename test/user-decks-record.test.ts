import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as cardsRepo from '../src/repositories/cards.repository.js';
import * as srsRepo from '../src/repositories/srs.repository.js';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as userDecksRepo from '../src/repositories/user-decks.repository.js';
import { complete, updateProgress } from '../src/services/sessions.service.js';
import { rate } from '../src/services/srs.service.js';
import { trackStudied } from '../src/services/user-decks.service.js';

vi.mock('../src/repositories/sessions.repository.js', () => ({
    findSessionOwned: vi.fn(),
    updateProgress: vi.fn(),
    completeSession: vi.fn(),
    incrementUserXp: vi.fn(),
    hasCompletedInRun: vi.fn(),
}));
vi.mock('../src/repositories/cards.repository.js', () => ({ findCardWithOwner: vi.fn() }));
vi.mock('../src/repositories/srs.repository.js', () => ({
    findProgress: vi.fn(),
    upsertProgress: vi.fn(),
}));
vi.mock('../src/repositories/activity.repository.js', () => ({ recordReview: vi.fn() }));
vi.mock('../src/repositories/decks.repository.js', () => ({}));
vi.mock('../src/repositories/user-decks.repository.js', () => ({ recordStudied: vi.fn() }));
vi.mock('../src/services/achievements.service.js', () => ({
    evaluate: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../src/services/milestone.service.js', () => ({
    checkFirstSession: vi.fn(),
    checkFirstReview: vi.fn(),
}));

const mSessions = vi.mocked(sessionsRepo);
const mCards = vi.mocked(cardsRepo);
const mSrs = vi.mocked(srsRepo);
const mActivity = vi.mocked(activityRepo);
const mUserDecks = vi.mocked(userDecksRepo);

const CARDS = ['c0', 'c1', 'c2', 'c3', 'c4'];
const session = (over: Record<string, unknown> = {}) =>
    ({
        id: 's1',
        userId: 'u1',
        deckId: 'd1',
        mode: 'flashcard',
        status: 'active',
        srsEnabled: false,
        cardIds: CARDS,
        cardIndex: 0,
        correct: 2,
        xpAwarded: 0,
        cardsStudied: 0,
        correctAnswers: 0,
        duration: 0,
        countsAgain: 0,
        countsHard: 0,
        countsGood: 0,
        countsEasy: 0,
        revisitCardIds: [],
        durationMs: 0,
        runId: null,
        startedAt: new Date(Date.now() - 60_000),
        endedAt: null,
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
    }) as never;

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.resetAllMocks();
    mUserDecks.recordStudied.mockResolvedValue(undefined);
    mSessions.hasCompletedInRun.mockResolvedValue(false);
    mSessions.completeSession.mockResolvedValue({ count: 1 } as never);
    mSessions.updateProgress.mockResolvedValue({ count: 1 } as never);
    mActivity.recordReview.mockResolvedValue(undefined as never);
});

describe('rate → library', () => {
    const publicCard = { id: 'c1', deckId: 'd9', deck: { authorId: 'owner', isPublic: true } };
    const saved = {
        state: 'review',
        learningStepSecs: 0,
        nextReviewAt: new Date(),
        interval: 1,
        easeFactor: 2.5,
        repetitions: 1,
        remainingSteps: 0,
        lapses: 0,
        leeched: false,
        reps: 1,
        cardId: 'c1',
        userId: 'viewer',
        lastReviewedAt: new Date(),
        masteredAt: null,
    };

    it("records the card against someone else's public deck", async () => {
        mCards.findCardWithOwner.mockResolvedValue(publicCard as never);
        mSrs.findProgress.mockResolvedValue(null as never);
        mSrs.upsertProgress.mockResolvedValue(saved as never);
        await rate('viewer', { cardId: 'c1', rating: 'good' });
        await flush();
        expect(mUserDecks.recordStudied).toHaveBeenCalledWith('viewer', 'd9', ['c1']);
    });

    it('a failing library write does not fail the rating or touch the activity roll-up', async () => {
        mCards.findCardWithOwner.mockResolvedValue(publicCard as never);
        mSrs.findProgress.mockResolvedValue(null as never);
        mSrs.upsertProgress.mockResolvedValue(saved as never);
        mUserDecks.recordStudied.mockRejectedValue(new Error('db down'));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await rate('viewer', { cardId: 'c1', rating: 'good' });
        await flush();
        expect(r.cardId).toBe('c1');
        expect(mActivity.recordReview).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalledWith('[user-decks] recordStudied failed', expect.any(Error));
        err.mockRestore();
    });
});

describe('session progress → library', () => {
    it('PATCH cardIndex=3 records exactly the first 3 cards (SRS off)', async () => {
        mSessions.findSessionOwned.mockResolvedValue(session({ cardIndex: 3 }));
        await updateProgress('u1', 's1', { cardIndex: 3 });
        await flush();
        expect(mUserDecks.recordStudied).toHaveBeenCalledWith('u1', 'd1', ['c0', 'c1', 'c2']);
    });

    it('a tally-only PATCH records nothing', async () => {
        mSessions.findSessionOwned.mockResolvedValue(session({ cardIndex: 3 }));
        await updateProgress('u1', 's1', { correct: 2 });
        await flush();
        expect(mUserDecks.recordStudied).not.toHaveBeenCalled();
    });

    it('cardIndex 0 records nothing', async () => {
        mSessions.findSessionOwned.mockResolvedValue(session({ cardIndex: 0 }));
        await updateProgress('u1', 's1', { cardIndex: 0 });
        await flush();
        expect(mUserDecks.recordStudied).not.toHaveBeenCalled();
    });

    it('complete records every card of the round', async () => {
        mSessions.findSessionOwned.mockResolvedValue(session());
        await complete('u1', 's1');
        await flush();
        expect(mUserDecks.recordStudied).toHaveBeenCalledWith('u1', 'd1', CARDS);
    });

    it('a failing library write leaves XP and the activity roll-up exactly as before', async () => {
        mSessions.findSessionOwned.mockResolvedValue(session());
        const ok = await complete('u1', 's1');
        const okXp = mSessions.incrementUserXp.mock.calls[0]?.[1];
        const okActivity = mActivity.recordReview.mock.calls[0]?.[1];

        vi.clearAllMocks();
        mSessions.findSessionOwned.mockResolvedValue(session());
        mSessions.completeSession.mockResolvedValue({ count: 1 } as never);
        mSessions.hasCompletedInRun.mockResolvedValue(false);
        mActivity.recordReview.mockResolvedValue(undefined as never);
        mUserDecks.recordStudied.mockRejectedValue(new Error('db down'));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const failed = await complete('u1', 's1');
        await flush();

        expect(failed.xpAwarded).toBe(ok.xpAwarded);
        expect(mSessions.incrementUserXp.mock.calls[0]?.[1]).toBe(okXp);
        expect(mActivity.recordReview.mock.calls[0]?.[1]).toEqual(okActivity);
        err.mockRestore();
    });
});

describe('trackStudied', () => {
    it('skips an empty list and never throws', async () => {
        trackStudied('u1', 'd1', []);
        expect(mUserDecks.recordStudied).not.toHaveBeenCalled();
        mUserDecks.recordStudied.mockRejectedValue(new Error('x'));
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => trackStudied('u1', 'd1', ['c1'])).not.toThrow();
        await flush();
        err.mockRestore();
    });
});
