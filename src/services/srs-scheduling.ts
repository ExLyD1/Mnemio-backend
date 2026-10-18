import type { CardProgressModel } from '../../generated/prisma/models/CardProgress.js';
import {
    DAY,
    defaultContext,
    fuzzFactorFor,
    learningIvlWithFuzz,
    nextStates,
    reviewState,
    type CardState,
    type Rating,
} from './anki-scheduler.js';
import { dayNumber, dueForDays, dueForStep } from './anki-time.js';
import { toPreviews } from '../shared/mappers.srs.js';

export const stateFromProgress = (
    p: CardProgressModel | null,
    now: Date,
    tz: string,
): CardState => {
    if (!p || p.state === 'new') {
        return { kind: 'NewState', position: 0 };
    }
    const elapsed_days = p.lastReviewedAt
        ? Math.max(0, dayNumber(now, tz) - dayNumber(p.lastReviewedAt, tz))
        : 0;
    const review = reviewState({
        scheduled_days: p.interval,
        elapsed_days,
        ease_factor: p.easeFactor,
        lapses: p.lapses,
        leeched: p.leeched,
    });
    const learning = {
        kind: 'LearnState' as const,
        remaining_steps: p.remainingSteps,
        scheduled_secs: p.learningStepSecs,
        elapsed_secs: p.lastReviewedAt
            ? Math.max(0, Math.floor((now.getTime() - p.lastReviewedAt.getTime()) / 1000))
            : 0,
    };
    if (p.state === 'learning') {
        return learning;
    }
    if (p.state === 'relearning') {
        return { kind: 'RelearnState', learning, review };
    }
    return review;
};
const contextFor = (id: string, reps: number) =>
    defaultContext({
        // A binary32 quantile can round to 1; retain the largest legal binary32 sample.
        fuzz_factor: Math.min(fuzzFactorFor(id, reps), 1 - 2 ** -24),
    });
export const previewsFor = (
    id: string,
    progress: CardProgressModel | null,
    now: Date,
    tz: string,
) =>
    toPreviews(
        nextStates(stateFromProgress(progress, now, tz), contextFor(id, progress?.reps ?? 0)),
    );

export const scheduleAnswer = (
    id: string,
    p: CardProgressModel | null,
    rating: Rating,
    now: Date,
    tz: string,
) => {
    const ctx = contextFor(id, p?.reps ?? 0);
    const next = nextStates(stateFromProgress(p, now, tz), ctx)[rating];
    const review =
        next.kind === 'RelearnState' ? next.review : next.kind === 'ReviewState' ? next : null;
    const learning =
        next.kind === 'RelearnState' ? next.learning : next.kind === 'LearnState' ? next : null;
    const secs = learning?.scheduled_secs ?? 0;
    const intraday = learning !== null && secs < DAY;
    return {
        state:
            next.kind === 'RelearnState'
                ? 'relearning'
                : next.kind === 'LearnState'
                  ? 'learning'
                  : 'review',
        remainingSteps: learning?.remaining_steps ?? 0,
        // Persist scheduled_secs without answering-layer fuzz, just like Anki.
        learningStepSecs: secs,
        interval: review?.scheduled_days ?? 0,
        easeFactor: review?.ease_factor ?? p?.easeFactor ?? 2.5,
        lapses: review?.lapses ?? p?.lapses ?? 0,
        leeched: review?.leeched ?? p?.leeched ?? false,
        reps: (p?.reps ?? 0) + 1,
        repetitions: rating === 'again' ? 0 : (p?.repetitions ?? 0) + 1,
        nextReviewAt: learning
            ? dueForStep(now, intraday ? learningIvlWithFuzz(ctx.fuzz_factor, secs) : secs, tz)
            : dueForDays(now, review?.scheduled_days ?? 1, tz),
        lastReviewedAt: now,
    };
};

/** Spread new cards through the review queue without changing either input order. */
export const mixNewWithReviews = <T>(reviews: T[], fresh: T[]): T[] => {
    const out: T[] = [];
    let reviewIdx = 0,
        newIdx = 0;
    const total = reviews.length + fresh.length;
    for (let i = 0; i < total; i++) {
        if (newIdx < fresh.length && Math.floor(((i + 1) * fresh.length) / total) > newIdx) {
            const item = fresh[newIdx++];
            if (item !== undefined) {
                out.push(item);
            }
        } else {
            const item = reviews[reviewIdx++];
            if (item !== undefined) {
                out.push(item);
            }
        }
    }
    return out;
};
