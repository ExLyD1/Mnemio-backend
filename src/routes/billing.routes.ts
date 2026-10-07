import type { FastifyInstance } from 'fastify';
import * as billingController from '../controllers/billing.controller.js';

const billingRoutes = async (fastify: FastifyInstance) => {
    // NOTE: POST /billing/checkout is gone. Checkout is opened client-side by
    // Paddle.js (Paddle.Checkout.open) straight from the pricing page, so the
    // server never mints a checkout session. Fulfillment still happens here via
    // the webhook below — that, not the browser, is what grants access.

    fastify.get(
        '/billing/subscription',
        { preHandler: [fastify.authenticate] },
        billingController.getSubscription,
    );

    fastify.post(
        '/billing/portal',
        { preHandler: [fastify.authenticate] },
        billingController.portal,
    );

    // Webhook — public (Paddle-signed, no JWT). Scoped child plugin so its
    // raw-body content-type parser doesn't affect the JSON routes above:
    // verification runs over the exact bytes Paddle sent, and any parse +
    // re-serialise in between would break the signature.
    await fastify.register(async (webhookScope) => {
        webhookScope.addContentTypeParser(
            'application/json',
            { parseAs: 'buffer' },
            (_req, body, done) => done(null, body),
        );
        webhookScope.post('/billing/webhook', billingController.webhook);
    });
};

export default billingRoutes;
