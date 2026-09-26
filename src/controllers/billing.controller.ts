import type { FastifyRequest, FastifyReply } from 'fastify';
import * as billingService from '../services/billing.service.js';
import * as authRepo from '../repositories/auth.repository.js';
import { checkoutSchema } from '../schemas/billing.schema.js';
import { BadRequestError, UnauthorizedError } from '../shared/errors.js';

export const checkout = async (request: FastifyRequest, reply: FastifyReply) => {
    const { plan } = checkoutSchema.parse(request.body);
    const user = await authRepo.findUserById(request.currentUser.sub);
    if (!user) {
        throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'User no longer exists');
    }
    const result = await billingService.createCheckoutSession(user.id, user.email, plan);
    reply.code(201).send(result);
};

// 200 with a null body for a user who has never subscribed — being on the free
// plan is the normal case, not an error. It used to 404 on every page load,
// which filled the browser console with red herrings while debugging real
// failures. Clients that still treat 404 as "free" keep working.
export const getSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await billingService.getSubscription(request.currentUser.sub);
    reply.send(result ?? null);
};

export const portal = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await billingService.createPortalSession(request.currentUser.sub);
    reply.code(201).send(result);
};

export const webhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const sig = request.headers['stripe-signature'];
    if (typeof sig !== 'string') {
        throw new BadRequestError('BILLING_WEBHOOK_MISSING_SIG', 'Missing stripe-signature header');
    }
    const emits = await billingService.handleWebhookEvent(request.body as Buffer, sig);
    // ACK Stripe FIRST, then fire analytics — a Mixpanel hiccup must never delay
    // or fail the webhook acknowledgement (Stripe would retry an un-ACKed event).
    await reply.send({ received: true });
    for (const emit of emits) {
        emit();
    }
};
