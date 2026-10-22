import { z } from 'zod';

export const cancelSubscriptionSchema = z.object({
    reason: z.enum([
        'too_expensive',
        'not_using',
        'free_enough',
        'missing_feature',
        'not_working',
        'other',
    ]),
    feedback: z.string().max(500).optional(),
});
export const pauseSubscriptionSchema = z.object({
    months: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export const changePlanSchema = z.object({
    plan: z.enum(['monthly', 'annual']),
    when: z.enum(['now', 'renewal']),
});
export const resumeSubscriptionSchema = z.object({}).strict();
export const invoiceParamsSchema = z.object({ id: z.string().regex(/^txn_[a-zA-Z0-9]+$/) });
export type CancelSubscriptionInput = z.infer<typeof cancelSubscriptionSchema>;
export type ChangePlanInput = z.infer<typeof changePlanSchema>;
