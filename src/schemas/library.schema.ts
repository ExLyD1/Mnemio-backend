import { z } from 'zod';
import { SUBJECTS } from '../shared/subjects.js';
import { langSchema } from './lang.schema.js';

export const LIBRARY_SCOPES = ['all', 'my', 'learning'] as const;
export type LibraryScope = (typeof LIBRARY_SCOPES)[number];

export const libraryQuerySchema = z.object({
    // all = my ∪ learning (default) · my = decks I authored · learning = decks
    // (mine or others') I've studied enough of.
    scope: z.enum(LIBRARY_SCOPES).default('all'),
    subject: z.enum(SUBJECTS).optional(),
    // The language being learned (targetLanguage); aliases normalize.
    lang: langSchema.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
});

export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
