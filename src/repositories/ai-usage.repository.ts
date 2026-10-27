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

// Counted by what the user sees, not by which AI call ran: a new deck is a
// 'deck' whether it came from a topic, a word list or a photo. 'tip' is Mimi's
// automatic suggestions; 'import' is the non-AI Quizlet / paste-text import.
export type AiUsageKind = 'deck' | 'message' | 'action' | 'tip' | 'import';

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

/** Reserve a slot before work starts; the conflict lock enforces the cap. */
export const reserveUse = async (
    userId: string,
    kind: AiUsageKind,
    cap: number,
): Promise<number | null> => {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO ai_usage ("userId", day, kind, count, "updatedAt")
        SELECT ${userId}, ${dayUtc()}::date, ${kind}, 1, now()
        WHERE ${cap} > 0
        ON CONFLICT ("userId", day, kind) DO UPDATE
        SET count = ai_usage.count + 1, "updatedAt" = now()
        WHERE ai_usage.count < ${cap}
        RETURNING count
    `;
    return rows[0]?.count ?? null;
};

/** Release failed work without allowing a negative counter. */
export const releaseUse = async (userId: string, kind: AiUsageKind): Promise<void> => {
    await prisma.$executeRaw`
        UPDATE ai_usage SET count = GREATEST(0, count - 1), "updatedAt" = now()
        WHERE "userId" = ${userId} AND day = ${dayUtc()}::date AND kind = ${kind}
    `;
};
