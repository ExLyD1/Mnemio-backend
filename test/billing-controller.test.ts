import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

vi.mock('../src/services/billing.service.js', () => ({
    cancelSubscription: vi.fn(),
    pauseSubscription: vi.fn(),
    resumeSubscription: vi.fn(),
    previewPlanChange: vi.fn(),
    changePlan: vi.fn(),
    paymentMethodTransaction: vi.fn(),
    invoices: vi.fn(),
    invoicePdf: vi.fn(),
    getSubscription: vi.fn(),
    createPortalSession: vi.fn(),
    handleWebhookEvent: vi.fn(),
}));
import * as billing from '../src/services/billing.service.js';
import * as controller from '../src/controllers/billing.controller.js';

beforeEach(() => vi.resetAllMocks());

describe('billing controller reply ownership', () => {
    it.each([
        ['pause', 'pauseSubscription', { months: 1 }],
        ['resume', 'resumeSubscription', undefined],
        ['previewPlanChange', 'previewPlanChange', { plan: 'annual', when: 'now' }],
        ['changePlan', 'changePlan', { plan: 'annual', when: 'renewal' }],
        ['paymentMethodTransaction', 'paymentMethodTransaction', undefined],
        ['invoices', 'invoices', undefined],
        ['invoicePdf', 'invoicePdf', undefined],
        ['getSubscription', 'getSubscription', undefined],
        ['portal', 'createPortalSession', undefined],
    ] as const)('%s returns the sent reply', async (handler, service, body) => {
        const reply = { send: vi.fn(), code: vi.fn() };
        reply.send.mockReturnValue(reply);
        reply.code.mockReturnValue(reply);
        vi.mocked(billing[service]).mockResolvedValue({ id: 'result' } as never);
        const request = {
            currentUser: { sub: 'own-user' },
            body,
            params: { id: 'txn_owned' },
        } as unknown as FastifyRequest;
        expect(await controller[handler](request, reply as unknown as FastifyReply)).toBe(reply);
        expect(reply.send).toHaveBeenCalledOnce();
    });
    it.each(['cancel', 'webhook'] as const)(
        '%s returns the reply and emits side effects after sending',
        async (handler) => {
            const order: string[] = [];
            const reply = { send: vi.fn() };
            reply.send.mockImplementation(() => {
                order.push('send');
                return reply;
            });
            const emit = () => {
                order.push('emit');
            };
            vi.mocked(billing.cancelSubscription).mockResolvedValue({
                subscription: { id: 'result' },
                emits: [emit],
            } as never);
            vi.mocked(billing.handleWebhookEvent).mockResolvedValue([emit]);
            const request = {
                currentUser: { sub: 'own-user' },
                body: handler === 'cancel' ? { reason: 'other' } : Buffer.from('{}'),
                headers: { 'paddle-signature': 'signature' },
            } as unknown as FastifyRequest;
            expect(await controller[handler](request, reply as unknown as FastifyReply)).toBe(
                reply,
            );
            expect(order).toEqual(['send', 'emit']);
        },
    );
});
