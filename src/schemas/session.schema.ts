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
    })
    .refine((v) => v.cardIndex !== undefined || v.correct !== undefined, {
        message: 'At least one of cardIndex or correct is required',
    });

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
