import { z } from 'zod';

export const cardBaseSchema = z.object({
    word: z.string().trim().min(1, 'Word is required').max(120),
    definition: z.string().trim().min(1, 'Definition is required').max(1000),
    phonetic: z.string().trim().max(120).optional(),
});

export const createCardSchema = cardBaseSchema;

export const updateCardSchema = cardBaseSchema
    .extend({ position: z.number().int().nonnegative().optional() })
    .partial()
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
        message: 'At least one field is required',
    });

export const bulkCreateCardsSchema = z.object({
    cards: z.array(cardBaseSchema).min(1).max(100),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type BulkCreateCardsInput = z.infer<typeof bulkCreateCardsSchema>;
