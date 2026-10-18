import type { CardProgressModel } from '../../generated/prisma/models/CardProgress.js';
import type { CardState, SchedulingStates, Rating } from '../services/anki-scheduler.js';

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
const intervalPreview = (state: CardState): IntervalPreview => {
    if (state.kind === 'ReviewState') {
        return { kind: 'days', value: state.scheduled_days };
    }
    if (state.kind === 'RelearnState') {
        return { kind: 'secs', value: state.learning.scheduled_secs };
    }
    return { kind: 'secs', value: state.kind === 'LearnState' ? state.scheduled_secs : 0 };
};
export const toPreviews = (states: SchedulingStates): Previews => ({
    again: intervalPreview(states.again),
    hard: intervalPreview(states.hard),
    good: intervalPreview(states.good),
    easy: intervalPreview(states.easy),
});
