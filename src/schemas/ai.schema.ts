import { z } from 'zod';
import { langSchema } from './lang.schema.js';

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
    sourceLanguage: langSchema,
    targetLanguage: langSchema,
    context: z.string().trim().max(200).optional(),
    fields: z.array(z.enum(ENRICH_FIELDS)).optional(),
});

export const generateDeckSchema = z.object({
    topic: z.string().trim().min(2).max(160),
    // Omitted → the user's native language (see ai.service), then 'en'.
    sourceLanguage: langSchema.optional(),
    targetLanguage: langSchema,
    count: z.coerce.number().int().min(1).max(20).optional(),
});

// Text fields for POST /ai/deck-from-image (multipart). The image itself is
// read via request.file() in the controller — not part of this schema.
// sourceLanguage is optional: when omitted, the user's native language is
// used (see ai.service), then 'en'. targetLanguage is optional: when omitted,
// the model detects the image's language and uses that.
export const deckFromImageSchema = z.object({
    sourceLanguage: langSchema.optional(),
    targetLanguage: langSchema.optional(),
    count: z.coerce.number().int().min(1).max(20).optional(),
    // Free-text refine hint carried over on a re-submit of the same image
    // (e.g. "more words", "harder", "with examples") — the image isn't
    // stored server-side, so the FE resends it alongside a new instruction.
    instructions: z.string().trim().max(300).optional(),
});

export const SUGGEST_KINDS = ['tip', 'deck', 'review'] as const;

export const suggestSchema = z.object({
    context: z.enum(['dashboard', 'deck_detail', 'review']).default('dashboard'),
    deckId: z.string().uuid().optional(),
});

export type EnrichWordsInput = z.infer<typeof enrichWordsSchema>;
export type GenerateDeckRequest = z.infer<typeof generateDeckSchema>;
export type DeckFromImageRequest = z.infer<typeof deckFromImageSchema>;
// What the provider receives — the service has resolved sourceLanguage.
export type GenerateDeckInput = GenerateDeckRequest & { sourceLanguage: string };
export type DeckFromImageInput = DeckFromImageRequest & { sourceLanguage: string };
export type SuggestInput = z.infer<typeof suggestSchema>;
export type EnrichField = (typeof ENRICH_FIELDS)[number];
