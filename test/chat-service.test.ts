import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as chatRepo from '../src/repositories/chat.repository.js';
import * as decksRepo from '../src/repositories/decks.repository.js';
import * as prefsRepo from '../src/repositories/preferences.repository.js';
import * as budget from '../src/services/ai.budget.service.js';
import { sendMessage, cancelReply, __setProviderForTesting } from '../src/services/chat.service.js';
import {
    AiProviderError,
    ChatNotFoundError,
    AiBudgetExceededError,
    ChatBusyError,
} from '../src/shared/errors.js';
import type { AiProvider, ChatResult, ChatStreamEvent } from '../src/services/ai.provider.js';

vi.mock('../src/repositories/chat.repository.js', () => ({
    findConversation: vi.fn(),
    countUserMessages: vi.fn(),
    claimTurn: vi.fn(),
    createMessage: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    lastTurnsForModel: vi.fn(),
    renameAndTouch: vi.fn(),
    touchLastMessageAt: vi.fn(),
}));
vi.mock('../src/repositories/decks.repository.js', () => ({
    findDeckById: vi.fn(),
}));
vi.mock('../src/repositories/preferences.repository.js', () => ({
    findOrCreate: vi.fn(),
}));
vi.mock('../src/services/ai.budget.service.js', () => ({
    reserve: vi.fn(),
    release: vi.fn(),
    usageSnapshot: vi.fn(),
}));

const mockedRepo = vi.mocked(chatRepo);
const mockedDecksRepo = vi.mocked(decksRepo);
const mockedBudget = vi.mocked(budget);
const mockedPrefs = vi.mocked(prefsRepo);

const setProfile = (nativeLanguage: string | null, learningLanguages: string[]) =>
    mockedPrefs.findOrCreate.mockResolvedValue({ nativeLanguage, learningLanguages } as never);

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

const buildProvider = (chatImpl: AiProvider['chat']): AiProvider => ({
    name: 'test',
    enrichWords: vi.fn() as never,
    generateDeck: vi.fn() as never,
    deckFromImage: vi.fn() as never,
    suggest: vi.fn() as never,
    chat: chatImpl,
});

// Every send now claims the conversation's streaming slot in one transaction
// instead of two createMessage calls. Tests state the rows the claim returns.
const claim = (userOverrides: Record<string, unknown> = {}, assistantId = 'ai-msg') =>
    mockedRepo.claimTurn.mockResolvedValue({
        userRow: messageRow({ id: 'user-msg', ...userOverrides }),
        placeholder: messageRow({
            id: assistantId,
            role: 'assistant',
            content: '',
            status: 'streaming',
        }),
    } as never);

const usage = (overrides: Record<string, { used: number; cap: number; remaining: number }> = {}) =>
    mockedBudget.usageSnapshot.mockResolvedValue({
        plan: 'free',
        resetsAt: '2026-06-09T00:00:00.000Z',
        kinds: {
            enrich: { used: 0, cap: 5, remaining: 5 },
            generate: { used: 0, cap: 20, remaining: 20 },
            suggest: { used: 0, cap: 60, remaining: 60 },
            import: { used: 0, cap: 20, remaining: 20 },
            chat: { used: 0, cap: 50, remaining: 50 },
            image: { used: 0, cap: 10, remaining: 10 },
            ...overrides,
        },
    } as never);

beforeEach(() => {
    vi.resetAllMocks();
    __setProviderForTesting(null);
    setProfile(null, []);
    claim();
    usage();
});

describe('chat.service / sendMessage', () => {
    it('keeps the reservation when the provider completes with a saved-tool fallback', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        const attachment = { type: 'deck', deckId: 'saved', title: 'Saved', cardCount: 2 };
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ role: 'assistant', content: 'Saved', attachments: [attachment] }) as never,
        );
        mockedRepo.renameAndTouch.mockResolvedValue(conversationRow() as never);
        __setProviderForTesting(
            buildProvider(async () => ({
                content: 'Saved',
                tokensInput: 1,
                tokensOutput: 1,
                attachments: [attachment],
            })),
        );
        await sendMessage('u', 'c', 'create', () => undefined);
        expect(mockedBudget.reserve).toHaveBeenCalledWith('u', 'chat');
        expect(mockedBudget.release).not.toHaveBeenCalled();
    });
    it('throws CHAT_NOT_FOUND when the caller does not own the conversation', async () => {
        mockedRepo.findConversation.mockResolvedValue(null);
        await expect(sendMessage('u', 'c', 'hi', () => undefined)).rejects.toBeInstanceOf(
            ChatNotFoundError,
        );
        expect(mockedRepo.claimTurn).not.toHaveBeenCalled();
    });

    it('returns AI_BUDGET_EXCEEDED before persisting anything', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedBudget.reserve.mockRejectedValue(
            new AiBudgetExceededError('chat', 50, '2026-06-09T00:00:00.000Z'),
        );
        await expect(sendMessage('u', 'c', 'hi', () => undefined)).rejects.toBeInstanceOf(
            AiBudgetExceededError,
        );
        expect(mockedRepo.claimTurn).not.toHaveBeenCalled();
        expect(mockedBudget.release).not.toHaveBeenCalled();
    });

    it('on success: persists user msg, placeholder, finalizes assistant, auto-titles, records use', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(0); // first turn → auto-title
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        claim({ content: 'Hi Mnemio!' });
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

        // user msg + placeholder claimed atomically
        expect(mockedRepo.claimTurn).toHaveBeenCalledWith(
            expect.objectContaining({ conversationId: 'c', content: 'Hi Mnemio!' }),
        );

        // finalize with the streamed buffer
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'Hello!', status: 'complete' }),
        );
        // auto-title triggered (first user message)
        expect(mockedRepo.renameAndTouch).toHaveBeenCalledWith('c', 'Hi Mnemio!', expect.any(Date));
        expect(mockedRepo.touchLastMessageAt).not.toHaveBeenCalled();
        expect(mockedBudget.release).not.toHaveBeenCalled();
        // reservation remains charged on success
        expect(mockedBudget.reserve).toHaveBeenCalledWith('u', 'chat');
    });

    it.each([502, 'refusal'])(
        'on provider failure %s: saves partial content and releases the reservation',
        async (status) => {
            mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
            mockedRepo.countUserMessages.mockResolvedValue(0);
            mockedRepo.lastTurnsForModel.mockResolvedValue([]);
            __setProviderForTesting(
                buildProvider(async (_input, opts) => {
                    opts?.onEvent?.({ type: 'token', delta: 'Hello' } as ChatStreamEvent);
                    throw new AiProviderError(status, 'upstream blew up');
                }),
            );

            await expect(sendMessage('u', 'c', 'Hi', () => undefined)).rejects.toBeInstanceOf(
                AiProviderError,
            );

            // The placeholder was finalized with the partial buffer, NOT marked complete.
            expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith({
                id: 'ai-msg',
                content: 'Hello',
                tokensInput: 0,
                tokensOutput: 0,
                status: 'partial',
            });
            // We didn't charge the user for the partial.
            expect(mockedBudget.release).toHaveBeenCalledWith('u', 'chat');
            // And we didn't bump the conversation order — partial replies don't
            // jump to the top of the sidebar.
            expect(mockedRepo.touchLastMessageAt).not.toHaveBeenCalled();
            expect(mockedRepo.renameAndTouch).not.toHaveBeenCalled();
        },
    );

    it('does NOT auto-title on the second user turn even if the title is still default', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1); // already had a turn
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
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

    it('threads opts.locale into the system prompt', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'Привіт!' }) as never,
        );
        let seenPrompt = '';
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenPrompt = input.systemPrompt;
                return { content: 'Привіт!', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', 'Привіт', () => undefined, { locale: 'uk' });

        expect(seenPrompt).toContain('Always reply in Ukrainian');
        expect(seenPrompt).toContain('app language: Ukrainian (uk)');
    });

    it("gives the model the user's profile languages (normalized) in the system prompt", async () => {
        setProfile('ukrainian', ['en', 'de-DE', 'xx']);
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        let seenPrompt = '';
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenPrompt = input.systemPrompt;
                return { content: 'ok', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', 'зроби колоду', () => undefined, { locale: 'en' });

        expect(seenPrompt).toContain(
            'native language: Ukrainian (uk); learning: English (en), German (de); app language: English (en)',
        );
    });

    it("re-attaches a previous deck's languages to its assistant turn for the model", async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([
            { role: 'user', content: 'German food words', attachments: null },
            {
                role: 'assistant',
                content: 'Done!',
                attachments: [
                    {
                        type: 'deck',
                        deckId: 'd1',
                        title: 'Food',
                        cardCount: 8,
                        action: 'created',
                        sourceLanguage: 'uk',
                        targetLanguage: 'de',
                    },
                ],
            },
        ]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        let seenMessages: { role: string; content: string }[] = [];
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenMessages = input.messages;
                return { content: 'ok', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', 'one more', () => undefined);

        expect(seenMessages[0]).toEqual({ role: 'user', content: 'German food words' });
        expect(seenMessages[1]?.content).toBe(
            'Done!\n\n(Deck "Food": words in German (de), definitions in Ukrainian (uk))',
        );
    });

    // Two sends racing on one conversation produced a second reply that was the
    // first reply plus its own, twice — the loser is now refused outright.
    it('refuses a second send while one is still streaming', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.claimTurn.mockResolvedValue(null as never);

        await expect(sendMessage('u', 'c', 'second', () => undefined)).rejects.toBeInstanceOf(
            ChatBusyError,
        );
        expect(mockedBudget.release).toHaveBeenCalledWith('u', 'chat');
    });

    // History is read AFTER the user row is saved, so without an explicit
    // boundary the current message went to the model twice in a row.
    it('excludes the current turn from the history it sends the model', async () => {
        const created = new Date('2026-06-08T10:05:00Z');
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        claim({ createdAt: created });
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        let seenMessages: { role: string; content: string }[] = [];
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenMessages = input.messages;
                return { content: 'ok', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', 'only once please', () => undefined);

        expect(mockedRepo.lastTurnsForModel).toHaveBeenCalledWith('c', expect.any(Number), created);
        expect(seenMessages.filter((m) => m.content === 'only once please')).toHaveLength(1);
    });

    it('passes retryOf through so the failed turn is replaced, not duplicated', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'ok' }) as never,
        );
        __setProviderForTesting(
            buildProvider(async () => ({ content: 'ok', tokensInput: 0, tokensOutput: 0 })),
        );

        await sendMessage('u', 'c', 'again', () => undefined, { retryOf: 'old-ai-msg' });

        expect(mockedRepo.claimTurn).toHaveBeenCalledWith(
            expect.objectContaining({ retryOf: 'old-ai-msg' }),
        );
    });

    // If the deck was already written, a Retry would create it a second time —
    // the partial message has to carry the attachment so the FE can hide Retry.
    it('keeps a successful tool attachment on the partial message when the turn then fails', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        const attachment = { type: 'deck', deckId: 'd1', title: 'Fruits', cardCount: 5 };
        __setProviderForTesting(
            buildProvider(async (_input, opts) => {
                opts?.onEvent?.({
                    type: 'tool_result',
                    name: 'create_deck',
                    ok: true,
                    data: attachment,
                } as ChatStreamEvent);
                throw new AiProviderError(502, 'died after the write');
            }),
        );

        await expect(sendMessage('u', 'c', 'make a deck', () => undefined)).rejects.toBeInstanceOf(
            AiProviderError,
        );

        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'partial', attachments: [attachment] }),
        );
    });

    it('with an attached image: meters under "image" (not "chat"), adds the image clause to the prompt, and attaches the image to only the newest turn', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.countUserMessages.mockResolvedValue(1);
        mockedRepo.lastTurnsForModel.mockResolvedValue([
            { role: 'user', content: 'earlier text turn', attachments: null },
        ]);
        mockedRepo.finalizeAssistantMessage.mockResolvedValue(
            messageRow({ id: 'ai-msg', role: 'assistant', content: 'Found 3 words.' }) as never,
        );
        const image = { mediaType: 'image/png' as const, dataBase64: 'ZmFrZQ==' };
        let seenPrompt = '';
        let seenMessages: unknown[] = [];
        __setProviderForTesting(
            buildProvider(async (input): Promise<ChatResult> => {
                seenPrompt = input.systemPrompt;
                seenMessages = input.messages;
                return { content: 'Found 3 words.', tokensInput: 0, tokensOutput: 0 };
            }),
        );

        await sendMessage('u', 'c', '', () => undefined, { image });

        // Metered as 'image', not 'chat'.
        expect(mockedBudget.reserve).toHaveBeenCalledWith('u', 'image');
        expect(mockedBudget.reserve).toHaveBeenCalledWith('u', 'image');
        // System prompt gets the image-handling clause.
        expect(seenPrompt).toContain('attached an image');
        // Only the newest (last) turn carries the image; the prior DB turn doesn't.
        expect(seenMessages.at(-1)).toMatchObject({ image });
        expect(seenMessages[0]).not.toHaveProperty('image');
    });
});

describe('chat turn recovery', () => {
    it('finalizes a partial reply if loading model context fails', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockRejectedValue(new Error('database unavailable'));
        await expect(sendMessage('u', 'c', 'hi', () => undefined)).rejects.toThrow(
            'database unavailable',
        );
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'ai-msg', status: 'partial' }),
        );
    });
    it('rejects unsafe retries without invoking the model', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.claimTurn.mockResolvedValue('retry_unavailable');
        await expect(
            sendMessage('u', 'c', 'hi', () => undefined, { retryOf: 'done' }),
        ).rejects.toMatchObject({ code: 'CHAT_RETRY_UNAVAILABLE' });
    });
    it('passes cancellation to the provider and saves interrupted text', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        const controller = new AbortController();
        __setProviderForTesting(
            buildProvider(async (_input, opts) => {
                expect(opts?.signal).toBeDefined();
                opts?.onEvent?.({ type: 'token', delta: 'half' });
                controller.abort();
                opts?.signal?.throwIfAborted();
                return { content: '', tokensInput: 0, tokensOutput: 0 };
            }),
        );
        await expect(
            sendMessage('u', 'c', 'hi', () => undefined, { signal: controller.signal }),
        ).rejects.toBeDefined();
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'half', status: 'partial' }),
        );
        expect(mockedBudget.release).toHaveBeenCalledWith('u', 'chat');
    });
});

describe('explicit chat cancellation', () => {
    it('remembers cancellation during preparation before the start frame', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        let ready: () => void = () => undefined;
        const preparing = new Promise<void>((resolve) => {
            ready = resolve;
        });
        let finish: (value: never) => void = () => undefined;
        mockedPrefs.findOrCreate.mockImplementation(() => {
            ready();
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const chat = vi.fn();
        __setProviderForTesting(buildProvider(chat));
        const sending = sendMessage('u', 'conv-preparing', 'hi', () => undefined);
        const rejected = expect(sending).rejects.toBeDefined();
        await preparing;
        await cancelReply('u', 'conv-preparing');
        finish({ nativeLanguage: 'uk', learningLanguages: ['en'] } as never);
        await rejected;
        expect(chat).not.toHaveBeenCalled();
        expect(mockedBudget.release).toHaveBeenCalledExactlyOnceWith('u', 'chat');
    });
    it('requires conversation ownership', async () => {
        mockedRepo.findConversation.mockResolvedValue(null);
        await expect(cancelReply('other-user', 'conv-1')).rejects.toBeInstanceOf(ChatNotFoundError);
    });
    it('cancels the active provider even when a proxy keeps SSE open', async () => {
        mockedRepo.findConversation.mockResolvedValue(conversationRow() as never);
        mockedRepo.lastTurnsForModel.mockResolvedValue([]);
        let ready: () => void = () => undefined;
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        __setProviderForTesting(
            buildProvider(async (_input, opts) => {
                ready();
                await new Promise<void>((_resolve, reject) => {
                    opts?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {
                        once: true,
                    });
                });
                return { content: '', tokensInput: 0, tokensOutput: 0 };
            }),
        );
        const sending = sendMessage('u', 'conv-1', 'hi', () => undefined);
        const rejection = expect(sending).rejects.toThrow('cancelled');
        await started;
        await cancelReply('u', 'conv-1');
        await rejection;
        expect(mockedRepo.finalizeAssistantMessage).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'partial' }),
        );
    });
});
