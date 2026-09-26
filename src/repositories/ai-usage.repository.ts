import { prisma } from '../db/prisma.js';

const dayUtc = (d: Date = new Date()) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
};

/**
 * When today's counters reset: the next UTC midnight. Counters are keyed by
 * `dayUtc`, so this is the single source of truth for every "resets at" the
 * API reports — the FE renders it in the user's own timezone.
 */
export const nextResetAt = (d: Date = new Date()): Date => {
    const x = dayUtc(d);
    x.setUTCDate(x.getUTCDate() + 1);
    return x;
};

// 'import' shares the same per-user-per-day rollup table as the AI kinds
// (Quizlet / paste-text imports — see imports.service.ts). 'chat' tracks
// real-time chat-message turns (see chat.service.ts). 'image' tracks vision
// calls (deck-from-image endpoint + image-attached chat turns) — metered
// separately since vision calls cost more than text-only ones.
export type AiUsageKind = 'enrich' | 'generate' | 'suggest' | 'import' | 'chat' | 'image';

export const findTodayCount = async (userId: string, kind: AiUsageKind): Promise<number> => {
    const row = await prisma.aiUsage.findUnique({
        where: { userId_day_kind: { userId, day: dayUtc(), kind } },
    });
    return row?.count ?? 0;
};

/**
 * Every kind's count for today in one query — backs GET /ai/usage, which the
 * chat composer polls so the user sees "3/5 decks today" before they hit the
 * cap rather than after.
 */
export const findTodayCounts = async (
    userId: string,
): Promise<Partial<Record<AiUsageKind, number>>> => {
    const rows = await prisma.aiUsage.findMany({
        where: { userId, day: dayUtc() },
        select: { kind: true, count: true },
    });
    const out: Partial<Record<AiUsageKind, number>> = {};
    for (const r of rows) {
        out[r.kind as AiUsageKind] = r.count;
    }
    return out;
};

/**
 * Atomic +1 on the day's counter. Returns the new total after increment so
 * callers can surface "you have N left" if they want.
 */
export const recordUse = async (userId: string, kind: AiUsageKind): Promise<number> => {
    const row = await prisma.aiUsage.upsert({
        where: { userId_day_kind: { userId, day: dayUtc(), kind } },
        update: { count: { increment: 1 } },
        create: { userId, day: dayUtc(), kind, count: 1 },
    });
    return row.count;
};
