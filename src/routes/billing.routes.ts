import type { FastifyInstance } from 'fastify';
import * as billingController from '../controllers/billing.controller.js';

const billingRoutes = async (fastify: FastifyInstance) => {
    fastify.post(
        '/billing/checkout',
        { preHandler: [fastify.authenticate] },
        billingController.checkout,
    );

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

    // Webhook — scoped child plugin so its raw-body content-type parser
    // doesn't affect the JSON routes above.
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
