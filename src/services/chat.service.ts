import { env } from '../config/env.js';
import { ChatBusyError, ChatNotFoundError } from '../shared/errors.js';
import { encodeCursor, type Cursor, type Page } from '../shared/pagination.js';
import {
    fromDbAttachments,
    toPublicConversation,
    toPublicMessage,
    type ChatAttachment,
    type PublicConversation,
    type PublicMessage,
} from '../shared/mappers.chat.js';
import * as chatRepo from '../repositories/chat.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import * as prefsRepo from '../repositories/preferences.repository.js';
import * as budget from './ai.budget.service.js';
import { mockProvider } from './ai.provider.mock.js';
import { anthropicProvider } from './ai.provider.anthropic.js';
import type {
    AiImageInput,
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
    type UserLanguages,
} from './chat.tools.js';
import { normalizeLang } from '../shared/lang.js';
import { promptLang } from './ai.prompts.js';

// Same selector ai.service uses — keeps the mock/real switch single-sourced
// at env.AI_PROVIDER.
const selectProvider = (): AiProvider => {
    if (env.AI_PROVIDER === 'anthropic') {
        return anthropicProvider;
    }
    return mockProvider;
};

// Lazy so tests can mock the provider before the service is imported.
let cachedProvider: AiProvider | null = null;
const provider = (): AiProvider => {
    cachedProvider ??= selectProvider();
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
    if (result.count === 0) {
        throw new ChatNotFoundError();
    }
    const refreshed = await chatRepo.findConversation(conversationId, userId);
    // Only null if the row was deleted between the rename and this read.
    if (!refreshed) {
        throw new ChatNotFoundError();
    }
    return toPublicConversation(refreshed);
};

export const deleteConversation = async (userId: string, conversationId: string): Promise<void> => {
    const result = await chatRepo.deleteConversation(conversationId, userId);
    if (result.count === 0) {
        throw new ChatNotFoundError();
    }
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
    if (!conv) {
        throw new ChatNotFoundError();
    }
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
              // `words` grounds the model's round-2 reply in the actual
              // persisted cards (not just the title/count) — it's only in the
              // tool_result JSON the model sees, not the FE-facing attachment.
              // ALL of them, not a slice: with a truncated list the model
              // filled the gap from its own draft and named words that were
              // never saved (QA: the reply said "água", the card said "agua").
              resultJson: JSON.stringify({
                  ok: true,
                  ...result.attachment,
                  wordsLanguage: result.attachment.targetLanguage,
                  definitionsLanguage: result.attachment.sourceLanguage,
                  words: result.words,
                  ...(result.skipped && result.skipped.length > 0
                      ? { skipped: result.skipped }
                      : {}),
              }),
          }
        : {
              ok: false,
              data: { reason: result.reason },
              resultJson: JSON.stringify({
                  ok: false,
                  reason: result.reason,
                  ...(result.details ? { details: result.details } : {}),
              }),
          };

// The user's profile languages, normalized and deduped. Unrecognized stored
// values are dropped rather than guessed at.
const loadUserLanguages = async (userId: string): Promise<UserLanguages> => {
    const pref = await prefsRepo.findOrCreate(userId);
    const learning = pref.learningLanguages
        .map((l) => normalizeLang(l))
        .filter((l): l is string => l !== null);
    return {
        native: normalizeLang(pref.nativeLanguage),
        learning: [...new Set(learning)],
    };
};

// Prior turns go to the model as plain text, so a deck made earlier would
// lose its languages ("make another one" then drifts). Append them to the
// assistant turn that produced the deck.
const withDeckNote = (turn: {
    role: 'user' | 'assistant';
    content: string;
    attachments: unknown;
}): { role: 'user' | 'assistant'; content: string } => {
    const notes = (fromDbAttachments(turn.attachments) ?? []).flatMap((a) =>
        a.sourceLanguage && a.targetLanguage
            ? [
                  `(Deck "${a.title}": words in ${promptLang(a.targetLanguage)}, definitions in ${promptLang(a.sourceLanguage)})`,
              ]
            : [],
    );
    return {
        role: turn.role,
        content: notes.length > 0 ? `${turn.content}\n\n${notes.join('\n')}` : turn.content,
    };
};

// Builds the tools config the provider receives. Lives here (not in
// chat.tools.ts) because it closes over the per-request userId + the in-context
// deck — each tool run is scoped to who sent the message. add_cards is exposed
// ONLY when a deck is open, and the deckId comes from that context (never the
// model), so the model can't append to an arbitrary deck.
const toolsForUser = (
    userId: string,
    userLangs: UserLanguages,
    deckCtx: ChatDeckContext | undefined,
    locale: string | null | undefined,
    // The message that triggered this turn. The tools read it to honour a deck
    // name the user quoted, and to refuse an append aimed at a deck other than
    // the open one — neither can be trusted to the model's own arguments.
    userMessage: string,
): ChatToolsConfig => ({
    defs: deckCtx ? [CREATE_DECK_TOOL_DEF, ADD_CARDS_TOOL_DEF] : [CREATE_DECK_TOOL_DEF],
    run: async (call): Promise<ChatToolOutcome> => {
        if (call.name === 'create_deck') {
            return toOutcome(
                await runCreateDeck(
                    userId,
                    call.input as CreateDeckToolInput,
                    userLangs,
                    locale,
                    { userMessage },
                ),
            );
        }
        if (call.name === 'add_cards' && deckCtx) {
            return toOutcome(
                await runAddCards(userId, deckCtx.deckId, call.input as AddCardsToolInput, {
                    userMessage,
                }),
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
    opts: {
        deckId?: string;
        locale?: string | null;
        image?: AiImageInput;
        retryOf?: string;
    } = {},
): Promise<{
    userMessage: PublicMessage;
    assistantMessage: PublicMessage;
    conversationTitle: string;
    tokensInput: number;
    tokensOutput: number;
}> => {
    const conv = await chatRepo.findConversation(conversationId, userId);
    if (!conv) {
        throw new ChatNotFoundError();
    }

    // Image-attached turns are metered under the 'image' cap (vision calls
    // cost more) instead of 'chat' — one consistent cap across both the
    // standalone deck-from-image endpoint and this attachment path.
    const budgetKind = opts.image ? 'image' : 'chat';

    // Budget check BEFORE we persist anything. We don't charge for messages
    // that 429.
    await budget.assertWithinBudget(userId, budgetKind);

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

    const userLangs = await loadUserLanguages(userId);

    // Real remaining deck-building allowance, so the reply can state it instead
    // of inventing one (and so an exhausted budget costs a sentence, not a
    // doomed tool call).
    const usage = await budget.usageSnapshot(userId);
    const budgetCtx = {
        wordListRemaining: usage.kinds.enrich.remaining,
        wordListCap: usage.kinds.enrich.cap,
        topicRemaining: usage.kinds.generate.remaining,
        topicCap: usage.kinds.generate.cap,
        resetsAt: usage.resetsAt,
        plan: usage.plan,
    };


    // Persist the user message and claim the conversation's streaming slot in
    // one transaction — if anything below fails, we still have what they typed,
    // and a second concurrent send is refused rather than interleaved.
    const claimed = await chatRepo.claimTurn({
        conversationId,
        content,
        ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    });
    if (!claimed) {
        throw new ChatBusyError();
    }
    const { userRow: userRowDb, placeholder: assistantPlaceholder } = claimed;
    const userMessage = toPublicMessage(userRowDb);

    // Is this the auto-title turn? Counted after the claim and scoped to rows
    // older than this one, so a retry (which deleted the failed pair) still
    // titles the conversation.
    const priorUserCount = await chatRepo.countUserMessages(
        conversationId,
        userRowDb.createdAt,
    );
    const isAutoTitleTurn = priorUserCount === 0;

    onFrame({
        type: 'start',
        userMessage,
        assistantMessageId: assistantPlaceholder.id,
    });

    // Build the model context: prior turns + the just-saved user message.
    // `before` excludes this turn's own rows — they are already persisted, so
    // without it the current message went to the model twice.
    // Only the newest turn ever carries an image — images aren't persisted,
    // so turns rebuilt from the DB (priorTurns) are always text-only.
    const priorTurns = await chatRepo.lastTurnsForModel(
        conversationId,
        env.AI_CHAT_CONTEXT_TURNS - 1,
        userRowDb.createdAt,
    );
    const turnsForModel = [
        ...priorTurns.map(withDeckNote),
        { role: 'user' as const, content, ...(opts.image ? { image: opts.image } : {}) },
    ];

    let buffer = '';
    let tokensInput = 0;
    let tokensOutput = 0;
    let attachments: ChatAttachment[] | undefined;

    try {
        const result = await provider().chat(
            {
                messages: turnsForModel,
                systemPrompt: buildChatSystemPrompt(
                    deckCtx,
                    opts.locale,
                    !!opts.image,
                    userLangs,
                    budgetCtx,
                ),
                maxOutputTokens: env.AI_CHAT_MAX_OUTPUT_TOKENS,
                tools: toolsForUser(userId, userLangs, deckCtx, opts.locale, content),
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
                        // Remember a successful write here, not just on the
                        // provider's return value: if the turn dies after the
                        // deck was persisted, the partial message must still
                        // carry the attachment so the FE hides Retry and the
                        // user can't create the same deck twice.
                        if (event.ok) {
                            attachments = [event.data as ChatAttachment];
                        }
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
        // Save whatever we got so the FE can render the partial reply, and
        // release the streaming slot. Attachments ride along when a tool
        // already wrote something (see the tool_result handler above).
        await chatRepo.finalizeAssistantMessage({
            id: assistantPlaceholder.id,
            content: buffer,
            tokensInput: 0,
            tokensOutput: 0,
            status: 'partial',
            ...(attachments ? { attachments } : {}),
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
    await budget.recordUse(userId, budgetKind);

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
