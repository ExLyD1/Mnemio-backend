import { prisma } from '../db/prisma.js';

const dayUtc = (d: Date = new Date()) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
};

// 'import' shares the same per-user-per-day rollup table as the AI kinds
// (Quizlet / paste-text imports — see imports.service.ts). 'chat' tracks
// real-time chat-message turns (see chat.service.ts).
export type AiUsageKind = 'enrich' | 'generate' | 'suggest' | 'import' | 'chat';

export const findTodayCount = async (
    userId: string,
    kind: AiUsageKind,
): Promise<number> => {
    const row = await prisma.aiUsage.findUnique({
        where: { userId_day_kind: { userId, day: dayUtc(), kind } },
    });
    return row?.count ?? 0;
};

/**
 * Atomic +1 on the day's counter. Returns the new total after increment so
 * callers can surface "you have N left" if they want.
 */
export const recordUse = async (
    userId: string,
    kind: AiUsageKind,
): Promise<number> => {
    const row = await prisma.aiUsage.upsert({
        where: { userId_day_kind: { userId, day: dayUtc(), kind } },
        update: { count: { increment: 1 } },
        create: { userId, day: dayUtc(), kind, count: 1 },
    });
    return row.count;
};
