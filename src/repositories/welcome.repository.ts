import { prisma } from '../db/prisma.js';

export type WelcomeState = {
    hasDeck: boolean;
    hasSession: boolean;
    hasReviewed: boolean;
};

// Three independent count > 0 probes, run in parallel. Total cost ~3ms on a
// warm pool. The FE uses this to pick between the empty-state dashboard CTA
// and "Continue studying" — baking it into the auth payload saves three round
// trips on every dashboard mount.
export const getWelcomeState = async (userId: string): Promise<WelcomeState> => {
    const [deckCount, sessionCount, progressCount] = await Promise.all([
        prisma.deck.count({ where: { authorId: userId }, take: 1 }),
        prisma.studySession.count({ where: { userId, status: 'completed' }, take: 1 }),
        prisma.cardProgress.count({ where: { userId }, take: 1 }),
    ]);
    return {
        hasDeck: deckCount > 0,
        hasSession: sessionCount > 0,
        hasReviewed: progressCount > 0,
    };
};
