import * as srsRepo from '../repositories/srs.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as achievementsService from './achievements.service.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';
import { initialState, review } from './sm2.js';
import { RATING_TO_QUALITY, type Rating } from '../schemas/srs.schema.js';

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
    // Ownership: user must own the deck the card belongs to.
    const card = await cardsRepo.findCardWithOwner(input.cardId);
    if (!card) throw new NotFoundError('CARD_NOT_FOUND', 'Card not found');
    if (card.deck.authorId !== ownerId) {
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
    const saved = await srsRepo.upsertProgress({
        userId: ownerId,
        cardId: input.cardId,
        repetitions: next.repetitions,
        interval: next.interval,
        easeFactor: next.easeFactor,
        lastReviewedAt: next.lastReviewedAt,
        nextReviewAt: next.nextReviewAt,
    });

    // Roll the day's activity counters. 'good' and 'easy' count as correct,
    // matching the FE's accuracy model (quality ≥ 3).
    const wasCorrect = input.rating === 'good' || input.rating === 'easy';
    activityRepo.recordReview(ownerId, { wasCorrect }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[activity] recordReview failed', err);
    });

    achievementsService.evaluate(ownerId, 'rate').catch(() => {});

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
