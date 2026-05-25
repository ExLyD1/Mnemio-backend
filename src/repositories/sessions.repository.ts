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

export const updateProgress = (
    id: string,
    userId: string,
    patch: { cardIndex?: number; correct?: number },
) =>
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

export const incrementUserXp = (userId: string, xp: number) =>
    prisma.user.update({
        where: { id: userId },
        data: { xp: { increment: xp } },
    });
