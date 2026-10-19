/**
 * Mnemio spaced-repetition engine (SM-2 family). Behaviour spec and
 * provenance: docs/srs-algorithm.md.
 */
import { createHash } from 'node:crypto';

export const DAY_SECS = 86_400;

export const SRS_DEFAULTS = {
    learnSteps: [1, 10],
    relearnSteps: [10],
    graduatingInterval: 1,
    easyInterval: 4,
    startingEase: 2.5,
    easyBonus: 1.3,
    hardInterval: 1.2,
    intervalModifier: 1,
    lapseInterval: 0,
    minimumLapseInterval: 1,
    maximumInterval: 36500,
    leechThreshold: 8,
    newPerDay: 20,
    reviewsPerDay: 200,
    learnAheadMinutes: 20,
    rolloverHour: 4,
} as const;

export type SrsSettings = {
    learnSteps: readonly number[]; // minutes
    relearnSteps: readonly number[]; // minutes
    graduatingInterval: number;
    easyInterval: number;
    startingEase: number;
    easyBonus: number;
    hardInterval: number;
    intervalModifier: number;
    lapseInterval: number;
    minimumLapseInterval: number;
    maximumInterval: number;
    leechThreshold: number;
};

export type Rating = 'again' | 'hard' | 'good' | 'easy';
export type SrsPhase = 'new' | 'learning' | 'review' | 'relearning';

export type SrsMemory = {
    phase: SrsPhase;
    stepsLeft: number;
    stepSecs: number;
    intervalDays: number;
    daysSinceReview: number;
    ease: number;
    lapses: number;
    leeched: boolean;
};

export type SrsOptions = Record<Rating, SrsMemory>;

const MIN_EASE = 1.3;
const MAX_SECS = 2 ** 32 - 1;

export const newMemory = (settings: SrsSettings = SRS_DEFAULTS): SrsMemory => ({
    phase: 'new',
    stepsLeft: 0,
    stepSecs: 0,
    intervalDays: 0,
    daysSinceReview: 0,
    ease: settings.startingEase,
    lapses: 0,
    leeched: false,
});

// Four decimals keep stored values free of float noise (2.3, not 2.2999999523).
const tidyEase = (ease: number): number => Math.max(MIN_EASE, Math.round(ease * 10_000) / 10_000);

// ---------- Random factor ----------

/** Deterministic [0, 1) factor per card and answer, so a preview matches the real answer. */
export const fuzzFactor = (cardId: string, reps: number): number =>
    createHash('sha256').update(`${cardId}:${reps}`).digest().readUInt32BE(0) / 2 ** 32;

const checkFactor = (factor: number): void => {
    if (!(factor >= 0 && factor < 1)) {
        throw new RangeError(`fuzz factor must be in [0, 1), got ${factor}`);
    }
};

/** Random extra for an intraday learning delay: up to a quarter of it, at most 5 minutes. */
export const jitterStep = (secs: number, factor: number | null): number => {
    if (factor === null) {
        return secs;
    }
    checkFactor(factor);
    return secs + Math.floor(factor * Math.min(Math.floor(secs / 4), 300));
};

// ---------- Interval fuzz ----------

const fuzzSpread = (days: number): number =>
    1 +
    0.15 * Math.max(0, Math.min(days, 7) - 2.5) +
    0.1 * Math.max(0, Math.min(days, 20) - 7) +
    0.05 * Math.max(0, days - 20);

/** Whole-day range an interval may land in, after the min/max limits. */
export const fuzzRange = (days: number, min: number, max: number): [number, number] => {
    const lo = Math.min(min, max);
    const target = Math.min(Math.max(days, lo), max);
    if (target < 2.5) {
        const exact = Math.round(target);
        return [exact, exact];
    }
    const spread = fuzzSpread(target);
    const clamp = (n: number) => Math.min(Math.max(Math.round(n), lo), max);
    return [clamp(target - spread), clamp(target + spread)];
};

/** Final whole-day interval: exact when factor is null, otherwise a pick from the fuzz range. */
export const pickInterval = (
    days: number,
    min: number,
    max: number,
    factor: number | null,
): number => {
    if (factor === null) {
        const lo = Math.min(min, max);
        return Math.round(Math.min(Math.max(days, lo), max));
    }
    checkFactor(factor);
    const [lower, upper] = fuzzRange(days, min, max);
    return Math.floor(lower + factor * (1 + upper - lower));
};

// ---------- Learning steps ----------

const toSecs = (minutes: number): number =>
    Math.min(Math.max(Math.trunc(minutes * 60), 0), MAX_SECS);

const roundToDays = (secs: number): number =>
    secs > DAY_SECS ? Math.round(secs / DAY_SECS) * DAY_SECS : secs;

const position = (steps: readonly number[], stepsLeft: number): number =>
    Math.min(Math.max(steps.length - stepsLeft, 0), steps.length - 1);

/** Delay for Hard on the given position, or null when there are no steps. */
export const hardStepSecs = (steps: readonly number[], stepsLeft: number): number | null => {
    const first = steps[0];
    if (first === undefined) {
        return null;
    }
    const at = position(steps, stepsLeft);
    if (at > 0) {
        return toSecs(steps[at] ?? first);
    }
    const second = steps[1];
    const secs =
        second === undefined
            ? Math.min(toSecs(first) * 1.5, toSecs(first) + DAY_SECS)
            : (toSecs(first) + toSecs(second)) / 2;
    return roundToDays(Math.trunc(secs));
};

/** Delay of the step after the current one, or null when Good graduates. */
export const nextStepSecs = (steps: readonly number[], stepsLeft: number): number | null => {
    if (steps.length === 0) {
        return null;
    }
    const next = steps[position(steps, stepsLeft) + 1];
    return next === undefined ? null : toSecs(next);
};

// ---------- Leeches ----------

/** A lapse is a leech at the threshold and every half threshold (rounded up) after it. */
export const isLeech = (lapses: number, threshold: number): boolean => {
    if (threshold <= 0 || lapses < threshold) {
        return false;
    }
    return (lapses - threshold) % Math.max(Math.ceil(threshold / 2), 1) === 0;
};

// ---------- Review intervals ----------

/** Hard, Good and Easy intervals for a card in review. */
export const reviewIntervals = (
    card: Pick<SrsMemory, 'intervalDays' | 'daysSinceReview' | 'ease'>,
    s: SrsSettings,
    factor: number | null,
): [number, number, number] => {
    const { intervalDays: scheduled, daysSinceReview: elapsed } = card;
    // Older rows may hold binary32 noise (3.0999999); 3.1 × 25 must round to 78, not 77.
    const ease = tidyEase(card.ease);
    const ivl = Math.max(scheduled, 1);
    const max = s.maximumInterval;
    const scale = s.intervalModifier;

    if (elapsed < scheduled) {
        const hardBase = Math.max(elapsed * s.hardInterval, (ivl * s.hardInterval) / 2);
        const goodBase = Math.max(elapsed * ease, ivl);
        const easyBonus = s.easyBonus - (s.easyBonus - 1) / 2;
        return [hardBase, goodBase, goodBase * easyBonus].map((days) =>
            pickInterval(days * scale, 1, max, null),
        ) as [number, number, number];
    }

    const late = elapsed - scheduled;
    const hardMin = s.hardInterval > 1 ? scheduled + 1 : 1;
    const hard = pickInterval(ivl * s.hardInterval * scale, hardMin, max, factor);
    const goodMin = s.hardInterval > 1 ? hard + 1 : scheduled + 1;
    const good = pickInterval((ivl + late / 2) * ease * scale, goodMin, max, factor);
    const easy = pickInterval((ivl + late) * ease * s.easyBonus * scale, good + 1, max, factor);
    return [hard, good, easy];
};

// ---------- Transitions ----------

/** Interval a forgotten card returns to once it is relearned. */
const lapseIntervalDays = (ivl: number, s: SrsSettings, factor: number | null): number =>
    pickInterval(ivl * s.lapseInterval, s.minimumLapseInterval, s.maximumInterval, factor);

const graduated = (base: SrsMemory, intervalDays: number, ease: number): SrsMemory => ({
    ...base,
    phase: 'review',
    stepsLeft: 0,
    stepSecs: 0,
    intervalDays,
    daysSinceReview: 0,
    ease: tidyEase(ease),
});

const stepping = (base: SrsMemory, stepsLeft: number, stepSecs: number): SrsMemory => ({
    ...base,
    stepsLeft,
    stepSecs,
    daysSinceReview: 0,
});

const learningOptions = (card: SrsMemory, s: SrsSettings, factor: number | null): SrsOptions => {
    const steps = s.learnSteps;
    const stepsLeft = card.phase === 'new' ? steps.length : card.stepsLeft;
    const base: SrsMemory = { ...card, phase: 'learning', ease: s.startingEase };
    const good = pickInterval(s.graduatingInterval, 1, s.maximumInterval, factor);
    const easy = pickInterval(s.easyInterval, 1, s.maximumInterval, factor);
    const graduateGood = graduated(base, good, s.startingEase);
    const first = steps[0];
    const hard = hardStepSecs(steps, stepsLeft);
    const next = nextStepSecs(steps, stepsLeft);
    return {
        again: first === undefined ? graduateGood : stepping(base, steps.length, toSecs(first)),
        hard: hard === null ? graduateGood : stepping(base, stepsLeft, hard),
        good: next === null ? graduateGood : stepping(base, stepsLeft - 1, next),
        easy: graduated(base, easy, s.startingEase),
    };
};

const relearningOptions = (card: SrsMemory, s: SrsSettings, factor: number | null): SrsOptions => {
    const steps = s.relearnSteps;
    const base: SrsMemory = { ...card, phase: 'relearning' };
    // The saved interval was already lapsed and limited when the card was forgotten.
    const graduateGood = graduated(base, card.intervalDays, card.ease);
    const first = steps[0];
    const hard = hardStepSecs(steps, card.stepsLeft);
    const next = nextStepSecs(steps, card.stepsLeft);
    const restart: SrsMemory = {
        ...base,
        intervalDays: lapseIntervalDays(card.intervalDays, s, factor),
    };
    return {
        again: first === undefined ? graduateGood : stepping(restart, steps.length, toSecs(first)),
        hard: hard === null ? graduateGood : stepping(base, card.stepsLeft, hard),
        good: next === null ? graduateGood : stepping(base, card.stepsLeft - 1, next),
        easy: graduated(base, card.intervalDays + 1, card.ease),
    };
};

const reviewOptions = (card: SrsMemory, s: SrsSettings, factor: number | null): SrsOptions => {
    const [hard, good, easy] = reviewIntervals(card, s, factor);
    const base: SrsMemory = { ...card, leeched: false };

    const lapses = card.lapses + 1;
    const lapsed: SrsMemory = {
        ...card,
        intervalDays: lapseIntervalDays(card.intervalDays, s, factor),
        daysSinceReview: 0,
        ease: tidyEase(card.ease - 0.2),
        lapses,
        leeched: isLeech(lapses, s.leechThreshold),
    };
    const first = s.relearnSteps[0];
    return {
        again:
            first === undefined
                ? { ...lapsed, phase: 'review' }
                : {
                      ...lapsed,
                      phase: 'relearning',
                      stepsLeft: s.relearnSteps.length,
                      stepSecs: toSecs(first),
                  },
        hard: graduated(base, hard, card.ease - 0.15),
        good: graduated(base, good, card.ease),
        easy: graduated(base, easy, card.ease + 0.15),
    };
};

/** What each answer would do to the card. `factor` is a fuzz factor in [0, 1), or null for none. */
export const answerOptions = (
    card: SrsMemory,
    settings: SrsSettings = SRS_DEFAULTS,
    factor: number | null = null,
): SrsOptions => {
    switch (card.phase) {
        case 'new':
        case 'learning':
            return learningOptions(card, settings, factor);
        case 'relearning':
            return relearningOptions(card, settings, factor);
        case 'review':
            return reviewOptions(card, settings, factor);
    }
};
