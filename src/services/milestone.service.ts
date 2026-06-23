import * as analytics from './analytics.service.js';
import * as decksRepo from '../repositories/decks.repository.js';
import * as sessionsRepo from '../repositories/sessions.repository.js';
import * as srsRepo from '../repositories/srs.repository.js';

// `first_value_reached` fires exactly once per milestone the moment a user
// crosses from zero → one. Each helper is fire-and-forget: call it right AFTER
// the triggering write succeeds; it swallows its own errors and never throws,
// so it can never break the request that triggered it.
//
// The "exactly once" guarantee comes from the count === 1 check: the relevant
// row count is strictly 1 only immediately after the very first deck / completed
// session / reviewed card. Callers must ensure the check runs on a genuine
// insert (see checkFirstReview's caller guard) so a no-op update can't re-fire.

export const checkFirstDeck = async (userId: string): Promise<void> => {
    try {
        if ((await decksRepo.countDecks({ ownerId: userId, q: undefined })) === 1) {
            analytics.track(userId, 'first_value_reached', { milestone: 'first_deck' });
        }
    } catch {
        // Never break deck creation for an analytics probe.
    }
};

export const checkFirstSession = async (userId: string): Promise<void> => {
    try {
        if ((await sessionsRepo.countCompletedSessions(userId)) === 1) {
            analytics.track(userId, 'first_value_reached', { milestone: 'first_session' });
        }
    } catch {
        // Never break session completion.
    }
};

// Call ONLY when a new progress row was just created (not on a re-review of an
// existing card), so count === 1 unambiguously means the user's first review.
export const checkFirstReview = async (userId: string): Promise<void> => {
    try {
        if ((await srsRepo.countProgress(userId)) === 1) {
            analytics.track(userId, 'first_value_reached', { milestone: 'first_review' });
        }
    } catch {
        // Never break the rating flow.
    }
};
