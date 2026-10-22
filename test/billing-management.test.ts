import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';

const sdk = vi.hoisted(() => {
    if (
        process.env.DATABASE_URL !== 'postgresql://postgres:postgres@localhost:5433/mnemio_qa_sub'
    ) {
        throw new Error(
            'Billing integration tests require the dedicated mnemio_qa_sub DATABASE_URL',
        );
    }
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'billing-test-secret-at-least-32-characters';
    process.env.PADDLE_API_KEY = 'pdl_sdbx_test';
    process.env.PADDLE_WEBHOOK_SECRET = 'test-signing-secret';
    process.env.PADDLE_PRICE_MONTHLY = 'pri_monthly';
    process.env.PADDLE_PRICE_ANNUAL = 'pri_annual';
    return {
        subscriptions: {
            cancel: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            update: vi.fn(),
            previewUpdate: vi.fn(),
            getPaymentMethodChangeTransaction: vi.fn(),
        },
        transactions: { list: vi.fn(), get: vi.fn(), getInvoicePDF: vi.fn() },
        customerPortalSessions: { create: vi.fn() },
    };
});
vi.mock('@paddle/paddle-node-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@paddle/paddle-node-sdk')>();
    return {
        ...actual,
        Paddle: class extends actual.Paddle {
            constructor(...args: ConstructorParameters<typeof actual.Paddle>) {
                super(...args);
                Object.assign(this, sdk, {
                    customers: {
                        get: vi.fn().mockRejectedValue(new Error('Unexpected customer lookup')),
                    },
                });
            }
        },
    };
});
vi.mock('../src/services/mail.service.js', () => ({ sendMail: vi.fn() }));
vi.mock('../src/services/analytics.service.js', () => ({ track: vi.fn(), setUserProps: vi.fn() }));
import { prisma } from '../src/db/prisma.js';
import { registerJwt } from '../src/plugins/jwt.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import billingRoutes from '../src/routes/billing.routes.js';
import * as prefsController from '../src/controllers/preferences.controller.js';
import { usageSnapshot, capFor } from '../src/services/ai.budget.service.js';
import { runTrialEndingOnce, registerTrialEndingJob } from '../src/jobs/trial-ending.job.js';
import { sendMail } from '../src/services/mail.service.js';
import { billingEmail } from '../src/services/billing-mail.service.js';
import { addMonths, handleWebhookEvent } from '../src/services/billing.service.js';
import * as analytics from '../src/services/analytics.service.js';
import { isEntitled, type SubscriptionRow } from '../src/repositories/subscription.repository.js';
import { env } from '../src/config/env.js';
import {
    lowestUnitToMajor,
    subscriptionData,
    toSubscriptionDto,
} from '../src/shared/mappers.billing.js';
import { usage } from '../src/controllers/ai.controller.js';

const start = '2026-10-01T12:00:00.000Z';
const end = '2026-11-01T12:00:00.000Z';
let userId: string;
let otherId: string;
let headers: { authorization: string };
const app = Fastify({ logger: false });
const mail = vi.mocked(sendMail);
const eventIds: string[] = [];

const paddleSub = (over: Record<string, unknown> = {}) => ({
    id: 'sub_own',
    customerId: 'ctm_own',
    status: 'active',
    currencyCode: 'USD',
    currentBillingPeriod: { startsAt: start, endsAt: end },
    billingCycle: { interval: 'month', frequency: 1 },
    scheduledChange: null,
    items: [
        {
            status: 'active',
            quantity: 1,
            recurring: true,
            trialDates: null,
            price: {
                id: 'pri_monthly',
                productId: 'pro_premium',
                unitPrice: { amount: '1000', currencyCode: 'USD' },
                quantity: { minimum: 1, maximum: 100 },
                billingCycle: { interval: 'month', frequency: 1 },
            },
        },
    ],
    customData: { userId },
    ...over,
});
const seedSubscription = (over: Record<string, unknown> = {}) =>
    prisma.subscription.create({
        data: {
            userId,
            paddleCustomerId: 'ctm_own',
            paddleSubId: 'sub_own',
            paddlePriceId: 'pri_monthly',
            paddleProductId: 'pro_premium',
            status: 'active',
            plan: 'monthly',
            currentPeriodStart: new Date(start),
            currentPeriodEnd: new Date(end),
            priceAmount: 1000,
            currency: 'USD',
            ...over,
        },
    });
const row = () => prisma.subscription.findUniqueOrThrow({ where: { userId } });
const patch = (data: Record<string, unknown>) =>
    prisma.subscription.update({ where: { userId }, data });
const request = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) =>
    app.inject({
        method,
        url: `/api/v1${path}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
    });
const apiTransaction = (over: Record<string, unknown> = {}) => ({
    id: 'txn_own',
    subscriptionId: 'sub_own',
    customerId: 'ctm_own',
    status: 'completed',
    currencyCode: 'USD',
    invoiceId: 'inv_own',
    billedAt: start,
    createdAt: start,
    updatedAt: start,
    items: paddleSub().items,
    payments: [],
    details: {
        totals: { total: '1000', grandTotal: '1000', currencyCode: 'USD' },
        taxRatesUsed: [],
        lineItems: [],
    },
    customData: { userId },
    origin: 'subscription_recurring',
    ...over,
});
const snake = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(snake)
        : value && typeof value === 'object'
          ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                    k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
                    k === 'customData' ? v : snake(v),
                ]),
            )
          : value;
const event = (type: string, data: unknown) => {
    const id = `evt_${crypto.randomBytes(13).toString('hex')}`;
    eventIds.push(id);
    const body = JSON.stringify({
        event_id: id,
        event_type: type,
        occurred_at: start,
        notification_id: 'ntf_test',
        data: snake(data),
    });
    const ts = Math.floor(Date.now() / 1000);
    const signature = `ts=${ts};h1=${crypto.createHmac('sha256', 'test-signing-secret').update(`${ts}:${body}`).digest('hex')}`;
    return { body, signature };
};
const deliver = async (type: string, data: unknown) => {
    const e = event(type, data);
    const emits = await handleWebhookEvent(e.body, e.signature);
    for (const emit of emits) emit();
    await vi.waitFor(() => expect(analytics.track).toBeDefined());
    return e;
};

beforeAll(async () => {
    await registerJwt(app);
    registerErrorHandler(app);
    await app.register(billingRoutes, { prefix: '/api/v1' });
    app.get('/api/v1/ai/usage', { preHandler: [app.authenticate] }, usage);
    app.get(
        '/api/v1/users/me/preferences',
        { preHandler: [app.authenticate] },
        prefsController.get,
    );
    app.patch(
        '/api/v1/users/me/preferences',
        { preHandler: [app.authenticate] },
        prefsController.update,
    );
    userId = (
        await prisma.user.create({ data: { email: `billing-${crypto.randomUUID()}@test.local` } })
    ).id;
    otherId = (
        await prisma.user.create({ data: { email: `billing-${crypto.randomUUID()}@test.local` } })
    ).id;
    headers = {
        authorization: `Bearer ${app.jwt.sign({ sub: userId, role: 'user', emailVerified: true })}`,
    };
    await app.ready();
}, 30000);
beforeEach(async () => {
    vi.resetAllMocks();
    await prisma.subscription.deleteMany({ where: { userId: { in: [userId, otherId] } } });
    await prisma.preference.deleteMany({ where: { userId } });
    sdk.subscriptions.cancel.mockResolvedValue(
        paddleSub({ scheduledChange: { action: 'cancel', effectiveAt: end, resumeAt: null } }),
    );
    sdk.subscriptions.pause.mockResolvedValue(
        paddleSub({
            scheduledChange: {
                action: 'pause',
                effectiveAt: end,
                resumeAt: '2027-01-01T12:00:00.000Z',
            },
        }),
    );
    sdk.subscriptions.resume.mockResolvedValue(paddleSub());
    sdk.subscriptions.update.mockResolvedValue(paddleSub());
    sdk.subscriptions.getPaymentMethodChangeTransaction.mockResolvedValue({ id: 'txn_card' });
    sdk.transactions.get.mockResolvedValue(apiTransaction());
    sdk.transactions.getInvoicePDF.mockResolvedValue({ url: 'https://paddle.test/invoice.pdf' });
    sdk.transactions.list.mockReturnValue({ next: vi.fn().mockResolvedValue([apiTransaction()]) });
    sdk.subscriptions.previewUpdate.mockResolvedValue({
        items: [{ price: { unitPrice: { amount: '9600', currencyCode: 'USD' } } }],
        currencyCode: 'USD',
        nextBilledAt: end,
        immediateTransaction: { details: { totals: { grandTotal: '9000', currencyCode: 'USD' } } },
        updateSummary: { credit: { amount: '600', currencyCode: 'USD' } },
    });
});
afterAll(async () => {
    await app.close();
    if (userId) await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.paddleWebhookEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
});

describe('appearance preferences', () => {
    it('defaults both lazy-created and null preferences', async () => {
        expect((await request('GET', '/users/me/preferences')).json()).toMatchObject({
            mascot: 'panda',
            palette: 'green',
        });
        await prisma.preference.update({
            where: { userId },
            data: { mascot: null, palette: null },
        });
        expect((await request('GET', '/users/me/preferences')).json()).toMatchObject({
            mascot: 'panda',
            palette: 'green',
        });
    });
    it.each(['panda', 'red', 'pink', 'axolotl'])(
        'saves mascot %s and preserves other fields',
        async (mascot) => {
            const res = await request('PATCH', '/users/me/preferences', {
                mascot,
                goal: 'Learn words',
                avatarHue: 42,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toMatchObject({
                mascot,
                palette: 'green',
                goal: 'Learn words',
                avatarHue: 42,
            });
            expect((await request('GET', '/users/me/preferences')).json().mascot).toBe(mascot);
        },
    );
    it.each(['green', 'violet', 'pink'])('saves palette %s', async (palette) => {
        expect((await request('PATCH', '/users/me/preferences', { palette })).json()).toMatchObject(
            { palette, mascot: 'panda' },
        );
    });
    it.each([{ mascot: 'bear' }, { palette: 'blue' }, { mascot: null }, { palette: 3 }])(
        'rejects invalid appearance %j',
        async (body) => {
            const res = await request('PATCH', '/users/me/preferences', body);
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe('VALIDATION_ERROR');
        },
    );
    it('returns free caps for every AI kind on both plans', async () => {
        const free = await usageSnapshot(userId);
        await seedSubscription({ currentPeriodEnd: new Date(Date.now() + 86400000) });
        const premium = await usageSnapshot(userId);
        expect(premium.plan).toBe('premium');
        expect(premium.freeCaps).toEqual(free.freeCaps);
        expect((await request('GET', '/ai/usage')).json().freeCaps).toEqual(free.freeCaps);
        for (const kind of Object.keys(free.kinds) as (keyof typeof free.kinds)[])
            expect(free.freeCaps[kind]).toBe(capFor(kind, 'free'));
    });
});

const endpoints = [
    ['POST', '/billing/cancel', { reason: 'other' }, 'cancel'],
    ['POST', '/billing/pause', { months: 2 }, 'pause'],
    ['POST', '/billing/resume', {}, 'resume'],
    ['POST', '/billing/change-plan/preview', { plan: 'annual', when: 'now' }, 'previewUpdate'],
    ['POST', '/billing/change-plan', { plan: 'annual', when: 'now' }, 'update'],
    ['GET', '/billing/payment-method-transaction', undefined, 'getPaymentMethodChangeTransaction'],
    ['GET', '/billing/invoices', undefined, 'list'],
    ['GET', '/billing/invoices/txn_own/pdf', undefined, 'get'],
] as const;

describe('billing management routes', () => {
    it.each(endpoints)(
        '%s %s rejects a missing token before reaching Paddle',
        async (method, url, body) => {
            const response = await app.inject({
                method,
                url: `/api/v1${url}`,
                ...(body ? { payload: body } : {}),
            });
            expect(response.statusCode).toBe(401);
            expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
            for (const fn of [
                ...Object.values(sdk.subscriptions),
                ...Object.values(sdk.transactions),
            ]) {
                expect(fn).not.toHaveBeenCalled();
            }
        },
    );
    it.each([undefined, 'application/json', 'application/json; charset=utf-8'])(
        'accepts resume with no body and content-type %s',
        async (contentType) => {
            await seedSubscription({ status: 'paused' });
            const response = await app.inject({
                method: 'POST',
                url: '/api/v1/billing/resume',
                headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().status).toBe('active');
            expect(sdk.subscriptions.resume).toHaveBeenCalledWith('sub_own', {
                effectiveFrom: 'immediately',
            });
        },
    );
    it('authenticates resume even when its JSON body is empty', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/api/v1/billing/resume',
            headers: { 'content-type': 'application/json' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('AUTH_INVALID_TOKEN');
    });
    it('keeps resume JSON validation and scopes empty JSON acceptance to resume', async () => {
        await seedSubscription({ status: 'paused' });
        for (const payload of ['{', '{"__proto__":{"polluted":true}}']) {
            expect(
                (
                    await app.inject({
                        method: 'POST',
                        url: '/api/v1/billing/resume',
                        headers: { ...headers, 'content-type': 'application/json' },
                        payload,
                    })
                ).statusCode,
            ).toBe(400);
        }
        expect(
            (
                await app.inject({
                    method: 'POST',
                    url: '/api/v1/billing/cancel',
                    headers: { ...headers, 'content-type': 'application/json' },
                })
            ).statusCode,
        ).toBe(400);
        expect(sdk.subscriptions.resume).not.toHaveBeenCalled();
    });
    it('derives invoice plans for unknown prices from their billing cycle', async () => {
        await seedSubscription();
        const monthly = apiTransaction();
        monthly.items[0]!.price.id = 'pri_new_monthly';
        const annual = apiTransaction({ id: 'txn_annual' });
        annual.items[0]!.price.id = 'pri_new_annual';
        annual.items[0]!.price.billingCycle.interval = 'year';
        const unknown = apiTransaction({
            id: 'txn_unknown',
            items: [{ price: { id: 'pri_unknown', billingCycle: null } }],
        });
        sdk.transactions.list.mockReturnValueOnce({ next: async () => [monthly, annual, unknown] });
        const response = await request('GET', '/billing/invoices');
        expect(response.statusCode).toBe(200);
        expect(
            response.json().items.map((invoice: { plan: string | null }) => invoice.plan),
        ).toEqual(['monthly', 'annual', null]);
    });
    it('keeps billing-not-configured behavior for provider routes and local GET semantics', async () => {
        const key = env.PADDLE_API_KEY;
        env.PADDLE_API_KEY = undefined;
        try {
            for (const [method, url, body] of endpoints) {
                const response = await request(method, url, body);
                expect(response.statusCode).toBe(400);
                expect(response.json().code).toBe('BILLING_NOT_CONFIGURED');
            }
            expect((await request('GET', '/billing/subscription')).json()).toBeNull();
        } finally {
            env.PADDLE_API_KEY = key;
        }
    });
    it('returns 200 null without a subscription', async () => {
        const res = await request('GET', '/billing/subscription');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toBeNull();
    });
    it.each(endpoints)(
        '%s %s requires authentication and an owned subscription',
        async (method, url, body) => {
            const unauthenticated = await app.inject({
                method,
                url: `/api/v1${url}`,
                ...(body ? { payload: body } : {}),
            });
            expect(unauthenticated.statusCode).toBe(401);
            await seedSubscription({ userId: otherId });
            const res = await request(method, url, body);
            expect(res.statusCode).toBe(404);
            expect(res.json().code).toBe('BILLING_NO_SUBSCRIPTION');
        },
    );
    it.each(endpoints)(
        '%s %s maps provider failures to 502 without changing DB',
        async (method, url, body, api) => {
            const before = await seedSubscription(api === 'resume' ? { status: 'paused' } : {});
            const fn =
                api === 'list'
                    ? sdk.transactions.list
                    : api === 'get'
                      ? sdk.transactions.get
                      : sdk.subscriptions[api];
            fn.mockImplementationOnce(() => {
                throw Object.assign(new Error('secret provider details'), {
                    code: 'provider_test_error',
                });
            });
            const res = await request(method, url, body);
            expect(res.statusCode).toBe(502);
            expect(res.json()).toEqual({
                code: 'BILLING_PROVIDER_ERROR',
                message: 'Billing provider request failed',
            });
            expect(await row()).toEqual(before);
            expect(mail).not.toHaveBeenCalled();
        },
    );
    it('cancels at renewal, persists feedback and defers one email', async () => {
        await seedSubscription();
        const res = await request('POST', '/billing/cancel', {
            reason: 'too_expensive',
            feedback: '<script>test</script>',
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            status: 'active',
            cancelAtPeriodEnd: true,
            scheduledChange: { action: 'cancel', effectiveAt: end, resumeAt: null },
        });
        expect(sdk.subscriptions.cancel).toHaveBeenCalledWith('sub_own', {
            effectiveFrom: 'next_billing_period',
        });
        expect(await row()).toMatchObject({
            cancelReason: 'too_expensive',
            cancelFeedback: '<script>test</script>',
            cancelRequestedAt: expect.any(Date),
        });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
        expect(mail.mock.calls[0]![0]).toMatchObject({
            subject: 'Your subscription is cancelled',
            text: expect.stringContaining('Your decks stay.'),
        });
        expect(mail.mock.calls[0]![0].html).not.toContain('<script>');
        expect((await request('POST', '/billing/cancel', { reason: 'other' })).statusCode).toBe(
            409,
        );
    });
    it('allows cancellation during trial and mail failure does not fail response', async () => {
        await seedSubscription({ status: 'trialing' });
        mail.mockRejectedValueOnce(new Error('mail offline'));
        expect((await request('POST', '/billing/cancel', { reason: 'other' })).statusCode).toBe(
            200,
        );
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it.each(['past_due', 'paused', 'canceled'])('blocks cancel in %s', async (status) => {
        await seedSubscription({ status });
        expect((await request('POST', '/billing/cancel', { reason: 'other' })).statusCode).toBe(
            409,
        );
        expect(sdk.subscriptions.cancel).not.toHaveBeenCalled();
    });
    it('pauses with a calendar resume date', async () => {
        await seedSubscription();
        const res = await request('POST', '/billing/pause', { months: 2 });
        expect(res.statusCode).toBe(200);
        expect(res.json().scheduledChange).toEqual({
            action: 'pause',
            effectiveAt: end,
            resumeAt: '2027-01-01T12:00:00.000Z',
        });
        expect(sdk.subscriptions.pause).toHaveBeenCalledWith('sub_own', {
            effectiveFrom: 'next_billing_period',
            resumeAt: '2027-01-01T12:00:00.000Z',
        });
        expect(addMonths(new Date('2028-01-31T12:30:00Z'), 1).toISOString()).toBe(
            '2028-02-29T12:30:00.000Z',
        );
        expect(addMonths(new Date('2027-01-31T12:30:00Z'), 1).toISOString()).toBe(
            '2027-02-28T12:30:00.000Z',
        );
    });
    it.each([
        { status: 'trialing' },
        { status: 'past_due' },
        { status: 'paused' },
        { status: 'canceled' },
        { scheduledChangeAction: 'pause' },
        { scheduledChangeAction: 'cancel' },
        { scheduledPlan: 'annual' },
    ])('blocks pause in %j', async (over) => {
        await seedSubscription(over);
        expect((await request('POST', '/billing/pause', { months: 1 })).statusCode).toBe(409);
    });
    it.each(['cancel', 'pause'])('removes a scheduled %s', async (action) => {
        await seedSubscription({
            scheduledChangeAction: action,
            scheduledChangeAt: new Date(end),
            cancelAtPeriodEnd: action === 'cancel',
        });
        const res = await request('POST', '/billing/resume');
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ scheduledChange: null, cancelAtPeriodEnd: false });
        expect(sdk.subscriptions.update).toHaveBeenCalledWith('sub_own', { scheduledChange: null });
    });
    it('resumes a paused subscription immediately', async () => {
        await seedSubscription({ status: 'paused' });
        const res = await request('POST', '/billing/resume', {});
        expect(res.json().status).toBe('active');
        expect(sdk.subscriptions.resume).toHaveBeenCalledWith('sub_own', {
            effectiveFrom: 'immediately',
        });
    });
    it('can remove a scheduled cancellation while payment is past due', async () => {
        await seedSubscription({
            status: 'past_due',
            scheduledChangeAction: 'cancel',
            cancelAtPeriodEnd: true,
        });
        expect((await request('POST', '/billing/resume', {})).statusCode).toBe(200);
        expect(sdk.subscriptions.update).toHaveBeenCalledWith('sub_own', { scheduledChange: null });
    });
    it.each(['active', 'trialing', 'past_due', 'canceled'])(
        'blocks resume in unscheduled %s',
        async (status) => {
            await seedSubscription({ status });
            expect((await request('POST', '/billing/resume', {})).statusCode).toBe(409);
        },
    );
    it.each(['now', 'renewal'] as const)(
        'previews %s with positive credit in major units',
        async (when) => {
            const before = await seedSubscription();
            const res = await request('POST', '/billing/change-plan/preview', {
                plan: 'annual',
                when,
            });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({
                plan: 'annual',
                when,
                newPrice: { amount: 96, currency: 'USD' },
                credit: { amount: 6, currency: 'USD' },
                dueToday: { amount: when === 'now' ? 90 : 0, currency: 'USD' },
                nextBilledAt: end,
            });
            expect(sdk.subscriptions.previewUpdate).toHaveBeenCalledWith('sub_own', {
                items: [{ priceId: 'pri_annual', quantity: 1 }],
                prorationBillingMode:
                    when === 'now' ? 'prorated_immediately' : 'full_next_billing_period',
            });
            expect(await row()).toEqual(before);
        },
    );
    it.each(['now', 'renewal'] as const)(
        'changes plan %s and persists returned subscription',
        async (when) => {
            await seedSubscription();
            const annual = paddleSub();
            annual.items[0]!.price.id = 'pri_annual';
            annual.items[0]!.price.unitPrice.amount = '9600';
            sdk.subscriptions.update.mockResolvedValueOnce(annual);
            const res = await request('POST', '/billing/change-plan', { plan: 'annual', when });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toMatchObject({
                plan: 'annual',
                price: { amount: 96, currency: 'USD' },
                scheduledPlanChange: when === 'renewal' ? 'annual' : null,
            });
            expect(sdk.subscriptions.update).toHaveBeenCalledWith('sub_own', {
                items: [{ priceId: 'pri_annual', quantity: 1 }],
                prorationBillingMode:
                    when === 'now' ? 'prorated_immediately' : 'full_next_billing_period',
            });
        },
    );
    it.each(['/billing/change-plan', '/billing/change-plan/preview'])(
        'enforces plan change states on %s',
        async (url) => {
            await seedSubscription();
            expect((await request('POST', url, { plan: 'monthly', when: 'now' })).statusCode).toBe(
                409,
            );
            await patch({ plan: 'annual' });
            expect((await request('POST', url, { plan: 'monthly', when: 'now' })).statusCode).toBe(
                409,
            );
            for (const status of ['paused', 'canceled', 'past_due']) {
                await patch({ status, plan: 'monthly' });
                expect(
                    (await request('POST', url, { plan: 'annual', when: 'renewal' })).statusCode,
                ).toBe(409);
            }
        },
    );
    it('allows trial upgrades now and annual downgrades at renewal', async () => {
        await seedSubscription({ status: 'trialing' });
        expect(
            (await request('POST', '/billing/change-plan/preview', { plan: 'annual', when: 'now' }))
                .statusCode,
        ).toBe(200);
        await patch({ status: 'active', plan: 'annual' });
        expect(
            (await request('POST', '/billing/change-plan', { plan: 'monthly', when: 'renewal' }))
                .statusCode,
        ).toBe(200);
        expect((await row()).scheduledPlan).toBe('monthly');
    });
    it('derives preview from summary/next transaction when there is no immediate transaction', async () => {
        await seedSubscription();
        sdk.subscriptions.previewUpdate.mockResolvedValueOnce({
            items: [],
            currencyCode: 'USD',
            nextBilledAt: null,
            immediateTransaction: null,
            nextTransaction: { details: { totals: { total: '9600', currencyCode: 'USD' } } },
            updateSummary: {
                credit: { amount: '-100', currencyCode: 'USD' },
                result: { action: 'charge', amount: '9500' },
            },
        });
        const res = await request('POST', '/billing/change-plan/preview', {
            plan: 'annual',
            when: 'now',
        });
        expect(res.json()).toEqual({
            plan: 'annual',
            when: 'now',
            newPrice: { amount: 96, currency: 'USD' },
            credit: { amount: 1, currency: 'USD' },
            dueToday: { amount: 95, currency: 'USD' },
            nextBilledAt: null,
        });
    });
    it('does not persist an action response for a different Paddle subscription', async () => {
        const before = await seedSubscription();
        sdk.subscriptions.cancel.mockResolvedValueOnce(paddleSub({ id: 'sub_other' }));
        expect((await request('POST', '/billing/cancel', { reason: 'other' })).statusCode).toBe(
            502,
        );
        expect(await row()).toEqual(before);
    });
    it('returns a payment method transaction and rejects canceled state', async () => {
        await seedSubscription();
        expect((await request('GET', '/billing/payment-method-transaction')).json()).toEqual({
            transactionId: 'txn_card',
        });
        expect(sdk.subscriptions.getPaymentMethodChangeTransaction).toHaveBeenCalledWith('sub_own');
        await patch({ status: 'canceled' });
        expect((await request('GET', '/billing/payment-method-transaction')).statusCode).toBe(409);
    });
    it('lists invoices newest first with live refund adjustments and a 50-row limit', async () => {
        await seedSubscription();
        sdk.transactions.list.mockReturnValueOnce({
            next: async () => [
                apiTransaction({
                    id: 'txn_trial',
                    details: { totals: { total: '0', currencyCode: 'USD' } },
                    billedAt: '2026-01-01T00:00:00Z',
                }),
                apiTransaction({
                    id: 'txn_failed',
                    status: 'past_due',
                    billedAt: '2026-02-01T00:00:00Z',
                }),
                apiTransaction({
                    id: 'txn_refund',
                    adjustments: [{ action: 'refund', status: 'approved' }],
                    billedAt: '2026-03-01T00:00:00Z',
                }),
                apiTransaction({
                    id: 'txn_paid',
                    adjustments: [{ action: 'refund', status: 'pending_approval' }],
                    billedAt: '2026-04-01T00:00:00Z',
                }),
            ],
        });
        const res = await request('GET', '/billing/invoices');
        expect(res.statusCode).toBe(200);
        expect(res.json().items.map((t: { status: string }) => t.status)).toEqual([
            'paid',
            'refunded',
            'failed',
            'trial',
        ]);
        expect(res.json().items[3].hasPdf).toBe(false);
        expect(res.json().items[0]).toMatchObject({
            amount: 10,
            currency: 'USD',
            plan: 'monthly',
            hasPdf: true,
        });
        expect(sdk.transactions.list).toHaveBeenCalledWith({
            subscriptionId: ['sub_own'],
            status: ['completed', 'past_due', 'billed', 'paid'],
            perPage: 50,
            orderBy: 'billed_at[DESC]',
            include: ['adjustment'],
        });
        sdk.transactions.list.mockReturnValueOnce({
            next: async () => Array.from({ length: 55 }, () => apiTransaction()),
        });
        expect((await request('GET', '/billing/invoices')).json().items).toHaveLength(50);
    });
    it('returns a verified owned invoice PDF URL', async () => {
        await seedSubscription();
        expect((await request('GET', '/billing/invoices/txn_own/pdf')).json()).toEqual({
            url: 'https://paddle.test/invoice.pdf',
        });
        expect(sdk.transactions.getInvoicePDF).toHaveBeenCalledWith('txn_own');
    });
    it.each([
        { subscriptionId: 'sub_other' },
        { customerId: 'ctm_other' },
        { invoiceId: null },
        { details: { totals: { total: '0' } } },
    ])('refuses PDF before URL lookup for %j', async (over) => {
        await seedSubscription();
        sdk.transactions.get.mockResolvedValueOnce(apiTransaction(over));
        const res = await request('GET', '/billing/invoices/txn_own/pdf');
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('BILLING_INVOICE_NOT_FOUND');
        expect(sdk.transactions.getInvoicePDF).not.toHaveBeenCalled();
    });
    it.each([
        ['/billing/cancel', { reason: 'invalid' }],
        ['/billing/cancel', { reason: 'other', feedback: 'x'.repeat(501) }],
        ['/billing/pause', { months: 4 }],
        ['/billing/pause', { months: '1' }],
        ['/billing/change-plan', { plan: 'free', when: 'now' }],
        ['/billing/change-plan/preview', { plan: 'annual', when: 'later' }],
        ['/billing/resume', { unexpected: true }],
    ])('validates %s body', async (url, payload) => {
        await seedSubscription();
        const res = await request('POST', url, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('VALIDATION_ERROR');
    });
    it('maps a failure of the PDF request itself without changing the row', async () => {
        const before = await seedSubscription();
        sdk.transactions.getInvoicePDF.mockRejectedValueOnce({ code: 'invoice_unavailable' });
        expect((await request('GET', '/billing/invoices/txn_own/pdf')).statusCode).toBe(502);
        expect(await row()).toEqual(before);
    });
    it('maps rich and legacy subscription DTOs without fabricating retry dates', async () => {
        await seedSubscription();
        expect((await request('GET', '/billing/subscription')).json()).toMatchObject({
            scheduledChange: null,
            paymentMethod: null,
            pastDue: null,
            scheduledPlanChange: null,
        });
        await patch({
            status: 'past_due',
            scheduledChangeAction: 'pause',
            scheduledChangeAt: new Date(end),
            scheduledResumeAt: new Date('2027-01-01Z'),
            scheduledPlan: 'annual',
            cardBrand: 'visa',
            cardLast4: '4242',
            cardExpMonth: 5,
            cardExpYear: 2029,
            declineReason: 'declined',
            pastDueAmount: 1234,
            pastDueCurrency: 'USD',
            pastDueAt: new Date(start),
        });
        const dto = (await request('GET', '/billing/subscription')).json();
        expect(dto.pastDue).toEqual({
            amount: 12.34,
            currency: 'USD',
            failedAt: start,
            nextRetryAt: null,
            graceEndsAt: end,
        });
        expect(dto.paymentMethod).toEqual({
            brand: 'visa',
            last4: '4242',
            expMonth: 5,
            expYear: 2029,
            declineReason: 'declined',
        });
        expect(dto.scheduledChange).toEqual({
            action: 'pause',
            effectiveAt: end,
            resumeAt: '2027-01-01T00:00:00.000Z',
        });
        expect(dto.scheduledPlanChange).toBe('annual');
        await patch({ status: 'active' });
        expect((await request('GET', '/billing/subscription')).json().pastDue).toBeNull();
    });
});

describe('billing notifications and trial reminders', () => {
    it.each([
        ['subscription.updated', 'subscription.past_due'],
        ['subscription.past_due', 'subscription.updated'],
    ])(
        'claims one email per episode for %s then %s, including redelivery and recovery',
        async (firstType, secondType) => {
            await seedSubscription();
            const first = event(firstType!, paddleSub({ status: 'past_due' }));
            const second = event(secondType!, paddleSub({ status: 'past_due' }));
            const firstEmits = await handleWebhookEvent(first.body, first.signature);
            const marker = (await row()).pastDueEmailSentAt;
            expect(marker).toBeInstanceOf(Date);
            expect(mail).not.toHaveBeenCalled();
            expect(firstEmits).toHaveLength(1);
            const secondEmits = await handleWebhookEvent(second.body, second.signature);
            expect(secondEmits).toEqual([]);
            expect((await row()).pastDueEmailSentAt).toEqual(marker);
            for (const emit of firstEmits) emit();
            await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
            expect(await handleWebhookEvent(first.body, first.signature)).toEqual([]);
            expect(await handleWebhookEvent(second.body, second.signature)).toEqual([]);
            expect(mail).toHaveBeenCalledTimes(1);

            await deliver('subscription.updated', paddleSub({ status: 'active' }));
            expect(await row()).toMatchObject({
                pastDueEmailSentAt: null,
                pastDueAt: null,
                pastDueAmount: null,
                pastDueCurrency: null,
            });
            await deliver(firstType!, paddleSub({ status: 'past_due' }));
            await deliver(secondType!, paddleSub({ status: 'past_due' }));
            await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(2));
            expect((await row()).pastDueEmailSentAt).toBeInstanceOf(Date);
        },
    );
    it('claims mail for an already past-due row with no marker even if its price is unknown to analytics', async () => {
        await seedSubscription({ status: 'past_due', pastDueEmailSentAt: null });
        const sub = paddleSub({ status: 'past_due' });
        sub.items[0]!.price.id = 'pri_new_price';
        await deliver('subscription.updated', sub);
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        expect((await row()).pastDueEmailSentAt).toBeInstanceOf(Date);
        expect(analytics.track).not.toHaveBeenCalled();
        await deliver('subscription.past_due', sub);
        expect(mail).toHaveBeenCalledOnce();
    });
    it('claims once across concurrent updated and past_due notifications', async () => {
        await seedSubscription();
        const updated = event('subscription.updated', paddleSub({ status: 'past_due' }));
        const pastDue = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const results = await Promise.all([
            handleWebhookEvent(updated.body, updated.signature),
            handleWebhookEvent(pastDue.body, pastDue.signature),
        ]);
        expect(results.flat()).toHaveLength(1);
        expect((await row()).pastDueEmailSentAt).toBeInstanceOf(Date);
        for (const emit of results.flat()) emit();
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it('keeps the episode marker through completed transactions until a subscription recovery', async () => {
        const marker = new Date('2026-10-01T12:00:00Z');
        await seedSubscription({ status: 'past_due', pastDueEmailSentAt: marker });
        await deliver('transaction.completed', apiTransaction());
        expect(await row()).toMatchObject({ status: 'past_due', pastDueEmailSentAt: marker });
        await deliver('subscription.updated', paddleSub({ status: 'past_due' }));
        expect(mail).not.toHaveBeenCalled();
        await deliver('subscription.updated', paddleSub({ status: 'active' }));
        expect((await row()).pastDueEmailSentAt).toBeNull();
        await deliver('subscription.past_due', paddleSub({ status: 'past_due' }));
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it.each([
        ['month', 'monthly'],
        ['year', 'annual'],
    ])(
        'grants Premium for a new unknown %s price without configured price IDs',
        async (interval, plan) => {
            const monthly = env.PADDLE_PRICE_MONTHLY;
            const annual = env.PADDLE_PRICE_ANNUAL;
            env.PADDLE_PRICE_MONTHLY = undefined;
            env.PADDLE_PRICE_ANNUAL = undefined;
            try {
                const sub = paddleSub({
                    currentBillingPeriod: {
                        startsAt: start,
                        endsAt: new Date(Date.now() + 86400000).toISOString(),
                    },
                });
                sub.items[0]!.price.id = 'pri_dashboard_new';
                sub.items[0]!.price.billingCycle.interval = interval!;
                await deliver('subscription.created', sub);
                expect(await row()).toMatchObject({
                    plan,
                    status: 'active',
                    paddlePriceId: 'pri_dashboard_new',
                });
                expect(await isEntitled(userId)).toBe(true);
                expect(analytics.track).not.toHaveBeenCalled();
            } finally {
                env.PADDLE_PRICE_MONTHLY = monthly;
                env.PADDLE_PRICE_ANNUAL = annual;
            }
        },
    );
    it.each(['transaction-first', 'subscription-first'])(
        'sends one email across retries and distinct events in %s order',
        async (order) => {
            await seedSubscription();
            const failed = () =>
                deliver('transaction.payment_failed', apiTransaction({ status: 'past_due' }));
            const pastDue = () =>
                deliver('subscription.past_due', paddleSub({ status: 'past_due' }));
            if (order === 'transaction-first') {
                await failed();
                await pastDue();
            } else {
                await pastDue();
                await failed();
            }
            await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
            await failed();
            await pastDue();
            await deliver('transaction.past_due', apiTransaction({ status: 'past_due' }));
            expect(mail).toHaveBeenCalledTimes(1);
            await deliver('subscription.activated', paddleSub());
            await pastDue();
            await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(2));
        },
    );
    it('serializes distinct concurrent subscription past-due events into one email transition', async () => {
        await seedSubscription();
        const first = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const second = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const results = await Promise.all([
            handleWebhookEvent(first.body, first.signature),
            handleWebhookEvent(second.body, second.signature),
        ]);
        expect(results.flat()).toHaveLength(1);
        for (const emit of results.flat()) emit();
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it.each(['transaction.payment_failed', 'transaction.past_due'])(
        'ignores card-change %s for a healthy subscription',
        async (type) => {
            const before = await seedSubscription();
            await deliver(
                type,
                apiTransaction({
                    origin: 'subscription_payment_method_change',
                    status: 'past_due',
                    payments: [{ status: 'error', errorCode: 'declined', createdAt: end }],
                }),
            );
            expect(await row()).toEqual(before);
            expect(mail).not.toHaveBeenCalled();
        },
    );
    it('updates only the decline code for a card-change failure on an already past-due subscription', async () => {
        const before = await seedSubscription({
            status: 'past_due',
            pastDueAmount: 1234,
            pastDueCurrency: 'EUR',
            pastDueAt: new Date(start),
        });
        await deliver(
            'transaction.payment_failed',
            apiTransaction({
                origin: 'subscription_payment_method_change',
                payments: [{ status: 'error', errorCode: 'declined', createdAt: end }],
            }),
        );
        const after = await row();
        expect({ ...after, updatedAt: before.updatedAt }).toEqual({
            ...before,
            declineReason: 'declined',
        });
        expect(mail).not.toHaveBeenCalled();
    });
    it.each(['active', 'trialing', 'paused', 'canceled'])(
        'keeps subscription status %s during renewal failure bookkeeping',
        async (status) => {
            await seedSubscription({ status });
            await deliver(
                'transaction.payment_failed',
                apiTransaction({
                    payments: [{ status: 'error', errorCode: 'declined', createdAt: start }],
                }),
            );
            expect(await row()).toMatchObject({
                status,
                pastDueAmount: 1000,
                pastDueCurrency: 'USD',
                pastDueAt: new Date(start),
                declineReason: 'declined',
            });
            expect(mail).not.toHaveBeenCalled();
        },
    );
    it('records an original past-due checkout transaction without changing subscription status', async () => {
        await seedSubscription();
        await deliver(
            'transaction.past_due',
            apiTransaction({ origin: 'web', status: 'past_due' }),
        );
        expect(await row()).toMatchObject({
            status: 'active',
            pastDueAmount: 1000,
            pastDueAt: new Date(start),
        });
        expect(mail).not.toHaveBeenCalled();
    });
    it('ignores unrelated failed one-off subscription charges', async () => {
        const before = await seedSubscription();
        await deliver(
            'transaction.payment_failed',
            apiTransaction({ origin: 'subscription_charge', status: 'billed' }),
        );
        expect(await row()).toEqual(before);
    });
    it('uses the Subscription navigation label in both trial-ending email parts', async () => {
        const sub = await seedSubscription({ trialEnd: new Date(end) });
        const template = billingEmail('trial-ending', sub);
        expect(template.text).toContain('Settings → Subscription');
        expect(template.html).toContain('Settings → Subscription');
        expect(template.text).not.toContain('Settings → Billing');
    });
    it('rolls back the webhook ledger with the subscription write on failure', async () => {
        const e = event(
            'subscription.created',
            paddleSub({ customData: { userId: crypto.randomUUID() } }),
        );
        await expect(handleWebhookEvent(e.body, e.signature)).rejects.toMatchObject({
            code: 'P2003',
        });
        expect(
            await prisma.paddleWebhookEvent.findUnique({
                where: { id: JSON.parse(e.body).event_id },
            }),
        ).toBeNull();
        expect(mail).not.toHaveBeenCalled();
    });
    it('applies a concurrent redelivery and deferred mail only once', async () => {
        await seedSubscription();
        const e = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const results = await Promise.all([
            handleWebhookEvent(e.body, e.signature),
            handleWebhookEvent(e.body, e.signature),
        ]);
        expect(results.flat()).toHaveLength(1);
        for (const emit of results.flat()) emit();
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it.each([
        'subscription.updated',
        'subscription.paused',
        'subscription.resumed',
        'subscription.activated',
        'subscription.trialing',
        'subscription.canceled',
    ])('persists %s including scheduled changes and prices', async (type) => {
        await seedSubscription({
            status: 'past_due',
            pastDueAt: new Date(start),
            pastDueAmount: 1000,
            pastDueCurrency: 'USD',
            scheduledPlan: 'annual',
        });
        const sub = paddleSub({
            status: type.endsWith('paused')
                ? 'paused'
                : type.endsWith('canceled')
                  ? 'canceled'
                  : 'active',
            scheduledChange: { action: 'resume', effectiveAt: end, resumeAt: null },
        });
        sub.items[0]!.price.id = 'pri_annual';
        sub.items[0]!.price.unitPrice.amount = '9600';
        await deliver(type, sub);
        expect(await row()).toMatchObject({
            plan: 'annual',
            priceAmount: 9600,
            currency: 'USD',
            scheduledChangeAction: 'resume',
            scheduledChangeAt: new Date(end),
            scheduledPlan: null,
            pastDueAt: null,
            pastDueAmount: null,
            pastDueCurrency: null,
        });
        if (type.endsWith('paused')) expect((await row()).status).toBe('paused');
    });
    it('preserves period dates on paused subscriptions with no billing period', async () => {
        await seedSubscription();
        await deliver(
            'subscription.paused',
            paddleSub({ status: 'paused', currentBillingPeriod: null }),
        );
        expect(await row()).toMatchObject({
            currentPeriodStart: new Date(start),
            currentPeriodEnd: new Date(end),
            status: 'paused',
        });
    });
    it('records a captured card and clears decline and past-due fields without a receipt email', async () => {
        await seedSubscription({
            declineReason: 'declined',
            pastDueAmount: 1000,
            pastDueCurrency: 'USD',
            pastDueAt: new Date(start),
        });
        const payment = {
            status: 'captured',
            methodDetails: {
                type: 'card',
                card: { type: 'visa', last4: '4242', expiryMonth: 6, expiryYear: 2029 },
            },
            createdAt: start,
        };
        await deliver(
            'transaction.completed',
            apiTransaction({
                payments: [
                    {
                        ...payment,
                        status: 'error',
                        methodDetails: {
                            type: 'card',
                            card: { ...payment.methodDetails.card, last4: '1111' },
                        },
                    },
                    payment,
                ],
            }),
        );
        expect(await row()).toMatchObject({
            cardBrand: 'visa',
            cardLast4: '4242',
            cardExpMonth: 6,
            cardExpYear: 2029,
            declineReason: null,
            pastDueAmount: null,
            pastDueCurrency: null,
            pastDueAt: null,
        });
        expect(analytics.track).toHaveBeenCalledWith(userId, 'subscription_renewed', {
            billing_plan: 'monthly',
            price: 10,
        });
        expect(mail).not.toHaveBeenCalled();
    });
    it('defers only the subscription transition email until after ACK and suppresses redelivery', async () => {
        await seedSubscription();
        await deliver(
            'transaction.payment_failed',
            apiTransaction({
                status: 'past_due',
                payments: [{ status: 'error', errorCode: 'declined', createdAt: start }],
            }),
        );
        expect(await row()).toMatchObject({
            status: 'active',
            declineReason: 'declined',
            pastDueAmount: 1000,
            pastDueCurrency: 'USD',
            pastDueAt: new Date(start),
        });
        expect(mail).not.toHaveBeenCalled();
        const e = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const emits = await handleWebhookEvent(e.body, e.signature);
        expect(mail).not.toHaveBeenCalled();
        expect((await row()).status).toBe('past_due');
        for (const emit of emits) emit();
        await vi.waitFor(() => expect(mail).toHaveBeenCalledTimes(1));
        expect(mail.mock.calls[0]![0]).toMatchObject({
            subject: "We couldn't charge your card",
            text: expect.stringContaining('Premium stays on until Nov 1, 2026'),
        });
        expect(await handleWebhookEvent(e.body, e.signature)).toEqual([]);
        expect(mail).toHaveBeenCalledTimes(1);
    });
    it('ACKs failed-payment webhooks even when mail delivery fails', async () => {
        await seedSubscription();
        mail.mockRejectedValueOnce(new Error('mail offline'));
        const e = event('subscription.past_due', paddleSub({ status: 'past_due' }));
        const res = await app.inject({
            method: 'POST',
            url: '/api/v1/billing/webhook',
            headers: { 'paddle-signature': e.signature, 'content-type': 'application/json' },
            payload: e.body,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ received: true });
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
    });
    it('books transaction.past_due totals without manufacturing card or retry details', async () => {
        await seedSubscription();
        await deliver('transaction.past_due', apiTransaction({ status: 'past_due' }));
        expect(await row()).toMatchObject({
            pastDueAmount: 1000,
            pastDueCurrency: 'USD',
            pastDueAt: new Date(start),
            declineReason: null,
        });
        expect(mail).not.toHaveBeenCalled();
    });
    it('books subscription.past_due with available data and idempotent mail', async () => {
        await seedSubscription({ pastDueAmount: 2000, pastDueCurrency: 'USD' });
        const e = await deliver('subscription.past_due', paddleSub({ status: 'past_due' }));
        await vi.waitFor(() => expect(mail).toHaveBeenCalledOnce());
        expect(await row()).toMatchObject({
            status: 'past_due',
            pastDueAmount: 2000,
            pastDueCurrency: 'USD',
            pastDueAt: new Date(start),
        });
        expect(await handleWebhookEvent(e.body, e.signature)).toEqual([]);
        expect(mail).toHaveBeenCalledOnce();
    });
    it('records adjustment.created once without changing a subscription', async () => {
        const before = await seedSubscription();
        const e = await deliver('adjustment.created', {
            id: 'adj_test',
            items: [],
            totals: {
                subtotal: '1000',
                tax: '0',
                total: '1000',
                fee: '0',
                earnings: '1000',
                currencyCode: 'USD',
            },
        });
        expect(await handleWebhookEvent(e.body, e.signature)).toEqual([]);
        expect(
            await prisma.paddleWebhookEvent.count({ where: { id: JSON.parse(e.body).event_id } }),
        ).toBe(1);
        expect(await row()).toEqual(before);
        expect(mail).not.toHaveBeenCalled();
    });
    it('claims a trial reminder atomically across two workers and does not resend', async () => {
        await seedSubscription({
            status: 'trialing',
            trialEnd: new Date(Date.now() + 24 * 3600000),
        });
        await Promise.all([runTrialEndingOnce(app.log), runTrialEndingOnce(app.log)]);
        await runTrialEndingOnce(app.log);
        expect(mail).toHaveBeenCalledOnce();
        expect((await row()).trialEndingEmailSentAt).toBeInstanceOf(Date);
        expect(mail.mock.calls[0]![0]).toMatchObject({
            subject: expect.stringMatching(/^Your free trial ends /),
            text: expect.stringContaining('$10.00'),
            html: expect.stringContaining('Mnemio'),
        });
        expect(registerTrialEndingJob(app.log)).toBeUndefined();
    });
    it.each([
        { status: 'active' },
        { trialEnd: new Date(Date.now() - 3600000) },
        { trialEnd: new Date(Date.now() + 72 * 3600000) },
        { cancelAtPeriodEnd: true },
        { scheduledChangeAction: 'cancel' },
        { trialEndingEmailSentAt: new Date() },
    ])('skips ineligible trial %j', async (over) => {
        await seedSubscription({
            status: 'trialing',
            trialEnd: new Date(Date.now() + 24 * 3600000),
            ...over,
        });
        await runTrialEndingOnce(app.log);
        expect(mail).not.toHaveBeenCalled();
    });
    it('logs reminder mail failure and keeps the claim to prevent duplicate delivery', async () => {
        await seedSubscription({
            status: 'trialing',
            trialEnd: new Date(Date.now() + 24 * 3600000),
        });
        mail.mockRejectedValueOnce(new Error('mail offline'));
        await expect(runTrialEndingOnce(app.log)).resolves.toBeUndefined();
        await runTrialEndingOnce(app.log);
        expect(mail).toHaveBeenCalledOnce();
    });
    it('uses text-only branding, required layout and safe HTML', async () => {
        const sub = await seedSubscription({
            status: 'trialing',
            trialEnd: new Date(end),
            currency: 'JPY',
            priceAmount: 1000,
        });
        const template = billingEmail('trial-ending', sub as SubscriptionRow);
        expect(template.text).toContain('¥1,000');
        for (const fragment of [
            '600px',
            '#E9E6DF',
            'border-radius:16px',
            '32px 40px',
            'Georgia',
            '#3D4A3B',
            '#2E6B4A',
            '13px 24px',
            '#8A9387',
        ])
            expect(template.html).toContain(fragment);
        expect(template.html).not.toMatch(/<svg|<img/);
    });
});

describe('billing mapper edge cases', () => {
    it('prefers configured prices, then interval, then the previous plan and skips only unknowable plans', async () => {
        const previous = await seedSubscription({ plan: 'annual' });
        const incoming = paddleSub();
        incoming.items[0]!.price.billingCycle.interval = 'year';
        expect(subscriptionData(incoming as never, userId, null)?.plan).toBe('monthly');
        incoming.items[0]!.price.id = 'pri_unknown';
        incoming.items[0]!.price.billingCycle.interval = 'month';
        expect(subscriptionData(incoming as never, userId, previous)?.plan).toBe('monthly');
        incoming.items[0]!.price.billingCycle.interval = 'day';
        expect(subscriptionData(incoming as never, userId, previous)?.plan).toBe('annual');
        expect(subscriptionData(incoming as never, userId, null)).toBeNull();
    });
    it.each([
        ['USD', '1234', 12.34],
        ['JPY', '1234', 1234],
        ['KRW', '1234', 1234],
        ['KWD', '1234', 1.234],
    ] as const)('converts %s without assuming two decimal places', (currency, amount, expected) => {
        expect(lowestUnitToMajor(amount, currency)).toBe(expected);
    });
    it('preserves nullable card expiry and legacy absent price without inventing dates', async () => {
        const sub = await seedSubscription({
            priceAmount: null,
            currency: null,
            cardBrand: 'visa',
            cardLast4: '4242',
        });
        expect(toSubscriptionDto(sub)).toMatchObject({
            price: null,
            paymentMethod: {
                brand: 'visa',
                last4: '4242',
                expMonth: null,
                expYear: null,
                declineReason: null,
            },
        });
        const incoming = paddleSub({ currentBillingPeriod: null });
        expect(subscriptionData(incoming as never, userId, null)).toBeNull();
        expect(subscriptionData(incoming as never, userId, sub)).toMatchObject({
            currentPeriodStart: sub.currentPeriodStart,
            currentPeriodEnd: sub.currentPeriodEnd,
        });
    });
});
