import * as dashboardRepo from '../repositories/dashboard.repository.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as sessionsRepo from '../repositories/sessions.repository.js';
import { toPublicDeck, type PublicDeck } from '../shared/mappers.deck.js';
import { toPublicSession, type PublicSession } from '../shared/mappers.session.js';

export type DashboardResponse = {
    stats: { decks: number; cards: number; xp: number };
    dueCount: number;
    recentDecks: PublicDeck[];
    continueStudying: PublicSession | null;
};

export const get = async (userId: string): Promise<DashboardResponse> => {
    const [stats, dueCount, recentDecksRows, incomplete] = await Promise.all([
        dashboardRepo.fetchStats(userId),
        srsRepo.countDueCards(userId),
        dashboardRepo.fetchRecentDecks(userId, 5),
        sessionsRepo.findLatestIncomplete(userId),
    ]);

    return {
        stats,
        dueCount,
        recentDecks: recentDecksRows.map(toPublicDeck),
        continueStudying: incomplete ? toPublicSession(incomplete) : null,
    };
};
