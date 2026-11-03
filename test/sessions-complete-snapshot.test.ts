import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as achievementsService from '../src/services/achievements.service.js';
import * as milestone from '../src/services/milestone.service.js';
import { complete } from '../src/services/sessions.service.js';
import { completeSessionSchema } from '../src/schemas/session.schema.js';

// Library tracking is a side effect with its own tests (user-decks-record.test.ts).
vi.mock('../src/services/user-decks.service.js', () => ({ trackStudied: vi.fn() }));

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

const SUBSET = ['card-0', 'card-1', 'card-2'];
const REVISIT = '22222222-2222-4222-8222-222222222222';

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
    runId: null,
    ...over,
});

describe('sessions.service / complete — final snapshot', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSessions.completeSession.mockResolvedValue({ count: 1 } as never);
        mockedSessions.incrementUserXp.mockResolvedValue({} as never);
        mockedActivity.recordReview.mockResolvedValue({} as never);
        mockedAch.evaluate.mockResolvedValue([]);
        mockedMilestone.checkFirstSession.mockResolvedValue(undefined as never);
    });

    const written = () => mockedSessions.completeSession.mock.calls[0]?.[2];

    it('an empty body completes exactly as before (PATCHed tally, stored correct)', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ srsEnabled: true, correct: 2, durationMs: 9_000 }) as never,
        );
        await complete('u1', 'sess-1', 'UTC', {});
        expect(written()).toEqual({
            xpAwarded: 2 * 10 + 25,
            cardsStudied: 3,
            correctAnswers: 2,
            cardIndex: 3,
            correct: 2,
            durationMs: 9_000,
        });
        expect(mockedSessions.incrementUserXp).toHaveBeenCalledWith('u1', 45);
    });

    it('persists the snapshot in the completing write and pays XP on its correct', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ srsEnabled: true, correct: 0 }) as never,
        );
        await complete('u1', 'sess-1', 'UTC', {
            correct: 3,
            counts: { again: 1, hard: 0, good: 2, easy: 1 },
            revisitCardIds: [REVISIT],
            durationMs: 42_000,
        });
        expect(mockedSessions.completeSession).toHaveBeenCalledTimes(1);
        expect(written()).toMatchObject({
            correct: 3,
            correctAnswers: 3,
            countsAgain: 1,
            countsHard: 0,
            countsGood: 2,
            countsEasy: 1,
            revisitCardIds: [REVISIT],
            durationMs: 42_000,
            xpAwarded: 3 * 10 + 25,
        });
        expect(mockedSessions.incrementUserXp).toHaveBeenCalledWith('u1', 55);
    });

    it('a partial snapshot keeps the stored values for the fields it omits', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ srsEnabled: true, correct: 1, durationMs: 5_000 }) as never,
        );
        await complete('u1', 'sess-1', 'UTC', { durationMs: 8_000 });
        expect(written()).toMatchObject({ correct: 1, durationMs: 8_000, xpAwarded: 35 });
        expect(written()).not.toHaveProperty('countsAgain');
        expect(written()).not.toHaveProperty('revisitCardIds');
    });

    it('browse mode: DailyActivity gets the session cards and the snapshot correct', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(
            session({ srsEnabled: false, correct: 0 }) as never,
        );
        await complete('u1', 'sess-1', 'UTC', { correct: 2, durationMs: 7_000 });
        expect(mockedActivity.recordReview).toHaveBeenCalledTimes(1);
        expect(mockedActivity.recordReview.mock.calls[0]?.[1]).toMatchObject({
            reviews: SUBSET.length,
            correct: 2,
            durationMs: 7_000,
            wasCorrect: true,
        });
    });

    it('still refuses a session that is not active', async () => {
        mockedSessions.findSessionOwned.mockResolvedValue(session({ status: 'complete' }) as never);
        await expect(complete('u1', 'sess-1', 'UTC', { correct: 1 })).rejects.toMatchObject({
            code: 'SESSION_NOT_ACTIVE',
        });
        expect(mockedSessions.completeSession).not.toHaveBeenCalled();
    });
});

describe('session.schema / completeSessionSchema', () => {
    it('accepts an empty body', () => {
        expect(completeSessionSchema.parse({})).toEqual({});
    });

    it.each([
        ['negative correct', { correct: -1 }],
        ['fractional correct', { correct: 1.5 }],
        ['incomplete counts', { counts: { again: 1, hard: 0, good: 0 } }],
        ['negative count', { counts: { again: -1, hard: 0, good: 0, easy: 0 } }],
        ['non-uuid revisit id', { revisitCardIds: ['card-1'] }],
        ['too many revisit ids', { revisitCardIds: Array.from({ length: 1001 }, () => REVISIT) }],
        ['negative duration', { durationMs: -5 }],
    ])('rejects %s', (_label, body) => {
        expect(() => completeSessionSchema.parse(body)).toThrow(ZodError);
    });
});
