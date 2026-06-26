import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as chatRepo from '../src/repositories/chat.repository.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import * as budget from '../src/services/ai.budget.service.js';
import { sendMessage, __setProviderForTesting } from '../src/services/chat.service.js';
import { AiProviderError, ChatNotFoundError, AiBudgetExceededError } from '../src/shared/errors.js';
import type { AiProvider, ChatResult, ChatStreamEvent } from '../src/services/ai.provider.js';

vi.mock('../src/repositories/chat.repository.js', () => ({
    findConversation: vi.fn(),
    countUserMessages: vi.fn(),
    createMessage: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    lastTurnsForModel: vi.fn(),
    renameAndTouch: vi.fn(),
    touchLastMessageAt: vi.fn(),
}));
vi.mock('../src/repositories/decks.repository.js', () => ({
    findDeckById: vi.fn(),
}));
vi.mock('../src/services/ai.budget.service.js', () => ({
    assertWithinBudget: vi.fn(),
    recordUse: vi.fn(),
}));

const mockedRepo = vi.mocked(chatRepo);
const mockedDecksRepo = vi.mocked(decksRepo);
const mockedBudget = vi.mocked(budget);

const conversationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    userId: 'user-1',
    title: 'New chat',
    createdAt: new Date('2026-06-08T10:00:00Z'),
    updatedAt: new Date('2026-06-08T10:00:00Z'),
    lastMessageAt: new Date('2026-06-08T10:00:00Z'),
    ...overrides,
});

const messageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg-x',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'hello',
    tokensInput: null,
    tokensOutput: null,
    status: 'complete' as const,
    createdAt: new Date('2026-06-08T10:00:00Z'),
    ...overrides,
});

const buildProvider = (
    chatImpl: AiProvider['chat'],
): AiProvider => ({
    name: 'test',
    enrichWords: vi.fn() as never,
    generateDeck: vi.fn() as never,
    suggest: vi.fn() as never,
    chat: chatImpl,
});

beforeEach(() => {
    vi.resetAllMocks();
    __setProviderForTesting(null);
});

describe('chat.service / sendMessage', () => {
    it('throws CHAT_NOT_FOUND when the caller does not own the conversation', async () => {
        mockedRepo.findConversation.mockResolvedValue(null);
        await expect(sendMessage('u', 'c', 'hi', () => undefined)).rejects.toBeInstanceOf(
            ChatNotFoundError,
        );
        expect(mockedRepo.createMessage).not.toHaveBeenCalled();
    });

    it('returns AI_BUDGET_EXCEEDED before persisting anything', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedBudget.assertWithinBudget.mockRejectedValue(
            new AiBudgetExceededError('chat', 50),
        );
        await expect(sendMessage('u', 'c', 'hi', () => undefined)).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
        expect(mockedRepo.createMessage).not.toHaveBeenCalled();
        expect(mockedBudget.recordUse).not.toHaveBeenCalled();
    });

    it('on success: persists user msg, placeholder, finalizes assistant, auto-titles, records use', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(0); // first turn → auto-title
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.createMessage
            .mockResolvedValueOnce(
                messageRow({ id: 'user-msg', role: 'user', content: 'Hi Mnemio!' }) as never,
            )
            .mockResolvedValueOnce(
                messageRow({
                    id: 'ai-msg',
                    role: 'assistant',
                    content: '',
                    status: 'partial',
                }) as never,
            );
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({
                id: 'ai-msg',
                role: 'assistant',
                content: 'Hello!',
                status: 'complete',
                tokensInput: 12,
                tokensOutput: 3,
            }) as never,
        );
        mockedRepo.renameAndTouch.mockResolvedValue(
            conversationRow({ title: 'Hi Mnemio!' }) as never,
        );
        __setProviderForTesting(
            buildProvider(async (_input, opts): Promise<ChatResult> => {
                opts?.onEvent?.({ type: 'token', delta: 'Hello' } as ChatStreamEvent);
                opts?.onEvent?.({ type: 'token', delta: '!' } as ChatStreamEvent);
                return { content: 'Hello!', tokensInput: 12, tokensOutput: 3 };
            }),
        );

        const frames: string[] = [];
        const result = await sendMessage('u', 'c', 'Hi Mnemio!', (f) => frames.push(f.type));

        expect(frames).toEqual(['start', 'token', 'token', 'done']);
        expect(result.assistantMessage.content).toBe('Hello!');
        expect(result.conversationTitle).toBe('Hi Mnemio!');

        // user msg saved first, then assistant placeholder
        expect(mockedRepo.createMessage.mock.calls[0]?.[0]).toMatchObject({ role: 'user' });
        expect(mockedRepo.createMessage.mock.calls[1]?.[0]).toMatchObject({
            role: 'assistant',
            status: 'partial',
        });

        // finalize with the streamed buffer
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'Hello!', status: 'complete' }),
        );
        // auto-title triggered (first user message)
        expect(mockedRepo.renameAndTouch).toHaveBeenCalledWith(
            'c',
            'Hi Mnemio!',
            expect.any(Date),
        );
        expect(mockedRepo.touchLastMessageAt).not.toHaveBeenCalled();
        // budget recorded only after success
        expect(mockedBudget.recordUse).toHaveBeenCalledWith('u', 'chat');
    });

    it('on provider failure: keeps user msg, flips placeholder to partial with buffered content, does not record use', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(0);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.createMessage
            .mockResolvedValueOnce(messageRow({ id: 'user-msg' }) as never)
            .mockResolvedValueOnce(
                messageRow({ id: 'ai-msg', role: 'assistant', status: 'partial' }) as never,
            );
        __setProviderForTesting(
            buildProvider(async (_input, opts) => {
                opts?.onEvent?.({ type: 'token', delta: 'Hello' } as ChatStreamEvent);
                throw new AiProviderError(502, 'upstream blew up');
            }),
        );

        await expect(
            sendMessage('u', 'c', 'Hi', () => undefined),
        ).rejects.toBeInstanceOf(AiProviderError);

        // The placeholder was finalized with the partial buffer, NOT marked complete.
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith({
            id: 'ai-msg',
            content: 'Hello',
            tokensInput: 0,
            tokensOutput: 0,
            status: 'partial',
        });
        // We didn't charge the user for the partial.
        expect(mockedBudget.recordUse).not.toHaveBeenCalled();
        // And we didn't bump the conversation order — partial replies don't
        // jump to the top of the sidebar.
        expect(mockedRepo.touchLastMessageAt).not.toHaveBeenCalled();
        expect(mockedRepo.renameAndTouch).not.toHaveBeenCalled();
    });

    it('does NOT auto-title on the second user turn even if the title is still default', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1); // already had a turn
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.createMessage
            .mockResolvedValueOnce(messageRow({ id: 'user-msg' }) as never)
            .mockResolvedValueOnce(
                messageRow({ id: 'ai-msg', role: 'assistant', status: 'partial' }) as never,
            );
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        __setProviderForTesting(
            buildProvider(async () => ({ content: 'ok', tokensInput: 0, tokensOutput: 0 })),
        );

        await sendMessage('u', 'c', 'A second turn', () => undefined);

        expect(mockedRepo.renameAndTouch).not.toHaveBeenCalled();
        expect(mockedRepo.touchLastMessageAt).toHaveBeenCalled();
    });

    it('with an in-context deckId: exposes add_cards, injects deck context, saves provider content + attachment', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.createMessage
            .mockResolvedValueOnce(messageRow({ id: 'user-msg' }) as never)
            .mockResolvedValueOnce(
                messageRow({ id: 'ai-msg', role: 'assistant', status: 'partial' }) as never,
            );
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({
                id: 'ai-msg',
                role: 'assistant',
                content: 'Added 2 cards to your deck.',
                status: 'complete',
            }) as never,
        );
        // Owned deck → deckCtx is built.
        mockedDecksRepo.findDeckById.mockResolvedValue({
            id: 'deck-9',
            authorId: 'u',
            title: 'My French deck',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            cardCount: 5,
        } as never);

        const attachment = {
            type: 'deck',
            deckId: 'deck-9',
            title: 'My French deck',
            cardCount: 7,
            action: 'appended',
            addedCount: 2,
        };
        let seenToolNames: string[] = [];
        let seenPrompt = '';
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenToolNames = (input.tools?.defs ?? []).map((d) => d.name);
                seenPrompt = input.systemPrompt;
                // Provider's authoritative (round-2) content + attachment.
                return {
                    content: 'Added 2 cards to your deck.',
                    tokensInput: 1,
                    tokensOutput: 1,
                    attachments: [attachment],
                };
            }),
        );

        const result = await sendMessage(
            'u',
            'c',
            'add agua and pan to this deck',
            () => undefined,
            { deckId: 'deck-9' },
        );

        // add_cards is offered alongside create_deck, and the deck context is injected.
        expect(seenToolNames).toContain('add_cards');
        expect(seenToolNames).toContain('create_deck');
        expect(seenPrompt).toContain('My French deck');
        // Saved message = provider content (round-2 authoritative) + attachment.
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                content: 'Added 2 cards to your deck.',
                attachments: [attachment],
            }),
        );
        expect(result.assistantMessage.content).toBe('Added 2 cards to your deck.');
    });

    it('does NOT expose add_cards when no deckId is supplied', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.createMessage
            .mockResolvedValueOnce(messageRow({ id: 'user-msg' }) as never)
            .mockResolvedValueOnce(
                messageRow({ id: 'ai-msg', role: 'assistant', status: 'partial' }) as never,
            );
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        let seenToolNames: string[] = [];
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenToolNames = (input.tools?.defs ?? []).map((d) => d.name);
                return { content: 'ok', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', 'hello', () => undefined);

        expect(seenToolNames).toContain('create_deck');
        expect(seenToolNames).not.toContain('add_cards');
        expect(mockedDecksRepo.findDeckById).not.toHaveBeenCalled();
    });
});
