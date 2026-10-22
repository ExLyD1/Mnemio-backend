import type { FastifyInstance } from 'fastify';
import * as billingController from '../controllers/billing.controller.js';

const billingRoutes = async (fastify: FastifyInstance) => {
    const actionOptions = {
        preHandler: [fastify.authenticate],
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    };
    fastify.post('/billing/cancel', actionOptions, billingController.cancel);
    fastify.post('/billing/pause', actionOptions, billingController.pause);
    // Only resume accepts an empty application/json body. Keep normal JSON
    // syntax/prototype checks for nonempty bodies and all other routes.
    await fastify.register(async (resumeScope) => {
        const parseJson = resumeScope.getDefaultJsonParser('error', 'error');
        resumeScope.addContentTypeParser<string>(
            'application/json',
            { parseAs: 'string' },
            (request, body, done) => {
                if (body.length === 0) {
                    done(null, {});
                    return;
                }
                return parseJson(request, body, done);
            },
        );
        resumeScope.post('/billing/resume', actionOptions, billingController.resume);
    });
    fastify.post(
        '/billing/change-plan/preview',
        actionOptions,
        billingController.previewPlanChange,
    );
    fastify.post('/billing/change-plan', actionOptions, billingController.changePlan);
    const readOptions = {
        preHandler: [fastify.authenticate],
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    };
    fastify.get(
        '/billing/payment-method-transaction',
        readOptions,
        billingController.paymentMethodTransaction,
    );
    fastify.get('/billing/invoices', readOptions, billingController.invoices);
    fastify.get('/billing/invoices/:id/pdf', readOptions, billingController.invoicePdf);
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
