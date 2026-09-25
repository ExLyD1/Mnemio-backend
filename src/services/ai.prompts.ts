/**
 * Prompt builders for the Anthropic provider. Each builder returns:
 *   - `system`: cacheable text wrapped in Anthropic's `cache_control` block
 *   - `user`:   the per-request user message
 *
 * Keeping prompts here (vs inline in the adapter) makes them easy to A/B
 * tune without touching the SDK plumbing.
 */
import type {
    DeckFromImageInput,
    EnrichWordsInput,
    GenerateDeckInput,
} from '../schemas/ai.schema.js';
import type { SuggestContext } from './ai.provider.js';
import { langDisplayName, normalizeLang } from '../shared/lang.js';

// Bare ISO codes are ambiguous to the model — "uk" in particular reads as
// "United Kingdom" (i.e. English), which produced English definitions on
// decks meant for Ukrainian speakers. Always name the language in full and
// keep the code alongside it: "Ukrainian (uk)".
export const promptLang = (raw: string): string => {
    const code = normalizeLang(raw);
    if (!code) {
        return raw;
    }
    const name = langDisplayName(code);
    return name === code ? code : `${name} (${code})`;
};

// Card content is what the user actually studies, so the writing rules are
// shared by every generator. Two kinds of rule live here:
//
//  - STYLE_RULES keep decks consistent with each other. QA found one deck's
//    definitions capitalized with a full stop and the next deck's lowercase
//    without, and definitions that opened by restating the headword
//    ("Груша — …"), which gives the answer away on a flashcard.
//
//  - qualityRules(lang) adds per-language rules. Ukrainian earns its own set:
//    generated cards came back with Russian words and broken agreement
//    («млекопитаюче», «с гострими кігтями», «хобіт», «щокранку»), which is
//    exactly the material Ukrainian learners are paying to study.
const STYLE_RULES = `
Writing style (applies to every card):
- definition: a short gloss, sentence case, NO trailing period. Never begin
  with the word being defined or a dash restating it — the learner is trying
  to recall that word.
- example: one complete sentence with normal capitalization and final
  punctuation.
- exampleTranslation: a natural sentence in the definition language, not a
  word-for-word calque.
- Keep register and length consistent across all cards in one response.`.trim();

const UKRAINIAN_RULES = `
Ukrainian quality (CRITICAL — the text below is studied as-is):
- Write modern standard Ukrainian. The letters ы, э, ъ, ё do not exist in
  Ukrainian; never emit them.
- Never use a Russian word where a Ukrainian one exists. Wrong → right:
  «млекопитаюче» → «ссавець»; «с гострими кігтями» → «з гострими кігтями»;
  «хобіт» → «хобот»; «щокранку» → «щоранку»; «растає» → «росте»;
  «Киві» → «ківі»; «карточка» → «картка»; «слідуючий» → «наступний».
- Agree gender, number and case correctly: «мала пухнаста тварина», not
  «мала пухнаста млекопитаюче».
- Use natural Ukrainian word order and idiom — never a word-for-word calque
  from English or Russian.
- If you are unsure a word is standard Ukrainian, choose a simpler word you
  are sure of.`.trim();

export const qualityRules = (...langs: (string | undefined)[]): string => {
    const codes = langs.map((l) => (l ? normalizeLang(l) : null));
    const rules = [STYLE_RULES];
    if (codes.includes('uk')) {
        rules.push(UKRAINIAN_RULES);
    }
    return rules.join('\n\n');
};

const CACHEABLE = { type: 'ephemeral' as const };

export type CacheableSystem = Array<{
    type: 'text';
    text: string;
    cache_control?: typeof CACHEABLE;
}>;

const enrichSystem = (rawSource: string, rawTarget: string): string => {
    const sourceLanguage = promptLang(rawSource);
    const targetLanguage = promptLang(rawTarget);
    return `
You are a dictionary assistant for Mnemio, a vocabulary-learning app.

Your job: given a list of words written in ${targetLanguage}, output one
short, learner-friendly entry per word, translated into ${sourceLanguage}.
Each input word is the ${targetLanguage} word being learned: keep it exactly
as given — never translate, replace, or re-spell it.

For each input word, fill these fields:
- definition (REQUIRED, written in ${sourceLanguage}, 1 sentence, <= 120 chars)
- phonetic (IPA or pronunciation guide, optional; for Japanese, Chinese or
  Korean give the reading — kana, pinyin with tones, or romanization)
- partOfSpeech (e.g. "noun", "verb"; optional)
- example (one short sentence in ${targetLanguage}, <= 100 chars — include it
  for every word you can)
- exampleTranslation (REQUIRED whenever you give an example: that example
  translated into ${sourceLanguage})
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

The definition and exampleTranslation MUST be in ${sourceLanguage}, never in
${targetLanguage} (unless the two are the same language).

${qualityRules(rawSource, rawTarget)}

Call the emit_cards tool exactly once with all entries.
`.trim();
};

export const buildEnrichWordsPrompt = (input: EnrichWordsInput) => {
    const system: CacheableSystem = [
        {
            type: 'text',
            text: enrichSystem(input.sourceLanguage, input.targetLanguage),
            cache_control: CACHEABLE,
        },
    ];

    const numbered = input.words.map((w, i) => `${i + 1}. ${w}`).join('\n');

    const user = [
        input.context ? `Context: ${input.context}\n` : '',
        `Words (${input.words.length}, in ${promptLang(input.targetLanguage)}):\n${numbered}`,
    ].join('');

    return { system, user };
};

const generateDeckSystem = (rawSource: string, rawTarget: string): string =>
    `
You are a vocabulary-deck designer for Mnemio.

Your job: given a topic + a source language and target language, output a
study-ready deck with title, description, subject ("languages" if vocab,
else the field), an optional 1-glyph emoji, and N high-quality cards.

Each card has the same fields as enrich (definition is required;
phonetic / partOfSpeech / tags / difficulty optional). Give every card an
example sentence in the target language plus its exampleTranslation into the
source language whenever you can — learners rely on both.

Languages — never swap them:
- word and example: in the TARGET language, in its standard script and
  spelling (e.g. Japanese in Japanese script, German nouns capitalized).
- definition and exampleTranslation: in the SOURCE language.
- phonetic: for Japanese, Chinese or Korean give the reading (kana, pinyin
  with tones, or romanization).
Echo the given language codes unchanged in the deck's sourceLanguage and
targetLanguage fields.

If the topic names or implies a specific set of items (e.g. "names of X",
"the capitals of Y", a species/category the caller clearly means to
enumerate), the cards MUST be those actual items — do not substitute generic
themed vocabulary instead of the real entities the topic asks for. Only fall
back to generic learner vocabulary around the topic when the topic is
genuinely open-ended and does not name a specific set. Avoid duplicates and
trivial synonyms. Order from easier to harder.

${qualityRules(rawSource, rawTarget)}

Call the emit_deck tool exactly once.
`.trim();

export const buildGenerateDeckPrompt = (input: GenerateDeckInput) => {
    const system: CacheableSystem = [
        {
            type: 'text',
            text: generateDeckSystem(input.sourceLanguage, input.targetLanguage),
            cache_control: CACHEABLE,
        },
    ];
    const count = input.count ?? 8;
    const lines = [
        `Topic: ${input.topic}`,
        `Source language (for definitions/translations): ${promptLang(input.sourceLanguage)}`,
        `Target language (for the words being learned): ${promptLang(input.targetLanguage)}`,
        `Number of cards: ${count}`,
    ];
    // Appending to a deck: the model can't see what's already in it, so it
    // happily regenerates words the learner already has.
    if (input.exclude && input.exclude.length > 0) {
        lines.push(
            `Already in this deck — do NOT repeat any of these, pick different words: ${input.exclude
                .slice(0, 200)
                .join(', ')}`,
        );
    }
    return { system, user: lines.join('\n') };
};

const deckFromImageSystem = (
    rawSource: string,
    rawTarget?: string,
): string => {
    const sourceLanguage = promptLang(rawSource);
    const targetLanguage = rawTarget ? promptLang(rawTarget) : undefined;
    return `
You are a vocabulary-deck designer for Mnemio, working from a single image —
a photo of a page, a screenshot of an article, or a video subtitle frame.

Your job: read the image, ${targetLanguage ? `the text is in ${targetLanguage}` : 'detect the language of the text in it'},
and extract words genuinely worth learning — skip purely functional words
(articles, basic pronouns) and words that are trivially easy.

For each selected word, fill the same fields as enrich (definition REQUIRED,
in ${sourceLanguage}, <= 120 chars; phonetic / partOfSpeech / example /
exampleTranslation / tags / difficulty optional).

CRITICAL rules:
- Only include words that are ACTUALLY PRESENT in the image. Never invent,
  guess, or add words that aren't there — a fabricated word breaks the
  user's trust in the feature.
- Wherever possible, set "example" to the exact sentence the word appeared
  in on the image (not a made-up sentence), and "exampleTranslation" to that
  sentence translated into ${sourceLanguage}.
- Do not transcribe handwriting or blurry/illegible text you're not
  confident about — skip a word rather than guess at it.
- If the image has no readable text, or no text in a learnable language,
  set title/description to explain that plainly and return an EMPTY cards
  array. Do not fabricate cards to fill the deck.

Also produce: title, description, subject ("languages"), and an optional
1-glyph emoji. Set targetLanguage to the ISO 639-1 code of the words' language
(e.g. "de", not "German") and sourceLanguage to the ISO 639-1 code of the
definitions' language.

${qualityRules(rawSource, rawTarget)}

Call the emit_deck tool exactly once.
`.trim();
};

export const buildDeckFromImagePrompt = (input: DeckFromImageInput) => {
    const system: CacheableSystem = [
        {
            type: 'text',
            text: deckFromImageSystem(input.sourceLanguage, input.targetLanguage),
            cache_control: CACHEABLE,
        },
    ];
    const count = input.count ?? 8;
    const lines = [
        `Source language (for definitions/translations): ${promptLang(input.sourceLanguage)}`,
        input.targetLanguage
            ? `Target language (the words being learned): ${promptLang(input.targetLanguage)}`
            : 'Target language: detect it from the text in the image.',
        `Aim for up to ${count} cards — fewer is fine if the image genuinely doesn't have that many good words.`,
    ];
    if (input.instructions) {
        lines.push(`Additional instructions: ${input.instructions}`);
    }
    return { system, user: lines.join('\n') };
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
