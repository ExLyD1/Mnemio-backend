import { z } from 'zod';

export const SESSION_MODES = ['flashcard', 'multiple_choice', 'srs'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const createSessionSchema = z.object({
    deckId: z.string().uuid(),
    mode: z.enum(SESSION_MODES),
});

export const updateSessionSchema = z
    .object({
        cardIndex: z.number().int().nonnegative().optional(),
        correct: z.number().int().nonnegative().optional(),
        // Server-backed Session Summary fields. All optional; FE patches
        // incrementally as it ticks through cards.
        counts: z
            .object({
                again: z.number().int().nonnegative(),
                hard: z.number().int().nonnegative(),
                good: z.number().int().nonnegative(),
                easy: z.number().int().nonnegative(),
            })
            .optional(),
        revisitCardIds: z.array(z.string().uuid()).max(1000).optional(),
        durationMs: z.number().int().nonnegative().optional(),
    })
    .refine(
        (v) =>
            v.cardIndex !== undefined ||
            v.correct !== undefined ||
            v.counts !== undefined ||
            v.revisitCardIds !== undefined ||
            v.durationMs !== undefined,
        { message: 'At least one updatable field is required' },
    );

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
