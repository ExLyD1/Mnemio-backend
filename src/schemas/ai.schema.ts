import { z } from 'zod';

export const ENRICH_FIELDS = [
    'phonetic',
    'partOfSpeech',
    'example',
    'exampleTranslation',
    'tags',
    'difficulty',
] as const;

export const enrichWordsSchema = z.object({
    // Service-side de-dup + trim happens before the provider sees these; the
    // schema-level cap (200) is a safety net above the per-call env cap.
    words: z
        .array(z.string().trim().min(1).max(80))
        .min(1, 'words[] must contain at least one entry')
        .max(200),
    sourceLanguage: z.string().trim().min(2).max(10),
    targetLanguage: z.string().trim().min(2).max(10),
    context: z.string().trim().max(200).optional(),
    fields: z.array(z.enum(ENRICH_FIELDS)).optional(),
});

export const generateDeckSchema = z.object({
    topic: z.string().trim().min(2).max(160),
    sourceLanguage: z.string().trim().min(2).max(10).default('en'),
    targetLanguage: z.string().trim().min(2).max(10),
    count: z.coerce.number().int().min(1).max(20).optional(),
});

export const SUGGEST_KINDS = ['tip', 'deck', 'review'] as const;

export const suggestSchema = z.object({
    context: z.enum(['dashboard', 'deck_detail', 'review']).default('dashboard'),
    deckId: z.string().uuid().optional(),
});

export type EnrichWordsInput = z.infer<typeof enrichWordsSchema>;
export type GenerateDeckInput = z.infer<typeof generateDeckSchema>;
export type SuggestInput = z.infer<typeof suggestSchema>;
export type EnrichField = (typeof ENRICH_FIELDS)[number];
