import { z } from 'zod';

export const RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type Rating = (typeof RATINGS)[number];

export const timezoneSchema = z
    .string()
    .max(100)
    .refine((tz) => {
        try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return true;
        } catch {
            return false;
        }
    }, 'Invalid IANA timezone');

// tz is optional in the body: the X-Timezone header (requestTz) is the usual source.
export const rateSchema = z.object({
    cardId: z.string().uuid(),
    rating: z.enum(RATINGS),
    tz: timezoneSchema.optional(),
});

export const dueQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
});

export const MAX_REVIEW_DECKS = 50;

// `?deckIds=a,b,c` — comma-separated, trimmed and deduped (first occurrence wins,
// so URL order survives for deck-by-deck review).
const deckIdListSchema = z
    .string()
    .transform((s) => {
        const ids = s.split(',').map((id) => id.trim());
        return [...new Set(ids.filter(Boolean))];
    })
    .pipe(z.array(z.string().uuid()).min(1).max(MAX_REVIEW_DECKS));

// The review queue can legitimately be long (every card due today across every
// deck), so it allows a higher ceiling than /srs/due's preview list. `limit`
// caps the due reviews; deckId adds that deck's new cards (Anki daily limit);
// deckIds narrows the due-only queue to a set of decks (no new cards).
export const queueQuerySchema = z
    .object({
        deckId: z.string().uuid().optional(),
        deckIds: deckIdListSchema.optional(),
        extraNew: z.coerce.number().int().min(0).max(100).default(0),
        limit: z.coerce.number().int().positive().max(2000).optional(),
    })
    .refine((q) => !(q.deckId && q.deckIds), {
        message: 'Use either deckId or deckIds, not both',
        path: ['deckIds'],
    });
export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const progressQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(2000).optional(),
});

export type RateInput = z.infer<typeof rateSchema>;
export type DueQuery = z.infer<typeof dueQuerySchema>;
export type ProgressQuery = z.infer<typeof progressQuerySchema>;
