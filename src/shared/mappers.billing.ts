import type { SubscriptionNotification } from '@paddle/paddle-node-sdk';
import { env } from '../config/env.js';
import type {
    SubscriptionRow,
    UpsertSubscriptionData,
    SubscriptionStatus,
} from '../repositories/subscription.repository.js';

export type BillingPlan = 'monthly' | 'annual';
export type Money = { amount: number; currency: string };
export type SubscriptionDto = {
    id: string;
    status: SubscriptionStatus;
    plan: BillingPlan;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    trialEnd: string | null;
    scheduledChange: {
        action: 'cancel' | 'pause' | 'resume';
        effectiveAt: string;
        resumeAt: string | null;
    } | null;
    price: Money | null;
    paymentMethod: {
        brand: string;
        last4: string;
        expMonth: number | null;
        expYear: number | null;
        declineReason: string | null;
    } | null;
    pastDue: {
        amount: number;
        currency: string;
        failedAt: string;
        nextRetryAt: string | null;
        graceEndsAt: string;
    } | null;
    scheduledPlanChange: BillingPlan | null;
};

/** Paddle amounts use the currency's lowest denomination. */
export const lowestUnitToMajor = (
    amount: string | number | null | undefined,
    currency: string,
): number => {
    const n = Number(amount ?? 0);
    if (!Number.isFinite(n)) {
        return 0;
    }
    const digits =
        new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
            .maximumFractionDigits ?? 2;
    return n / 10 ** digits;
};

export const billingPlanFromPriceId = (id: string | undefined): BillingPlan | null => {
    if (id && id === env.PADDLE_PRICE_MONTHLY) {
        return 'monthly';
    }
    if (id && id === env.PADDLE_PRICE_ANNUAL) {
        return 'annual';
    }
    return null;
};

export const billingPlanFromPrice = (
    price: { id: string; billingCycle: { interval: string } | null } | null | undefined,
): BillingPlan | null => {
    const configuredPlan = billingPlanFromPriceId(price?.id);
    if (configuredPlan) {
        return configuredPlan;
    }
    if (price?.billingCycle?.interval === 'year') {
        return 'annual';
    }
    if (price?.billingCycle?.interval === 'month') {
        return 'monthly';
    }
    return null;
};

export const clearedPastDue = { pastDueAmount: null, pastDueCurrency: null, pastDueAt: null };

// API entities and notification entities share these fields in SDK 3.10.
type PaddleSubscription = Pick<
    SubscriptionNotification,
    'id' | 'status' | 'customerId' | 'items' | 'currentBillingPeriod' | 'scheduledChange'
>;
export const subscriptionData = (
    sub: PaddleSubscription,
    userId: string,
    previous: SubscriptionRow | null,
): UpsertSubscriptionData | null => {
    const item = sub.items[0];
    if (!item?.price?.id) {
        return null;
    }
    const start = sub.currentBillingPeriod?.startsAt;
    const end = sub.currentBillingPeriod?.endsAt;
    const currentPeriodStart = start ? new Date(start) : previous?.currentPeriodStart;
    const currentPeriodEnd = end ? new Date(end) : previous?.currentPeriodEnd;
    const plan = billingPlanFromPrice(item.price) ?? previous?.plan;
    if (!currentPeriodStart || !currentPeriodEnd || !plan) {
        return null;
    }
    const scheduled = sub.scheduledChange;
    return {
        userId,
        status: sub.status,
        plan,
        paddleCustomerId: sub.customerId,
        paddleSubId: sub.id,
        paddlePriceId: item.price.id,
        paddleProductId: item.price.productId,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: scheduled?.action === 'cancel',
        scheduledChangeAction: scheduled?.action ?? null,
        scheduledChangeAt: scheduled?.effectiveAt ? new Date(scheduled.effectiveAt) : null,
        scheduledResumeAt: scheduled?.resumeAt ? new Date(scheduled.resumeAt) : null,
        trialEnd: item.trialDates?.endsAt ? new Date(item.trialDates.endsAt) : null,
        priceAmount: item.price.unitPrice ? Number(item.price.unitPrice.amount) : null,
        currency: item.price.unitPrice?.currencyCode ?? null,
        ...(sub.status !== 'past_due' ? clearedPastDue : {}),
        ...(previous?.scheduledPlan === plan ? { scheduledPlan: null } : {}),
    };
};

export const toSubscriptionDto = (row: SubscriptionRow): SubscriptionDto => ({
    id: row.id,
    status: row.status as SubscriptionStatus,
    plan: row.plan as BillingPlan,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEnd: row.trialEnd?.toISOString() ?? null,
    scheduledChange:
        row.scheduledChangeAction && row.scheduledChangeAt
            ? {
                  action: row.scheduledChangeAction as 'cancel' | 'pause' | 'resume',
                  effectiveAt: row.scheduledChangeAt.toISOString(),
                  resumeAt: row.scheduledResumeAt?.toISOString() ?? null,
              }
            : null,
    price:
        row.priceAmount !== null && row.currency
            ? { amount: lowestUnitToMajor(row.priceAmount, row.currency), currency: row.currency }
            : null,
    paymentMethod:
        row.cardBrand && row.cardLast4
            ? {
                  brand: row.cardBrand,
                  last4: row.cardLast4,
                  expMonth: row.cardExpMonth ?? null,
                  expYear: row.cardExpYear ?? null,
                  declineReason: row.declineReason ?? null,
              }
            : null,
    pastDue:
        row.status === 'past_due' &&
        row.pastDueAmount !== null &&
        row.pastDueCurrency &&
        row.pastDueAt
            ? {
                  amount: lowestUnitToMajor(row.pastDueAmount, row.pastDueCurrency),
                  currency: row.pastDueCurrency,
                  failedAt: row.pastDueAt.toISOString(),
                  nextRetryAt: null,
                  graceEndsAt: row.currentPeriodEnd.toISOString(),
              }
            : null,
    scheduledPlanChange: (row.scheduledPlan as BillingPlan | null) ?? null,
});
