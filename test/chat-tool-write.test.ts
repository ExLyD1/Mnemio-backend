import { beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { writeDeck } from '../src/repositories/chat-tools.repository.js';
import { finalizeAssistantMessage } from '../src/repositories/chat.repository.js';

vi.mock('../src/db/prisma.js', () => ({
    prisma: { $transaction: vi.fn(), chatMessage: { update: vi.fn() } },
}));
const tx = {
    $queryRaw: vi.fn(),
    chatMessage: { findFirst: vi.fn(), update: vi.fn() },
    deck: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    card: { findFirst: vi.fn(), createMany: vi.fn(), count: vi.fn() },
};
const params = {
    userId: 'u',
    assistantMessageId: 'assistant',
    meta: { title: 'Fruit', sourceLanguage: 'uk', targetLanguage: 'en' },
    cards: [{ word: 'apple', definition: 'яблуко' }],
};
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(
        async (fn: unknown) => (fn as (tx: unknown) => unknown)(tx) as never,
    );
    tx.chatMessage.findFirst.mockResolvedValue({ id: 'assistant' });
    tx.deck.create.mockResolvedValue({ id: 'd', ...params.meta });
    tx.deck.findFirst.mockResolvedValue({ id: 'd', ...params.meta });
    tx.card.count.mockResolvedValue(2);
});
it.each([undefined, 'd'])(
    'commits the %s deck write and attachment in the same transaction',
    async (deckId) => {
        const result = await writeDeck({ ...params, ...(deckId ? { deckId } : {}) });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.card.createMany).toHaveBeenCalled();
        expect(tx.chatMessage.update).toHaveBeenCalledWith({
            where: { id: 'assistant' },
            data: { attachments: [result] },
        });
        expect(tx.chatMessage.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ conversation: { userId: 'u' } }),
            }),
        );
    },
);
it('propagates an attachment write failure so the transaction rolls back the cards', async () => {
    const failure = new Error('attachment failed');
    tx.chatMessage.update.mockRejectedValue(failure);
    await expect(writeDeck(params)).rejects.toBe(failure);
});
it('finalization preserves an attachment committed before the result event', async () => {
    await finalizeAssistantMessage({
        id: 'assistant',
        content: '',
        tokensInput: 0,
        tokensOutput: 0,
        status: 'partial',
    });
    expect(prisma.chatMessage.update).toHaveBeenCalledWith({
        where: { id: 'assistant' },
        data: { content: '', tokensInput: 0, tokensOutput: 0, status: 'partial' },
    });
});
