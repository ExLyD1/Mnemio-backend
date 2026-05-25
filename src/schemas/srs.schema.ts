import { z } from 'zod';

export const rateSchema = z.object({
    cardId: z.string().uuid(),
    quality: z
        .number()
        .int()
        .min(0)
        .max(5),
});

export const dueQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
});

export type RateInput = z.infer<typeof rateSchema>;
export type DueQuery = z.infer<typeof dueQuerySchema>;
