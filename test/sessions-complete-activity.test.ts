import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as achievementsService from '../src/services/achievements.service.js';
import * as milestone from '../src/services/milestone.service.js';
import { complete } from '../src/services/sessions.service.js';

vi.mock('../src/repositories/sessions.repository.js', async () => {
    const actual = await vi.importActual<typeof sessionsRepo>(
        '../src/repositories/sessions.repository.js',
    );
    return {
        ...actual,
        findSessionOwned: vi.fn(),
        completeSession: vi.fn(),
        incrementUserXp: vi.fn(),
    };
});
vi.mock('../src/repositories/activity.repository.js', async () => {
    const actual = await vi.importActual<typeof activityRepo>(
        '../src/repositories/activity.repository.js',
    );
    return { ...actual, recordReview: vi.fn() };
});
vi.mock('../src/services/achievements.service.js', async () => {
    const actual = await vi.importActual<typeof achievementsService>(
        '../src/services/achievements.service.js',
    );
    return { ...actual, evaluate: vi.fn() };
});
vi.mock('../src/services/milestone.service.js', async () => {
    const actual = await vi.importActual<typeof milestone>('../src/services/milestone.service.js');
    return { ...actual, checkFirstSession: vi.fn() };
});

const mockedSessions = vi.mocked(sessionsRepo);
const mockedActivity = vi.mocked(activityRepo);
const mockedAch = vi.mocked(achievementsService);
const mockedMilestone = vi.mocked(milestone);

const DECK_CARDS = Array.from({ length: 100 }, (_, i) => `card-${i}`);
const SUBSET = DECK_CARDS.slice(0, 3);

const session = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'sess-1',
    userId: 'u1',
    deckId: 'd1',
    mode: 'flashcard',
    status: 'active',
    cardIds: SUBSET,
    index: 3,
    correct: 2,
    srsEnabled: false,
    durationMs: 0,
    countsAgain: 0,
    countsHard: 0,
    countsGood: 0,
    countsEasy: 0,
    revisitCardIds: [],
    startedAt: new Date(Date.now() - 60_000),
    endedAt: null,
    completedAt: new Date(),
    xpAwarded: 0,
    cardsStudied: 0,
    correctAnswers: 0,
    ...over,
});

describe('sessions.service / complete — daily activity', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSessions.completeSession.mockResolvedValue({ count: 1 } as never);
        mockedSessions.incrementUserXp.mockResolvedValue({} as never);
        mockedActivity.recordReview.mockResolvedValue({} as never);
        mockedAch.evaluate.mockResolvedValue([]);
        mockedMilestone.checkFirstSession.mockResolvedValue(undefined as never);
    });

    // The regression: a 3-card round used to report 100 reviews into the day's
    // counters, inflating streaks, the weekly goal and every stats series.
    it('browse-mode records the cards actually studied, not the whole deck', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(session() as never);
        await complete('u1', 'sess-1');
        expect(mockedActivity.recordReview).toHaveBeenCalledTimes(1);
        expect(mockedActivity.recordReview.mock.calls[0]?.[1]).toMatchObject({
            reviews: 3,
            correct: 2,
        });
    });

    it('persists cardsStudied as the session size, not the deck size', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(session() as never);
        await complete('u1', 'sess-1');
        expect(mockedSessions.completeSession.mock.calls[0]?.[2]).toMatchObject({
            cardsStudied: 3,
        });
    });

    // SRS sessions report per-card via POST /srs/rate; completing must not
    // double-count them into the same day.
    it('SRS-mode does not roll activity a second time', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ srsEnabled: true }) as never,
        );
        await complete('u1', 'sess-1');
        expect(mockedActivity.recordReview).not.toHaveBeenCalled();
    });

    it('prefers a client-reported duration over wall-clock', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ durationMs: 12_345 }) as never,
        );
        await complete('u1', 'sess-1');
        expect(mockedSessions.completeSession.mock.calls[0]?.[2]).toMatchObject({
            durationMs: 12_345,
        });
    });
});
