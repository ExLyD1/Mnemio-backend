import { z } from 'zod';

const langSchema = z
    .string()
    .trim()
    .min(2, 'Language code is required')
    .max(10);

// P2 cosmetic / discovery fields. All optional; default to null when unset.
const coverColorSchema = z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'coverColor must be a #RRGGBB hex string');
const glyphSchema = z.string().trim().min(1).max(8);     // emoji or short symbol
const subjectSchema = z.string().trim().min(1).max(40);  // e.g. 'languages', 'science'

export const deckBaseSchema = z.object({
    title: z.string().trim().min(2, 'Title must be at least 2 characters').max(120),
    description: z.string().trim().max(500).optional().default(''),
    sourceLanguage: langSchema,
    targetLanguage: langSchema,
    isPublic: z.boolean().optional(),
    coverColor: coverColorSchema.nullable().optional(),
    glyph: glyphSchema.nullable().optional(),
    subject: subjectSchema.nullable().optional(),
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
