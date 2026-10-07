import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// The fulfillment path is the one place where a silent bug costs real money:
// an unverified payload could grant Premium for free, and a non-idempotent
// handler could double-apply an at-least-once redelivery. These tests drive the
// real service (and the real Paddle SDK verifier) with a fake database.

const SECRET = 'pdl_ntfset_test_secret_value';
const MONTHLY_PRICE = 'pri_test_monthly';

/**
 * Builds the `paddle-signature` header the way Paddle does: HMAC-SHA256 over
 * `<timestamp>:<raw body>`, keyed with the notification signing secret.
 */
const signPayload = (body: string, ts = Math.floor(Date.now() / 1000)): string => {
    const digest = crypto.createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
    return `ts=${ts};h1=${digest}`;
};

const subscriptionEvent = (overrides: Record<string, unknown> = {}) => ({
    event_id: 'evt_01htest000000000000000000',
    event_type: 'subscription.created',
    occurred_at: '2026-10-07T10:00:00.000000Z',
    notification_id: 'ntf_01htest000000000000000000',
    data: {
        id: 'sub_01htest000000000000000000',
        status: 'trialing',
        customer_id: 'ctm_01htest000000000000000000',
        custom_data: { userId: 'user-abc' },
        currency_code: 'USD',
        started_at: '2026-10-07T10:00:00.000000Z',
        current_billing_period: {
            starts_at: '2026-10-07T10:00:00.000000Z',
            ends_at: '2026-11-07T10:00:00.000000Z',
        },
        scheduled_change: null,
        collection_mode: 'automatic',
        billing_cycle: { interval: 'month', frequency: 1 },
        billing_details: null,
        discount: null,
        paused_at: null,
        canceled_at: null,
        address_id: 'add_01htest000000000000000000',
        business_id: null,
        created_at: '2026-10-07T10:00:00.000000Z',
        updated_at: '2026-10-07T10:00:00.000000Z',
        first_billed_at: '2026-10-07T10:00:00.000000Z',
        next_billed_at: '2026-11-07T10:00:00.000000Z',
        items: [
            {
                status: 'trialing',
                quantity: 1,
                recurring: true,
                created_at: '2026-10-07T10:00:00.000000Z',
                updated_at: '2026-10-07T10:00:00.000000Z',
                previously_billed_at: null,
                next_billed_at: '2026-11-07T10:00:00.000000Z',
                trial_dates: {
                    starts_at: '2026-10-07T10:00:00.000000Z',
                    ends_at: '2026-10-14T10:00:00.000000Z',
                },
                price: {
                    id: MONTHLY_PRICE,
                    product_id: 'pro_test',
                    description: 'Mnemio Premium — monthly',
                    name: 'Monthly',
                    type: 'standard',
                    billing_cycle: { interval: 'month', frequency: 1 },
                    trial_period: { interval: 'day', frequency: 7 },
                    tax_mode: 'account_setting',
                    unit_price: { amount: '1000', currency_code: 'USD' },
                    unit_price_overrides: [],
                    quantity: { minimum: 1, maximum: 100 },
                    status: 'active',
                    custom_data: null,
                    created_at: '2026-10-07T10:00:00.000000Z',
                    updated_at: '2026-10-07T10:00:00.000000Z',
                },
            },
        ],
        ...overrides,
    },
});

// --- fake database -------------------------------------------------------

const upsertMock = vi.fn();
const findUniqueSubMock = vi.fn();
const recordedEvents = new Set<string>();

const txClient = {
    subscription: { upsert: upsertMock, findUnique: findUniqueSubMock, updateMany: vi.fn() },
    paddleWebhookEvent: {
        create: vi.fn(({ data }: { data: { id: string } }) => {
            if (recordedEvents.has(data.id)) {
                // Mirrors the real primary-key violation Postgres would raise.
                throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
            }
            recordedEvents.add(data.id);
            return Promise.resolve({ id: data.id });
        }),
        findUnique: vi.fn(({ where }: { where: { id: string } }) =>
            Promise.resolve(recordedEvents.has(where.id) ? { id: where.id } : null),
        ),
    },
};

vi.mock('../src/db/prisma.js', () => ({
    prisma: {
        $transaction: (fn: (tx: unknown) => unknown) => fn(txClient),
        subscription: {
            findUnique: (...a: unknown[]) => findUniqueSubMock(...a),
            findFirst: vi.fn(),
        },
        paddleWebhookEvent: {
            findUnique: ({ where }: { where: { id: string } }) =>
                Promise.resolve(recordedEvents.has(where.id) ? { id: where.id } : null),
        },
    },
}));

vi.mock('../src/services/analytics.service.js', () => ({
    track: vi.fn(),
    setUserProps: vi.fn(),
}));

describe('billing webhook', () => {
    beforeEach(() => {
        vi.resetModules();
        upsertMock.mockReset();
        findUniqueSubMock.mockReset();
        findUniqueSubMock.mockResolvedValue(null);
        recordedEvents.clear();
        process.env.PADDLE_API_KEY = 'pdl_sdbx_test_key';
        process.env.PADDLE_WEBHOOK_SECRET = SECRET;
        process.env.PADDLE_ENV = 'sandbox';
        process.env.PADDLE_PRICE_MONTHLY = MONTHLY_PRICE;
        process.env.PADDLE_PRICE_ANNUAL = 'pri_test_annual';
    });

    it('rejects a payload whose signature does not match', async () => {
        const billing = await import('../src/services/billing.service.js');
        const body = JSON.stringify(subscriptionEvent());

        await expect(
            billing.handleWebhookEvent(body, signPayload('{"tampered":true}')),
        ).rejects.toMatchObject({ code: 'BILLING_WEBHOOK_INVALID' });

        // Nothing may be written off an unverified payload.
        expect(upsertMock).not.toHaveBeenCalled();
    });

    it('rejects a body that was modified after signing', async () => {
        const billing = await import('../src/services/billing.service.js');
        const original = JSON.stringify(subscriptionEvent());
        const signature = signPayload(original);
        const tampered = original.replace('"status":"trialing"', '"status":"active"');

        await expect(billing.handleWebhookEvent(tampered, signature)).rejects.toMatchObject({
            code: 'BILLING_WEBHOOK_INVALID',
        });
        expect(upsertMock).not.toHaveBeenCalled();
    });

    it('mirrors a verified subscription.created onto the user', async () => {
        const billing = await import('../src/services/billing.service.js');
        const body = JSON.stringify(subscriptionEvent());

        await billing.handleWebhookEvent(body, signPayload(body));

        expect(upsertMock).toHaveBeenCalledTimes(1);
        const arg = upsertMock.mock.calls[0]![0] as {
            where: { userId: string };
            create: Record<string, unknown>;
        };
        expect(arg.where.userId).toBe('user-abc');
        expect(arg.create).toMatchObject({
            userId: 'user-abc',
            status: 'trialing',
            plan: 'monthly',
            paddleSubId: 'sub_01htest000000000000000000',
            paddleCustomerId: 'ctm_01htest000000000000000000',
            paddlePriceId: MONTHLY_PRICE,
            cancelAtPeriodEnd: false,
        });
    });

    it('is idempotent — a redelivered event applies exactly once', async () => {
        const billing = await import('../src/services/billing.service.js');
        const body = JSON.stringify(subscriptionEvent());
        const sig = signPayload(body);

        await billing.handleWebhookEvent(body, sig);
        await billing.handleWebhookEvent(body, sig);

        expect(upsertMock).toHaveBeenCalledTimes(1);
    });

    it('records a pending cancellation as a flag, not as a canceled status', async () => {
        const billing = await import('../src/services/billing.service.js');
        const body = JSON.stringify(
            subscriptionEvent({
                status: 'active',
                scheduled_change: {
                    action: 'cancel',
                    effective_at: '2026-11-07T10:00:00.000000Z',
                },
            }),
        );

        await billing.handleWebhookEvent(body, signPayload(body));

        const arg = upsertMock.mock.calls[0]![0] as { create: Record<string, unknown> };
        // Access must survive a scheduled cancellation — only a real `canceled`
        // status ends it.
        expect(arg.create['status']).toBe('active');
        expect(arg.create['cancelAtPeriodEnd']).toBe(true);
    });

    it('ignores an event type it does not handle', async () => {
        const billing = await import('../src/services/billing.service.js');
        const evt = { ...subscriptionEvent(), event_type: 'report.created' };
        const body = JSON.stringify(evt);

        await expect(billing.handleWebhookEvent(body, signPayload(body))).resolves.toEqual([]);
        expect(upsertMock).not.toHaveBeenCalled();
    });
});
