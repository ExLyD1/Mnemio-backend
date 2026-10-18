import * as srsRepo from '../repositories/srs.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as achievementsService from './achievements.service.js';
import type { PublicAchievement } from './achievements.service.js';
import * as milestone from './milestone.service.js';
import { toPublicCard, type PublicCard } from '../shared/mappers.deck.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';
import { scheduleAnswer, previewsFor, mixNewWithReviews } from './srs-scheduling.js';
import { ANKI_DEFAULTS } from './anki-scheduler.js';
import { dayNumber, rollover } from './anki-time.js';
import { DEFAULT_TZ } from './tz.js';
import {
    toPublicProgress,
    type PublicCardProgress,
    type Previews,
    type SrsState,
} from '../shared/mappers.srs.js';
import type { QueueQuery, Rating } from '../schemas/srs.schema.js';

export type { PublicCardProgress } from '../shared/mappers.srs.js';

export const MASTERY_THRESHOLD = 3; // repetitions >= 3 (canonical, deck-stats.repository.ts)

// Set-once mastery timestamp. Once set it is preserved forever — never
// overwritten and never cleared when the card lapses below the threshold — so
// the cumulative mastery curve stays monotonic ("ever mastered").
export const resolveMasteredAt = (
    existingMasteredAt: Date | null,
    nextRepetitions: number,
    now: Date,
): Date | null => existingMasteredAt ?? (nextRepetitions >= MASTERY_THRESHOLD ? now : null);

export const rate = async (
    ownerId: string,
    input: { cardId: string; rating: Rating },
    tz: string = DEFAULT_TZ,
): Promise<
    PublicCardProgress & {
        newAchievements: PublicAchievement[];
        requeueAt: string | null;
        previews: Previews | null;
    }
> => {
    // Access: the rater must own the card's deck OR the deck must be public.
    // The progress row is keyed by (ownerId = rater, cardId), so two users
    // studying the same shared deck keep fully independent SRS — a viewer's
    // ratings never touch the owner's progress. Private decks stay 403 for
    // non-owners, which also re-locks the moment isPublic flips to false.
    const card = await cardsRepo.findCardWithOwner(input.cardId);
    if (!card) {
        throw new NotFoundError('CARD_NOT_FOUND', 'Card not found');
    }
    if (card.deck.authorId !== ownerId && !card.deck.isPublic) {
        throw new ForbiddenError('CARD_FORBIDDEN', 'You do not own this card');
    }

    const now = new Date();
    const existing = await srsRepo.findProgress(ownerId, input.cardId);
    const next = scheduleAnswer(input.cardId, existing, input.rating, now, tz);
    const saved = await srsRepo.upsertProgress({
        userId: ownerId,
        cardId: input.cardId,
        ...next,
        masteredAt: resolveMasteredAt(existing?.masteredAt ?? null, next.repetitions, now),
    });

    // Roll the day's activity counters. Hard is a passing answer in Anki.
    activityRepo
        .recordReview(ownerId, { wasCorrect: input.rating !== 'again', tz })
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[activity] recordReview failed', err);
        });

    const newAchievements = await achievementsService.evaluate(ownerId, 'rate').catch(() => []);

    // Only a brand-new progress row can be the user's first-ever review; skip
    // the probe on re-reviews of an already-seen card so it can't double-fire.
    if (!existing) {
        void milestone.checkFirstReview(ownerId);
    }

    // Still in an intraday (re)learning step: the client shows it again this session.
    const intraday =
        (saved.state === 'learning' || saved.state === 'relearning') &&
        saved.learningStepSecs < 86400;
    return {
        ...toPublicProgress(saved, card.deckId),
        newAchievements,
        requeueAt: intraday ? saved.nextReviewAt.toISOString() : null,
        previews: intraday ? previewsFor(input.cardId, saved, saved.nextReviewAt, tz) : null,
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

export const progress = async (ownerId: string, limit = 2000): Promise<PublicCardProgress[]> => {
    const rows = await srsRepo.findAllProgress(ownerId, limit);
    return rows.map((r) => toPublicProgress(r, r.card.deckId));
};

export type QueueItem = {
    card: PublicCard;
    state: SrsState;
    dueAt: string | null;
    previews: Previews;
    // Kept from the pre-Anki queue shape so existing consumers keep working.
    progress: PublicCardProgress | null;
    deckId: string;
    deckTitle: string;
};

/**
 * The study queue, ready to render, in one response (no per-deck fan-out).
 * With a deck: due (re)learning + due reviews + that deck's new cards under
 * Anki's daily limit. Without: due cards across every accessible deck.
 */
export const queue = async (userId: string, query: QueueQuery, tz: string = DEFAULT_TZ) => {
    const { deckId, extraNew } = query;
    if (deckId) {
        const deck = await decksRepo.findDeckByIdUnscoped(deckId);
        if (!deck) {
            throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
        }
        if (deck.authorId !== userId && !deck.isPublic) {
            throw new ForbiddenError('CARD_FORBIDDEN', 'You do not own this deck');
        }
    }
    const now = new Date();
    const today = rollover(dayNumber(now, tz), tz);
    const introduced = await srsRepo.newIntroducedToday(userId, deckId, today);
    const newLimit = Math.max(0, ANKI_DEFAULTS.newPerDay - introduced + extraNew);
    const data = await srsRepo.queueData(
        userId,
        deckId,
        now,
        new Date(now.getTime() + ANKI_DEFAULTS.learnAheadMinutes * 60_000),
        newLimit,
        query.limit ?? ANKI_DEFAULTS.reviewsPerDay,
    );
    const mapProgress = (p: (typeof data.reviews)[number]): QueueItem => ({
        card: toPublicCard(p.card),
        state: p.state as SrsState,
        dueAt: p.nextReviewAt.toISOString(),
        previews: previewsFor(p.cardId, p, p.nextReviewAt > now ? p.nextReviewAt : now, tz),
        progress: toPublicProgress(p, p.card.deckId),
        deckId: p.card.deckId,
        deckTitle: p.card.deck.title,
    });
    const fresh: QueueItem[] = data.newCards.map((c) => ({
        card: toPublicCard(c),
        state: 'new',
        dueAt: null,
        previews: previewsFor(c.id, null, now, tz),
        progress: null,
        deckId: c.deckId,
        deckTitle: c.deck.title,
    }));
    const items = [
        ...data.dueLearning.map(mapProgress),
        ...mixNewWithReviews(data.reviews.map(mapProgress), fresh),
        ...data.learnAhead.map(mapProgress),
    ];
    const future = await srsRepo.nextFutureDue(
        userId,
        deckId,
        now,
        data.learnAhead.map((p) => p.cardId),
    );
    return {
        items,
        counts: {
            new: fresh.length,
            learning: data.dueLearning.length + data.learnAhead.length,
            review: data.reviews.length,
        },
        nextDueAt: future?.nextReviewAt.toISOString() ?? null,
        newAvailable: Math.max(0, data.newTotal - fresh.length),
        limits: { newPerDay: ANKI_DEFAULTS.newPerDay, newIntroducedToday: introduced },
    };
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
