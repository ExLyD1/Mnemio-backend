// Tools the chat model can call during a conversation. Single registry today
// (`create_deck`); shape is designed so adding more is a one-entry append.
//
// Each tool exposes:
//   - `definition` — what Anthropic sees (name, description, input_schema)
//   - `run`        — the actual handler the backend executes when the model
//                    emits a tool_use block
//
// The handler returns `ToolResult`. On success we forward the attachment to
// the assistant message; on failure we send the reason to the model as a
// tool_result so it can apologise rather than 500-ing the request.

import * as aiService from './ai.service.js';
import * as decksService from './decks.service.js';
import * as cardsService from './cards.service.js';
import * as decksRepo from '../repositories/decks.repository.js';
import type { AiCardDraft } from './ai.provider.js';
import type { ChatAttachment } from '../shared/mappers.chat.js';
import { AppError } from '../shared/errors.js';
import type { CreateCardInput } from '../schemas/card.schema.js';
import { langDisplayName, normalizeLang } from '../shared/lang.js';

// ---------- Public types ----------

// The model sees `wordsLanguage`/`definitionsLanguage` — the DB's
// `targetLanguage`/`sourceLanguage` read backwards to it ("source" sounds like
// the original words, but it's the definitions' language).
export type CreateDeckToolInput = {
    topic?: string;
    words?: string[];
    title?: string;
    wordsLanguage?: string;
    definitionsLanguage?: string;
    count?: number;
};

// The user's profile languages, normalized to supported codes. Loaded once
// per chat turn by chat.service and shared by the prompt and the tools.
export type UserLanguages = {
    native: string | null;
    learning: string[];
};

// add_cards targets the deck the user is viewing — the backend supplies the
// deckId and the deck's languages, so the model only chooses the content.
export type AddCardsToolInput = {
    topic?: string;
    words?: string[];
    count?: number;
};

export type ToolResult =
    // `words` is the final, persisted card list — carried alongside the
    // attachment (not inside it) so chat.service can ground the model's
    // round-2 reply in exactly what was saved, without changing the FE-facing
    // attachment shape.
    | { ok: true; attachment: ChatAttachment; words: string[] }
    // `details` goes to the model only (e.g. which languages to offer when
    // asking the user) — the FE ignores tool_result frames.
    | { ok: false; reason: string; details?: Record<string, unknown> };

// ---------- Tool definition advertised to the model ----------

export const CREATE_DECK_TOOL_DEF = {
    name: 'create_deck',
    description:
        'Create a study-ready vocabulary deck for the user when they ' +
        'explicitly ask to build one, paste a list of words to learn, or ' +
        'ask for vocab on a topic. Pass `words` — the exact items you will ' +
        'name in your reply — for any enumerable request (a specific count ' +
        'of items, a named list, "the X of Y", specific species/terms/' +
        'places). Only pass `topic` for genuinely open-ended requests where ' +
        'you are not committing to a specific list (e.g. "some vocab about ' +
        'cooking"). The `words` you pass become the deck\'s cards verbatim, ' +
        'so they MUST match what you tell the user. Pass wordsLanguage and ' +
        'definitionsLanguage whenever the conversation settles them; omit ' +
        "them only to fall back to the user's profile. Do NOT call for " +
        'casual chat.',
    input_schema: {
        type: 'object' as const,
        properties: {
            topic: { type: 'string' as const },
            words: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description:
                    'Clean, standalone dictionary/citation-form words only — ' +
                    'never raw fragments copied from a source (no list bullets, ' +
                    'leading/trailing dashes, or numbering). Normalize casing to ' +
                    "the target language's standard orthography even if the " +
                    'source displays it differently.',
            },
            title: {
                type: 'string' as const,
                description:
                    "A short, natural title describing the deck's subject/topic " +
                    '(e.g. "Німецькі слова: Енергія" or "German vocabulary — ' +
                    'Energy"). Do not echo the user\'s selection instructions ' +
                    '(like a color or formatting cue used to pick the words) — ' +
                    'describe what the words are about instead.',
            },
            wordsLanguage: {
                type: 'string' as const,
                description:
                    'ISO 639-1 code of the language the user is LEARNING — the ' +
                    'language of the words on the cards (e.g. "en", "de").',
            },
            definitionsLanguage: {
                type: 'string' as const,
                description:
                    'ISO 639-1 code of the language the user already KNOWS — ' +
                    'the language of the definitions and translations (e.g. "uk").',
            },
            count: { type: 'integer' as const, minimum: 3, maximum: 20 },
        },
        required: [] as string[],
        additionalProperties: false,
    },
} as const;

export const ADD_CARDS_TOOL_DEF = {
    name: 'add_cards',
    description:
        'Add new cards to the deck the user is CURRENTLY VIEWING (do not create ' +
        'a new deck). Use when the user asks to add a word or words, or to add ' +
        'more cards on a theme, to "this deck"/"my deck". Pass `words` when the ' +
        'user listed them; pass `topic` to generate more cards on a theme. The ' +
        'target deck and its languages are supplied by the app — you only choose ' +
        'the content. Only available when a deck is open.',
    input_schema: {
        type: 'object' as const,
        properties: {
            topic: { type: 'string' as const },
            words: { type: 'array' as const, items: { type: 'string' as const } },
            count: { type: 'integer' as const, minimum: 1, maximum: 20 },
        },
        required: [] as string[],
        additionalProperties: false,
    },
} as const;

// ---------- Language resolution ----------

const DEFAULT_TITLE_FALLBACK = 'Vocabulary deck';

// Failure reasons the model turns into a question for the user.
export type LanguageFailureReason =
    | 'UNSUPPORTED_LANGUAGE'
    | 'WORDS_LANGUAGE_AMBIGUOUS'
    | 'WORDS_LANGUAGE_NEEDED'
    | 'SAME_LANGUAGE_PAIR';

export type ResolvedLanguages =
    | { ok: true; sourceLanguage: string; targetLanguage: string }
    | { ok: false; reason: LanguageFailureReason; details: Record<string, unknown> };

// Resolves the deck's language pair. What the model explicitly passed wins
// (it carries what the user asked for). Otherwise:
//   - definitions (source): native language → chat locale → 'en'. Native beats
//     the locale: a Ukrainian using the app in English still reads Ukrainian.
//   - words (target): the user's learning language, if exactly one remains
//     after excluding the definitions language. Several → ambiguous, none →
//     needed. We never invent one (the old en/es fallback produced Spanish
//     decks nobody asked for) — the model asks the user instead.
// Words and definitions may only match when the model passed both (an
// explicit monolingual deck); an accidental match teaches nothing (QA: "Mimi
// created decks for learning Ukrainian").
export const resolveDeckLanguages = (params: {
    wordsLanguage?: string | undefined;
    definitionsLanguage?: string | undefined;
    userLangs: UserLanguages;
    locale?: string | null | undefined;
}): ResolvedLanguages => {
    const { userLangs } = params;
    const explicitSource = normalizeLang(params.definitionsLanguage);
    const explicitTarget = normalizeLang(params.wordsLanguage);
    if (params.definitionsLanguage && !explicitSource) {
        return {
            ok: false,
            reason: 'UNSUPPORTED_LANGUAGE',
            details: { field: 'definitionsLanguage', value: params.definitionsLanguage },
        };
    }
    if (params.wordsLanguage && !explicitTarget) {
        return {
            ok: false,
            reason: 'UNSUPPORTED_LANGUAGE',
            details: { field: 'wordsLanguage', value: params.wordsLanguage },
        };
    }

    const sourceLanguage =
        explicitSource ?? userLangs.native ?? normalizeLang(params.locale) ?? 'en';

    let targetLanguage = explicitTarget;
    if (!targetLanguage) {
        const candidates = userLangs.learning.filter((l) => l !== sourceLanguage);
        if (candidates.length > 1) {
            return {
                ok: false,
                reason: 'WORDS_LANGUAGE_AMBIGUOUS',
                details: { options: candidates },
            };
        }
        const [only] = candidates;
        if (!only) {
            return { ok: false, reason: 'WORDS_LANGUAGE_NEEDED', details: {} };
        }
        targetLanguage = only;
    }

    if (sourceLanguage === targetLanguage && !(explicitSource && explicitTarget)) {
        return {
            ok: false,
            reason: 'SAME_LANGUAGE_PAIR',
            details: { language: targetLanguage },
        };
    }
    return { ok: true, sourceLanguage, targetLanguage };
};

// ---------- Persistence helpers ----------

const cardFromDraft = (c: AiCardDraft): CreateCardInput => ({
    word: c.word,
    definition: c.definition,
    ...(c.phonetic ? { phonetic: c.phonetic } : {}),
    ...(c.partOfSpeech ? { partOfSpeech: c.partOfSpeech } : {}),
    ...(c.example ? { example: c.example } : {}),
    ...(c.exampleTranslation ? { exampleTranslation: c.exampleTranslation } : {}),
    ...(c.tags && c.tags.length > 0 ? { tags: c.tags } : {}),
    ...(c.difficulty ? { difficulty: c.difficulty } : {}),
});

const persistDeck = async (
    userId: string,
    meta: { title: string; description?: string; sourceLanguage: string; targetLanguage: string },
    cards: AiCardDraft[],
): Promise<{ attachment: ChatAttachment; words: string[] }> => {
    const deck = await decksService.create(userId, {
        title: meta.title,
        description: meta.description ?? '',
        sourceLanguage: meta.sourceLanguage,
        targetLanguage: meta.targetLanguage,
    });
    await cardsService.bulkCreate(userId, deck.id, {
        cards: cards.map(cardFromDraft),
    });
    return {
        attachment: {
            type: 'deck',
            deckId: deck.id,
            title: deck.title,
            cardCount: cards.length,
            action: 'created',
            sourceLanguage: deck.sourceLanguage,
            targetLanguage: deck.targetLanguage,
        },
        words: cards.map((c) => c.word),
    };
};

// ---------- The handler ----------

// Friendly fallback title when the user gave words but no title hint.
const titleForWordList = (input: CreateDeckToolInput, targetLanguage: string): string => {
    if (input.title) {
        return input.title;
    }
    if (input.topic) {
        return input.topic;
    }
    return `${langDisplayName(targetLanguage)} vocabulary`;
};

// Deterministic sanity check on a topic-branch draft: non-empty, and (when a
// count was requested) not wildly off from it. Catches a provider glitch that
// returns an empty or near-empty deck without needing an LLM judge.
const isDraftAcceptable = (cards: AiCardDraft[], requestedCount?: number): boolean => {
    if (cards.length === 0) {
        return false;
    }
    if (!requestedCount) {
        return true;
    }
    const min = Math.max(1, Math.ceil(requestedCount / 2));
    return cards.length >= min;
};

// Wraps aiService.generateDeck with one deterministic retry if the draft
// fails the sanity check above (e.g. the provider returned zero cards).
const generateDeckWithRetry = async (
    userId: string,
    params: Parameters<typeof aiService.generateDeck>[1],
) => {
    const first = await aiService.generateDeck(userId, params);
    if (isDraftAcceptable(first.cards, params.count)) {
        return first;
    }
    // eslint-disable-next-line no-console
    console.warn('[chat.tools] generateDeck draft failed sanity check, retrying', {
        topic: params.topic,
        requestedCount: params.count,
        got: first.cards.length,
    });
    const retry = await aiService.generateDeck(userId, params);
    return isDraftAcceptable(retry.cards, params.count) ? retry : first;
};

export const runCreateDeck = async (
    userId: string,
    input: CreateDeckToolInput,
    userLangs: UserLanguages,
    locale?: string | null,
): Promise<ToolResult> => {
    // Require at least one of words/topic — the JSON schema is loose so the
    // model doesn't get confused by oneOf, but we tighten here.
    const words = input.words && input.words.length > 0 ? input.words : null;
    const topic = input.topic?.trim() ? input.topic : null;
    if (!words && !topic) {
        return {
            ok: false,
            reason: 'create_deck needs either a `topic` or a non-empty `words` list',
        };
    }

    const langs = resolveDeckLanguages({
        wordsLanguage: input.wordsLanguage,
        definitionsLanguage: input.definitionsLanguage,
        userLangs,
        locale,
    });
    // eslint-disable-next-line no-console
    console.log('[chat.tools] create_deck', {
        hasWords: words !== null,
        hasTopic: topic !== null,
        wordsCount: input.words?.length ?? 0,
        topic: input.topic,
        locale,
        requested: { words: input.wordsLanguage, definitions: input.definitionsLanguage },
        profile: userLangs,
        resolved: langs.ok
            ? { sourceLanguage: langs.sourceLanguage, targetLanguage: langs.targetLanguage }
            : langs.reason,
        requestedCount: input.count,
    });
    if (!langs.ok) {
        return { ok: false, reason: langs.reason, details: langs.details };
    }
    const { sourceLanguage, targetLanguage } = langs;

    try {
        if (words) {
            const enriched = await aiService.enrichWords(userId, {
                words,
                sourceLanguage,
                targetLanguage,
            });
            const title = titleForWordList(input, targetLanguage);
            const persisted = await persistDeck(
                userId,
                { title, sourceLanguage, targetLanguage },
                enriched.cards,
            );
            // eslint-disable-next-line no-console
            console.log('[chat.tools] create_deck persisted', {
                deckId: persisted.attachment.deckId,
                cardCount: persisted.words.length,
                firstWords: persisted.words.slice(0, 10),
            });
            return { ok: true, ...persisted };
        }

        // topic branch — `words` is null here, so the guard above means topic is set
        const draft = await generateDeckWithRetry(userId, {
            topic: topic ?? '',
            sourceLanguage,
            targetLanguage,
            ...(input.count ? { count: input.count } : {}),
        });
        const persisted = await persistDeck(
            userId,
            {
                title: input.title ?? (draft.title.trim() ? draft.title : DEFAULT_TITLE_FALLBACK),
                description: draft.description,
                // The resolved pair is authoritative — it is what the prompt
                // told the model to write in. Don't let the model's own echo of
                // the languages (draft.sourceLanguage/targetLanguage) override
                // it: it can mislabel, e.g. read "uk" as UK English.
                sourceLanguage,
                targetLanguage,
            },
            draft.cards,
        );
        // eslint-disable-next-line no-console
        console.log('[chat.tools] create_deck persisted', {
            deckId: persisted.attachment.deckId,
            cardCount: persisted.words.length,
            firstWords: persisted.words.slice(0, 10),
        });
        return { ok: true, ...persisted };
    } catch (err) {
        // AppError → keep the original `code` so the FE error catalog still
        // maps it (AI_BUDGET_EXCEEDED, AI_PROVIDER_ERROR, etc.). Unknown
        // errors surface as a generic reason and avoid leaking stacks.
        if (err instanceof AppError) {
            return { ok: false, reason: err.code };
        }
        return { ok: false, reason: 'INTERNAL' };
    }
};

// Append cards to an existing, owned deck. `deckId` comes from the in-context
// deck the user is viewing (supplied by chat.service), never from the model, so
// it can't target an arbitrary deck. Mirrors runCreateDeck but reuses the deck's
// own languages and persists via cardsService.bulkCreate (ownership check,
// positions, cardCount recompute, achievements all handled there).
export const runAddCards = async (
    userId: string,
    deckId: string,
    input: AddCardsToolInput,
): Promise<ToolResult> => {
    const words = input.words && input.words.length > 0 ? input.words : null;
    const topic = input.topic?.trim() ? input.topic : null;
    if (!words && !topic) {
        return { ok: false, reason: 'NEEDS_WORDS_OR_TOPIC' };
    }

    try {
        // Ownership + source of truth for languages. findDeckById is authorId-scoped.
        const deck = await decksRepo.findDeckById(deckId, userId);
        if (!deck) {
            return { ok: false, reason: 'DECK_NOT_FOUND' };
        }

        const sourceLanguage = deck.sourceLanguage;
        const targetLanguage = deck.targetLanguage;

        const cards: AiCardDraft[] = words
            ? (
                  await aiService.enrichWords(userId, {
                      words,
                      sourceLanguage,
                      targetLanguage,
                  })
              ).cards
            : (
                  await generateDeckWithRetry(userId, {
                      topic: topic ?? '',
                      sourceLanguage,
                      targetLanguage,
                      ...(input.count ? { count: input.count } : {}),
                  })
              ).cards;

        await cardsService.bulkCreate(userId, deckId, {
            cards: cards.map(cardFromDraft),
        });

        // Re-read for the deck's new total (bulkCreate recomputes cardCount).
        const fresh = await decksRepo.findDeckById(deckId, userId);
        return {
            ok: true,
            attachment: {
                type: 'deck',
                deckId,
                title: deck.title,
                cardCount: fresh?.cardCount ?? cards.length,
                action: 'appended',
                addedCount: cards.length,
                sourceLanguage,
                targetLanguage,
            },
            words: cards.map((c) => c.word),
        };
    } catch (err) {
        if (err instanceof AppError) {
            return { ok: false, reason: err.code };
        }
        return { ok: false, reason: 'INTERNAL' };
    }
};
