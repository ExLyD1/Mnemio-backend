// Library tracking (spec 002): remembers which decks a user is learning.
//
// Strictly a side effect. It is fire-and-forget and swallows every error, the
// same contract as activityRepo.recordReview in srs.rate / sessions.complete:
// a failed write must never fail a rating or a session, and it never touches
// XP, streaks, DailyActivity or achievements. A card missed here is simply
// recorded the next time it is studied.
import * as userDecksRepo from '../repositories/user-decks.repository.js';

export const trackStudied = (userId: string, deckId: string, cardIds: string[]): void => {
    if (cardIds.length === 0) {
        return;
    }
    userDecksRepo.recordStudied(userId, deckId, cardIds).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[user-decks] recordStudied failed', err);
    });
};
