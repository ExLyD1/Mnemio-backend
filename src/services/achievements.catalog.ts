/**
 * Achievement catalog. Single source of truth — no DB rows needed beyond the
 * per-user `user_achievements` table.
 *
 * Each criterion is evaluated at certain trigger points (see
 * achievements.service.ts). `progress(stats) → 0..100` lets the FE render
 * progress bars even before the achievement is earned.
 */
export type AchievementTriggers =
    | 'session_complete'   // fired from POST /sessions/:id/complete
    | 'rate'               // fired from POST /srs/rate
    | 'card_create';       // fired from POST /decks/:id/cards (single + bulk)

export type AchievementStats = {
    sessionsCompleted: number;
    cardsRated: number;
    cardsCreated: number;
    perfectSessions: number;          // 100% accuracy, ≥5 cards
    distinctTargetLanguages: number;  // # of distinct target langs across owned decks
};

export type AchievementDef = {
    key: string;
    name: string;
    description: string;
    iconKey: string;                 // FE owns the actual asset mapping
    triggers: AchievementTriggers[];
    isEarned: (s: AchievementStats) => boolean;
    progress: (s: AchievementStats) => number;
};

const pct = (cur: number, target: number) =>
    target <= 0 ? 0 : Math.min(100, Math.round((cur / target) * 100));

export const ACHIEVEMENTS: readonly AchievementDef[] = [
    {
        key: 'first_steps',
        name: 'First steps',
        description: 'Complete your first study session.',
        iconKey: 'first_steps',
        triggers: ['session_complete'],
        isEarned: (s) => s.sessionsCompleted >= 1,
        progress: (s) => pct(s.sessionsCompleted, 1),
    },
    {
        key: 'quick_learner',
        name: 'Quick learner',
        description: 'Complete 5 study sessions.',
        iconKey: 'quick_learner',
        triggers: ['session_complete'],
        isEarned: (s) => s.sessionsCompleted >= 5,
        progress: (s) => pct(s.sessionsCompleted, 5),
    },
    {
        key: 'marathoner',
        name: 'Marathoner',
        description: 'Complete 25 study sessions.',
        iconKey: 'marathoner',
        triggers: ['session_complete'],
        isEarned: (s) => s.sessionsCompleted >= 25,
        progress: (s) => pct(s.sessionsCompleted, 25),
    },
    {
        key: 'accuracy_ace',
        name: 'Accuracy ace',
        description: 'Finish a session with 100% accuracy on at least 5 cards.',
        iconKey: 'accuracy_ace',
        triggers: ['session_complete'],
        isEarned: (s) => s.perfectSessions >= 1,
        progress: (s) => pct(s.perfectSessions, 1),
    },
    {
        key: 'reviewer_100',
        name: 'Centurion',
        description: 'Rate 100 cards.',
        iconKey: 'reviewer_100',
        triggers: ['rate'],
        isEarned: (s) => s.cardsRated >= 100,
        progress: (s) => pct(s.cardsRated, 100),
    },
    {
        key: 'builder_50',
        name: 'Deck builder',
        description: 'Create 50 cards.',
        iconKey: 'builder_50',
        triggers: ['card_create'],
        isEarned: (s) => s.cardsCreated >= 50,
        progress: (s) => pct(s.cardsCreated, 50),
    },
    {
        key: 'polyglot',
        name: 'Polyglot',
        description: 'Study decks in 3 different target languages.',
        iconKey: 'polyglot',
        triggers: ['session_complete', 'card_create'],
        isEarned: (s) => s.distinctTargetLanguages >= 3,
        progress: (s) => pct(s.distinctTargetLanguages, 3),
    },
] as const;

export const ACHIEVEMENT_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));
