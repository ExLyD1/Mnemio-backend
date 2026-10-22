import { prisma } from '../db/prisma.js';
import type { SubscriptionModel } from '../../generated/prisma/models/Subscription.js';
import type { Prisma } from '../../generated/prisma/client.js';
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export const transaction = <T>(fn: (tx: Tx) => Promise<T>) => prisma.$transaction(fn);

/** Paddle subscription statuses, mirrored verbatim onto the row. */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';

export type SubscriptionRow = SubscriptionModel;

export type UpsertSubscriptionData = Prisma.SubscriptionUncheckedCreateInput;

export const findByUserId = (userId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { userId } });

export const findByPaddleCustomerId = (paddleCustomerId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { paddleCustomerId } });

export const findByPaddleSubId = (paddleSubId: string): Promise<SubscriptionRow | null> =>
    prisma.subscription.findUnique({ where: { paddleSubId } });

export const upsertFromPaddle = (
    data: UpsertSubscriptionData,
    tx: Tx = prisma,
): Promise<SubscriptionRow> =>
    tx.subscription.upsert({ where: { userId: data.userId }, update: data, create: data });

export const findInTransaction = (tx: Tx, userId: string) =>
    tx.subscription.findUnique({ where: { userId } });
export const updateForUser = (
    userId: string,
    data: Prisma.SubscriptionUpdateManyMutationInput,
    tx: Tx = prisma,
) => tx.subscription.updateMany({ where: { userId }, data });
export const updateForPaddleSub = (
    paddleSubId: string,
    data: Prisma.SubscriptionUpdateManyMutationInput,
    tx: Tx,
) => tx.subscription.updateMany({ where: { paddleSubId }, data });
export const findPaddleSubInTransaction = (tx: Tx, paddleSubId: string) =>
    tx.subscription.findUnique({ where: { paddleSubId } });

/** Claim one deferred email per past-due episode in the webhook transaction. */
export const claimPastDueEmail = (tx: Tx, userId: string, sentAt: Date) =>
    tx.subscription.updateMany({
        where: { userId, status: 'past_due', pastDueEmailSentAt: null },
        data: { pastDueEmailSentAt: sentAt },
    });

export const trialEndingCandidates = (now: Date, until: Date) =>
    prisma.subscription.findMany({
        where: {
            status: 'trialing',
            trialEnd: { gt: now, lte: until },
            cancelAtPeriodEnd: false,
            OR: [{ scheduledChangeAction: null }, { scheduledChangeAction: { not: 'cancel' } }],
            trialEndingEmailSentAt: null,
        },
        include: { user: { select: { email: true } } },
    });
export const claimTrialEnding = (id: string, now: Date, until: Date) =>
    prisma.subscription.updateMany({
        where: {
            id,
            status: 'trialing',
            trialEnd: { gt: now, lte: until },
            cancelAtPeriodEnd: false,
            OR: [{ scheduledChangeAction: null }, { scheduledChangeAction: { not: 'cancel' } }],
            trialEndingEmailSentAt: null,
        },
        data: { trialEndingEmailSentAt: now },
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
