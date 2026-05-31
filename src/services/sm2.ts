// Pure SM-2 implementation. Mirrors the frontend's useSpacedRepetition.
// No side effects, no DB access — safe to unit-test.

export type Quality = 0 | 1 | 2 | 3 | 4 | 5;

export type SrsState = {
    repetitions: number;
    interval: number; // in days
    easeFactor: number;
    lastReviewedAt: Date | null;
    nextReviewAt: Date;
};

const MIN_EF = 1.3;

export const initialState = (now: Date = new Date()): SrsState => ({
    repetitions: 0,
    interval: 0,
    easeFactor: 2.5,
    lastReviewedAt: null,
    nextReviewAt: now,
});

const addDays = (date: Date, days: number): Date => {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
};

export const review = (state: SrsState, quality: Quality, now: Date = new Date()): SrsState => {
    if (quality < 3) {
        // Failed recall: reset progress; review again tomorrow.
        return {
            repetitions: 0,
            interval: 1,
            easeFactor: Math.max(MIN_EF, state.easeFactor - 0.2),
            lastReviewedAt: now,
            nextReviewAt: addDays(now, 1),
        };
    }

    // Successful recall: advance schedule.
    const nextRepetitions = state.repetitions + 1;
    let nextInterval: number;
    if (nextRepetitions === 1) nextInterval = 1;
    else if (nextRepetitions === 2) nextInterval = 6;
    else nextInterval = Math.round(state.interval * state.easeFactor);

    const nextEase = Math.max(
        MIN_EF,
        state.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
    );

    return {
        repetitions: nextRepetitions,
        interval: nextInterval,
        easeFactor: nextEase,
        lastReviewedAt: now,
        nextReviewAt: addDays(now, nextInterval),
    };
};
