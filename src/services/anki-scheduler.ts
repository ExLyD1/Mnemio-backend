/** SM-2 state path ported from anki_sched.py / Anki scheduler states.
 * Derived from Ankitects Pty Ltd and contributors, AGPL-3.0-or-later.
 * Keep f32 boundaries explicit: JS doubles otherwise change interval rounding.
 */
import { createHash } from 'node:crypto';

export const DAY = 86_400;
const U32_MAX = 2 ** 32 - 1;
const f32 = Math.fround;
export const ANKI_DEFAULTS = {
    learnSteps: [1, 10],
    relearnSteps: [10],
    graduatingGood: 1,
    graduatingEasy: 4,
    startingEase: 2.5,
    easyBonus: 1.3,
    hardMultiplier: 1.2,
    intervalModifier: 1,
    lapseMultiplier: 0,
    minimumLapseInterval: 1,
    maximumInterval: 36500,
    leechThreshold: 8,
    newPerDay: 20,
    reviewsPerDay: 200,
    learnAheadMinutes: 20,
    rolloverHour: 4,
} as const;

export type NewState = { kind: 'NewState'; position: number };
export type LearnState = {
    kind: 'LearnState';
    remaining_steps: number;
    scheduled_secs: number;
    elapsed_secs: number;
};
export type ReviewState = {
    kind: 'ReviewState';
    scheduled_days: number;
    elapsed_days: number;
    ease_factor: number;
    lapses: number;
    leeched: boolean;
};
export type RelearnState = { kind: 'RelearnState'; learning: LearnState; review: ReviewState };
export type CardState = NewState | LearnState | ReviewState | RelearnState;
export type Rating = 'again' | 'hard' | 'good' | 'easy';
export type SchedulingStates = Record<Rating, CardState> & { current: CardState };
export type StateContext = {
    fuzz_factor: number | null;
    steps: readonly number[];
    relearn_steps: readonly number[];
    graduating_interval_good: number;
    graduating_interval_easy: number;
    initial_ease_factor: number;
    hard_multiplier: number;
    easy_multiplier: number;
    interval_multiplier: number;
    maximum_review_interval: number;
    leech_threshold: number;
    lapse_multiplier: number;
    minimum_lapse_interval: number;
};
export const defaultContext = (patch: Partial<StateContext> = {}): StateContext => ({
    fuzz_factor: null,
    steps: ANKI_DEFAULTS.learnSteps,
    relearn_steps: ANKI_DEFAULTS.relearnSteps,
    graduating_interval_good: ANKI_DEFAULTS.graduatingGood,
    graduating_interval_easy: ANKI_DEFAULTS.graduatingEasy,
    initial_ease_factor: ANKI_DEFAULTS.startingEase,
    hard_multiplier: ANKI_DEFAULTS.hardMultiplier,
    easy_multiplier: ANKI_DEFAULTS.easyBonus,
    interval_multiplier: ANKI_DEFAULTS.intervalModifier,
    maximum_review_interval: ANKI_DEFAULTS.maximumInterval,
    leech_threshold: ANKI_DEFAULTS.leechThreshold,
    lapse_multiplier: ANKI_DEFAULTS.lapseMultiplier,
    minimum_lapse_interval: ANKI_DEFAULTS.minimumLapseInterval,
    ...patch,
});

export const rustRound = (value: number): number =>
    value < 0 ? -Math.round(-value) : Math.round(value);
export const asU32 = (value: number): number =>
    Number.isNaN(value) || value <= 0 ? 0 : Math.min(Math.trunc(value), U32_MAX);
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(n, max));
export const fuzzFactorFor = (cardId: string, reps: number): number =>
    f32(createHash('sha256').update(`${cardId}:${reps}`).digest().readUInt32BE(0) / 2 ** 32);
const validateFuzz = (factor: number | null) => {
    // fround may round the deterministic hash quantile up to 1. Clamp at the call site.
    if (factor !== null && !(factor >= 0 && factor < 1)) {
        throw new RangeError('fuzz_factor must be in [0, 1), or null');
    }
};
export const fuzzBounds = (input: number): [number, number] => {
    const interval = f32(input);
    let delta = interval < 2.5 ? 0 : 1;
    if (interval >= 2.5) {
        for (const [start, end, factor] of [
            [2.5, 7, 0.15],
            [7, 20, 0.1],
            [20, Infinity, 0.05],
        ] as const) {
            delta = f32(
                delta + f32(f32(factor) * Math.max(0, f32(Math.min(interval, end) - start))),
            );
        }
    }
    return [asU32(rustRound(f32(interval - delta))), asU32(rustRound(f32(interval + delta)))];
};
export const constrainedFuzzBounds = (
    input: number,
    minimum: number,
    maximum: number,
): [number, number] => {
    minimum = Math.min(minimum, maximum);
    const [lo, hi] = fuzzBounds(clamp(f32(input), f32(minimum), f32(maximum)));
    const lower = clamp(lo, minimum, maximum);
    let upper = clamp(hi, minimum, maximum);
    if (upper === lower && upper > 2 && upper < maximum) {
        upper = lower + 1;
    }
    return [lower, upper];
};
export const withReviewFuzz = (
    factor: number | null,
    interval: number,
    minimum: number,
    maximum: number,
): number => {
    validateFuzz(factor);
    if (factor === null) {
        return clamp(asU32(rustRound(f32(interval))), minimum, maximum);
    }
    const [lower, upper] = constrainedFuzzBounds(interval, minimum, maximum);
    return asU32(Math.floor(f32(f32(lower) + f32(f32(factor) * f32(1 + upper - lower)))));
};
export const minimumReviewFuzzInterval = (
    interval: number,
    previous: number,
    maximum: number,
): number => {
    const rounded = asU32(rustRound(f32(interval)));
    const [, upper] = constrainedFuzzBounds(interval, 1, maximum);
    return rounded > previous ? previous + 1 : previous <= upper ? previous : 0;
};
export const learningIvlWithFuzz = (factor: number | null, secs: number): number => {
    validateFuzz(factor);
    const width = asU32(Math.floor(Math.min(secs * 0.25, 300)));
    return factor === null || width === 0 ? secs : secs + Math.floor(factor * width);
};
export const maybeRoundInDays = (secs: number): number =>
    secs > DAY ? Math.min(asU32(rustRound(f32(f32(secs) / DAY))) * DAY, U32_MAX) : secs;

export class LearningSteps {
    constructor(readonly steps: readonly number[] = []) {}
    getIndex(remaining: number): number {
        return Math.min(
            Math.max(this.steps.length - (remaining % 1000), 0),
            Math.max(this.steps.length - 1, 0),
        );
    }
    secsAtIndex(index: number): number | null {
        const minutes = this.steps[index];
        return minutes === undefined ? null : asU32(f32(f32(minutes) * 60));
    }
    againDelaySecsLearn(): number | null {
        return this.secsAtIndex(0);
    }
    hardDelaySecs(remaining: number): number | null {
        const idx = this.getIndex(remaining);
        const current = this.secsAtIndex(idx) ?? this.secsAtIndex(0);
        if (current === null || idx !== 0) {
            return current;
        }
        const following = this.secsAtIndex(1);
        return maybeRoundInDays(
            following === null
                ? Math.min(
                      Math.floor(Math.min(current * 3, U32_MAX) / 2),
                      Math.min(current + DAY, U32_MAX),
                  )
                : Math.floor(Math.min(current + following, U32_MAX) / 2),
        );
    }
    goodDelaySecs(remaining: number): number | null {
        return this.secsAtIndex(this.getIndex(remaining) + 1);
    }
    currentDelaySecs(remaining: number): number {
        return this.secsAtIndex(this.getIndex(remaining)) ?? 0;
    }
    remainingForGood(remaining: number): number {
        return Math.max(this.steps.length - this.getIndex(remaining) - 1, 0);
    }
    remainingForFailed(): number {
        return this.steps.length;
    }
}
export const leechThresholdMet = (lapses: number, threshold: number): boolean =>
    threshold !== 0 &&
    lapses >= threshold &&
    (lapses - threshold) % Math.max(Math.ceil(f32(f32(threshold) / 2)), 1) === 0;
const minMax = (ctx: StateContext, minimum: number): [number, number] => {
    const max = Math.max(ctx.maximum_review_interval, 1);
    return [clamp(minimum, 1, max), max];
};
const constrainPassing = (ctx: StateContext, input: number, min: number, fuzz: boolean): number => {
    const interval = f32(f32(input) * f32(ctx.interval_multiplier));
    const [minimum, maximum] = minMax(ctx, min);
    return fuzz
        ? withReviewFuzz(ctx.fuzz_factor, interval, minimum, maximum)
        : clamp(asU32(rustRound(interval)), minimum, maximum);
};
export const passingReviewIntervals = (
    state: ReviewState,
    ctx: StateContext,
): [number, number, number] => {
    const current = Math.max(f32(state.scheduled_days), 1);
    const ease = f32(state.ease_factor);
    const hardFactor = f32(ctx.hard_multiplier),
        easyFactor = f32(ctx.easy_multiplier);
    if (state.elapsed_days < state.scheduled_days) {
        const elapsed = f32(state.elapsed_days);
        const hard = constrainPassing(
            ctx,
            Math.max(f32(elapsed * hardFactor), f32(current * f32(hardFactor / 2))),
            0,
            false,
        );
        const goodBase = Math.max(f32(elapsed * ease), current);
        const good = constrainPassing(ctx, goodBase, 0, false);
        const bonus = f32(easyFactor - f32(f32(easyFactor - 1) / 2));
        return [hard, good, constrainPassing(ctx, f32(goodBase * bonus), 0, false)];
    }
    const late = f32(Math.max(state.elapsed_days - state.scheduled_days, 0));
    const hard = constrainPassing(
        ctx,
        f32(current * hardFactor),
        hardFactor <= 1 ? 0 : state.scheduled_days + 1,
        true,
    );
    const good = constrainPassing(
        ctx,
        f32(f32(current + f32(late / 2)) * ease),
        hardFactor <= 1 ? state.scheduled_days + 1 : hard + 1,
        true,
    );
    const easy = constrainPassing(
        ctx,
        f32(f32(f32(current + late) * ease) * easyFactor),
        good + 1,
        true,
    );
    return [hard, good, easy];
};
const failingInterval = (state: ReviewState, ctx: StateContext): number => {
    const [min, max] = minMax(ctx, ctx.minimum_lapse_interval);
    return asU32(
        rustRound(
            f32(
                withReviewFuzz(
                    ctx.fuzz_factor,
                    f32(Math.max(f32(state.scheduled_days), 1) * f32(ctx.lapse_multiplier)),
                    min,
                    max,
                ),
            ),
        ),
    );
};
const learn = (remaining_steps: number, scheduled_secs: number, elapsed_secs = 0): LearnState => ({
    kind: 'LearnState',
    remaining_steps,
    scheduled_secs,
    elapsed_secs,
});
export const reviewState = (patch: Partial<Omit<ReviewState, 'kind'>> = {}): ReviewState => ({
    kind: 'ReviewState',
    scheduled_days: 0,
    elapsed_days: 0,
    lapses: 0,
    leeched: false,
    ...patch,
    ease_factor: f32(patch.ease_factor ?? 2.5),
});
const learnNext = (state: LearnState, ctx: StateContext): SchedulingStates => {
    const steps = new LearningSteps(ctx.steps);
    const graduate = (days: number): ReviewState => {
        const [min, max] = minMax(ctx, 1);
        return reviewState({
            scheduled_days: withReviewFuzz(ctx.fuzz_factor, days, min, max),
            ease_factor: ctx.initial_ease_factor,
        });
    };
    const again = steps.againDelaySecsLearn(),
        hard = steps.hardDelaySecs(state.remaining_steps),
        good = steps.goodDelaySecs(state.remaining_steps);
    return {
        current: state,
        again:
            again === null
                ? graduate(Math.max(ctx.graduating_interval_good, 1))
                : learn(steps.remainingForFailed(), again),
        hard:
            hard === null
                ? graduate(Math.max(ctx.graduating_interval_good, 1))
                : { ...state, scheduled_secs: hard, elapsed_secs: 0 },
        good:
            good === null
                ? graduate(Math.max(ctx.graduating_interval_good, 1))
                : learn(steps.remainingForGood(state.remaining_steps), good),
        easy: graduate(ctx.graduating_interval_easy),
    };
};
export const nextStates = (
    state: CardState,
    ctx: StateContext = defaultContext(),
): SchedulingStates => {
    validateFuzz(ctx.fuzz_factor);
    if (state.kind === 'NewState') {
        return { ...learnNext(learn(ctx.steps.length, 0), ctx), current: state };
    }
    if (state.kind === 'LearnState') {
        return learnNext(state, ctx);
    }
    if (state.kind === 'ReviewState') {
        const [hard, good, easy] = passingReviewIntervals(state, ctx);
        const lapses = state.lapses + 1;
        const failed = reviewState({
            scheduled_days: Math.max(failingInterval(state, ctx), 1),
            ease_factor: Math.max(f32(f32(state.ease_factor) - f32(0.2)), f32(1.3)),
            lapses,
            leeched: leechThresholdMet(lapses, ctx.leech_threshold),
        });
        const steps = new LearningSteps(ctx.relearn_steps),
            delay = steps.againDelaySecsLearn();
        return {
            current: state,
            again:
                delay === null
                    ? failed
                    : {
                          kind: 'RelearnState',
                          learning: learn(steps.remainingForFailed(), delay),
                          review: failed,
                      },
            hard: {
                ...state,
                scheduled_days: hard,
                elapsed_days: 0,
                ease_factor: Math.max(f32(f32(state.ease_factor) - f32(0.15)), f32(1.3)),
            },
            good: { ...state, scheduled_days: good, elapsed_days: 0 },
            easy: {
                ...state,
                scheduled_days: easy,
                elapsed_days: 0,
                ease_factor: f32(f32(state.ease_factor) + f32(0.15)),
            },
        };
    }
    const { learning, review } = state;
    const steps = new LearningSteps(ctx.relearn_steps);
    const again = steps.againDelaySecsLearn(),
        hard = steps.hardDelaySecs(learning.remaining_steps),
        good = steps.goodDelaySecs(learning.remaining_steps);
    return {
        current: state,
        again:
            again === null
                ? review
                : {
                      kind: 'RelearnState',
                      learning: learn(steps.remainingForFailed(), again),
                      review: {
                          ...review,
                          scheduled_days: Math.max(failingInterval(review, ctx), 1),
                          elapsed_days: 0,
                      },
                  },
        hard:
            hard === null
                ? review
                : {
                      kind: 'RelearnState',
                      learning: { ...learning, scheduled_secs: hard },
                      review: { ...review, elapsed_days: 0 },
                  },
        good:
            good === null
                ? review
                : {
                      kind: 'RelearnState',
                      learning: learn(steps.remainingForGood(learning.remaining_steps), good),
                      review: { ...review, elapsed_days: 0 },
                  },
        easy: { ...review, scheduled_days: review.scheduled_days + 1, elapsed_days: 0 },
    };
};
