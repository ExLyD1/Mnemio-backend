import * as srsRepo from '../repositories/srs.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as achievementsService from './achievements.service.js';
import * as milestone from './milestone.service.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';
import { initialState, review } from './sm2.js';
import { RATING_TO_QUALITY, type Rating } from '../schemas/srs.schema.js';

export const MASTERY_THRESHOLD = 3; // repetitions >= 3 (canonical, deck-stats.repository.ts)

// Set-once mastery timestamp. Once set it is preserved forever — never
// overwritten and never cleared when the card lapses below the threshold — so
// the cumulative mastery curve stays monotonic ("ever mastered").
export const resolveMasteredAt = (
    existingMasteredAt: Date | null,
    nextRepetitions: number,
    now: Date,
): Date | null =>
    existingMasteredAt ?? (nextRepetitions >= MASTERY_THRESHOLD ? now : null);

export type PublicCardProgress = {
    cardId: string;
    repetitions: number;
    interval: number;
    easeFactor: number;
    nextReviewAt: string;
    lastReviewedAt: string | null;
};

export const rate = async (
    ownerId: string,
    input: { cardId: string; rating: Rating },
): Promise<PublicCardProgress> => {
    // Access: the rater must own the card's deck OR the deck must be public.
    // The progress row is keyed by (ownerId = rater, cardId), so two users
    // studying the same shared deck keep fully independent SRS — a viewer's
    // ratings never touch the owner's progress. Private decks stay 403 for
    // non-owners, which also re-locks the moment isPublic flips to false.
    const card = await cardsRepo.findCardWithOwner(input.cardId);
    if (!card) throw new NotFoundError('CARD_NOT_FOUND', 'Card not found');
    if (card.deck.authorId !== ownerId && !card.deck.isPublic) {
        throw new ForbiddenError('CARD_FORBIDDEN', 'You do not own this card');
    }

    const now = new Date();
    const existing = await srsRepo.findProgress(ownerId, input.cardId);
    const prev = existing
        ? {
              repetitions: existing.repetitions,
              interval: existing.interval,
              easeFactor: existing.easeFactor,
              lastReviewedAt: existing.lastReviewedAt,
              nextReviewAt: existing.nextReviewAt,
          }
        : initialState(now);

    const next = review(prev, RATING_TO_QUALITY[input.rating], now);
    const masteredAt = resolveMasteredAt(existing?.masteredAt ?? null, next.repetitions, now);
    const saved = await srsRepo.upsertProgress({
        userId: ownerId,
        cardId: input.cardId,
        repetitions: next.repetitions,
        interval: next.interval,
        easeFactor: next.easeFactor,
        lastReviewedAt: next.lastReviewedAt,
        nextReviewAt: next.nextReviewAt,
        masteredAt,
    });

    // Roll the day's activity counters. 'good' and 'easy' count as correct,
    // matching the FE's accuracy model (quality ≥ 3).
    const wasCorrect = input.rating === 'good' || input.rating === 'easy';
    activityRepo.recordReview(ownerId, { wasCorrect }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[activity] recordReview failed', err);
    });

    achievementsService.evaluate(ownerId, 'rate').catch(() => {});

    // Only a brand-new progress row can be the user's first-ever review; skip
    // the probe on re-reviews of an already-seen card so it can't double-fire.
    if (!existing) void milestone.checkFirstReview(ownerId);

    return {
        cardId: saved.cardId,
        repetitions: saved.repetitions,
        interval: saved.interval,
        easeFactor: saved.easeFactor,
        nextReviewAt: saved.nextReviewAt.toISOString(),
        lastReviewedAt: saved.lastReviewedAt ? saved.lastReviewedAt.toISOString() : null,
    };
};

export type DueCardDto = {
    cardId: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    nextReviewAt: string;
    interval: number;
    easeFactor: number;
    repetitions: number;
};

export const progress = async (
    ownerId: string,
    limit = 2000,
): Promise<PublicCardProgress[]> => {
    const rows = await srsRepo.findAllProgress(ownerId, limit);
    return rows.map((r) => ({
        cardId: r.cardId,
        repetitions: r.repetitions,
        interval: r.interval,
        easeFactor: r.easeFactor,
        nextReviewAt: r.nextReviewAt.toISOString(),
        lastReviewedAt: r.lastReviewedAt ? r.lastReviewedAt.toISOString() : null,
    }));
};

export const due = async (ownerId: string, limit = 50): Promise<DueCardDto[]> => {
    const rows = await srsRepo.findDueCards(ownerId, limit);
    return rows.map((r) => ({
        cardId: r.cardId,
        deckId: r.deckId,
        word: r.word,
        definition: r.definition,
        phonetic: r.phonetic,
        nextReviewAt: r.nextReviewAt.toISOString(),
        interval: r.interval,
        easeFactor: r.easeFactor,
        repetitions: r.repetitions,
    }));
};
