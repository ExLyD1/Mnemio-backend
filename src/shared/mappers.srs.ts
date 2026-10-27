import type { CardProgressModel } from '../../generated/prisma/models/CardProgress.js';
import type { Rating, SrsMemory, SrsOptions } from '../services/srs-engine.js';

export type SrsState = 'new' | 'learning' | 'review' | 'relearning';
export type IntervalPreview = { kind: 'secs' | 'days'; value: number };
export type Previews = Record<Rating, IntervalPreview>;
export type PublicCardProgress = {
    cardId: string;
    deckId?: string;
    repetitions: number;
    interval: number;
    easeFactor: number;
    nextReviewAt: string;
    lastReviewedAt: string | null;
    state: SrsState;
    lapses: number;
    leeched: boolean;
    remainingSteps: number;
    reps: number;
};
export const toPublicProgress = (p: CardProgressModel, deckId?: string): PublicCardProgress => ({
    cardId: p.cardId,
    ...(deckId ? { deckId } : {}),
    repetitions: p.repetitions,
    interval: p.interval,
    easeFactor: p.easeFactor,
    nextReviewAt: p.nextReviewAt.toISOString(),
    lastReviewedAt: p.lastReviewedAt?.toISOString() ?? null,
    state: p.state as SrsState,
    lapses: p.lapses,
    leeched: p.leeched,
    remainingSteps: p.remainingSteps,
    reps: p.reps,
});
const intervalPreview = (m: SrsMemory): IntervalPreview =>
    m.phase === 'review'
        ? { kind: 'days', value: m.intervalDays }
        : { kind: 'secs', value: m.stepSecs };
export const toPreviews = (options: SrsOptions): Previews => ({
    again: intervalPreview(options.again),
    hard: intervalPreview(options.hard),
    good: intervalPreview(options.good),
    easy: intervalPreview(options.easy),
});
