import { z } from 'zod';

export const importQuizletSchema = z.object({
    // We don't enforce the quizlet.com host here — the parser does that and
    // surfaces IMPORT_BAD_URL with a friendly message. We only sanity-check
    // that this looks like a URL at all.
    url: z.string().trim().url('url must be a valid URL').max(500),
});

export const importTextSchema = z.object({
    text: z.string().min(1, 'text must not be empty').max(100_000),
    format: z.enum(['tsv', 'csv', 'newline', 'auto']).default('auto'),
});

export type ImportQuizletInput = z.infer<typeof importQuizletSchema>;
export type ImportTextInput = z.infer<typeof importTextSchema>;

// Deck import (JSON body variant — multipart can be added later if needed).
export const deckImportSchema = z.object({
    format: z.enum(['csv', 'json']),
    text: z.string().min(1, 'text must not be empty').max(1_000_000),
});

export const deckExportQuerySchema = z.object({
    format: z.enum(['csv', 'json']).default('csv'),
});

export type DeckImportInput = z.infer<typeof deckImportSchema>;
export type DeckExportQuery = z.infer<typeof deckExportQuerySchema>;
