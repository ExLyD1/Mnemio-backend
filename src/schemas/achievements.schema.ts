import { z } from 'zod';

// `keys` omitted (or empty) acks everything currently unseen.
export const ackAchievementsSchema = z.object({
    keys: z.array(z.string()).optional(),
});

export type AckAchievementsInput = z.infer<typeof ackAchievementsSchema>;
