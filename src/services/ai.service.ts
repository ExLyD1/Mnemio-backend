import { env } from '../config/env.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as prefsRepo from '../repositories/preferences.repository.js';
import * as budget from './ai.budget.service.js';
import { mockProvider } from './ai.provider.mock.js';
import { anthropicProvider } from './ai.provider.anthropic.js';
import type {
    AiDeckDraft,
    AiImageInput,
    AiProvider,
    EnrichWordsEvent,
    EnrichWordsResult,
    GenerateDeckEvent,
} from './ai.provider.js';
import type {
    DeckFromImageRequest,
    EnrichWordsInput,
    GenerateDeckRequest,
    SuggestInput,
} from '../schemas/ai.schema.js';
import { AiTooManyWordsError } from '../shared/errors.js';
import { DEFAULT_TZ, computeStreak, tzDayKey } from './tz.js';
import { normalizeLang } from '../shared/lang.js';

const selectProvider = (): AiProvider => {
    if (env.AI_PROVIDER === 'anthropic') {
        return anthropicProvider;
    }
    return mockProvider;
};

const provider = selectProvider();

/**
 * Trim, drop empties, and de-dup the user's word list while preserving first-
 * occurrence order. Returns the prepared input together with the original
 * word list (post-trim) so callers can map provider output back to whatever
 * the user pasted.
 */
export const prepareWords = (input: EnrichWordsInput): EnrichWordsInput => {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const raw of input.words) {
        const word = raw.trim();
        if (word.length === 0) {
            continue;
        }
        const key = word.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(word);
    }
    return { ...input, words: unique };
};

// Unmetered: callers charge the limit that matches what the user sees (a new
// deck vs. cards added to an existing one).
export const fillCards = async (
    input: EnrichWordsInput,
    opts?: { onCard?: (event: EnrichWordsEvent) => void },
): Promise<EnrichWordsResult> => {
    const prepared = prepareWords(input);
    if (prepared.words.length > env.MIMI_MAX_WORDS_PER_REQUEST) {
        throw new AiTooManyWordsError(env.MIMI_MAX_WORDS_PER_REQUEST, prepared.words.length);
    }
    return provider.enrichWords(prepared, opts);
};

// The word-list import fills cards the user then saves into a deck — one action.
export const enrichWords = (
    userId: string,
    input: EnrichWordsInput,
    opts?: { onCard?: (event: EnrichWordsEvent) => void },
): Promise<EnrichWordsResult> => budget.metered(userId, 'action', () => fillCards(input, opts));

// Definitions default to the user's native language, never a hardcoded 'en'
// they didn't choose (the image dialog never sends sourceLanguage, so every
// image deck used to get English definitions).
const resolveSourceLanguage = async (userId: string, requested?: string): Promise<string> => {
    if (requested) {
        return requested;
    }
    const pref = await prefsRepo.findOrCreate(userId);
    return normalizeLang(pref.nativeLanguage) ?? 'en';
};

// The languages we asked for are authoritative; the model's echo of them can
// mislabel (e.g. read "uk" as UK English) or name a detected language in full
// ("German"). Only a detected target (image, no target requested) comes from
// the model, normalized to a code.
const withResolvedLangs = <T extends { sourceLanguage: string; targetLanguage: string }>(
    deck: T,
    sourceLanguage: string,
    requestedTarget: string | undefined,
): T => ({
    ...deck,
    sourceLanguage,
    targetLanguage: requestedTarget ?? normalizeLang(deck.targetLanguage) ?? deck.targetLanguage,
});

const withResolvedHeader = (
    onEvent: ((event: GenerateDeckEvent) => void) | undefined,
    sourceLanguage: string,
    requestedTarget: string | undefined,
) =>
    onEvent &&
    ((event: GenerateDeckEvent) =>
        onEvent(
            event.type === 'header'
                ? { ...event, deck: withResolvedLangs(event.deck, sourceLanguage, requestedTarget) }
                : event,
        ));

// Unmetered — see fillCards.
export const draftDeck = async (
    userId: string,
    // `exclude` is internal-only (chat's add_cards passes the words already in
    // the deck); the HTTP schema never accepts it.
    input: GenerateDeckRequest & { exclude?: string[] },
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<AiDeckDraft> => {
    const sourceLanguage = await resolveSourceLanguage(userId, input.sourceLanguage);
    const onEvent = withResolvedHeader(opts?.onEvent, sourceLanguage, input.targetLanguage);
    const draft = await provider.generateDeck(
        { ...input, sourceLanguage },
        onEvent ? { onEvent } : undefined,
    );
    return withResolvedLangs(draft, sourceLanguage, input.targetLanguage);
};

export const generateDeck = (
    userId: string,
    input: GenerateDeckRequest,
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<AiDeckDraft> => budget.metered(userId, 'deck', () => draftDeck(userId, input, opts));

// Result carries an optional `note` when the image had no readable/learnable
// text — this is a normal outcome, not an error (empty cards, not a throw).
export const deckFromImage = (
    userId: string,
    input: DeckFromImageRequest & { image: AiImageInput },
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<{ draft: AiDeckDraft; note?: 'no_text' }> =>
    budget.metered(userId, 'deck', async () => {
        const sourceLanguage = await resolveSourceLanguage(userId, input.sourceLanguage);
        const onEvent = withResolvedHeader(opts?.onEvent, sourceLanguage, input.targetLanguage);
        const raw = await provider.deckFromImage(
            { ...input, sourceLanguage },
            onEvent ? { onEvent } : undefined,
        );
        const draft = withResolvedLangs(raw, sourceLanguage, input.targetLanguage);
        return draft.cards.length === 0 ? { draft, note: 'no_text' as const } : { draft };
    });

export const suggest = (userId: string, input: SuggestInput, tz: string = DEFAULT_TZ) =>
    budget.metered(userId, 'tip', async () => {
        const [dueCount, days] = await Promise.all([
            srsRepo.countDueCards(userId),
            activityRepo.allDays(userId),
        ]);
        const streak = computeStreak(days, tzDayKey(new Date(), tz));

        const args: {
            context: SuggestInput['context'];
            deckId?: string;
            dueCount: number;
            streak: number;
        } = {
            context: input.context,
            dueCount,
            streak,
        };
        if (input.deckId !== undefined) {
            args.deckId = input.deckId;
        }
        return provider.suggest(args);
    });

export const providerName = (): string => provider.name;
