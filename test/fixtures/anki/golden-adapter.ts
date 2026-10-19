// Maps the recorded reference transitions (Anki field names) onto Mnemio's SrsMemory.
import type { Rating, SrsMemory, SrsSettings } from '../../../src/services/srs-engine.js';

type RefLearn = { kind: 'LearnState'; remaining_steps: number; scheduled_secs: number };
type RefReview = {
    kind: 'ReviewState';
    scheduled_days: number;
    elapsed_days: number;
    ease_factor: number;
    lapses: number;
    leeched: boolean;
};
export type RefState =
    | { kind: 'NewState' }
    | RefLearn
    | RefReview
    | { kind: 'RelearnState'; learning: RefLearn; review: RefReview };
export type RefCase = {
    state: RefState;
    ctx: Record<string, unknown> & { fuzz_factor: number | null };
    next: Record<Rating, RefState>;
};

export const settingsFrom = (ctx: RefCase['ctx']): SrsSettings => ({
    learnSteps: ctx.steps as number[],
    relearnSteps: ctx.relearn_steps as number[],
    graduatingInterval: ctx.graduating_interval_good as number,
    easyInterval: ctx.graduating_interval_easy as number,
    startingEase: ctx.initial_ease_factor as number,
    easyBonus: ctx.easy_multiplier as number,
    hardInterval: ctx.hard_multiplier as number,
    intervalModifier: ctx.interval_multiplier as number,
    lapseInterval: ctx.lapse_multiplier as number,
    minimumLapseInterval: ctx.minimum_lapse_interval as number,
    maximumInterval: ctx.maximum_review_interval as number,
    leechThreshold: ctx.leech_threshold as number,
});

const reviewPart = (r: RefReview) => ({
    intervalDays: r.scheduled_days,
    daysSinceReview: r.elapsed_days,
    ease: r.ease_factor,
    lapses: r.lapses,
    leeched: r.leeched,
});
const noReview = { intervalDays: 0, daysSinceReview: 0, ease: 0, lapses: 0, leeched: false };

export const memoryFrom = (s: RefState, startingEase: number): SrsMemory => {
    switch (s.kind) {
        case 'NewState':
            return { phase: 'new', stepsLeft: 0, stepSecs: 0, ...noReview, ease: startingEase };
        case 'LearnState':
            return {
                phase: 'learning',
                stepsLeft: s.remaining_steps,
                stepSecs: s.scheduled_secs,
                ...noReview,
                ease: startingEase,
            };
        case 'ReviewState':
            return { phase: 'review', stepsLeft: 0, stepSecs: 0, ...reviewPart(s) };
        case 'RelearnState':
            return {
                phase: 'relearning',
                stepsLeft: s.learning.remaining_steps,
                stepSecs: s.learning.scheduled_secs,
                ...reviewPart(s.review),
            };
    }
};

/** The fields an answer is judged on; ease to 4 decimals (the reference stores binary32 values). */
export const comparable = (m: SrsMemory) =>
    m.phase === 'learning'
        ? { phase: m.phase, stepsLeft: m.stepsLeft, stepSecs: m.stepSecs }
        : {
              phase: m.phase,
              ...(m.phase === 'relearning' ? { stepsLeft: m.stepsLeft, stepSecs: m.stepSecs } : {}),
              intervalDays: m.intervalDays,
              ease: Math.round(m.ease * 10_000) / 10_000,
              lapses: m.lapses,
              leeched: m.leeched,
          };
