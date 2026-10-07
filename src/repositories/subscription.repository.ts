import { prisma } from '../db/prisma.js';

/** Paddle subscription statuses, mirrored verbatim onto the row. */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';

export type SubscriptionRow = {
    id: string;
    userId: string;
    status: string;
    plan: string;
    paddleCustomerId: string;
    paddleSubId: string;
    paddlePriceId: string;
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
    paddleCustomerId: string;
    paddleSubId: string;
    paddlePriceId: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    trialEnd: Date | null;
};

export const findByUserId = (userId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { userId } });

export const findByPaddleCustomerId = (paddleCustomerId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { paddleCustomerId } });

export const findByPaddleSubId = (paddleSubId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { paddleSubId } });

export const upsertFromPaddle = (data: UpsertSubscriptionData): Promise<SubscriptionRow> =>
    prisma.subscription.upsert({
        where: { userId: data.userId },
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

/**
 * Statuses that grant paid access.
 *
 * `trialing` counts — a 7-day trial is a paying relationship in waiting, and
 * gating it would make the trial pointless.
 *
 * `past_due` counts, deliberately: Paddle retries a failed renewal over several
 * days, and yanking Premium mid-dunning punishes someone whose card merely
 * expired. The `currentPeriodEnd` guard below still bounds it.
 *
 * `canceled` and `paused` do NOT count. Note this differs from the old Stripe
 * rule, which kept `canceled` entitled until the period end: under Paddle a
 * scheduled cancellation leaves `status` as `active` until the term actually
 * ends, so Paddle already provides that grace period. Honouring `canceled` too
 * would extend access past the real end date.
 *
 * Crucially this reads `status`, never `cancelAtPeriodEnd` — a subscription set
 * to cancel later is still active today and keeps full access until it lapses.
 */
const ENTITLED_STATUSES: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

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
    await tx.paddleWebhookEvent.create({ data: { id, type } });
};

export const findWebhookEvent = (id: string): Promise<{ id: string } | null> =>
    prisma.paddleWebhookEvent.findUnique({ where: { id }, select: { id: true } });
