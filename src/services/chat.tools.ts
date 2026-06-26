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
import * as prefsRepo from '../repositories/preferences.repository.js';
import type { AiCardDraft } from './ai.provider.js';
import type { ChatAttachment } from '../shared/mappers.chat.js';
import { AppError } from '../shared/errors.js';
import type { CreateCardInput } from '../schemas/card.schema.js';

// ---------- Public types ----------

export type CreateDeckToolInput = {
    topic?: string;
    words?: string[];
    title?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    count?: number;
};

// add_cards targets the deck the user is viewing — the backend supplies the
// deckId and the deck's languages, so the model only chooses the content.
export type AddCardsToolInput = {
    topic?: string;
    words?: string[];
    count?: number;
};

export type ToolResult =
    | { ok: true; attachment: ChatAttachment }
    | { ok: false; reason: string };

// ---------- Tool definition advertised to the model ----------

export const CREATE_DECK_TOOL_DEF = {
    name: 'create_deck',
    description:
        'Create a study-ready vocabulary deck for the user when they ' +
        'explicitly ask to build one, paste a list of words to learn, or ' +
        'ask for vocab on a topic. Pass `words` when the user listed them; ' +
        'pass `topic` otherwise. Languages default to the user\'s ' +
        'preferences when omitted. Do NOT call for casual chat.',
    input_schema: {
        type: 'object' as const,
        properties: {
            topic: { type: 'string' as const },
            words: { type: 'array' as const, items: { type: 'string' as const } },
            title: { type: 'string' as const },
            sourceLanguage: { type: 'string' as const },
            targetLanguage: { type: 'string' as const },
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

// ---------- Defaults ----------

const DEFAULT_SOURCE = 'en';
const DEFAULT_TARGET = 'es';
const DEFAULT_TITLE_FALLBACK = 'Vocabulary deck';

// Pulls languages out of Preference rows. If the user hasn't filled in a
// preference yet (anonymous-feeling defaults), we pick the safest pair —
// en→es is what most users will want first anyway.
const resolveDefaults = async (
    userId: string,
    input: CreateDeckToolInput,
): Promise<{ sourceLanguage: string; targetLanguage: string }> => {
    const pref = await prefsRepo.findOrCreate(userId);
    const sourceLanguage =
        input.sourceLanguage ?? pref.nativeLanguage ?? DEFAULT_SOURCE;
    const targetLanguage =
        input.targetLanguage ??
        pref.learningLanguages[0] ??
        DEFAULT_TARGET;
    return { sourceLanguage, targetLanguage };
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
): Promise<ChatAttachment> => {
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
        type: 'deck',
        deckId: deck.id,
        title: deck.title,
        cardCount: cards.length,
        action: 'created',
    };
};

// ---------- The handler ----------

// Friendly fallback title when the user gave words but no title hint.
const titleForWordList = (input: CreateDeckToolInput, targetLanguage: string): string => {
    if (input.title) return input.title;
    if (input.topic) return input.topic;
    return `${targetLanguage.toUpperCase()} vocabulary`;
};

export const runCreateDeck = async (
    userId: string,
    input: CreateDeckToolInput,
): Promise<ToolResult> => {
    // Require at least one of words/topic — the JSON schema is loose so the
    // model doesn't get confused by oneOf, but we tighten here.
    const hasWords = Array.isArray(input.words) && input.words.length > 0;
    const hasTopic = typeof input.topic === 'string' && input.topic.trim().length > 0;
    if (!hasWords && !hasTopic) {
        return {
            ok: false,
            reason: 'create_deck needs either a `topic` or a non-empty `words` list',
        };
    }

    try {
        const { sourceLanguage, targetLanguage } = await resolveDefaults(userId, input);

        if (hasWords) {
            const enriched = await aiService.enrichWords(userId, {
                words: input.words!,
                sourceLanguage,
                targetLanguage,
            });
            const title = titleForWordList(input, targetLanguage);
            const attachment = await persistDeck(
                userId,
                { title, sourceLanguage, targetLanguage },
                enriched.cards,
            );
            return { ok: true, attachment };
        }

        // topic branch
        const draft = await aiService.generateDeck(userId, {
            topic: input.topic!,
            sourceLanguage,
            targetLanguage,
            ...(input.count ? { count: input.count } : {}),
        });
        const attachment = await persistDeck(
            userId,
            {
                title: input.title ?? draft.title ?? DEFAULT_TITLE_FALLBACK,
                description: draft.description,
                sourceLanguage: draft.sourceLanguage ?? sourceLanguage,
                targetLanguage: draft.targetLanguage ?? targetLanguage,
            },
            draft.cards,
        );
        return { ok: true, attachment };
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
    const hasWords = Array.isArray(input.words) && input.words.length > 0;
    const hasTopic = typeof input.topic === 'string' && input.topic.trim().length > 0;
    if (!hasWords && !hasTopic) {
        return { ok: false, reason: 'NEEDS_WORDS_OR_TOPIC' };
    }

    try {
        // Ownership + source of truth for languages. findDeckById is authorId-scoped.
        const deck = await decksRepo.findDeckById(deckId, userId);
        if (!deck) return { ok: false, reason: 'DECK_NOT_FOUND' };

        const sourceLanguage = deck.sourceLanguage;
        const targetLanguage = deck.targetLanguage;

        const cards: AiCardDraft[] = hasWords
            ? (
                  await aiService.enrichWords(userId, {
                      words: input.words!,
                      sourceLanguage,
                      targetLanguage,
                  })
              ).cards
            : (
                  await aiService.generateDeck(userId, {
                      topic: input.topic!,
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
            },
        };
    } catch (err) {
        if (err instanceof AppError) {
            return { ok: false, reason: err.code };
        }
        return { ok: false, reason: 'INTERNAL' };
    }
};
