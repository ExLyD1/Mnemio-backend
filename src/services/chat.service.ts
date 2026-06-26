import { env } from '../config/env.js';
import { ChatNotFoundError } from '../shared/errors.js';
import {
    encodeCursor,
    type Cursor,
    type Page,
} from '../shared/pagination.js';
import {
    toPublicConversation,
    toPublicMessage,
    type PublicConversation,
    type PublicMessage,
} from '../shared/mappers.chat.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import * as budget from './ai.budget.service.js';
import { mockProvider } from './ai.provider.mock.js';
import { anthropicProvider } from './ai.provider.anthropic.js';
import type {
    AiProvider,
    ChatStreamEvent,
    ChatToolOutcome,
    ChatToolsConfig,
} from './ai.provider.js';
import { buildChatSystemPrompt, autoTitle, type ChatDeckContext } from './chat.prompt.js';
import {
    CREATE_DECK_TOOL_DEF,
    ADD_CARDS_TOOL_DEF,
    runCreateDeck,
    runAddCards,
    type CreateDeckToolInput,
    type AddCardsToolInput,
    type ToolResult,
} from './chat.tools.js';
import type { ChatAttachment } from '../shared/mappers.chat.js';

// Same selector ai.service uses — keeps the mock/real switch single-sourced
// at env.AI_PROVIDER.
const selectProvider = (): AiProvider => {
    if (env.AI_PROVIDER === 'anthropic') return anthropicProvider;
    return mockProvider;
};

// Lazy so tests can mock the provider before the service is imported.
let cachedProvider: AiProvider | null = null;
const provider = (): AiProvider => {
    if (!cachedProvider) cachedProvider = selectProvider();
    return cachedProvider;
};

// Test-only seam.
export const __setProviderForTesting = (p: AiProvider | null): void => {
    cachedProvider = p;
};

// ---------- Conversations ----------

export const createConversation = async (
    userId: string,
    title?: string,
): Promise<PublicConversation> => {
    const created = await chatRepo.createConversation(userId, title);
    return toPublicConversation(created);
};

export const renameConversation = async (
    userId: string,
    conversationId: string,
    title: string,
): Promise<PublicConversation> => {
    const result = await chatRepo.renameConversation(conversationId, userId, title);
    if (result.count === 0) throw new ChatNotFoundError();
    const refreshed = await chatRepo.findConversation(conversationId, userId);
    // findConversation can't be null here — we just updated the row.
    return toPublicConversation(refreshed!);
};

export const deleteConversation = async (
    userId: string,
    conversationId: string,
): Promise<void> => {
    const result = await chatRepo.deleteConversation(conversationId, userId);
    if (result.count === 0) throw new ChatNotFoundError();
};

export const listConversations = async (
    userId: string,
    params: { cursor: Cursor | null; limit: number },
): Promise<Page<PublicConversation>> => {
    const rows = await chatRepo.listConversations({
        userId,
        cursor: params.cursor,
        limit: params.limit,
    });
    const hasMore = rows.length > params.limit;
    const slice = hasMore ? rows.slice(0, params.limit) : rows;
    const last = slice.at(-1);
    const nextCursor =
        hasMore && last
            ? encodeCursor({ ts: last.lastMessageAt.toISOString(), id: last.id })
            : null;
    return {
        items: slice.map(toPublicConversation),
        nextCursor,
    };
};

export const getConversationWithMessages = async (
    userId: string,
    conversationId: string,
): Promise<{ conversation: PublicConversation; messages: PublicMessage[] }> => {
    const conv = await chatRepo.findConversation(conversationId, userId);
    if (!conv) throw new ChatNotFoundError();
    const messages = await chatRepo.listMessages(conversationId, 50);
    return {
        conversation: toPublicConversation(conv),
        messages: messages.map(toPublicMessage),
    };
};

// ---------- Send message ----------

export type SendMessageStreamFrame =
    | {
          type: 'start';
          userMessage: PublicMessage;
          assistantMessageId: string;
      }
    | { type: 'token'; delta: string }
    | {
          type: 'tool_use';
          name: string;
          input: Record<string, unknown>;
      }
    | {
          type: 'tool_result';
          name: string;
          ok: boolean;
          data: unknown;
      }
    | {
          type: 'done';
          assistantMessage: PublicMessage;
          conversationTitle: string;
          tokensInput: number;
          tokensOutput: number;
      };

// Maps a tool handler's ToolResult to the provider-facing ChatToolOutcome. The
// model gets the same JSON the FE will render so it can mention the title/id in
// its follow-up text.
const toOutcome = (result: ToolResult): ChatToolOutcome =>
    result.ok
        ? {
              ok: true,
              data: result.attachment,
              resultJson: JSON.stringify({ ok: true, ...result.attachment }),
          }
        : {
              ok: false,
              data: { reason: result.reason },
              resultJson: JSON.stringify({ ok: false, reason: result.reason }),
          };

// Builds the tools config the provider receives. Lives here (not in
// chat.tools.ts) because it closes over the per-request userId + the in-context
// deck — each tool run is scoped to who sent the message. add_cards is exposed
// ONLY when a deck is open, and the deckId comes from that context (never the
// model), so the model can't append to an arbitrary deck.
const toolsForUser = (userId: string, deckCtx?: ChatDeckContext): ChatToolsConfig => ({
    defs: deckCtx ? [CREATE_DECK_TOOL_DEF, ADD_CARDS_TOOL_DEF] : [CREATE_DECK_TOOL_DEF],
    run: async (call): Promise<ChatToolOutcome> => {
        if (call.name === 'create_deck') {
            return toOutcome(await runCreateDeck(userId, call.input as CreateDeckToolInput));
        }
        if (call.name === 'add_cards' && deckCtx) {
            return toOutcome(
                await runAddCards(userId, deckCtx.deckId, call.input as AddCardsToolInput),
            );
        }
        return {
            ok: false,
            data: { reason: `Unknown tool: ${call.name}` },
            resultJson: JSON.stringify({ ok: false, reason: 'UNKNOWN_TOOL' }),
        };
    },
});

// Both the JSON and SSE controller paths share this driver. The `onFrame`
// callback fires for every interesting moment so the controller can either
// buffer (JSON) or stream (SSE) them.
//
// Failure modes:
//   - assertWithinBudget throws AI_BUDGET_EXCEEDED before we persist anything
//   - if the provider throws after the user message + placeholder are saved,
//     the placeholder is flipped to status='partial' with whatever buffer we
//     have, and the error re-throws. The user message stays put either way.
export const sendMessage = async (
    userId: string,
    conversationId: string,
    content: string,
    onFrame: (frame: SendMessageStreamFrame) => void,
    opts: { deckId?: string } = {},
): Promise<{
    userMessage: PublicMessage;
    assistantMessage: PublicMessage;
    conversationTitle: string;
    tokensInput: number;
    tokensOutput: number;
}> => {
    const conv = await chatRepo.findConversation(conversationId, userId);
    if (!conv) throw new ChatNotFoundError();

    // Budget check BEFORE we persist anything. We don't charge for messages
    // that 429.
    await budget.assertWithinBudget(userId, 'chat');

    // Resolve the in-context deck (the one the user is viewing). Ownership-scoped
    // — a deckId the user doesn't own is silently ignored, so add_cards simply
    // stays unavailable rather than leaking that the deck exists.
    let deckCtx: ChatDeckContext | undefined;
    if (opts.deckId) {
        const deck = await decksRepo.findDeckById(opts.deckId, userId);
        if (deck) {
            deckCtx = {
                deckId: deck.id,
                title: deck.title,
                sourceLanguage: deck.sourceLanguage,
                targetLanguage: deck.targetLanguage,
            };
        }
    }

    // Is this the auto-title turn?
    const priorUserCount = await chatRepo.countUserMessages(conversationId);
    const isAutoTitleTurn = priorUserCount === 0;

    // Persist the user message first — if anything below fails, we still
    // have what they typed.
    const userRowDb = await chatRepo.createMessage({
        conversationId,
        role: 'user',
        content,
    });
    const userMessage = toPublicMessage(userRowDb);

    // Placeholder assistant row with status='partial'. The id is stable from
    // here on so the FE can render "typing…" attached to it.
    const assistantPlaceholder = await chatRepo.createMessage({
        conversationId,
        role: 'assistant',
        content: '',
        status: 'partial',
    });

    onFrame({
        type: 'start',
        userMessage,
        assistantMessageId: assistantPlaceholder.id,
    });

    // Build the model context: prior turns + the just-saved user message.
    const priorTurns = await chatRepo.lastTurnsForModel(
        conversationId,
        env.AI_CHAT_CONTEXT_TURNS - 1,
    );
    const turnsForModel = [...priorTurns, { role: 'user' as const, content }];

    let buffer = '';
    let tokensInput = 0;
    let tokensOutput = 0;
    let attachments: ChatAttachment[] | undefined;

    try {
        const result = await provider().chat(
            {
                messages: turnsForModel,
                systemPrompt: buildChatSystemPrompt(deckCtx),
                maxOutputTokens: env.AI_CHAT_MAX_OUTPUT_TOKENS,
                tools: toolsForUser(userId, deckCtx),
            },
            {
                onEvent: (event: ChatStreamEvent) => {
                    if (event.type === 'token') {
                        buffer += event.delta;
                        onFrame({ type: 'token', delta: event.delta });
                    } else if (event.type === 'tool_use') {
                        onFrame({
                            type: 'tool_use',
                            name: event.call.name,
                            input: event.call.input,
                        });
                    } else if (event.type === 'tool_result') {
                        onFrame({
                            type: 'tool_result',
                            name: event.name,
                            ok: event.ok,
                            data: event.data,
                        });
                    }
                },
            },
        );
        // The provider returns the AUTHORITATIVE answer — on a tool call that's
        // the post-tool-result text only, so a premature "added it" preamble
        // streamed live never makes it into the saved message. Prefer it; fall
        // back to the streamed buffer only if the provider returned nothing.
        if (result.content.length > 0) {
            buffer = result.content;
        }
        tokensInput = result.tokensInput;
        tokensOutput = result.tokensOutput;
        // The provider's attachments are typed as unknown[] (provider layer
        // is tool-agnostic). chat.tools is the only caller; we trust it
        // returned ChatAttachment objects.
        if (result.attachments && result.attachments.length > 0) {
            attachments = result.attachments as ChatAttachment[];
        }
    } catch (err) {
        // Save whatever we got so the FE can render the partial reply.
        await chatRepo.finalizeAssistantMessage({
            id: assistantPlaceholder.id,
            content: buffer,
            tokensInput: 0,
            tokensOutput: 0,
            status: 'partial',
        });
        throw err;
    }

    // Complete: finalize the assistant row, bump the conversation order,
    // and (if this was the first turn) set the title.
    const now = new Date();
    const finalAssistantDb = await chatRepo.finalizeAssistantMessage({
        id: assistantPlaceholder.id,
        content: buffer,
        tokensInput,
        tokensOutput,
        status: 'complete',
        ...(attachments ? { attachments } : {}),
    });

    let conversationTitle = conv.title;
    const newTitle = isAutoTitleTurn ? autoTitle(content) : null;
    if (newTitle) {
        const renamed = await chatRepo.renameAndTouch(conversationId, newTitle, now);
        conversationTitle = renamed.title;
    } else {
        await chatRepo.touchLastMessageAt(conversationId, now);
    }

    // Charge the user only after a successful turn.
    await budget.recordUse(userId, 'chat');

    const assistantMessage = toPublicMessage(finalAssistantDb);
    onFrame({
        type: 'done',
        assistantMessage,
        conversationTitle,
        tokensInput,
        tokensOutput,
    });

    return {
        userMessage,
        assistantMessage,
        conversationTitle,
        tokensInput,
        tokensOutput,
    };
};
