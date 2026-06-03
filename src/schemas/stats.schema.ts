import { z } from 'zod';

export const STATS_RANGES = ['7', '30', '90', 'all'] as const;

export const rangeQuerySchema = z.object({
    range: z.enum(STATS_RANGES).default('30'),
});

export type StatsRange = z.infer<typeof rangeQuerySchema>['range'];
