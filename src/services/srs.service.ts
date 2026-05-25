import * as srsRepo from '../repositories/srs.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';
import { initialState, review, type Quality } from './sm2.js';

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
    input: { cardId: string; quality: number },
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

    const next = review(prev, input.quality as Quality, now);
    const saved = await srsRepo.upsertProgress({
        userId: ownerId,
        cardId: input.cardId,
        repetitions: next.repetitions,
        interval: next.interval,
        easeFactor: next.easeFactor,
        lastReviewedAt: next.lastReviewedAt,
        nextReviewAt: next.nextReviewAt,
    });

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
