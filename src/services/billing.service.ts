import Stripe from 'stripe';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import * as subscriptionRepo from '../repositories/subscription.repository.js';
import * as analytics from './analytics.service.js';
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
        // Propagate userId onto the Subscription itself — Stripe does NOT copy
        // session metadata to the subscription, and the webhook handlers resolve
        // the user via sub.metadata.userId.
        subscription_data: { metadata: { userId, plan } },
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

// Narrow to the analytics contract's BillingPlan; null when the price isn't one
// of our configured plans (so we skip emitting rather than send 'unknown').
const billingPlanFromPriceId = (priceId: string): 'monthly' | 'annual' | null => {
    if (priceId === env.STRIPE_PRICE_ANNUAL) return 'annual';
    if (priceId === env.STRIPE_PRICE_MONTHLY) return 'monthly';
    return null;
};

const centsToUnits = (cents: number | null | undefined): number => (cents ?? 0) / 100;

// Deferred analytics emission. Handlers return these instead of emitting inline
// so the controller can ACK Stripe FIRST, then fire them — a Mixpanel outage can
// never delay or fail the webhook acknowledgement.
type AnalyticsEmit = () => void;

const handleSubscriptionUpsert = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    sub: Stripe.Subscription,
    ctx: { isCreated: boolean; previousStatus?: string | undefined },
): Promise<AnalyticsEmit[]> => {
    const item = sub.items.data[0];
    if (!item) return [];

    const userId = sub.metadata['userId'];
    if (!userId) return [];

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

    const billingPlan = billingPlanFromPriceId(item.price.id);
    if (!billingPlan) return [];
    const price = centsToUnits(item.price.unit_amount);
    const emits: AnalyticsEmit[] = [];

    // New subscription that begins in trial → trial_started.
    if (ctx.isCreated && sub.status === 'trialing') {
        emits.push(() => analytics.track(userId, 'trial_started', { billing_plan: billingPlan }));
    }
    // Existing subscription transitioning trialing → active → trial_converted.
    if (!ctx.isCreated && ctx.previousStatus === 'trialing' && sub.status === 'active') {
        emits.push(() =>
            analytics.track(userId, 'trial_converted', { billing_plan: billingPlan, price }),
        );
    }
    return emits;
};

// checkout.session.completed → subscription_started. Analytics only (the DB row
// is written by customer.subscription.created); we still record the event id for
// idempotency in the enclosing transaction.
const handleCheckoutCompleted = async (
    session: Stripe.Checkout.Session,
): Promise<AnalyticsEmit[]> => {
    const userId = session.metadata?.['userId'];
    if (!userId) return [];

    const subRef = session.subscription;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id;
    if (!subId) return [];

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    const item = sub.items.data[0];
    if (!item) return [];

    const billingPlan = billingPlanFromPriceId(item.price.id);
    if (!billingPlan) return [];

    const status: 'trialing' | 'active' = sub.status === 'trialing' ? 'trialing' : 'active';
    const price = centsToUnits(item.price.unit_amount);

    return [
        () =>
            analytics.track(userId, 'subscription_started', {
                billing_plan: billingPlan,
                status,
                price,
            }),
        () => analytics.setUserProps(userId, { plan: 'premium', is_ever_paid: true }),
    ];
};

const handleInvoicePaymentSucceeded = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    invoice: Stripe.Invoice,
): Promise<AnalyticsEmit[]> => {
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (tx as any).subscription.findUnique({ where: { stripeCustomerId: customerId } });
    if (!existing) return [];

    // In Stripe v22, the subscription reference is on invoice.parent.subscription_details.subscription.
    const subRef = invoice.parent?.subscription_details?.subscription;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id;
    if (!subId) return [];

    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(subId);
    const item = stripeSub.items.data[0];
    if (!item) return [];

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

    // Renewal (recurring cycle), not the first invoice → subscription_renewed.
    // The first invoice is 'subscription_create' and is covered by checkout.
    if (invoice.billing_reason !== 'subscription_cycle') return [];
    const billingPlan = billingPlanFromPriceId(item.price.id);
    if (!billingPlan) return [];
    const price = centsToUnits(invoice.amount_paid);
    const userId = existing.userId as string;
    return [
        () => analytics.track(userId, 'subscription_renewed', { billing_plan: billingPlan, price }),
    ];
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
): Promise<AnalyticsEmit[]> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).subscription.updateMany({
        where: { stripeSubId: sub.id },
        data: { status: 'expired' },
    });

    const userId = sub.metadata['userId'];
    if (!userId) return [];

    const item = sub.items.data[0];
    const billingPlan = item ? billingPlanFromPriceId(item.price.id) : null;
    const reason = sub.cancellation_details?.reason ?? undefined;

    const emits: AnalyticsEmit[] = [
        () => analytics.setUserProps(userId, { plan: 'free' }),
    ];
    if (billingPlan) {
        emits.push(() =>
            analytics.track(userId, 'subscription_canceled', {
                billing_plan: billingPlan,
                ...(reason ? { reason } : {}),
            }),
        );
    }
    return emits;
};

// Processes the webhook and returns deferred analytics emits. The caller is
// expected to ACK Stripe before firing them (see billing.controller.webhook).
export const handleWebhookEvent = async (
    rawBody: Buffer,
    signature: string,
): Promise<AnalyticsEmit[]> => {
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
    if (duplicate) return [];

    return prisma.$transaction(async (tx): Promise<AnalyticsEmit[]> => {
        await subscriptionRepo.recordWebhookEvent(tx, event.id, event.type);

        switch (event.type) {
            case 'checkout.session.completed':
                return handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
            case 'customer.subscription.created':
                return handleSubscriptionUpsert(tx, event.data.object as Stripe.Subscription, {
                    isCreated: true,
                });
            case 'customer.subscription.updated': {
                const previousStatus = (
                    event.data.previous_attributes as Partial<Stripe.Subscription> | undefined
                )?.status;
                return handleSubscriptionUpsert(tx, event.data.object as Stripe.Subscription, {
                    isCreated: false,
                    previousStatus,
                });
            }
            case 'customer.subscription.deleted':
                return handleSubscriptionDeleted(tx, event.data.object as Stripe.Subscription);
            case 'invoice.payment_succeeded':
                return handleInvoicePaymentSucceeded(tx, event.data.object as Stripe.Invoice);
            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(tx, event.data.object as Stripe.Invoice);
                return [];
            default:
                return [];
        }
    });
};
