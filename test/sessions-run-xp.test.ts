import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as sessionsRepo from '../src/repositories/sessions.repository.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as achievementsService from '../src/services/achievements.service.js';
import * as milestone from '../src/services/milestone.service.js';
import { complete, start } from '../src/services/sessions.service.js';

// An in-memory sessions repository, so the once-per-run bonus check reads the
// real state the earlier completions left behind (not a canned mock answer).
type Row = {
    id: string;
    userId: string;
    deckId: string;
    mode: string;
    status: string;
    srsEnabled: boolean;
    cardIds: string[];
    cardIndex: number;
    correct: number;
    xpAwarded: number;
    cardsStudied: number;
    correctAnswers: number;
    duration: number;
    countsAgain: number;
    countsHard: number;
    countsGood: number;
    countsEasy: number;
    revisitCardIds: string[];
    durationMs: number;
    runId: string | null;
    startedAt: Date;
    endedAt: Date | null;
    completedAt: Date;
    createdAt: Date;
    updatedAt: Date;
};
const db = vi.hoisted(() => ({
    rows: new Map<string, Row>(),
    xp: new Map<string, number>(),
    seq: 0,
}));

vi.mock('../src/repositories/sessions.repository.js', () => ({
    listDeckCardIds: async (deckId: string) =>
        Array.from({ length: 3 }, (_, i) => ({ id: `${deckId}-card-${i}` })),
    startSession: async (data: {
        userId: string;
        deckId: string;
        mode: string;
        cardIds: string[];
        srsEnabled: boolean;
        runId: string | null;
    }) => {
        for (const r of db.rows.values()) {
            if (r.userId === data.userId && r.status === 'active') {
                r.status = 'incomplete';
                r.endedAt = new Date();
            }
        }
        const now = new Date();
        const row: Row = {
            ...data,
            id: `sess-${++db.seq}`,
            status: 'active',
            cardIndex: 0,
            correct: 0,
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
            startedAt: now,
            endedAt: null,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
        };
        db.rows.set(row.id, row);
        return { ...row };
    },
    findSessionOwned: async (id: string, userId: string) => {
        const r = db.rows.get(id);
        return r?.userId === userId ? { ...r } : null;
    },
    completeSession: async (id: string, userId: string, data: Partial<Row>) => {
        const r = db.rows.get(id);
        if (r?.userId !== userId || r.status !== 'active') {
            return { count: 0 };
        }
        Object.assign(r, data, { status: 'complete', endedAt: new Date() });
        return { count: 1 };
    },
    hasCompletedInRun: async (userId: string, runId: string, excludeId: string) =>
        [...db.rows.values()].some(
            (r) =>
                r.userId === userId &&
                r.runId === runId &&
                r.status === 'complete' &&
                r.id !== excludeId,
        ),
    incrementUserXp: vi.fn(async (userId: string, xp: number) => {
        db.xp.set(userId, (db.xp.get(userId) ?? 0) + xp);
        return {};
    }),
}));
vi.mock('../src/repositories/decks.repository.js', () => ({
    findDeckByIdUnscoped: async (id: string) => ({ id, authorId: 'u1', isPublic: false }),
}));
vi.mock('../src/repositories/activity.repository.js', () => ({
    recordReview: vi.fn(async () => ({})),
}));
vi.mock('../src/services/achievements.service.js', () => ({ evaluate: vi.fn(async () => []) }));
vi.mock('../src/services/milestone.service.js', () => ({ checkFirstSession: vi.fn() }));

const mockedSessions = vi.mocked(sessionsRepo);
void decksRepo;
void activityRepo;
void achievementsService;
void milestone;

const USER = 'u1';
const RUN = '55555555-5555-4555-8555-555555555555';
const OTHER_RUN = '66666666-6666-4666-8666-666666666666';
const deck = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// The FE flush for one deck: start (with the run) → complete (with the tally).
const writeDeck = async (deckId: string, correct: number, runId: string | null = RUN) => {
    const s = await start(USER, {
        deckId,
        mode: 'srs',
        srsEnabled: true,
        cardIds: [`${deckId}-card-0`],
        ...(runId ? { runId } : {}),
    });
    return complete(USER, s.id, 'UTC', { correct });
};

const userXp = () => db.xp.get(USER) ?? 0;
const rows = () => [...db.rows.values()];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// Mixed tallies, zeros included, deterministic per index.
const corrects = (n: number) => Array.from({ length: n }, (_, i) => (i * 7) % 5);

describe('sessions.service / review run XP', () => {
    beforeEach(() => {
        db.rows.clear();
        db.xp.clear();
        db.seq = 0;
        vi.clearAllMocks();
    });

    it.each([1, 2, 3, 5, 50])('a run over %i decks earns exactly 10 × Σcorrect + 25', async (n) => {
        const cs = corrects(n);
        for (let i = 0; i < n; i++) {
            await writeDeck(deck(i), cs[i]!);
        }
        const expected = 10 * sum(cs) + 25;
        expect(userXp()).toBe(expected);
        expect(sum(mockedSessions.incrementUserXp.mock.calls.map((c) => c[1]))).toBe(expected);
        expect(sum(rows().map((r) => r.xpAwarded))).toBe(expected);
        expect(rows()).toHaveLength(n);
        expect(rows().every((r) => r.status === 'complete' && r.runId === RUN)).toBe(true);
    });

    it('pays the +25 to exactly one session of the run; the rest earn 10 × correct', async () => {
        const cs = [3, 0, 4];
        for (const [i, c] of cs.entries()) {
            await writeDeck(deck(i), c);
        }
        const bonusRows = rows().filter((r) => r.xpAwarded === r.correct * 10 + 25);
        expect(bonusRows).toHaveLength(1);
        expect(bonusRows[0]!.deckId).toBe(deck(0));
        for (const r of rows().filter((x) => x !== bonusRows[0])) {
            expect(r.xpAwarded).toBe(r.correct * 10);
        }
    });

    it('earns the same as one session holding all the correct answers', async () => {
        const cs = corrects(5);
        for (const [i, c] of cs.entries()) {
            await writeDeck(deck(i), c);
        }
        const runXp = userXp();

        db.rows.clear();
        db.xp.clear();
        await writeDeck(deck(0), sum(cs));
        expect(runXp).toBe(userXp());
    });

    it('two different runs each get their own +25', async () => {
        await writeDeck(deck(0), 2, RUN);
        await writeDeck(deck(1), 1, RUN);
        await writeDeck(deck(0), 3, OTHER_RUN);
        await writeDeck(deck(1), 0, OTHER_RUN);
        expect(userXp()).toBe(10 * (2 + 1 + 3 + 0) + 25 * 2);
    });

    it('sessions without a runId (deck study) get +25 on every complete', async () => {
        await writeDeck(deck(0), 2, null);
        await writeDeck(deck(0), 1, null);
        await writeDeck(deck(1), 0, null);
        expect(userXp()).toBe(10 * 3 + 25 * 3);
        expect(rows().every((r) => r.runId === null)).toBe(true);
    });

    it('if the first deck fails to complete, the rest still earn 10 × Σcorrect + 25', async () => {
        const first = await start(USER, {
            deckId: deck(0),
            mode: 'srs',
            srsEnabled: true,
            runId: RUN,
        });
        // Superseded before it could complete (e.g. a session started elsewhere).
        db.rows.get(first.id)!.status = 'incomplete';
        await expect(complete(USER, first.id, 'UTC', { correct: 4 })).rejects.toMatchObject({
            code: 'SESSION_NOT_ACTIVE',
        });

        const rest = [2, 0, 5];
        for (const [i, c] of rest.entries()) {
            await writeDeck(deck(i + 1), c);
        }
        expect(userXp()).toBe(10 * sum(rest) + 25);
    });

    it('a retried deck after a lost complete response never earns a second +25', async () => {
        await writeDeck(deck(0), 2);
        await writeDeck(deck(1), 3);
        // The client never saw deck 1's response and writes it again.
        await writeDeck(deck(1), 3);
        expect(userXp()).toBe(10 * (2 + 3 + 3) + 25);
    });

    it('an empty-body complete in a run uses the stored correct', async () => {
        await writeDeck(deck(0), 1);
        const s = await start(USER, {
            deckId: deck(1),
            mode: 'srs',
            srsEnabled: true,
            runId: RUN,
        });
        db.rows.get(s.id)!.correct = 4; // PATCHed earlier
        const done = await complete(USER, s.id, 'UTC', {});
        expect(done.xpAwarded).toBe(40);
        expect(userXp()).toBe(10 * (1 + 4) + 25);
    });
});
