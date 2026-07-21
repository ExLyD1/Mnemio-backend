import { prisma } from '../db/prisma.js';

export const listDeckCardIds = (deckId: string): Promise<{ id: string }[]> =>
    prisma.card.findMany({
        where: { deckId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
    });

// Marks all currently-active sessions for a user as incomplete and creates
// a new active session. All in one transaction to satisfy the
// "only one active session per user" invariant.
export const startSession = (data: {
    userId: string;
    deckId: string;
    mode: string;
    cardIds: string[];
}) =>
    prisma.$transaction(async (tx) => {
        await tx.studySession.updateMany({
            where: { userId: data.userId, status: 'active' },
            data: { status: 'incomplete', endedAt: new Date() },
        });
        return tx.studySession.create({
            data: {
                userId: data.userId,
                deckId: data.deckId,
                mode: data.mode,
                status: 'active',
                cardIds: data.cardIds,
            },
        });
    });

export const findSessionOwned = (id: string, userId: string) =>
    prisma.studySession.findFirst({ where: { id, userId } });

export type SessionProgressPatch = {
    cardIndex?: number;
    correct?: number;
    countsAgain?: number;
    countsHard?: number;
    countsGood?: number;
    countsEasy?: number;
    revisitCardIds?: string[];
    durationMs?: number;
};

export const updateProgress = (id: string, userId: string, patch: SessionProgressPatch) =>
    prisma.studySession.updateMany({
        where: { id, userId, status: 'active' },
        data: patch,
    });

export const completeSession = (
    id: string,
    userId: string,
    data: {
        xpAwarded: number;
        cardsStudied: number;
        correctAnswers: number;
        cardIndex: number;
        correct: number;
        durationMs: number;
    },
) =>
    prisma.studySession.updateMany({
        where: { id, userId, status: 'active' },
        data: {
            status: 'complete',
            xpAwarded: data.xpAwarded,
            cardsStudied: data.cardsStudied,
            correctAnswers: data.correctAnswers,
            cardIndex: data.cardIndex,
            correct: data.correct,
            durationMs: data.durationMs,
            endedAt: new Date(),
            completedAt: new Date(),
        },
    });

export const findLatestIncomplete = (userId: string) =>
    prisma.studySession.findFirst({
        where: { userId, status: 'incomplete' },
        orderBy: { endedAt: 'desc' },
    });

export const findActiveSession = (userId: string) =>
    prisma.studySession.findFirst({ where: { userId, status: 'active' } });

// Count of completed sessions — used to detect the first-session milestone.
export const countCompletedSessions = (userId: string): Promise<number> =>
    prisma.studySession.count({ where: { userId, status: 'complete' } });

export const exitSession = (id: string, userId: string) =>
    prisma.studySession.updateMany({
        where: { id, userId, status: 'active' },
        data: { status: 'incomplete', endedAt: new Date() },
    });

// Resume: atomically mark any currently-active session as incomplete and
// flip the target session back to active. Same invariant as start().
export const resumeSession = (id: string, userId: string) =>
    prisma.$transaction(async (tx) => {
        await tx.studySession.updateMany({
            where: { userId, status: 'active', NOT: { id } },
            data: { status: 'incomplete', endedAt: new Date() },
        });
        const { count } = await tx.studySession.updateMany({
            where: { id, userId, status: 'incomplete' },
            data: { status: 'active', endedAt: null },
        });
        return count;
    });

export const incrementUserXp = (userId: string, xp: number) =>
    prisma.user.update({
        where: { id: userId },
        data: { xp: { increment: xp } },
    });

// One row per *completed* session, for the session-based stats aggregations
// (study-time series + decks-studied). Only completed sessions carry a
// meaningful durationMs / cardsStudied and a real completedAt, and each session
// completes exactly once, so grouping these rows can never double-count.
// `fromUtc` is a loose lower bound on completedAt to narrow the scan; the caller
// decides final range membership by local day key.
export type CompletedSessionStatRow = {
    deckId: string;
    title: string;
    durationMs: number;
    cardsStudied: number;
    completedAt: Date;
};

export const findCompletedSessionsForStats = async (
    userId: string,
    fromUtc: Date | null,
): Promise<CompletedSessionStatRow[]> => {
    const rows = await prisma.studySession.findMany({
        where: {
            userId,
            status: 'complete',
            ...(fromUtc ? { completedAt: { gte: fromUtc } } : {}),
        },
        select: {
            deckId: true,
            durationMs: true,
            cardsStudied: true,
            completedAt: true,
            deck: { select: { title: true } },
        },
    });
    return rows.map((r) => ({
        deckId: r.deckId,
        title: r.deck.title,
        durationMs: r.durationMs,
        cardsStudied: r.cardsStudied,
        completedAt: r.completedAt,
    }));
};
