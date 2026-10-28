import { z } from 'zod';
import { SUBJECTS } from '../shared/subjects.js';
import { langSchema } from './lang.schema.js';

export const DISCOVER_SORTS = ['popular', 'recent'] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export const discoverListQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
    q: z.string().trim().max(120).optional(),
    // Language being learned (targetLanguage); aliases normalize, unknown → 400.
    lang: langSchema.optional(),
    subject: z.enum(SUBJECTS).optional(),
    sort: z.enum(DISCOVER_SORTS).optional(),
});

export type DiscoverListQuery = z.infer<typeof discoverListQuerySchema>;
