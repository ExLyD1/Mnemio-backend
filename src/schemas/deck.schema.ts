import { z } from 'zod';

const langSchema = z
    .string()
    .trim()
    .min(2, 'Language code is required')
    .max(10);

export const deckBaseSchema = z.object({
    title: z.string().trim().min(2, 'Title must be at least 2 characters').max(120),
    description: z.string().trim().max(500).optional().default(''),
    sourceLanguage: langSchema,
    targetLanguage: langSchema,
});

export const createDeckSchema = deckBaseSchema;

export const updateDeckSchema = deckBaseSchema
    .partial()
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
        message: 'At least one field is required',
    });

export const deckListQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    q: z.string().trim().max(120).optional(),
});

export const deckDetailQuerySchema = z.object({
    // Hard upper bound matches the FE per-deck cap of 1000.
    cardsLimit: z.coerce.number().int().positive().max(1000).optional(),
});

export type CreateDeckInput = z.infer<typeof createDeckSchema>;
export type UpdateDeckInput = z.infer<typeof updateDeckSchema>;
export type DeckListQuery = z.infer<typeof deckListQuerySchema>;
export type DeckDetailQuery = z.infer<typeof deckDetailQuerySchema>;
