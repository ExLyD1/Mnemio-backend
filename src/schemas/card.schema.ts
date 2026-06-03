import { z } from 'zod';

export const CARD_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const CARD_TYPES = ['basic', 'cloze', 'image'] as const;

const optionalShortText = (max: number) => z.string().trim().max(max).optional();

export const cardBaseSchema = z.object({
    word: z.string().trim().min(1, 'Word is required').max(120),
    definition: z.string().trim().min(1, 'Definition is required').max(1000),
    phonetic: optionalShortText(120),
    reading: optionalShortText(120),
    partOfSpeech: optionalShortText(40),
    example: optionalShortText(500),
    exampleTranslation: optionalShortText(500),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    difficulty: z.enum(CARD_DIFFICULTIES).optional(),
    type: z.enum(CARD_TYPES).optional(),
    audioUrl: z.string().url().max(2048).optional(),
    imageUrl: z.string().url().max(2048).optional(),
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
