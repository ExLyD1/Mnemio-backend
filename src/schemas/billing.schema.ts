import { z } from 'zod';

export const checkoutSchema = z.object({
    plan: z.enum(['monthly', 'annual']),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;
