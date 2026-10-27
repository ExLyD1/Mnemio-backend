import type { FastifyRequest, FastifyReply } from 'fastify';
import * as billingService from '../services/billing.service.js';
import { BadRequestError } from '../shared/errors.js';
import {
    cancelSubscriptionSchema,
    pauseSubscriptionSchema,
    resumeSubscriptionSchema,
    changePlanSchema,
    invoiceParamsSchema,
} from '../schemas/billing.schema.js';

export const cancel = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await billingService.cancelSubscription(
        request.currentUser.sub,
        cancelSubscriptionSchema.parse(request.body),
    );
    await reply.send(result.subscription);
    for (const emit of result.emits) {
        emit();
    }
    return reply;
};
export const pause = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = pauseSubscriptionSchema.parse(request.body);
    return reply.send(
        await billingService.pauseSubscription(request.currentUser.sub, input.months),
    );
};
export const resume = async (request: FastifyRequest, reply: FastifyReply) => {
    resumeSubscriptionSchema.parse(request.body ?? {});
    return reply.send(await billingService.resumeSubscription(request.currentUser.sub));
};
export const previewPlanChange = async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(
        await billingService.previewPlanChange(
            request.currentUser.sub,
            changePlanSchema.parse(request.body),
        ),
    );
};
export const changePlan = async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(
        await billingService.changePlan(
            request.currentUser.sub,
            changePlanSchema.parse(request.body),
        ),
    );
};
export const paymentMethodTransaction = async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await billingService.paymentMethodTransaction(request.currentUser.sub));
};
export const invoices = async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(await billingService.invoices(request.currentUser.sub));
};
export const invoicePdf = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = invoiceParamsSchema.parse(request.params);
    return reply.send(await billingService.invoicePdf(request.currentUser.sub, id));
};

// 200 with a null body for a user who has never subscribed — being on the free
// plan is the normal case, not an error. It used to 404 on every page load,
// which filled the browser console with red herrings while debugging real
// failures. Clients that still treat 404 as "free" keep working.
export const getSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await billingService.getSubscription(request.currentUser.sub);
    return reply.send(result ?? null);
};

// The Paddle customer id is resolved server-side from the authenticated user's
// own row — the client never supplies one, so nobody can open someone else's
// billing portal by passing a different id.
export const portal = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await billingService.createPortalSession(request.currentUser.sub);
    return reply.code(201).send(result);
};

export const webhook = async (request: FastifyRequest, reply: FastifyReply) => {
    const sig = request.headers['paddle-signature'];
    if (typeof sig !== 'string') {
        throw new BadRequestError('BILLING_WEBHOOK_MISSING_SIG', 'Missing paddle-signature header');
    }

    // The RAW body, exactly as delivered. The route's content-type parser keeps
    // it as a Buffer; parsing and re-serialising it would change the bytes the
    // signature was computed over and verification would fail.
    const rawBody = (request.body as Buffer).toString('utf8');

    // A throw here becomes a non-2xx response, which is what we want: a 2xx
    // tells Paddle the delivery succeeded and it stops retrying.
    const emits = await billingService.handleWebhookEvent(rawBody, sig);

    // ACK Paddle FIRST, then fire analytics — a Mixpanel hiccup must never delay
    // or fail the acknowledgement (Paddle would retry an un-ACKed event).
    await reply.send({ received: true });
    for (const emit of emits) {
        emit();
    }
    return reply;
};
