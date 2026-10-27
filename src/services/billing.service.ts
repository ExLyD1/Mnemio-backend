import {
    Paddle,
    Environment,
    type SubscriptionNotification,
    type TransactionNotification,
    type Subscription,
    type UpdateSubscriptionRequestBody,
} from '@paddle/paddle-node-sdk';
import { env } from '../config/env.js';
import * as subscriptionRepo from '../repositories/subscription.repository.js';
import * as authRepo from '../repositories/auth.repository.js';
import * as analytics from './analytics.service.js';
import {
    BadRequestError,
    NotFoundError,
    ConflictError,
    BillingProviderError,
} from '../shared/errors.js';
import type { SubscriptionRow } from '../repositories/subscription.repository.js';

import {
    toSubscriptionDto as toDto,
    subscriptionData,
    billingPlanFromPriceId,
    billingPlanFromPrice,
    lowestUnitToMajor,
    clearedPastDueDetails,
    type SubscriptionDto,
} from '../shared/mappers.billing.js';
import { sendBillingEmail } from './billing-mail.service.js';
import type { CancelSubscriptionInput, ChangePlanInput } from '../schemas/billing.schema.js';

export type { SubscriptionDto };

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

const provider = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
        return await call();
    } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? err.code : 'unknown';
        // eslint-disable-next-line no-console -- log only the provider code, never its raw message
        console.warn('Paddle request failed', { code });
        throw new BillingProviderError();
    }
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

    const session = await provider(() =>
        paddle.customerPortalSessions.create(sub.paddleCustomerId, [sub.paddleSubId]),
    );

    // `overview` lands the customer on the portal home, where they can update
    // their payment method, cancel, and download invoices.
    return { url: session.urls.general.overview };
};

const ownSubscription = async (userId: string) => {
    const paddle = getPaddle();
    const row = await subscriptionRepo.findByUserId(userId);
    if (!row) {
        throw new NotFoundError('BILLING_NO_SUBSCRIPTION', 'No subscription found');
    }
    return { paddle, row };
};
const requireState = (allowed: boolean) => {
    if (!allowed) {
        throw new ConflictError(
            'BILLING_INVALID_STATE',
            'Action is not allowed for this subscription',
        );
    }
};

const persistAction = async (
    row: SubscriptionRow,
    sub: Subscription,
    extra: Parameters<typeof subscriptionRepo.updateForUser>[1] = {},
) => {
    if (sub.id !== row.paddleSubId || sub.customerId !== row.paddleCustomerId) {
        throw new BillingProviderError();
    }
    return subscriptionRepo.transaction(async (tx) => {
        const previous = await subscriptionRepo.findInTransaction(tx, row.userId);
        const data = subscriptionData(sub, row.userId, previous);
        if (!data) {
            throw new BillingProviderError();
        }
        await subscriptionRepo.updateForUser(row.userId, { ...data, ...extra }, tx);
        const updated = await subscriptionRepo.findInTransaction(tx, row.userId);
        if (!updated) {
            throw new NotFoundError('BILLING_NO_SUBSCRIPTION', 'No subscription found');
        }
        return updated;
    });
};

export const cancelSubscription = async (userId: string, input: CancelSubscriptionInput) => {
    const { paddle, row } = await ownSubscription(userId);
    requireState(
        ['active', 'trialing'].includes(row.status) &&
            !row.cancelAtPeriodEnd &&
            row.scheduledChangeAction !== 'cancel',
    );
    const sub = await provider(() =>
        paddle.subscriptions.cancel(row.paddleSubId, { effectiveFrom: 'next_billing_period' }),
    );
    const updated = await persistAction(row, sub, {
        cancelReason: input.reason,
        cancelFeedback: input.feedback ?? null,
        cancelRequestedAt: new Date(),
    });
    return {
        subscription: toDto(updated),
        emits: [
            () => {
                void sendBillingEmail('cancelled', updated);
            },
        ],
    };
};

/** Calendar-month addition in UTC, clamped to the destination month's final day. */
export const addMonths = (date: Date, months: number) => {
    const result = new Date(date);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const last = new Date(
        Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(day, last));
    return result;
};

export const pauseSubscription = async (
    userId: string,
    months: 1 | 2 | 3,
): Promise<SubscriptionDto> => {
    const { paddle, row } = await ownSubscription(userId);
    requireState(
        ['active', 'paused'].includes(row.status) &&
            (row.status === 'paused' ||
                !row.scheduledChangeAction ||
                row.scheduledChangeAction === 'pause') &&
            !row.scheduledPlan &&
            !row.cancelAtPeriodEnd,
    );
    const resumeAt = addMonths(row.currentPeriodEnd, months).toISOString();
    requireState(row.status !== 'paused' || new Date(resumeAt).getTime() > Date.now());
    const sub = await provider(async () => {
        if (row.status === 'paused') {
            return paddle.subscriptions.resume(row.paddleSubId, { effectiveFrom: resumeAt });
        }
        if (row.scheduledChangeAction === 'pause') {
            await paddle.subscriptions.update(row.paddleSubId, { scheduledChange: null });
        }
        return paddle.subscriptions.pause(row.paddleSubId, {
            effectiveFrom: 'next_billing_period',
            resumeAt,
        });
    });
    return toDto(await persistAction(row, sub));
};

export const resumeSubscription = async (userId: string): Promise<SubscriptionDto> => {
    const { paddle, row } = await ownSubscription(userId);
    const scheduled =
        ['cancel', 'pause'].includes(row.scheduledChangeAction ?? '') || row.cancelAtPeriodEnd;
    requireState(row.status === 'paused' || scheduled);
    const sub = await provider(() =>
        row.status === 'paused'
            ? paddle.subscriptions.resume(row.paddleSubId, { effectiveFrom: 'immediately' })
            : paddle.subscriptions.update(row.paddleSubId, { scheduledChange: null }),
    );
    return toDto(await persistAction(row, sub));
};

const planChangeArgs = (
    row: SubscriptionRow,
    input: ChangePlanInput,
): UpdateSubscriptionRequestBody => {
    requireState(
        ['active', 'trialing'].includes(row.status) &&
            row.plan !== input.plan &&
            !row.scheduledChangeAction &&
            !row.cancelAtPeriodEnd &&
            !row.scheduledPlan &&
            !(row.plan === 'annual' && input.when === 'now'),
    );
    const priceId = input.plan === 'annual' ? env.PADDLE_PRICE_ANNUAL : env.PADDLE_PRICE_MONTHLY;
    if (!priceId) {
        throw new BadRequestError('BILLING_NOT_CONFIGURED', 'Billing is not configured');
    }
    return {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode:
            input.when === 'now' ? 'prorated_immediately' : 'full_next_billing_period',
    };
};

export const previewPlanChange = async (userId: string, input: ChangePlanInput) => {
    const { paddle, row } = await ownSubscription(userId);
    const args = planChangeArgs(row, input);
    const preview = await provider(() => paddle.subscriptions.previewUpdate(row.paddleSubId, args));
    const unit = preview.items[0]?.price.unitPrice;
    const recurring =
        preview.recurringTransactionDetails?.totals ?? preview.nextTransaction?.details.totals;
    const currency = unit?.currencyCode ?? recurring?.currencyCode ?? preview.currencyCode;
    const immediate = preview.immediateTransaction?.details.totals;
    const summary = preview.updateSummary;
    const due =
        input.when === 'now'
            ? (immediate?.grandTotal ??
              immediate?.total ??
              (summary?.result.action === 'charge' ? summary.result.amount : '0'))
            : '0';
    return {
        ...input,
        newPrice: {
            amount: lowestUnitToMajor(unit?.amount ?? recurring?.total, currency),
            currency,
        },
        credit: {
            amount: Math.abs(
                lowestUnitToMajor(
                    summary?.credit.amount ?? immediate?.credit,
                    summary?.credit.currencyCode ?? currency,
                ),
            ),
            currency: summary?.credit.currencyCode ?? currency,
        },
        dueToday: {
            amount: Math.max(0, lowestUnitToMajor(due, immediate?.currencyCode ?? currency)),
            currency: immediate?.currencyCode ?? currency,
        },
        nextBilledAt: preview.nextBilledAt ?? null,
    };
};

export const changePlan = async (
    userId: string,
    input: ChangePlanInput,
): Promise<SubscriptionDto> => {
    const { paddle, row } = await ownSubscription(userId);
    const args = planChangeArgs(row, input);
    const sub = await provider(() => paddle.subscriptions.update(row.paddleSubId, args));
    return toDto(
        await persistAction(row, sub, {
            scheduledPlan: input.when === 'renewal' ? input.plan : null,
        }),
    );
};

export const paymentMethodTransaction = async (userId: string) => {
    const { paddle, row } = await ownSubscription(userId);
    requireState(row.status !== 'canceled');
    const txn = await provider(() =>
        paddle.subscriptions.getPaymentMethodChangeTransaction(row.paddleSubId),
    );
    return { transactionId: txn.id };
};

export const invoices = async (userId: string) => {
    const { paddle, row } = await ownSubscription(userId);
    return provider(async () => {
        const transactions = await paddle.transactions
            .list({
                subscriptionId: [row.paddleSubId],
                status: ['completed', 'past_due', 'billed', 'paid'],
                perPage: 50,
                orderBy: 'billed_at[DESC]',
                include: ['adjustment'],
            })
            .next();
        const items = transactions
            .slice(0, 50)
            .filter(
                (t) =>
                    t.subscriptionId === row.paddleSubId && t.customerId === row.paddleCustomerId,
            )
            .map((t) => {
                const currency = t.details?.totals?.currencyCode ?? t.currencyCode;
                const amount = lowestUnitToMajor(t.details?.totals?.total, currency);
                const refunded = t.adjustments?.some(
                    (a) => a.action === 'refund' && a.status === 'approved',
                );
                const status =
                    amount === 0
                        ? ('trial' as const)
                        : refunded
                          ? ('refunded' as const)
                          : t.status === 'past_due'
                            ? ('failed' as const)
                            : ('paid' as const);
                return {
                    id: t.id,
                    billedAt: t.billedAt ?? t.createdAt,
                    plan: billingPlanFromPrice(t.items[0]?.price),
                    amount,
                    currency,
                    status,
                    hasPdf: amount > 0 && !!t.invoiceId,
                };
            });
        items.sort((a, b) => b.billedAt.localeCompare(a.billedAt));
        return { items };
    });
};

export const invoicePdf = async (userId: string, id: string) => {
    const { paddle, row } = await ownSubscription(userId);
    const txn = await provider(() => paddle.transactions.get(id));
    if (txn.subscriptionId !== row.paddleSubId || txn.customerId !== row.paddleCustomerId) {
        throw new NotFoundError('BILLING_INVOICE_NOT_FOUND', 'Invoice not found');
    }
    if (!txn.invoiceId || !txn.details?.totals || Number(txn.details.totals.total) === 0) {
        throw new NotFoundError('BILLING_INVOICE_NOT_FOUND', 'Invoice not found');
    }
    const pdf = await provider(() => paddle.transactions.getInvoicePDF(id));
    return { url: pdf.url };
};

// ---------- Webhook handling ----------

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
export type DeferredEmit = () => void;
type AnalyticsEmit = DeferredEmit;

type Tx = subscriptionRepo.Tx;

const handleSubscriptionUpsert = async (
    tx: Tx,
    sub: SubscriptionNotification,
    ctx: { isCreated: boolean; occurredAt: string },
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

    const previous = await subscriptionRepo.findInTransaction(tx, userId);
    const data = subscriptionData(sub, userId, previous);
    if (!data) {
        return [];
    }
    const row = await subscriptionRepo.upsertFromPaddle(data, tx);
    const emits: AnalyticsEmit[] = [];
    if (sub.status === 'past_due') {
        if (!row.pastDueAt) {
            row.pastDueAt = new Date(ctx.occurredAt);
            await subscriptionRepo.updateForUser(userId, { pastDueAt: row.pastDueAt }, tx);
        }
        if (!row.pastDueEmailSentAt) {
            const claim = await subscriptionRepo.claimPastDueEmail(tx, userId, new Date());
            if (claim.count === 1) {
                emits.push(() => {
                    void sendBillingEmail('payment-failed', row);
                });
            }
        }
    }

    const billingPlan = billingPlanFromPriceId(priceId);
    if (!billingPlan) {
        return emits;
    }
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
    occurredAt: string,
): Promise<AnalyticsEmit[]> => {
    await handleSubscriptionUpsert(tx, sub, { isCreated: false, occurredAt });

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
    tx: Tx,
): Promise<AnalyticsEmit[]> => {
    if (txn.subscriptionId) {
        const card = txn.payments.find((p) => p.status === 'captured')?.methodDetails?.card;
        await subscriptionRepo.updateForPaddleSub(
            txn.subscriptionId,
            {
                ...clearedPastDueDetails,
                declineReason: null,
                ...(card
                    ? {
                          cardBrand: card.type,
                          cardLast4: card.last4,
                          cardExpMonth: card.expiryMonth,
                          cardExpYear: card.expiryYear,
                      }
                    : {}),
            },
            tx,
        );
    }
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

const handleTransactionPastDue = async (
    tx: Tx,
    txn: TransactionNotification,
    occurredAt: string,
): Promise<DeferredEmit[]> => {
    if (!txn.subscriptionId) {
        return [];
    }
    const row = await subscriptionRepo.findPaddleSubInTransaction(tx, txn.subscriptionId);
    if (!row || (txn.customerId && txn.customerId !== row.paddleCustomerId)) {
        return [];
    }
    const failed = [...txn.payments].reverse().find((p) => p.status === 'error');
    // Updating a card is not a renewal attempt and cannot affect entitlement
    // status or overwrite the original failed invoice's amount/date.
    if (txn.origin === 'subscription_payment_method_change') {
        if (row.status === 'past_due' && failed?.errorCode) {
            await subscriptionRepo.updateForUser(
                row.userId,
                { declineReason: failed.errorCode },
                tx,
            );
        }
        return [];
    }
    if (txn.origin !== 'subscription_recurring' && txn.status !== 'past_due') {
        return [];
    }
    const totals = txn.details?.totals;
    const patch = {
        pastDueAt: new Date(failed?.createdAt ?? occurredAt),
        ...(totals?.total !== undefined
            ? {
                  pastDueAmount: Number(totals.total),
                  pastDueCurrency: totals.currencyCode,
              }
            : {}),
        ...(failed?.errorCode ? { declineReason: failed.errorCode } : {}),
    };
    await subscriptionRepo.updateForUser(row.userId, patch, tx);
    return [];
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
        return await subscriptionRepo.transaction(async (tx): Promise<AnalyticsEmit[]> => {
            // Inside the transaction: the primary-key conflict on a concurrent
            // redelivery aborts the whole thing, so an event can never apply twice.
            await subscriptionRepo.recordWebhookEvent(tx, event.eventId, event.eventType);

            switch (event.eventType) {
                case 'subscription.created':
                    return handleSubscriptionUpsert(tx, event.data as SubscriptionNotification, {
                        isCreated: true,
                        occurredAt: event.occurredAt,
                    });
                case 'subscription.activated':
                case 'subscription.trialing':
                case 'subscription.updated':
                case 'subscription.past_due':
                case 'subscription.paused':
                case 'subscription.resumed':
                    return handleSubscriptionUpsert(tx, event.data, {
                        isCreated: false,
                        occurredAt: event.occurredAt,
                    });
                case 'subscription.canceled':
                    return handleSubscriptionCanceled(tx, event.data, event.occurredAt);
                case 'transaction.completed':
                    return handleTransactionCompleted(event.data, tx);
                case 'transaction.payment_failed':
                case 'transaction.past_due':
                    return handleTransactionPastDue(tx, event.data, event.occurredAt);
                case 'adjustment.created':
                    return [];
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
