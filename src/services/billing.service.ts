import {
    Paddle,
    Environment,
    type SubscriptionNotification,
    type TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import * as subscriptionRepo from '../repositories/subscription.repository.js';
import * as authRepo from '../repositories/auth.repository.js';
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

const getPaddle = (): Paddle => {
    if (!env.PADDLE_API_KEY) {
        throw new BadRequestError('BILLING_NOT_CONFIGURED', 'Billing is not configured');
    }
    return new Paddle(env.PADDLE_API_KEY, {
        environment: env.PADDLE_ENV === 'production' ? Environment.production : Environment.sandbox,
    });
};

export const getSubscription = async (userId: string): Promise<SubscriptionDto | null> => {
    const row = await subscriptionRepo.findByUserId(userId);
    return row ? toDto(row) : null;
};

/**
 * Mints a Paddle-hosted customer portal session.
 *
 * The customer id is read from OUR row for the authenticated user — never from
 * the request — so a caller cannot mint a portal session for someone else's
 * billing account by supplying a different id.
 */
export const createPortalSession = async (userId: string): Promise<{ url: string }> => {
    const paddle = getPaddle();
    const sub = await subscriptionRepo.findByUserId(userId);
    if (!sub) {
        throw new NotFoundError('BILLING_NO_SUBSCRIPTION', 'No subscription found');
    }

    const session = await paddle.customerPortalSessions.create(sub.paddleCustomerId, [
        sub.paddleSubId,
    ]);

    // `overview` lands the customer on the portal home, where they can update
    // their payment method, cancel, and download invoices.
    return { url: session.urls.general.overview };
};

// ---------- Webhook handling ----------

const planFromPriceId = (priceId: string | undefined): string => {
    if (priceId && priceId === env.PADDLE_PRICE_ANNUAL) {
        return 'annual';
    }
    if (priceId && priceId === env.PADDLE_PRICE_MONTHLY) {
        return 'monthly';
    }
    return 'unknown';
};

// Narrowed to the analytics contract's BillingPlan; null when the price isn't
// one of our configured plans, so we skip emitting rather than send 'unknown'.
const billingPlanFromPriceId = (priceId: string | undefined): 'monthly' | 'annual' | null => {
    if (priceId && priceId === env.PADDLE_PRICE_ANNUAL) {
        return 'annual';
    }
    if (priceId && priceId === env.PADDLE_PRICE_MONTHLY) {
        return 'monthly';
    }
    return null;
};

/** Paddle amounts are strings in the currency's lowest denomination. */
const lowestUnitToMajor = (amount: string | null | undefined, currency: string): number => {
    const n = Number(amount ?? '0');
    if (!Number.isFinite(n)) {
        return 0;
    }
    // JPY, KRW and CLP have no minor unit — the integer IS the major amount.
    return ['JPY', 'KRW', 'CLP'].includes(currency) ? n : n / 100;
};

const readUserIdFromCustomData = (customData: unknown): string | null => {
    if (customData && typeof customData === 'object' && 'userId' in customData) {
        const raw = (customData as { userId: unknown }).userId;
        if (typeof raw === 'string' && raw.length > 0) {
            return raw;
        }
    }
    return null;
};

/**
 * Resolves the Mnemio user behind a Paddle event.
 *
 * Three strategies, in descending order of reliability, because no single one
 * is safe on its own:
 *  1. `custom_data.userId`, set by the frontend when it opens checkout. Exact,
 *     but absent on events Paddle generates itself (e.g. a renewal).
 *  2. An existing row carrying the same Paddle customer id — correct for every
 *     event after the first one for that customer.
 *  3. The Paddle customer's email matched against our users. The last resort
 *     for out-of-order delivery, where a subscription event can land before the
 *     transaction that carried the custom data.
 *
 * Returns null when none match; callers then skip the event rather than write a
 * row attached to the wrong account.
 */
const resolveUserId = async (
    customData: unknown,
    paddleCustomerId: string | null | undefined,
): Promise<string | null> => {
    const fromCustomData = readUserIdFromCustomData(customData);
    if (fromCustomData) {
        return fromCustomData;
    }

    if (!paddleCustomerId) {
        return null;
    }

    const existing = await subscriptionRepo.findByPaddleCustomerId(paddleCustomerId);
    if (existing) {
        return existing.userId;
    }

    try {
        const customer = await getPaddle().customers.get(paddleCustomerId);
        if (customer.email) {
            const user = await authRepo.findUserByEmail(customer.email);
            if (user) {
                return user.id;
            }
        }
    } catch {
        // Customer lookup failed (deleted, or the API is down) — fall through.
    }

    return null;
};

// Deferred analytics emission. Handlers return these instead of emitting inline
// so the controller can ACK Paddle FIRST, then fire them — a Mixpanel outage
// must never delay or fail the webhook acknowledgement.
type AnalyticsEmit = () => void;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const handleSubscriptionUpsert = async (
    tx: Tx,
    sub: SubscriptionNotification,
    ctx: { isCreated: boolean },
): Promise<AnalyticsEmit[]> => {
    const item = sub.items[0];
    const priceId = item?.price?.id;
    if (!priceId) {
        return [];
    }

    const userId = await resolveUserId(sub.customData, sub.customerId);
    if (!userId) {
        return [];
    }

    // Paddle reports a pending cancellation as a scheduled_change while the
    // subscription itself stays active. Mirror it as a flag, never as a status.
    const cancelAtPeriodEnd = sub.scheduledChange?.action === 'cancel';

    const periodStart = sub.currentBillingPeriod?.startsAt;
    const periodEnd = sub.currentBillingPeriod?.endsAt;
    // A paused/canceled subscription can arrive with no current billing period.
    // Keep whatever we already stored rather than inventing dates.
    const previous = await tx.subscription.findUnique({ where: { userId } });
    if ((!periodStart || !periodEnd) && !previous) {
        return [];
    }

    const trialEndsAt = item.trialDates?.endsAt ?? null;

    const data: subscriptionRepo.UpsertSubscriptionData = {
        userId,
        status: sub.status,
        plan: planFromPriceId(priceId),
        paddleCustomerId: sub.customerId,
        paddleSubId: sub.id,
        paddlePriceId: priceId,
        currentPeriodStart: periodStart
            ? new Date(periodStart)
            : (previous?.currentPeriodStart ?? new Date()),
        currentPeriodEnd: periodEnd
            ? new Date(periodEnd)
            : (previous?.currentPeriodEnd ?? new Date()),
        cancelAtPeriodEnd,
        trialEnd: trialEndsAt ? new Date(trialEndsAt) : null,
    };

    // Upsert keyed on userId — at-least-once delivery means this same event may
    // arrive again, and a redelivery must not create a second row.
    await tx.subscription.upsert({
        where: { userId },
        update: {
            status: data.status,
            plan: data.plan,
            paddleCustomerId: data.paddleCustomerId,
            paddleSubId: data.paddleSubId,
            paddlePriceId: data.paddlePriceId,
            currentPeriodStart: data.currentPeriodStart,
            currentPeriodEnd: data.currentPeriodEnd,
            cancelAtPeriodEnd: data.cancelAtPeriodEnd,
            trialEnd: data.trialEnd,
        },
        create: data,
    });

    const billingPlan = billingPlanFromPriceId(priceId);
    if (!billingPlan) {
        return [];
    }

    const emits: AnalyticsEmit[] = [];
    if (ctx.isCreated) {
        if (sub.status === 'trialing') {
            emits.push(() =>
                analytics.track(userId, 'trial_started', { billing_plan: billingPlan }),
            );
        }
        emits.push(() => analytics.setUserProps(userId, { plan: 'premium', is_ever_paid: true }));
    } else if (previous?.status === 'trialing' && sub.status === 'active') {
        // trialing → active is the trial converting into a paid term.
        const price = lowestUnitToMajor(
            item.price.unitPrice?.amount,
            item.price.unitPrice?.currencyCode ?? 'USD',
        );
        emits.push(() =>
            analytics.track(userId, 'trial_converted', { billing_plan: billingPlan, price }),
        );
    }
    return emits;
};

const handleSubscriptionCanceled = async (
    tx: Tx,
    sub: SubscriptionNotification,
): Promise<AnalyticsEmit[]> => {
    await tx.subscription.updateMany({
        where: { paddleSubId: sub.id },
        data: { status: sub.status, cancelAtPeriodEnd: false },
    });

    const userId = await resolveUserId(sub.customData, sub.customerId);
    if (!userId) {
        return [];
    }

    const billingPlan = billingPlanFromPriceId(sub.items[0]?.price?.id);
    const emits: AnalyticsEmit[] = [() => analytics.setUserProps(userId, { plan: 'free' })];
    if (billingPlan) {
        emits.push(() =>
            analytics.track(userId, 'subscription_canceled', { billing_plan: billingPlan }),
        );
    }
    return emits;
};

/**
 * `transaction.completed` is the money event: the first one confirms checkout,
 * later ones are renewals. The subscription ROW is written by the
 * subscription.* handlers — this one only emits analytics, so the two can't
 * fight over the same fields when they arrive out of order.
 */
const handleTransactionCompleted = async (
    txn: TransactionNotification,
): Promise<AnalyticsEmit[]> => {
    const item = txn.items[0];
    const priceId = item?.price?.id;
    const billingPlan = billingPlanFromPriceId(priceId);
    if (!billingPlan) {
        return [];
    }

    const userId = await resolveUserId(txn.customData, txn.customerId);
    if (!userId) {
        return [];
    }

    const currency = txn.details?.totals?.currencyCode ?? txn.currencyCode;
    const price = lowestUnitToMajor(txn.details?.totals?.total, currency);

    // origin distinguishes the opening transaction from a recurring charge.
    const isRenewal = txn.origin === 'subscription_recurring';
    if (isRenewal) {
        return [
            () =>
                analytics.track(userId, 'subscription_renewed', {
                    billing_plan: billingPlan,
                    price,
                }),
        ];
    }

    const existing = await subscriptionRepo.findByUserId(userId);
    const status: 'trialing' | 'active' = existing?.status === 'trialing' ? 'trialing' : 'active';
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

/**
 * Verifies and processes a Paddle webhook delivery, returning deferred
 * analytics emits. The caller ACKs Paddle before firing them (see
 * billing.controller.webhook).
 *
 * Throws on an invalid signature so the controller answers non-2xx — a 2xx
 * tells Paddle the delivery succeeded and it stops retrying.
 */
export const handleWebhookEvent = async (
    rawBody: string,
    signature: string,
): Promise<AnalyticsEmit[]> => {
    if (!env.PADDLE_WEBHOOK_SECRET || !env.PADDLE_API_KEY) {
        throw new BadRequestError('BILLING_NOT_CONFIGURED', 'Billing is not configured');
    }

    const paddle = getPaddle();

    // Verify BEFORE anything else, and keep verification separate from parsing.
    // `unmarshal` does both and throws the same way for either, which would
    // report a malformed payload as a forged one and send you hunting the wrong
    // bug. The HMAC covers the RAW body: a parse-then-restringify in between
    // changes the bytes and verification fails, which is why the route hands us
    // the untouched buffer.
    const verified = await paddle.webhooks.isSignatureValid(
        rawBody,
        env.PADDLE_WEBHOOK_SECRET,
        signature,
    );
    if (!verified) {
        throw new BadRequestError('BILLING_WEBHOOK_INVALID', 'Invalid webhook signature');
    }

    let event;
    try {
        event = await paddle.webhooks.unmarshal(rawBody, env.PADDLE_WEBHOOK_SECRET, signature);
    } catch (e) {
        // Authentic but unparseable — a shape this SDK version doesn't model.
        // Still non-2xx, so Paddle retries rather than dropping it silently.
        throw new BadRequestError(
            'BILLING_WEBHOOK_UNPARSEABLE',
            `Verified webhook could not be parsed: ${e instanceof Error ? e.message : 'unknown'}`,
        );
    }

    // Cheap pre-check outside the transaction; the insert below is the real
    // guard, since a concurrent redelivery can pass this check.
    const duplicate = await subscriptionRepo.findWebhookEvent(event.eventId);
    if (duplicate) {
        return [];
    }

    try {
        return await prisma.$transaction(async (tx): Promise<AnalyticsEmit[]> => {
            // Inside the transaction: the primary-key conflict on a concurrent
            // redelivery aborts the whole thing, so an event can never apply twice.
            await subscriptionRepo.recordWebhookEvent(tx, event.eventId, event.eventType);

            switch (event.eventType) {
                case 'subscription.created':
                    return handleSubscriptionUpsert(tx, event.data as SubscriptionNotification, {
                        isCreated: true,
                    });
                case 'subscription.activated':
                case 'subscription.trialing':
                case 'subscription.updated':
                case 'subscription.past_due':
                case 'subscription.paused':
                case 'subscription.resumed':
                    return handleSubscriptionUpsert(tx, event.data, {
                        isCreated: false,
                    });
                case 'subscription.canceled':
                    return handleSubscriptionCanceled(tx, event.data);
                case 'transaction.completed':
                    return handleTransactionCompleted(event.data);
                default:
                    // customer.*, price.*, product.* and everything else: recorded
                    // for idempotency, otherwise safely ignored.
                    return [];
            }
        });
    } catch (e) {
        // A duplicate that slipped past the pre-check is success, not failure:
        // the event is already applied, so ACK it instead of making Paddle retry.
        if (
            e &&
            typeof e === 'object' &&
            'code' in e &&
            (e as { code?: string }).code === 'P2002'
        ) {
            return [];
        }
        throw e;
    }
};
