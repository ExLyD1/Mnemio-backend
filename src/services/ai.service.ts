import { env } from '../config/env.js';
import * as srsRepo from '../repositories/srs.repository.js';
import * as activityRepo from '../repositories/activity.repository.js';
import * as budget from './ai.budget.service.js';
import { mockProvider } from './ai.provider.mock.js';
import { anthropicProvider } from './ai.provider.anthropic.js';
import type {
    AiProvider,
    DeckFromImageProviderInput,
    EnrichWordsEvent,
    EnrichWordsResult,
    GenerateDeckEvent,
} from './ai.provider.js';
import type { AiDeckDraft } from './ai.provider.js';
import type {
    EnrichWordsInput,
    GenerateDeckInput,
    SuggestInput,
} from '../schemas/ai.schema.js';
import { AiTooManyWordsError } from '../shared/errors.js';
import { DEFAULT_TZ, computeStreak, tzDayKey } from './tz.js';

const selectProvider = (): AiProvider => {
    if (env.AI_PROVIDER === 'anthropic') return anthropicProvider;
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
        if (word.length === 0) continue;
        const key = word.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(word);
    }
    return { ...input, words: unique };
};

export const enrichWords = async (
    userId: string,
    input: EnrichWordsInput,
    opts?: { onCard?: (event: EnrichWordsEvent) => void },
): Promise<EnrichWordsResult> => {
    const prepared = prepareWords(input);
    if (prepared.words.length > env.AI_MAX_WORDS_PER_ENRICH) {
        throw new AiTooManyWordsError(env.AI_MAX_WORDS_PER_ENRICH, prepared.words.length);
    }
    await budget.assertWithinBudget(userId, 'enrich');
    const result = await provider.enrichWords(prepared, opts);
    await budget.recordUse(userId, 'enrich');
    return result;
};

export const generateDeck = async (
    userId: string,
    input: GenerateDeckInput,
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<AiDeckDraft> => {
    await budget.assertWithinBudget(userId, 'generate');
    const draft = await provider.generateDeck(input, opts);
    await budget.recordUse(userId, 'generate');
    return draft;
};

// Result carries an optional `note` when the image had no readable/learnable
// text — this is a normal outcome, not an error (empty cards, not a throw).
export const deckFromImage = async (
    userId: string,
    input: DeckFromImageProviderInput,
    opts?: { onEvent?: (event: GenerateDeckEvent) => void },
): Promise<{ draft: AiDeckDraft; note?: 'no_text' }> => {
    await budget.assertWithinBudget(userId, 'image');
    const draft = await provider.deckFromImage(input, opts);
    await budget.recordUse(userId, 'image');
    return draft.cards.length === 0 ? { draft, note: 'no_text' } : { draft };
};

export const suggest = async (userId: string, input: SuggestInput, tz: string = DEFAULT_TZ) => {
    await budget.assertWithinBudget(userId, 'suggest');
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
    if (input.deckId !== undefined) args.deckId = input.deckId;
    const result = await provider.suggest(args);
    await budget.recordUse(userId, 'suggest');
    return result;
};

export const providerName = (): string => provider.name;
