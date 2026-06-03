import type { StudySessionModel } from '../../generated/prisma/models/StudySession.js';

export type SessionCounts = {
    again: number;
    hard: number;
    good: number;
    easy: number;
};

export type PublicSession = {
    id: string;
    userId: string;
    deckId: string;
    mode: string;
    status: string;
    cardIds: string[];
    cardIndex: number;
    correct: number;
    xpAwarded: number;
    cardsStudied: number;
    correctAnswers: number;
    counts: SessionCounts;
    revisitCardIds: string[];
    durationMs: number;
    startedAt: string;
    endedAt: string | null;
    completedAt: string;
};

export const toPublicSession = (s: StudySessionModel): PublicSession => ({
    id: s.id,
    userId: s.userId,
    deckId: s.deckId,
    mode: s.mode,
    status: s.status,
    cardIds: s.cardIds,
    cardIndex: s.cardIndex,
    correct: s.correct,
    xpAwarded: s.xpAwarded,
    cardsStudied: s.cardsStudied,
    correctAnswers: s.correctAnswers,
    counts: {
        again: s.countsAgain,
        hard: s.countsHard,
        good: s.countsGood,
        easy: s.countsEasy,
    },
    revisitCardIds: s.revisitCardIds,
    durationMs: s.durationMs,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    completedAt: s.completedAt.toISOString(),
});
