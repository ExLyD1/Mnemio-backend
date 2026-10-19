import type { CardProgressModel } from '../../generated/prisma/models/CardProgress.js';
import {
    DAY_SECS,
    answerOptions,
    fuzzFactor,
    jitterStep,
    newMemory,
    SRS_DEFAULTS,
    type Rating,
    type SrsMemory,
} from './srs-engine.js';
import { dayNumber, dueForDays, dueForStep } from './srs-clock.js';
import { toPreviews } from '../shared/mappers.srs.js';

export const memoryFromProgress = (
    p: CardProgressModel | null,
    now: Date,
    tz: string,
): SrsMemory => {
    if (!p || p.state === 'new') {
        return newMemory();
    }
    return {
        phase: p.state === 'learning' || p.state === 'relearning' ? p.state : 'review',
        stepsLeft: p.remainingSteps,
        stepSecs: p.learningStepSecs,
        intervalDays: p.interval,
        daysSinceReview: p.lastReviewedAt
            ? Math.max(0, dayNumber(now, tz) - dayNumber(p.lastReviewedAt, tz))
            : 0,
        ease: p.easeFactor,
        lapses: p.lapses,
        leeched: p.leeched,
    };
};

export const previewsFor = (
    id: string,
    progress: CardProgressModel | null,
    now: Date,
    tz: string,
) =>
    toPreviews(
        answerOptions(
            memoryFromProgress(progress, now, tz),
            SRS_DEFAULTS,
            fuzzFactor(id, progress?.reps ?? 0),
        ),
    );

export const scheduleAnswer = (
    id: string,
    p: CardProgressModel | null,
    rating: Rating,
    now: Date,
    tz: string,
) => {
    const factor = fuzzFactor(id, p?.reps ?? 0);
    const next = answerOptions(memoryFromProgress(p, now, tz), SRS_DEFAULTS, factor)[rating];
    const stepping = next.phase === 'learning' || next.phase === 'relearning';
    const secs = stepping ? next.stepSecs : 0;
    return {
        state: next.phase,
        remainingSteps: stepping ? next.stepsLeft : 0,
        // The stored step stays unjittered; only the due time gets the random extra.
        learningStepSecs: secs,
        interval: next.phase === 'learning' ? 0 : next.intervalDays,
        easeFactor: next.ease,
        lapses: next.lapses,
        leeched: next.leeched,
        reps: (p?.reps ?? 0) + 1,
        repetitions: rating === 'again' ? 0 : (p?.repetitions ?? 0) + 1,
        nextReviewAt: stepping
            ? dueForStep(now, secs < DAY_SECS ? jitterStep(secs, factor) : secs, tz)
            : dueForDays(now, next.intervalDays, tz),
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
