import { z } from 'zod';

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

export type GenerateDeckInput = z.infer<typeof generateDeckSchema>;
export type SuggestInput = z.infer<typeof suggestSchema>;
