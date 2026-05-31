import { z } from 'zod';

export const RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type Rating = (typeof RATINGS)[number];

// SM-2 quality mapping (matches frontend useSpacedRepetition button → quality):
//   again = 0 (full reset), hard = 2 (subpar success → treated as fail by SM-2),
//   good  = 3 (default success), easy = 5 (perfect recall).
export const RATING_TO_QUALITY: Record<Rating, 0 | 1 | 2 | 3 | 4 | 5> = {
    again: 0,
    hard: 2,
    good: 3,
    easy: 5,
};

export const rateSchema = z.object({
    cardId: z.string().uuid(),
    rating: z.enum(RATINGS),
});

export const dueQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
});

export const progressQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(2000).optional(),
});

export type RateInput = z.infer<typeof rateSchema>;
export type DueQuery = z.infer<typeof dueQuerySchema>;
export type ProgressQuery = z.infer<typeof progressQuerySchema>;
