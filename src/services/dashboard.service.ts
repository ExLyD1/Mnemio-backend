import * as dashboardRepo from '../repositories/dashboard.repository.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as sessionsRepo from '../repositories/sessions.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import { toPublicDeck, buildStats, type PublicDeck } from '../shared/mappers.deck.js';
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

    const deckStatsRows = await deckStatsRepo.aggregateDeckStats(
        userId,
        recentDecksRows.map((d) => d.id),
    );
    const aggById = new Map(deckStatsRows.map((r) => [r.deckId, r]));

    return {
        stats,
        dueCount,
        recentDecks: recentDecksRows.map((d) =>
            toPublicDeck(d, buildStats(d.cardCount, aggById.get(d.id))),
        ),
        continueStudying: incomplete ? toPublicSession(incomplete) : null,
    };
};
