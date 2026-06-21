import Stripe from 'stripe';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import * as subscriptionRepo from '../repositories/subscription.repository.js';
import { BadRequestError, NotFoundError } from '../shared/errors.js';
import type { SubscriptionRow } from '../repositories/subscription.repository.js';

export type SubscriptionDto = {
    id: string;
    status: string;
    plan: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
};

const toDto = (row: SubscriptionRow): SubscriptionDto => ({
    id: row.id,
    status: row.status,
    plan: row.plan,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEnd: row.trialEnd ? row.trialEnd.toISOString() : null,
});

const getStripe = (): Stripe => {
    if (!env.STRIPE_SECRET_KEY) {
        throw new BadRequestError('BILLING_NOT_CONFIGURED', 'Billing is not configured');
    }
    return new Stripe(env.STRIPE_SECRET_KEY);
};

const getOrCreateCustomer = async (stripe: Stripe, userId: string, email: string): Promise<string> => {
    const existing = await subscriptionRepo.findByUserId(userId);
    if (existing?.stripeCustomerId) return existing.stripeCustomerId;

    const customer = await stripe.customers.create({ email, metadata: { userId } });
    return customer.id;
};

export const createCheckoutSession = async (
    userId: string,
    email: string,
    plan: 'monthly' | 'annual',
): Promise<{ url: string }> => {
    const stripe = getStripe();

    const priceId = plan === 'annual' ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
    if (!priceId) {
        throw new BadRequestError('BILLING_PRICE_NOT_CONFIGURED', `Stripe price for plan "${plan}" is not configured`);
    }

    const stripeCustomerId = await getOrCreateCustomer(stripe, userId, email);
    const successUrl = `${env.WEB_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${env.WEB_URL}/billing/cancel`;

    const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { userId, plan },
    });

    if (!session.url) {
        throw new BadRequestError('BILLING_SESSION_ERROR', 'Failed to create checkout session');
    }
    return { url: session.url };
};

export const getSubscription = async (userId: string): Promise<SubscriptionDto | null> => {
    const row = await subscriptionRepo.findByUserId(userId);
    return row ? toDto(row) : null;
};

export const createPortalSession = async (userId: string): Promise<{ url: string }> => {
    const stripe = getStripe();
    const sub = await subscriptionRepo.findByUserId(userId);
    if (!sub) {
        throw new NotFoundError('BILLING_NO_SUBSCRIPTION', 'No subscription found');
    }

    const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${env.WEB_URL}/settings/billing`,
    });

    return { url: session.url };
};

// ---------- Webhook handler ----------

const planFromPriceId = (priceId: string): string => {
    if (priceId === env.STRIPE_PRICE_ANNUAL) return 'annual';
    if (priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly';
    return 'unknown';
};

const handleSubscriptionUpsert = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sub: Stripe.Subscription,
): Promise<void> => {
    const item = sub.items.data[0];
    if (!item) return;

    const userId = sub.metadata['userId'];
    if (!userId) return;

    const data: subscriptionRepo.UpsertSubscriptionData = {
        userId,
        status: sub.status,
        plan: planFromPriceId(item.price.id),
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        stripeSubId: sub.id,
        stripePriceId: item.price.id,
        // In Stripe v22, period dates live on the SubscriptionItem, not the Subscription.
        currentPeriodStart: new Date(item.current_period_start * 1000),
        currentPeriodEnd: new Date(item.current_period_end * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).subscription.upsert({
        where: { userId },
        update: {
            status: data.status,
            plan: data.plan,
            stripeCustomerId: data.stripeCustomerId,
            stripeSubId: data.stripeSubId,
            stripePriceId: data.stripePriceId,
            currentPeriodStart: data.currentPeriodStart,
            currentPeriodEnd: data.currentPeriodEnd,
            cancelAtPeriodEnd: data.cancelAtPeriodEnd,
            trialEnd: data.trialEnd,
        },
        create: data,
    });
};

const handleInvoicePaymentSucceeded = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    invoice: Stripe.Invoice,
): Promise<void> => {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (tx as any).subscription.findUnique({ where: { stripeCustomerId: customerId } });
    if (!existing) return;

    // In Stripe v22, the subscription reference is on invoice.parent.subscription_details.subscription.
    const subRef = invoice.parent?.subscription_details?.subscription;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id;
    if (!subId) return;

    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(subId);
    const item = stripeSub.items.data[0];
    if (!item) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).subscription.update({
        where: { stripeCustomerId: customerId },
        data: {
            status: 'active',
            currentPeriodStart: new Date(item.current_period_start * 1000),
            currentPeriodEnd: new Date(item.current_period_end * 1000),
            stripePriceId: item.price.id,
            plan: planFromPriceId(item.price.id),
        },
    });
};

const handleInvoicePaymentFailed = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    invoice: Stripe.Invoice,
): Promise<void> => {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).subscription.updateMany({
        where: { stripeCustomerId: customerId },
        data: { status: 'past_due' },
    });
};

const handleSubscriptionDeleted = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sub: Stripe.Subscription,
): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).subscription.updateMany({
        where: { stripeSubId: sub.id },
        data: { status: 'expired' },
    });
};

export const handleWebhookEvent = async (
    rawBody: Buffer,
    signature: string,
): Promise<void> => {
    if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
        throw new BadRequestError('BILLING_NOT_CONFIGURED', 'Billing is not configured');
    }

    const stripe = getStripe();
    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
        throw new BadRequestError('BILLING_WEBHOOK_INVALID', 'Invalid webhook signature');
    }

    const duplicate = await subscriptionRepo.findWebhookEvent(event.id);
    if (duplicate) return;

    await prisma.$transaction(async (tx) => {
        await subscriptionRepo.recordWebhookEvent(tx, event.id, event.type);

        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await handleSubscriptionUpsert(tx, event.data.object as Stripe.Subscription);
                break;
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(tx, event.data.object as Stripe.Subscription);
                break;
            case 'invoice.payment_succeeded':
                await handleInvoicePaymentSucceeded(tx, event.data.object as Stripe.Invoice);
                break;
            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(tx, event.data.object as Stripe.Invoice);
                break;
            default:
                break;
        }
    });
};
