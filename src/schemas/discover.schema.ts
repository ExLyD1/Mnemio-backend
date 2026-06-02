import { z } from 'zod';

export const DISCOVER_SORTS = ['popular', 'recent'] as const;
export type DiscoverSort = (typeof DISCOVER_SORTS)[number];

export const discoverListQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
    q: z.string().trim().max(120).optional(),
    lang: z.string().trim().min(2).max(10).optional(),
    subject: z.string().trim().min(1).max(40).optional(),
    sort: z.enum(DISCOVER_SORTS).optional(),
});

export type DiscoverListQuery = z.infer<typeof discoverListQuerySchema>;
