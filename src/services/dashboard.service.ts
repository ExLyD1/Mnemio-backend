import * as dashboardRepo from '../repositories/dashboard.repository.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as sessionsRepo from '../repositories/sessions.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import { toPublicDeck, buildStats, type PublicDeck } from '../shared/mappers.deck.js';
import { toPublicSession, type PublicSession } from '../shared/mappers.session.js';
import type { DeckModel } from '../../generated/prisma/models/Deck.js';

export type DashboardResponse = {
    stats: { decks: number; cards: number; xp: number };
    dueCount: number;
    recentDecks: PublicDeck[];
    continueStudying: PublicSession | null;
    lastPracticedDeck: PublicDeck | null;
    mostPracticedDecks: PublicDeck[];
};

export const get = async (userId: string): Promise<DashboardResponse> => {
    const [stats, dueCount, recentDecksRows, incomplete, lastPracticedRow, mostPracticedRows] =
        await Promise.all([
            dashboardRepo.fetchStats(userId),
            srsRepo.countDueCards(userId),
            dashboardRepo.fetchRecentDecks(userId, 5),
            sessionsRepo.findLatestIncomplete(userId),
            dashboardRepo.fetchLastPracticedDeck(userId),
            dashboardRepo.fetchMostPracticedDecks(userId, 4),
        ]);

    // Aggregate per-deck SRS stats once across the union of every deck we return
    // so each deck card carries the same stats shape as elsewhere in the app.
    const deckRows: DeckModel[] = [...recentDecksRows, ...mostPracticedRows];
    if (lastPracticedRow) deckRows.push(lastPracticedRow);
    const uniqueIds = [...new Set(deckRows.map((d) => d.id))];

    const deckStatsRows = await deckStatsRepo.aggregateDeckStats(userId, uniqueIds);
    const aggById = new Map(deckStatsRows.map((r) => [r.deckId, r]));

    const mapDeck = (d: DeckModel): PublicDeck =>
        toPublicDeck(d, buildStats(d.cardCount, aggById.get(d.id)));

    return {
        stats,
        dueCount,
        recentDecks: recentDecksRows.map(mapDeck),
        continueStudying: incomplete ? toPublicSession(incomplete) : null,
        lastPracticedDeck: lastPracticedRow ? mapDeck(lastPracticedRow) : null,
        mostPracticedDecks: mostPracticedRows.map(mapDeck),
    };
};
