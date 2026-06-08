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
