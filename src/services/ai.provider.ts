/**
 * AI provider abstraction. The MVP ships a deterministic mock; switching to a
 * real LLM (Anthropic / OpenAI / Gemini) is a matter of writing one adapter
 * that satisfies this interface and wiring it via env.AI_PROVIDER.
 *
 * Selection logic lives in ai.service.ts.
 */
import type { GenerateDeckInput, SuggestInput } from '../schemas/ai.schema.js';

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

export type AiProvider = {
    name: string;     // 'mock' | 'anthropic' | …
    generateDeck: (input: GenerateDeckInput) => Promise<AiDeckDraft>;
    suggest: (
        input: { context: SuggestContext; deckId?: string; dueCount: number; streak: number },
    ) => Promise<AiSuggestion>;
};
