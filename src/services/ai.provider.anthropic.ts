/**
 * Anthropic Claude adapter for AiProvider. Uses tool_choice to force the
 * model to emit structured JSON for each operation — more reliable than
 * "return JSON in prose" prompting.
 *
 * Non-streaming implementations live here; SSE streaming is layered on top
 * via the streaming entry points in ai.service.ts.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
    AiCardDraft,
    AiDeckDraft,
    AiProvider,
    AiSuggestion,
    ChatResult,
    ChatStreamEvent,
    ChatToolCall,
    ChatToolOutcome,
    ChatToolsConfig,
    ChatTurn,
    EnrichWordsEvent,
    EnrichWordsResult,
    GenerateDeckEvent,
    SuggestContext,
} from './ai.provider.js';
import type {
    EnrichWordsInput,
    GenerateDeckInput,
} from '../schemas/ai.schema.js';
import { env } from '../config/env.js';
import {
    AiProviderError,
    AiValidationFailedError,
} from '../shared/errors.js';
import {
    buildEnrichWordsPrompt,
    buildGenerateDeckPrompt,
    buildSuggestPrompt,
} from './ai.prompts.js';

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
        if (cached) return cached;
        if (!env.ANTHROPIC_API_KEY) {
            // Should never happen — env.ts refines this when AI_PROVIDER=anthropic.
            throw new AiProviderError(500, 'ANTHROPIC_API_KEY is not configured');
        }
        cached = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        return cached;
    };
})();

/** Run an Anthropic call and pull the forced tool's input out of the response. */
const callToolUse = async <T>(args: {
    system: ReturnType<typeof buildEnrichWordsPrompt>['system'];
    user: string;
    toolName: string;
    tool: typeof ENRICH_TOOL | typeof DECK_TOOL | typeof SUGGEST_TOOL;
    maxTokens: number;
}): Promise<{ data: T; tokensInput: number; tokensOutput: number }> => {
    let response;
    try {
        response = await client().messages.create({
            model: env.ANTHROPIC_MODEL,
            max_tokens: args.maxTokens,
            system: args.system,
            messages: [{ role: 'user', content: args.user }],
            tools: [args.tool],
            tool_choice: { type: 'tool', name: args.toolName },
        });
    } catch (err) {
        const status =
            err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
        throw new AiProviderError(status, (err as Error).message);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
        throw new AiValidationFailedError('Provider returned no tool_use block');
    }
    return {
        data: toolBlock.input as T,
        tokensInput: response.usage.input_tokens,
        tokensOutput: response.usage.output_tokens,
    };
};

/** Run a tool-use call once; on validation failure, retry once with a clarifying prompt. */
const callWithRetry = async <T>(
    args: Parameters<typeof callToolUse>[0],
    validate: (data: T) => boolean,
) => {
    const first = await callToolUse<T>(args);
    if (validate(first.data)) return first;
    const second = await callToolUse<T>({
        ...args,
        user: `${args.user}\n\nRetry: your previous output failed schema validation. Return only the tool call, fully populated.`,
    });
    if (validate(second.data)) return second;
    throw new AiValidationFailedError();
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

export const alignByInputOrder = (
    requested: string[],
    received: AiCardDraft[],
): AiCardDraft[] => {
    const byKey = new Map(received.map((c) => [c.word.trim().toLowerCase(), c]));
    return requested.map((word) => {
        const card = byKey.get(word.trim().toLowerCase());
        if (card) return { ...card, word };
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
    if (!snapshot || typeof snapshot !== 'object') return null;
    const arr = (snapshot as Record<string, unknown>)[arrayKey];
    return Array.isArray(arr) ? (arr as T[]) : null;
};

const enrichWords = async (
    input: EnrichWordsInput,
    opts?: { onCard?: (event: EnrichWordsEvent) => void },
): Promise<EnrichWordsResult> => {
    const start = Date.now();
    const { system, user } = buildEnrichWordsPrompt(input);
    const maxTokens = Math.min(8000, Math.max(1000, input.words.length * 200));

    // Non-streaming fast path: caller doesn't want incremental events.
    if (!opts?.onCard) {
        const { data, tokensInput, tokensOutput } = await callWithRetry<{
            cards: AiCardDraft[];
        }>(
            {
                system,
                user,
                toolName: ENRICH_TOOL.name,
                tool: ENRICH_TOOL,
                maxTokens,
            },
            isValidCardArray,
        );
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

    // Streaming path.
    let received: AiCardDraft[] = [];
    let emittedCount = 0;
    let tokensInput = 0;
    let tokensOutput = 0;

    try {
        const stream = client().messages.stream({
            model: env.ANTHROPIC_MODEL,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
            tools: [ENRICH_TOOL],
            tool_choice: { type: 'tool', name: ENRICH_TOOL.name },
        });

        stream.on('inputJson', (_delta, snapshot) => {
            const arr = arrayFromSnapshot<AiCardDraft>(snapshot, 'cards');
            if (!arr) return;
            // Only emit cards we haven't yet AND whose definition has fully
            // arrived. The last item in the snapshot may be partial.
            const completeUpToExclusive = arr.length - 1;
            for (let i = emittedCount; i < completeUpToExclusive; i++) {
                const card = arr[i]!;
                if (typeof card.word === 'string' && typeof card.definition === 'string') {
                    opts.onCard!({ type: 'card', position: i, card });
                    emittedCount = i + 1;
                }
            }
        });

        const finalMessage = await stream.finalMessage();
        tokensInput = finalMessage.usage.input_tokens;
        tokensOutput = finalMessage.usage.output_tokens;

        const toolBlock = finalMessage.content.find((b) => b.type === 'tool_use');
        if (toolBlock?.type === 'tool_use') {
            received = (toolBlock.input as { cards?: AiCardDraft[] }).cards ?? [];
        }
    } catch (err) {
        const status =
            err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
        throw new AiProviderError(status, (err as Error).message);
    }

    // Emit any trailing card the snapshot parser hadn't confirmed.
    for (let i = emittedCount; i < received.length; i++) {
        opts.onCard({ type: 'card', position: i, card: received[i]! });
    }

    const cards = alignByInputOrder(input.words, received);
    const enriched = cards.filter((c) => c.definition !== '').length;
    const meta = {
        requested: input.words.length,
        enriched,
        durationMs: Date.now() - start,
        tokensInput,
        tokensOutput,
    };
    opts.onCard({ type: 'done', meta });
    return { cards, meta };
};

// ---------- generateDeck ----------

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
    const maxTokens = Math.min(8000, 1500 + (input.count ?? 8) * 250);

    if (!opts?.onEvent) {
        const { data } = await callWithRetry<AiDeckDraft>(
            {
                system,
                user,
                toolName: DECK_TOOL.name,
                tool: DECK_TOOL,
                maxTokens,
            },
            isValidDeckDraft,
        );
        return data;
    }

    let emittedHeader = false;
    let emittedCardCount = 0;
    let finalData: AiDeckDraft | null = null;
    let tokensInput = 0;
    let tokensOutput = 0;

    try {
        const stream = client().messages.stream({
            model: env.ANTHROPIC_MODEL,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
            tools: [DECK_TOOL],
            tool_choice: { type: 'tool', name: DECK_TOOL.name },
        });

        stream.on('inputJson', (_delta, snapshot) => {
            if (!snapshot || typeof snapshot !== 'object') return;
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
                opts.onEvent!({ type: 'header', deck: header });
                emittedHeader = true;
            }
            if (Array.isArray(parsed.cards)) {
                const complete = parsed.cards.length - 1;
                for (let i = emittedCardCount; i < complete; i++) {
                    const c = parsed.cards[i]!;
                    if (typeof c.word === 'string' && typeof c.definition === 'string') {
                        opts.onEvent!({ type: 'card', position: i, card: c });
                        emittedCardCount = i + 1;
                    }
                }
            }
        });

        const finalMessage = await stream.finalMessage();
        tokensInput = finalMessage.usage.input_tokens;
        tokensOutput = finalMessage.usage.output_tokens;
        const toolBlock = finalMessage.content.find((b) => b.type === 'tool_use');
        if (toolBlock?.type === 'tool_use') {
            finalData = toolBlock.input as AiDeckDraft;
        }
    } catch (err) {
        const status =
            err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
        throw new AiProviderError(status, (err as Error).message);
    }

    if (!finalData || !isValidDeckDraft(finalData)) {
        throw new AiValidationFailedError();
    }
    // Drain any trailing cards.
    for (let i = emittedCardCount; i < finalData.cards.length; i++) {
        opts.onEvent({ type: 'card', position: i, card: finalData.cards[i]! });
    }
    opts.onEvent({
        type: 'done',
        meta: { durationMs: Date.now() - start, tokensInput, tokensOutput },
    });
    return finalData;
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
    const { data } = await callWithRetry<AiSuggestion>(
        {
            system,
            user,
            toolName: SUGGEST_TOOL.name,
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
    onEvent?: (event: ChatStreamEvent) => void;
    signal?: AbortSignal;
}): Promise<{
    content: string;
    tokensInput: number;
    tokensOutput: number;
    toolUse: ToolUseBlock | null;
    rawAssistantBlocks: Anthropic.ContentBlock[];
}> => {
    let buffer = '';
    try {
        const stream = client().messages.stream({
            model: env.ANTHROPIC_MODEL,
            max_tokens: params.maxOutputTokens,
            system: params.system,
            messages: params.messages,
            ...(params.tools
                ? {
                      tools: params.tools.defs as unknown as Anthropic.Tool[],
                      // 'auto' = model decides. Plain chat keeps working when
                      // the user isn't asking for a deck.
                      tool_choice: { type: 'auto' as const },
                  }
                : {}),
        });

        if (params.signal) {
            params.signal.addEventListener('abort', () => stream.abort(), { once: true });
        }

        stream.on('text', (delta) => {
            buffer += delta;
            params.onEvent?.({ type: 'token', delta } satisfies ChatStreamEvent);
        });

        const finalMessage = await stream.finalMessage();
        const toolBlock = finalMessage.content.find(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
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
            rawAssistantBlocks: finalMessage.content,
        };
    } catch (err) {
        const status =
            err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
        throw new AiProviderError(status, (err as Error).message);
    }
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
        content: m.content,
    }));

    const round1 = await runChatRound({
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
            resultJson: JSON.stringify({ ok: false, reason: 'INTERNAL', message: (err as Error).message }),
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

    const round2 = await runChatRound({
        messages: round2Messages,
        system: input.systemPrompt,
        maxOutputTokens: input.maxOutputTokens,
        // No tools on round 2 — keep it strictly the final text reply.
        ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
    });

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
    suggest,
    chat,
};
