import { z } from 'zod';

export const STATS_RANGES = ['7', '30', '90', 'all'] as const;

export const rangeQuerySchema = z.object({
    range: z.enum(STATS_RANGES).default('30'),
});

export type StatsRange = z.infer<typeof rangeQuerySchema>['range'];

// IANA time zone (e.g. 'Europe/Kyiv'). Validated via Intl so an unknown zone is
// a 400 rather than a runtime throw during bucketing. Defaults to UTC when the
// client omits it.
const isValidTimeZone = (tz: string): boolean => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

export const rangeTzQuerySchema = z.object({
    range: z.enum(STATS_RANGES).default('30'),
    tz: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .default('UTC')
        .refine(isValidTimeZone, { message: 'Invalid IANA time zone' }),
});

export type RangeTzQuery = z.infer<typeof rangeTzQuerySchema>;
