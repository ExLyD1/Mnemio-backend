/**
 * AI provider abstraction. The MVP ships a deterministic mock; switching to a
 * real LLM (Anthropic / OpenAI / Gemini) is a matter of writing one adapter
 * that satisfies this interface and wiring it via env.AI_PROVIDER.
 *
 * Selection logic lives in ai.service.ts.
 */
import type { EnrichWordsInput, GenerateDeckInput, SuggestInput } from '../schemas/ai.schema.js';

export type AiCardDraft = {
    word: string;
    definition: string;
    phonetic?: string;
    partOfSpeech?: string;
    example?: string;
    exampleTranslation?: string;
    tags?: string[];
    difficulty?: 'easy' | 'medium' | 'hard';
};

export type EnrichWordsMeta = {
    requested: number;
    enriched: number;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
};

export type EnrichWordsResult = {
    cards: AiCardDraft[];
    meta: EnrichWordsMeta;
};

// Per-card event the streaming variant emits as the LLM produces output.
// `position` matches the index in the request's `words[]` array.
export type EnrichWordsEvent =
    | { type: 'card'; position: number; card: AiCardDraft }
    | { type: 'done'; meta: EnrichWordsMeta };

export type GenerateDeckMeta = {
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
};

// Streaming event for generate-deck. `header` arrives first (title etc.),
// then one `card` event per generated card, then `done`.
export type GenerateDeckEvent =
    | {
          type: 'header';
          deck: Omit<AiDeckDraft, 'cards'>;
      }
    | { type: 'card'; position: number; card: AiCardDraft }
    | { type: 'done'; meta: GenerateDeckMeta };

export type AiDeckDraft = {
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    subject?: string;
    glyph?: string;
    cards: AiCardDraft[];
};

export type AiSuggestionAction = {
    label: string;
    href: string;     // relative FE path
};

export type AiSuggestion = {
    suggestion: string;
    kind: 'tip' | 'deck' | 'review';
    actions: AiSuggestionAction[];
};

export type SuggestContext = SuggestInput['context'];

// ---------- Chat ----------

export type ChatRole = 'user' | 'assistant';

// A single conversational turn. System prompts are kept separate (passed as
// `systemPrompt` on the input) so providers can hand them to the API's
// dedicated `system` field instead of stuffing them in the message array.
export type ChatTurn = { role: ChatRole; content: string };

export type ChatDoneMeta = {
    tokensInput: number;
    tokensOutput: number;
};

export type ChatStreamEvent =
    | { type: 'token'; delta: string }
    | { type: 'done'; meta: ChatDoneMeta };

export type ChatResult = {
    content: string;
    tokensInput: number;
    tokensOutput: number;
};

export type AiProvider = {
    name: string;     // 'mock' | 'anthropic' | …

    /**
     * Enrich a user-supplied word list. Implementations MUST preserve the
     * input order: `result.cards[i].word` corresponds to
     * `input.words[i]` (after de-dup, which is done in the service layer).
     *
     * Implementations MAY emit per-card events via `onCard` as soon as each
     * card is parsed from the streaming LLM output; non-streaming
     * implementations can omit it.
     */
    enrichWords: (
        input: EnrichWordsInput,
        opts?: { onCard?: (event: EnrichWordsEvent) => void },
    ) => Promise<EnrichWordsResult>;

    generateDeck: (
        input: GenerateDeckInput,
        opts?: { onEvent?: (event: GenerateDeckEvent) => void },
    ) => Promise<AiDeckDraft>;
    suggest: (
        input: { context: SuggestContext; deckId?: string; dueCount: number; streak: number },
    ) => Promise<AiSuggestion>;

    /**
     * Stream a multi-turn chat reply. `messages` is the full conversation in
     * chronological order; `systemPrompt` is the persona/scope wrapper (no
     * grounding at MVP — see chat.prompt.ts).
     *
     * Implementations MUST forward each text chunk as `{ type: 'token', delta }`
     * via `onEvent` (when provided) and emit one final `{ type: 'done', meta }`
     * with the usage counts.
     */
    chat: (
        input: { messages: ChatTurn[]; systemPrompt: string; maxOutputTokens: number },
        opts?: { onEvent?: (event: ChatStreamEvent) => void; signal?: AbortSignal },
    ) => Promise<ChatResult>;
};
