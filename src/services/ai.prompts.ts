/**
 * Prompt builders for the Anthropic provider. Each builder returns:
 *   - `system`: cacheable text wrapped in Anthropic's `cache_control` block
 *   - `user`:   the per-request user message
 *
 * Keeping prompts here (vs inline in the adapter) makes them easy to A/B
 * tune without touching the SDK plumbing.
 */
import type { EnrichWordsInput, GenerateDeckInput } from '../schemas/ai.schema.js';
import type { SuggestContext } from './ai.provider.js';

const CACHEABLE = { type: 'ephemeral' as const };

export type CacheableSystem = Array<{
    type: 'text';
    text: string;
    cache_control?: typeof CACHEABLE;
}>;

const enrichSystem = (sourceLanguage: string, targetLanguage: string): string => `
You are a dictionary assistant for Mnemio, a vocabulary-learning app.

Your job: given a list of words written in ${targetLanguage}, output one
short, learner-friendly entry per word, translated into ${sourceLanguage}.

For each input word, fill these fields:
- definition (REQUIRED, ${sourceLanguage}, 1 sentence, <= 120 chars)
- phonetic (IPA or pronunciation guide, optional)
- partOfSpeech (e.g. "noun", "verb"; optional)
- example (one short sentence in ${targetLanguage}, optional, <= 100 chars)
- exampleTranslation (the example translated to ${sourceLanguage}, optional)
- tags (1-3 thematic tags, optional)
- difficulty ("easy" | "medium" | "hard", optional)

Rules:
- Preserve the input order exactly. Item N in your output corresponds to
  item N in the input.
- Always return one entry per input word, even if you're unsure. If you
  truly can't define a word, return definition: "" and tags: ["ai-unfilled"].
- Do not invent or merge words. If the user pasted a misspelling, still
  produce an entry — just mark it ai-unfilled if unknowable.
- Use neutral, learner-appropriate phrasing. No slang, no emoji.
- If a word may be a slur or otherwise blocked content, return definition: ""
  and tags: ["ai-blocked"].

Call the emit_cards tool exactly once with all entries.
`.trim();

export const buildEnrichWordsPrompt = (input: EnrichWordsInput) => {
    const system: CacheableSystem = [
        {
            type: 'text',
            text: enrichSystem(input.sourceLanguage, input.targetLanguage),
            cache_control: CACHEABLE,
        },
    ];

    const numbered = input.words
        .map((w, i) => `${i + 1}. ${w}`)
        .join('\n');

    const user = [
        input.context ? `Context: ${input.context}\n` : '',
        `Words (${input.words.length}, in ${input.targetLanguage}):\n${numbered}`,
    ].join('');

    return { system, user };
};

const generateDeckSystem = `
You are a vocabulary-deck designer for Mnemio.

Your job: given a topic + a source language and target language, output a
study-ready deck with title, description, subject ("languages" if vocab,
else the field), an optional 1-glyph emoji, and N high-quality cards.

Each card has the same fields as enrich (definition is required; phonetic /
partOfSpeech / example / exampleTranslation / tags / difficulty optional).

Pick words that are useful for a learner around the requested topic. Avoid
duplicates and trivial synonyms. Order from easier to harder.

Call the emit_deck tool exactly once.
`.trim();

export const buildGenerateDeckPrompt = (input: GenerateDeckInput) => {
    const system: CacheableSystem = [
        { type: 'text', text: generateDeckSystem, cache_control: CACHEABLE },
    ];
    const count = input.count ?? 8;
    const user = `Topic: ${input.topic}
Source language (for definitions/translations): ${input.sourceLanguage}
Target language (for the words being learned): ${input.targetLanguage}
Number of cards: ${count}`;
    return { system, user };
};

const suggestSystem = `
You are Mimi, the friendly study coach inside Mnemio.

Output ONE short suggestion (1-2 sentences, conversational, <= 160 chars)
plus a kind ('tip' | 'deck' | 'review') and 0-2 CTA actions
(each action = { label, href }; href is a relative FE path).

Call the emit_suggestion tool exactly once.
`.trim();

export const buildSuggestPrompt = (input: {
    context: SuggestContext;
    deckId?: string;
    dueCount: number;
    streak: number;
}) => {
    const system: CacheableSystem = [
        { type: 'text', text: suggestSystem, cache_control: CACHEABLE },
    ];
    const user = `Context: ${input.context}
User state: ${input.dueCount} cards due, ${input.streak}-day streak.${input.deckId ? `\nDeck in focus: ${input.deckId}` : ''}`;
    return { system, user };
};
