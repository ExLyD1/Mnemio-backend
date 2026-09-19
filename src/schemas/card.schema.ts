import { z } from 'zod';

export const CARD_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const CARD_TYPES = ['basic', 'cloze', 'image'] as const;

// Optional text fields are nullable so the client has a wire representation for
// "clear this field". `undefined` means "leave alone"; `null` means "erase".
const optionalShortText = (max: number) => z.string().trim().max(max).nullish();

// Media lives behind MEDIA_PUBLIC_BASE, which defaults to the app-relative
// '/media' — a plain z.string().url() rejected every upload this app produces,
// so attaching an image or audio file 400'd after the file was already written.
// Accept an absolute http(s) URL (remote/CDN storage) or a root-relative path.
const mediaUrl = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .refine(
            (v) => {
                if (v.startsWith('/')) return !v.startsWith('//');
                try {
                    const { protocol } = new URL(v);
                    return protocol === 'http:' || protocol === 'https:';
                } catch {
                    return false;
                }
            },
            { message: 'Must be an http(s) URL or a root-relative path' },
        )
        .nullish();

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
    audioUrl: mediaUrl(2048),
    imageUrl: mediaUrl(2048),
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
