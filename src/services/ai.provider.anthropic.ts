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
    EnrichWordsResult,
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

const alignByInputOrder = (
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

const enrichWords = async (input: EnrichWordsInput): Promise<EnrichWordsResult> => {
    const start = Date.now();
    const { system, user } = buildEnrichWordsPrompt(input);

    const { data, tokensInput, tokensOutput } = await callWithRetry<{
        cards: AiCardDraft[];
    }>(
        {
            system,
            user,
            toolName: ENRICH_TOOL.name,
            tool: ENRICH_TOOL,
            // Generous: ~200 tokens per card output + headroom.
            maxTokens: Math.min(8000, Math.max(1000, input.words.length * 200)),
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
};

// ---------- generateDeck ----------

const isValidDeckDraft = (data: Partial<AiDeckDraft>): boolean =>
    typeof data.title === 'string' &&
    typeof data.description === 'string' &&
    typeof data.sourceLanguage === 'string' &&
    typeof data.targetLanguage === 'string' &&
    Array.isArray(data.cards) &&
    data.cards.length > 0;

const generateDeck = async (input: GenerateDeckInput): Promise<AiDeckDraft> => {
    const { system, user } = buildGenerateDeckPrompt(input);
    const { data } = await callWithRetry<AiDeckDraft>(
        {
            system,
            user,
            toolName: DECK_TOOL.name,
            tool: DECK_TOOL,
            maxTokens: Math.min(8000, 1500 + (input.count ?? 8) * 250),
        },
        isValidDeckDraft,
    );
    return data;
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

export const anthropicProvider: AiProvider = {
    name: 'anthropic',
    enrichWords,
    generateDeck,
    suggest,
};
