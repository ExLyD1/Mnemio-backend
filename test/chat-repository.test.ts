import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { claimTurn, listMessages } from '../src/repositories/chat.repository.js';

vi.mock('../src/db/prisma.js', () => ({
    prisma: { $transaction: vi.fn(), chatMessage: { findMany: vi.fn(), updateMany: vi.fn() } },
}));
const tx = {
    $queryRaw: vi.fn(),
    chatMessage: {
        count: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
    },
};
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(
        async (fn: unknown) => (fn as (value: unknown) => unknown)(tx) as never,
    );
    tx.chatMessage.count.mockResolvedValue(0);
    tx.chatMessage.create.mockResolvedValue({ id: 'new', createdAt: new Date() });
});
const failed = (overrides = {}) => ({
    id: 'failed',
    role: 'assistant',
    status: 'partial',
    attachments: null,
    createdAt: new Date(),
    ...overrides,
});

describe('chat repository retry safety', () => {
    it('pages strictly before timestamp/id ties and returns chronological rows', async () => {
        const before = { ts: '2026-10-20T00:00:00.000Z', id: 'm50' };
        vi.mocked(prisma.chatMessage.findMany).mockResolvedValue([
            { id: 'm49' },
            { id: 'm48' },
        ] as never);
        expect((await listMessages('c', 51, before)).map((m) => m.id)).toEqual(['m48', 'm49']);
        expect(prisma.chatMessage.findMany).toHaveBeenCalledWith({
            where: {
                conversationId: 'c',
                OR: [
                    { createdAt: { lt: new Date(before.ts) } },
                    { createdAt: new Date(before.ts), id: { lt: before.id } },
                ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 51,
        });
    });
    it.each([
        ['missing', null],
        ['completed', failed({ status: 'complete' })],
        ['older', failed({ id: 'newer' })],
        [
            'already wrote a deck',
            failed({
                attachments: [{ type: 'deck', deckId: 'saved', title: 'Saved', cardCount: 1 }],
            }),
        ],
    ])('refuses retry of %s reply before any new write', async (_label, latest) => {
        tx.chatMessage.findFirst.mockResolvedValue(latest);
        expect(await claimTurn({ conversationId: 'c', content: 'hello', retryOf: 'failed' })).toBe(
            'retry_unavailable',
        );
        expect(tx.chatMessage.deleteMany).not.toHaveBeenCalled();
        expect(tx.chatMessage.create).not.toHaveBeenCalled();
    });
    it('does not delete failed messages while another answer is live', async () => {
        tx.chatMessage.count.mockResolvedValue(1);
        expect(
            await claimTurn({ conversationId: 'c', content: 'hello', retryOf: 'failed' }),
        ).toBeNull();
        expect(tx.chatMessage.deleteMany).not.toHaveBeenCalled();
    });
    it('replaces exactly the latest failed pair', async () => {
        tx.chatMessage.findFirst
            .mockResolvedValueOnce(failed())
            .mockResolvedValueOnce({ id: 'user', role: 'user', content: 'hello' });
        await claimTurn({ conversationId: 'c', content: 'hello', retryOf: 'failed' });
        expect(tx.chatMessage.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ['failed', 'user'] } },
        });
        expect(tx.chatMessage.create).toHaveBeenCalledTimes(2);
    });
    it('rejects changed retry content', async () => {
        tx.chatMessage.findFirst
            .mockResolvedValueOnce(failed())
            .mockResolvedValueOnce({ id: 'user', role: 'user', content: 'original' });
        expect(
            await claimTurn({ conversationId: 'c', content: 'changed', retryOf: 'failed' }),
        ).toBe('retry_unavailable');
        expect(tx.chatMessage.deleteMany).not.toHaveBeenCalled();
    });
    it('reaps abandoned streaming rows when reopening a conversation', async () => {
        vi.mocked(prisma.chatMessage.findMany).mockResolvedValue([]);
        await listMessages('c');
        expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ conversationId: 'c', status: 'streaming' }),
                data: { status: 'partial' },
            }),
        );
    });
});
