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
    prisma.subscription.findUnique({ where: { userId } });

export const findByStripeCustomerId = (stripeCustomerId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { stripeCustomerId } });

export const upsertFromStripe = (data: UpsertSubscriptionData): Promise<SubscriptionRow> =>
    prisma.subscription.upsert({
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
    const row = await prisma.subscription.findFirst({
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
    await tx.stripeWebhookEvent.create({ data: { id, type } });
};

export const findWebhookEvent = (id: string): Promise<{ id: string } | null> =>
    prisma.stripeWebhookEvent.findUnique({ where: { id }, select: { id: true } });
