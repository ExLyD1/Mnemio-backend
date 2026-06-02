import { prisma } from '../db/prisma.js';

const dateAtUtcMidnight = (d: Date): Date => {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
};

export const recordReview = async (
    userId: string,
    args: { wasCorrect: boolean; durationMs?: number; at?: Date },
): Promise<void> => {
    const date = dateAtUtcMidnight(args.at ?? new Date());
    const correctInc = args.wasCorrect ? 1 : 0;
    const durationInc = args.durationMs ?? 0;
    await prisma.dailyActivity.upsert({
        where: { userId_date: { userId, date } },
        update: {
            reviews: { increment: 1 },
            correct: { increment: correctInc },
            durationMs: { increment: durationInc },
        },
        create: { userId, date, reviews: 1, correct: correctInc, durationMs: durationInc },
    });
};

export type DayRow = {
    date: Date;
    reviews: number;
    correct: number;
    durationMs: number;
};

export const rangeDays = (userId: string, fromUtc: Date, toUtc: Date) =>
    prisma.dailyActivity.findMany({
        where: { userId, date: { gte: fromUtc, lte: toUtc } },
        orderBy: { date: 'asc' },
    });

export const allDays = (userId: string) =>
    prisma.dailyActivity.findMany({
        where: { userId },
        orderBy: { date: 'asc' },
    });
