import { prisma } from '../db/prisma.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';

export type SubscriptionRow = {
    id: string;
    userId: string;
    status: string;
    plan: string;
    stripeCustomerId: string;
    stripeSubId: string;
    stripePriceId: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

export type UpsertSubscriptionData = {
    userId: string;
    status: string;
    plan: string;
    stripeCustomerId: string;
    stripeSubId: string;
    stripePriceId: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
};

export const findByUserId = (userId: string): Promise<SubscriptionRow | null> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).subscription.findUnique({ where: { userId } });

export const findByStripeCustomerId = (stripeCustomerId: string): Promise<SubscriptionRow | null> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).subscription.findUnique({ where: { stripeCustomerId } });

export const upsertFromStripe = (data: UpsertSubscriptionData): Promise<SubscriptionRow> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).subscription.upsert({
        where: { userId: data.userId },
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

const ENTITLED_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'canceled'];

export const isEntitled = async (userId: string): Promise<boolean> => {
    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).subscription.findFirst({
        where: {
            userId,
            status: { in: ENTITLED_STATUSES },
            currentPeriodEnd: { gt: now },
        },
        select: { id: true },
    });
    return row !== null;
};

export const recordWebhookEvent = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    id: string,
    type: string,
): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (tx as any).stripeWebhookEvent.create({ data: { id, type } });
};

export const findWebhookEvent = (id: string): Promise<{ id: string } | null> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).stripeWebhookEvent.findUnique({ where: { id }, select: { id: true } });
