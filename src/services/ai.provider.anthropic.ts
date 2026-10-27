/**
 * Anthropic Claude adapter for AiProvider. Each content operation ends in one
 * `emit_*` tool call carrying structured JSON — forced via tool_choice where
 * the model allows it, 'auto' + a strict tool where it doesn't (see
 * modelCaps in ai.models.ts). More reliable than "return JSON in prose".
 *
 * Non-streaming implementations live here; SSE streaming is layered on top
 * via the streaming entry points in ai.service.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
    AiCardDraft,
    AiDeckDraft,
    AiImageInput,
    AiProvider,
    AiSuggestion,
    ChatResult,
    ChatStreamEvent,
    ChatToolCall,
    ChatToolOutcome,
    ChatToolsConfig,
    ChatTurn,
    DeckFromImageProviderInput,
    EnrichWordsEvent,
    EnrichWordsResult,
    GenerateDeckEvent,
    SuggestContext,
} from './ai.provider.js';
import type { EnrichWordsInput, GenerateDeckInput } from '../schemas/ai.schema.js';
import { env } from '../config/env.js';
import { AiProviderError, AiValidationFailedError } from '../shared/errors.js';
import {
    buildDeckFromImagePrompt,
    buildEnrichWordsPrompt,
    buildGenerateDeckPrompt,
    buildSuggestPrompt,
    type CacheableSystem,
} from './ai.prompts.js';
import { logAiCall } from './ai.usage-log.js';
import {
    chatRoute,
    contentRoute,
    effortParam,
    modelCaps,
    photoRoute,
    scaledMaxTokens,
    type RouteChoice,
} from './ai.models.js';

const cardItemSchema = {
    type: 'object',
    properties: {
        word: { type: 'string' },
        definition: { type: 'string' },
        phonetic: { type: 'string' },
        partOfSpeech: { type: 'string' },
        example: { type: 'string' },
        exampleTranslation: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    },
    required: ['word', 'definition'],
    additionalProperties: false,
} as const;

const ENRICH_TOOL = {
    name: 'emit_cards',
    description: 'Emit one card entry per input word, in input order.',
    input_schema: {
        type: 'object' as const,
        properties: {
            cards: { type: 'array', items: cardItemSchema },
        },
        required: ['cards'] as string[],
        additionalProperties: false,
    },
} as const;

const DECK_TOOL = {
    name: 'emit_deck',
    description: 'Emit a study-ready deck draft.',
    input_schema: {
        type: 'object' as const,
        properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            sourceLanguage: { type: 'string' },
            targetLanguage: { type: 'string' },
            subject: { type: 'string' },
            glyph: { type: 'string' },
            cards: { type: 'array', items: cardItemSchema },
        },
        required: ['title', 'description', 'sourceLanguage', 'targetLanguage', 'cards'] as string[],
        additionalProperties: false,
    },
} as const;

const SUGGEST_TOOL = {
    name: 'emit_suggestion',
    description: 'Emit a single Mimi suggestion with optional CTAs.',
    input_schema: {
        type: 'object' as const,
        properties: {
            suggestion: { type: 'string' },
            kind: { type: 'string', enum: ['tip', 'deck', 'review'] },
            actions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        label: { type: 'string' },
                        href: { type: 'string' },
                    },
                    required: ['label', 'href'],
                    additionalProperties: false,
                },
            },
        },
        required: ['suggestion', 'kind', 'actions'] as string[],
        additionalProperties: false,
    },
} as const;

const client = (() => {
    let cached: Anthropic | null = null;
    return () => {
        if (cached) {
            return cached;
        }
        if (!env.ANTHROPIC_API_KEY) {
            // Should never happen — env.ts refines this when AI_PROVIDER=anthropic.
            throw new AiProviderError(500, 'ANTHROPIC_API_KEY is not configured');
        }
        cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        return cached;
    };
})();

/** Upstream HTTP status to report for a failed SDK call; 502 when there isn't one. */
const providerErrorStatus = (err: unknown): number | string => {
    if (!(err instanceof Anthropic.APIError)) {
        return 502;
    }
    // `instanceof` narrows to APIError<any, …>, so re-type the field before using it.
    const status: unknown = err.status;
    return typeof status === 'number' || typeof status === 'string' ? status : 502;
};

/**
 * Which model writes a deck's CARD CONTENT (see contentRoute in ai.models.ts).
 * Kept for callers and tests that only need the model id.
 */
export const contentModel = (...langs: (string | undefined)[]): string =>
    contentRoute(...langs).model;

type ContentTool = typeof ENRICH_TOOL | typeof DECK_TOOL | typeof SUGGEST_TOOL;

type ContentCallArgs = {
    op: string;
    choice: RouteChoice;
    system: CacheableSystem;
    // A bare string, or an image + text blocks for photo → deck.
    content: string | Anthropic.ContentBlockParam[];
    tool: ContentTool;
    // From the op's own formula (tuned on Haiku 4.5 / Sonnet 5); scaled per
    // model by scaledMaxTokens.
    maxTokens: number;
    attempt?: number;
    // Cumulative parsed tool input while it streams (SSE callers).
    onSnapshot?: (snapshot: unknown) => void;
};

type ContentCallResult<T> = {
    data: T | null;
    stopReason: Anthropic.StopReason | null;
    tokensInput: number;
    tokensOutput: number;
};

// Time to the first visible output: text or tool-input JSON, not thinking.
// Returns a 'streamEvent' listener.
const ttftListener =
    (started: number, set: (ms: number) => void) =>
    (event: Anthropic.MessageStreamEvent): void => {
        if (
            event.type === 'content_block_delta' &&
            (event.delta.type === 'text_delta' || event.delta.type === 'input_json_delta')
        ) {
            set(Date.now() - started);
        }
    };

/**
 * One Anthropic call that should end in a single `emit_*` tool call. Every
 * call streams: that yields a time-to-first-token figure and keeps large
 * max_tokens values clear of the SDK's non-streaming ceiling.
 *
 * Usage is logged exactly once per call, including a call that fails midway
 * (with whatever usage the stream had reported by then).
 */
const runContentCall = async <T>(args: ContentCallArgs): Promise<ContentCallResult<T>> => {
    const { route, model, effort } = args.choice;
    const caps = modelCaps(model);
    const started = Date.now();
    let ttftMs: number | null = null;
    const log = (message: Anthropic.Message | undefined, error?: string) =>
        logAiCall({
            op: args.op,
            route,
            model,
            effort,
            usage: message?.usage,
            stopReason: message?.stop_reason,
            attempt: args.attempt,
            durationMs: Date.now() - started,
            ttftMs,
            stream: true,
            ...(error ? { error } : {}),
        });

    // What the stream had reported when it failed; unset until a request went out.
    let partial: (() => Anthropic.Message | undefined) | null = null;
    let finalMessage: Anthropic.Message;
    try {
        const stream = client().messages.stream({
            model,
            max_tokens: scaledMaxTokens(args.maxTokens, caps),
            system: args.system,
            messages: [{ role: 'user', content: args.content }],
            ...effortParam(model, effort),
            ...(caps.forcedToolChoice
                ? {
                      tools: [args.tool],
                      tool_choice: { type: 'tool' as const, name: args.tool.name },
                  }
                : {
                      // Forced tool_choice is a 400 on this model. Every
                      // content prompt already says to call the tool exactly
                      // once; strict keeps the input schema-valid, and a
                      // missing call is caught by the caller.
                      tools: [{ ...args.tool, strict: true }],
                      tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true },
                  }),
        });
        partial = () => stream.currentMessage;
        stream.on(
            'streamEvent',
            ttftListener(started, (ms) => {
                ttftMs ??= ms;
            }),
        );
        const onSnapshot = args.onSnapshot;
        if (onSnapshot) {
            stream.on('inputJson', (_delta, snapshot) => onSnapshot(snapshot));
        }
        finalMessage = await stream.finalMessage();
    } catch (err) {
        if (partial) {
            log(partial(), (err as Error).message);
        }
        throw new AiProviderError(providerErrorStatus(err), (err as Error).message);
    }
    log(finalMessage);

    // Read by block type: a response may open with thinking blocks.
    const toolBlock = finalMessage.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === args.tool.name,
    );
    return {
        data: toolBlock ? (toolBlock.input as T) : null,
        stopReason: finalMessage.stop_reason,
        tokensInput: finalMessage.usage.input_tokens,
        tokensOutput: finalMessage.usage.output_tokens,
    };
};

const RETRY_NOTE =
    'Retry: your previous output failed schema validation. Return only the tool call, fully populated.';
const CUT_OFF = 'AI output was cut off before it finished (max_tokens)';
// Ceiling for the doubled max_tokens on a retry after truncation.
const MAX_RETRY_TOKENS = 32_000;

const withRetryNote = (content: ContentCallArgs['content']): ContentCallArgs['content'] =>
    typeof content === 'string'
        ? `${content}\n\n${RETRY_NOTE}`
        : [...content, { type: 'text', text: RETRY_NOTE }];

// A refusal is final: the same request would be declined again, so it is
// never retried (by us or by the chat tool's re-draft, which sees the throw).
const assertNotRefused = (result: ContentCallResult<unknown>): void => {
    if (result.stopReason === 'refusal') {
        throw new AiProviderError('refusal', 'Model declined the request');
    }
};

// Truncated tool JSON parses into a silently short deck, so it never counts
// as usable even when what arrived happens to validate.
const isUsable = <T>(result: ContentCallResult<T>, validate: (data: T) => boolean): boolean =>
    result.stopReason !== 'max_tokens' && result.data !== null && validate(result.data);

/**
 * Non-streaming callers: at most two attempts. Invalid output or a missing
 * tool call is retried with a clarifying note; truncation is retried with
 * twice the max_tokens; a refusal is never retried. Tokens are summed over
 * attempts.
 */
const callContent = async <T>(
    args: ContentCallArgs,
    validate: (data: T) => boolean,
): Promise<{ data: T; tokensInput: number; tokensOutput: number }> => {
    const first = await runContentCall<T>(args);
    assertNotRefused(first);
    if (isUsable(first, validate)) {
        return {
            data: first.data as T,
            tokensInput: first.tokensInput,
            tokensOutput: first.tokensOutput,
        };
    }
    const second = await runContentCall<T>({
        ...args,
        attempt: 2,
        ...(first.stopReason === 'max_tokens'
            ? { maxTokens: Math.min(MAX_RETRY_TOKENS, args.maxTokens * 2) }
            : { content: withRetryNote(args.content) }),
    });
    assertNotRefused(second);
    if (!isUsable(second, validate)) {
        throw new AiValidationFailedError(second.stopReason === 'max_tokens' ? CUT_OFF : undefined);
    }
    return {
        data: second.data as T,
        tokensInput: first.tokensInput + second.tokensInput,
        tokensOutput: first.tokensOutput + second.tokensOutput,
    };
};

/**
 * SSE callers: one attempt. Cards have already reached the client while it
 * streamed, so a retry would send them twice.
 */
const streamContent = async <T>(args: ContentCallArgs): Promise<ContentCallResult<T>> => {
    const result = await runContentCall<T>(args);
    assertNotRefused(result);
    return result;
};

// ---------- enrichWords ----------

const isValidCardArray = (data: { cards?: unknown }): boolean =>
    Array.isArray(data.cards) &&
    data.cards.every(
        (c: unknown) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as { word?: unknown }).word === 'string' &&
            typeof (c as { definition?: unknown }).definition === 'string',
    );

export const alignByInputOrder = (requested: string[], received: AiCardDraft[]): AiCardDraft[] => {
    const byKey = new Map(received.map((c) => [c.word.trim().toLowerCase(), c]));
    return requested.map((word) => {
        const card = byKey.get(word.trim().toLowerCase());
        if (card) {
            return { ...card, word };
        }
        // Provider skipped this word — surface as ai-unfilled.
        return {
            word,
            definition: '',
            tags: ['ai-unfilled'],
        };
    });
};

/**
 * The Anthropic SDK's `inputJson` event already provides the cumulative
 * parsed object snapshot of the tool's input as it streams in. This helper
 * pulls a partially-populated array property out of it.
 */
const arrayFromSnapshot = <T>(snapshot: unknown, arrayKey: string): T[] | null => {
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }
    const arr = (snapshot as Record<string, unknown>)[arrayKey];
    return Array.isArray(arr) ? (arr as T[]) : null;
};

const isCompleteCard = (c: unknown): c is AiCardDraft =>
    typeof c === 'object' &&
    c !== null &&
    typeof (c as { word?: unknown }).word === 'string' &&
    typeof (c as { definition?: unknown }).definition === 'string';

const enrichWords = async (
    input: EnrichWordsInput,
    opts?: { onCard?: (event: EnrichWordsEvent) => void },
): Promise<EnrichWordsResult> => {
    const start = Date.now();
    const { system, user } = buildEnrichWordsPrompt(input);
    const call: ContentCallArgs = {
        op: 'enrich',
        choice: contentRoute(input.sourceLanguage, input.targetLanguage),
        system,
        content: user,
        tool: ENRICH_TOOL,
        maxTokens: Math.min(16000, Math.max(1000, input.words.length * 200)),
    };

    // Non-streaming fast path: caller doesn't want incremental events.
    if (!opts?.onCard) {
        const { data, tokensInput, tokensOutput } = await callContent<{
            cards: AiCardDraft[];
        }>(call, isValidCardArray);
        const cards = alignByInputOrder(input.words, data.cards);
        const enriched = cards.filter((c) => c.definition !== '').length;
        return {
            cards,
            meta: {
                requested: input.words.length,
                enriched,
                durationMs: Date.now() - start,
                tokensInput,
                tokensOutput,
            },
        };
    }

    // Streaming path. Capture the callback: the guard above narrows
    // `opts.onCard`, but that narrowing doesn't reach into the stream closure.
    const onCard = opts.onCard;
    let emittedCount = 0;
    const result = await streamContent<{ cards?: unknown }>({
        ...call,
        onSnapshot: (snapshot) => {
            const arr = arrayFromSnapshot<AiCardDraft>(snapshot, 'cards');
            if (!arr) {
                return;
            }
            // Only emit cards we haven't yet AND whose definition has fully
            // arrived. The last item in the snapshot may be partial.
            const completeUpToExclusive = arr.length - 1;
            for (let i = emittedCount; i < completeUpToExclusive; i++) {
                const card = arr[i];
                if (isCompleteCard(card)) {
                    onCard({ type: 'card', position: i, card });
                    emittedCount = i + 1;
                }
            }
        },
    });

    // A cut-off list (max_tokens) keeps the cards that arrived whole; the
    // words it never reached come back ai-unfilled below, so the gap shows.
    const received = (Array.isArray(result.data?.cards) ? result.data.cards : []).filter(
        isCompleteCard,
    );
    // Emit any trailing card the snapshot parser hadn't confirmed.
    for (let i = emittedCount; i < received.length; i++) {
        const card = received[i];
        if (card !== undefined) {
            onCard({ type: 'card', position: i, card });
        }
    }

    const cards = alignByInputOrder(input.words, received);
    const enriched = cards.filter((c) => c.definition !== '').length;
    const meta = {
        requested: input.words.length,
        enriched,
        durationMs: Date.now() - start,
        tokensInput: result.tokensInput,
        tokensOutput: result.tokensOutput,
    };
    onCard({ type: 'done', meta });
    return { cards, meta };
};

// ---------- generateDeck / deckFromImage (shared streaming) ----------

/**
 * Turns streamed tool-input snapshots into header + card events, emitting
 * each card once and only after it fully arrived. Shared by topic and photo
 * decks.
 */
const deckEmitter = (onEvent: (event: GenerateDeckEvent) => void) => {
    let emittedHeader = false;
    let emittedCardCount = 0;
    return {
        onSnapshot: (snapshot: unknown) => {
            if (!snapshot || typeof snapshot !== 'object') {
                return;
            }
            const parsed = snapshot as Partial<AiDeckDraft>;
            if (
                !emittedHeader &&
                typeof parsed.title === 'string' &&
                typeof parsed.description === 'string' &&
                typeof parsed.sourceLanguage === 'string' &&
                typeof parsed.targetLanguage === 'string'
            ) {
                const { cards: _ignored, ...header } = parsed as AiDeckDraft;
                void _ignored;
                onEvent({ type: 'header', deck: header });
                emittedHeader = true;
            }
            if (Array.isArray(parsed.cards)) {
                const complete = parsed.cards.length - 1;
                for (let i = emittedCardCount; i < complete; i++) {
                    const c = parsed.cards[i];
                    if (isCompleteCard(c)) {
                        onEvent({ type: 'card', position: i, card: c });
                        emittedCardCount = i + 1;
                    }
                }
            }
        },
        // Emit any trailing cards the snapshots hadn't confirmed.
        drain: (cards: AiCardDraft[]) => {
            for (let i = emittedCardCount; i < cards.length; i++) {
                const card = cards[i];
                if (card !== undefined) {
                    onEvent({ type: 'card', position: i, card });
                }
            }
        },
    };
};

const streamDeck = async (
    call: ContentCallArgs,
    validate: (data: Partial<AiDeckDraft>) => boolean,
    onEvent: (event: GenerateDeckEvent) => void,
    start: number,
): Promise<AiDeckDraft> => {
    const emitter = deckEmitter(onEvent);
    const result = await streamContent<AiDeckDraft>({ ...call, onSnapshot: emitter.onSnapshot });
    // A cut-off deck would otherwise validate with fewer cards than asked for.
    if (result.stopReason === 'max_tokens') {
        throw new AiValidationFailedError(CUT_OFF);
    }
    if (!result.data || !validate(result.data)) {
        throw new AiValidationFailedError();
    }
    emitter.drain(result.data.cards);
    onEvent({
        type: 'done',
        meta: {
            durationMs: Date.now() - start,
            tokensInput: result.tokensInput,
            tokensOutput: result.tokensOutput,
        },
    });
    return result.data;
};

const isValidDeckDraft = (data: Partial<AiDeckDraft>): boolean =>
    typeof data.title === 'string' &&
    typeof data.description === 'string' &&
    typeof data.sourceLanguage === 'string' &&
    typeof data.targetLanguage === 'string' &&
    Array.isArray(data.cards) &&
    data.cards.length > 0;

const generateDeck = async (
    input: GenerateDeckInput,
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<AiDeckDraft> => {
    const start = Date.now();
    const { system, user } = buildGenerateDeckPrompt(input);
    const call: ContentCallArgs = {
        op: 'generate_deck',
        choice: contentRoute(input.sourceLanguage, input.targetLanguage),
        system,
        content: user,
        tool: DECK_TOOL,
        maxTokens: Math.min(8000, 1500 + (input.count ?? 8) * 250),
    };
    if (!opts?.onEvent) {
        return (await callContent<AiDeckDraft>(call, isValidDeckDraft)).data;
    }
    return streamDeck(call, isValidDeckDraft, opts.onEvent, start);
};

// ---------- deckFromImage ----------

const isValidImageDeckDraft = (data: Partial<AiDeckDraft>): boolean =>
    typeof data.title === 'string' &&
    typeof data.description === 'string' &&
    typeof data.sourceLanguage === 'string' &&
    typeof data.targetLanguage === 'string' &&
    // Unlike text-driven generateDeck, an empty cards array is a VALID
    // result here — it's how "no readable text in the image" is encoded.
    Array.isArray(data.cards);

const imageContentBlock = (image: AiImageInput): Anthropic.ImageBlockParam => ({
    type: 'image',
    source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.dataBase64,
    },
});

const deckFromImage = async (
    input: DeckFromImageProviderInput,
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<AiDeckDraft> => {
    const start = Date.now();
    const { system, user } = buildDeckFromImagePrompt(input);
    const call: ContentCallArgs = {
        op: 'deck_from_image',
        choice: photoRoute(input.sourceLanguage, input.targetLanguage),
        system,
        // A retry appends its note as a further text block; the image is
        // sent again with it (each attempt is a fresh request).
        content: [imageContentBlock(input.image), { type: 'text', text: user }],
        tool: DECK_TOOL,
        maxTokens: Math.min(8000, 1500 + (input.count ?? 8) * 250),
    };
    if (!opts?.onEvent) {
        return (await callContent<AiDeckDraft>(call, isValidImageDeckDraft)).data;
    }
    return streamDeck(call, isValidImageDeckDraft, opts.onEvent, start);
};

// ---------- suggest ----------

const isValidSuggestion = (data: Partial<AiSuggestion>): boolean =>
    typeof data.suggestion === 'string' &&
    typeof data.kind === 'string' &&
    Array.isArray(data.actions);

const suggest = async (input: {
    context: SuggestContext;
    deckId?: string;
    dueCount: number;
    streak: number;
}): Promise<AiSuggestion> => {
    const { system, user } = buildSuggestPrompt(input);
    const { data } = await callContent<AiSuggestion>(
        {
            op: 'suggest',
            choice: chatRoute(),
            system,
            content: user,
            tool: SUGGEST_TOOL,
            maxTokens: 400,
        },
        isValidSuggestion,
    );
    return data;
};

// ---------- chat ----------

// Shape Anthropic returns inside content blocks for a tool call.
type ToolUseBlock = {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
};

// Run a single streaming pass against Anthropic. Forwards text deltas as
// 'token' events; returns the final message + the parsed tool_use block if
// the model decided to call one. Errors map to AiProviderError as elsewhere.
const runChatRound = async (params: {
    messages: Anthropic.MessageParam[];
    system: string;
    maxOutputTokens: number;
    tools?: ChatToolsConfig;
    // 'none' keeps the tools declared but forbids calling them (round 2).
    toolChoice?: 'auto' | 'none';
    onEvent?: (event: ChatStreamEvent) => void;
    signal?: AbortSignal;
    op: string;
}): Promise<{
    content: string;
    tokensInput: number;
    tokensOutput: number;
    toolUse: ToolUseBlock | null;
    rawAssistantBlocks: Anthropic.ContentBlock[];
}> => {
    const { route, model, effort } = chatRoute();
    const started = Date.now();
    let ttftMs: number | null = null;
    const log = (message: Anthropic.Message | undefined, error?: string) =>
        logAiCall({
            op: params.op,
            route,
            model,
            effort,
            usage: message?.usage,
            stopReason: message?.stop_reason,
            durationMs: Date.now() - started,
            ttftMs,
            stream: true,
            ...(error ? { error } : {}),
        });
    let buffer = '';
    // What the stream had reported when it failed; unset until a request went out.
    let partial: (() => Anthropic.Message | undefined) | null = null;
    let finalMessage: Anthropic.Message;
    try {
        params.signal?.throwIfAborted();
        const stream = client().messages.stream({
            model,
            max_tokens: params.maxOutputTokens,
            system: params.system,
            messages: params.messages,
            ...effortParam(model, effort),
            ...(params.tools
                ? {
                      tools: params.tools.defs as unknown as Anthropic.Tool[],
                      // 'auto' = model decides. Plain chat keeps working when
                      // the user isn't asking for a deck. Parallel calls are
                      // off: only the first tool_use block is dispatched, and a
                      // second one leaves round 2 with an unanswered tool_use id
                      // (the API then rejects the whole turn).
                      tool_choice:
                          params.toolChoice === 'none'
                              ? { type: 'none' as const }
                              : { type: 'auto' as const, disable_parallel_tool_use: true },
                  }
                : {}),
        });
        partial = () => stream.currentMessage;
        const onAbort = () => stream.abort();
        params.signal?.addEventListener('abort', onAbort, { once: true });
        stream.on(
            'streamEvent',
            ttftListener(started, (ms) => {
                ttftMs ??= ms;
            }),
        );

        stream.on('text', (delta) => {
            buffer += delta;
            params.onEvent?.({ type: 'token', delta } satisfies ChatStreamEvent);
        });

        try {
            finalMessage = await stream.finalMessage();
        } finally {
            params.signal?.removeEventListener('abort', onAbort);
        }
    } catch (err) {
        if (partial) {
            log(partial(), (err as Error).message);
        }
        throw new AiProviderError(providerErrorStatus(err), (err as Error).message);
    }
    log(finalMessage);

    // The model declined mid-reply: any streamed text is cut off, so fail
    // the turn (nothing was written) instead of saving a partial answer.
    if (finalMessage.stop_reason === 'refusal') {
        throw new AiProviderError('refusal', 'Model declined to answer');
    }
    // Read by block type: a reply may open with thinking blocks.
    const toolBlock = finalMessage.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    // A turn that spent everything on thinking (or said nothing) would save
    // an empty bubble. A reply cut off by max_tokens after real text is kept.
    const hasText = finalMessage.content.some((b) => b.type === 'text' && b.text.trim() !== '');
    if (!toolBlock && !hasText) {
        throw new AiProviderError(
            'empty',
            finalMessage.stop_reason === 'max_tokens'
                ? 'Reply ran out of tokens before any text'
                : 'Model returned an empty reply',
        );
    }
    return {
        content: buffer,
        tokensInput: finalMessage.usage.input_tokens,
        tokensOutput: finalMessage.usage.output_tokens,
        toolUse: toolBlock
            ? {
                  type: 'tool_use',
                  id: toolBlock.id,
                  name: toolBlock.name,
                  input: toolBlock.input as Record<string, unknown>,
              }
            : null,
        // Passed back unchanged in round 2, thinking blocks included.
        rawAssistantBlocks: finalMessage.content,
    };
};

/**
 * Maps a single ChatTurn to the content Anthropic expects. Prior turns are
 * always plain text (images aren't persisted — see ChatTurn.image doc
 * comment); only the newest user turn may carry an image, in which case it's
 * sent as an image block + (optional) text block instead of a bare string.
 * Exported as a pure function so the multimodal mapping is unit-testable
 * without going through the SDK.
 */
export const chatTurnContent = (m: ChatTurn): Anthropic.MessageParam['content'] => {
    if (!m.image) {
        return m.content;
    }
    return m.content
        ? [imageContentBlock(m.image), { type: 'text', text: m.content }]
        : [imageContentBlock(m.image)];
};

// Builds a plain-text confirmation when round 2 (the model's own "here's your
// deck!" reply) fails after a tool call already succeeded — see the call site
// in chat() for why we must not throw in that case. Deliberately provider-
// agnostic about the exact attachment shape (this file doesn't import
// ChatAttachment - see the header comment), so it duck-types the fields it
// needs and falls back to a generic line if they're missing.
const fallbackToolConfirmation = (toolName: string, data: unknown): string => {
    const d = data as {
        title?: unknown;
        cardCount?: unknown;
        action?: unknown;
        addedCount?: unknown;
    };
    if (toolName === 'add_cards' && typeof d.addedCount === 'number') {
        return `Added ${d.addedCount} card${d.addedCount === 1 ? '' : 's'}.`;
    }
    if (typeof d.title === 'string' && typeof d.cardCount === 'number') {
        return `Created "${d.title}" with ${d.cardCount} card${d.cardCount === 1 ? '' : 's'}.`;
    }
    return 'Done.';
};

const chat = async (
    input: {
        messages: ChatTurn[];
        systemPrompt: string;
        maxOutputTokens: number;
        tools?: ChatToolsConfig;
    },
    opts?: { onEvent?: (event: ChatStreamEvent) => void; signal?: AbortSignal },
): Promise<ChatResult> => {
    if (input.messages.length === 0) {
        throw new AiValidationFailedError('chat requires at least one message');
    }

    const initialMessages: Anthropic.MessageParam[] = input.messages.map((m) => ({
        role: m.role,
        content: chatTurnContent(m),
    }));

    const round1 = await runChatRound({
        op: 'chat_round1',
        messages: initialMessages,
        system: input.systemPrompt,
        maxOutputTokens: input.maxOutputTokens,
        ...(input.tools ? { tools: input.tools } : {}),
        ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    // No tool call → behaves exactly like the pre-tool chat: stream text,
    // emit done, return content.
    if (!round1.toolUse || !input.tools) {
        const meta = {
            tokensInput: round1.tokensInput,
            tokensOutput: round1.tokensOutput,
        };
        opts?.onEvent?.({ type: 'done', meta } satisfies ChatStreamEvent);
        return {
            content: round1.content,
            tokensInput: round1.tokensInput,
            tokensOutput: round1.tokensOutput,
        };
    }

    // Tool call path: dispatch, wrap the result as a tool_result block, then
    // run round 2 (no tools — we don't support chains in MVP).
    const call: ChatToolCall = {
        name: round1.toolUse.name,
        input: round1.toolUse.input,
    };
    opts?.onEvent?.({ type: 'tool_use', call } satisfies ChatStreamEvent);

    let outcome: ChatToolOutcome;
    try {
        outcome = await input.tools.run(call);
    } catch (err) {
        // Defensive: tool handler isn't supposed to throw, but if it does
        // make sure the model still gets a tool_result so the conversation
        // doesn't dangle.
        outcome = {
            ok: false,
            data: { reason: 'INTERNAL' },
            resultJson: JSON.stringify({
                ok: false,
                reason: 'INTERNAL',
                message: (err as Error).message,
            }),
        };
    }

    opts?.onEvent?.({
        type: 'tool_result',
        name: call.name,
        ok: outcome.ok,
        data: outcome.data,
    } satisfies ChatStreamEvent);

    const round2Messages: Anthropic.MessageParam[] = [
        ...initialMessages,
        { role: 'assistant', content: round1.rawAssistantBlocks as Anthropic.ContentBlockParam[] },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: round1.toolUse.id,
                    content: outcome.resultJson,
                    ...(outcome.ok ? {} : { is_error: true }),
                },
            ],
        },
    ];

    // If the tool already ran successfully, its write is done and cannot be
    // un-done — but round 2 (the closing "here's your deck!" text) is just a
    // description of that write, generated with no further side effects. If
    // it fails (provider timeout/network blip), don't throw and force the
    // caller to retry: retrying resends the same user turn, the model calls
    // create_deck again, and a second (or third) deck gets created for what
    // the user experiences as one request (BUG-0824-08). Fall back to a
    // canned confirmation built from the tool's own result instead, so the
    // turn still completes successfully and nothing needs re-running.
    let round2: { content: string; tokensInput: number; tokensOutput: number };
    try {
        round2 = await runChatRound({
            op: 'chat_round2',
            messages: round2Messages,
            system: input.systemPrompt,
            maxOutputTokens: input.maxOutputTokens,
            // Same tools as round 1 but none may be called: round 2 is
            // strictly the final text reply. Dropping them instead would edit
            // the request under round 1's thinking blocks, which newer models
            // reject (or silently drop) as a history edit.
            tools: input.tools,
            toolChoice: 'none',
            ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
    } catch (err) {
        if (!outcome.ok) {
            throw err;
        } // nothing was written — safe to propagate and retry
        const fallback = fallbackToolConfirmation(call.name, outcome.data);
        opts?.onEvent?.({ type: 'token', delta: fallback } satisfies ChatStreamEvent);
        round2 = { content: fallback, tokensInput: 0, tokensOutput: 0 };
    }

    const tokensInput = round1.tokensInput + round2.tokensInput;
    const tokensOutput = round1.tokensOutput + round2.tokensOutput;
    const meta = { tokensInput, tokensOutput };
    opts?.onEvent?.({ type: 'done', meta } satisfies ChatStreamEvent);

    return {
        // Round-2 ONLY. Round-1 is the pre-tool turn; any text there is a neutral
        // preamble, never a result. The authoritative answer is generated in
        // round 2 with the tool_result in context, so it reflects the real
        // outcome (success or failure) — never a confirmation without a write.
        content: round2.content,
        tokensInput,
        tokensOutput,
        ...(outcome.ok ? { attachments: [outcome.data] } : {}),
    };
};

export const anthropicProvider: AiProvider = {
    name: 'anthropic',
    enrichWords,
    generateDeck,
    deckFromImage,
    suggest,
    chat,
};
