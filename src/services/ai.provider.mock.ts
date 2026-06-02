import type {
    AiDeckDraft,
    AiProvider,
    AiSuggestion,
    SuggestContext,
} from './ai.provider.js';

const titleCase = (s: string) =>
    s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

const PLACEHOLDER_DEFS = [
    'A common everyday word',
    'A useful expression',
    'A frequently encountered term',
    'A core piece of vocabulary',
    'A practical phrase',
];

/**
 * Mock AI provider. Returns deterministic-shaped drafts so the FE can wire the
 * Generate Deck and Mimi suggestion surfaces against realistic payloads. The
 * cards themselves are placeholders ("Word 1: A common everyday word"); a real
 * LLM provider will replace this content end-to-end without any contract
 * change.
 */
export const mockProvider: AiProvider = {
    name: 'mock',

    async generateDeck(input) {
        const count = input.count ?? 8;
        const cards = Array.from({ length: count }, (_, i) => {
            const word = `${titleCase(input.targetLanguage)} term ${i + 1}`;
            const definition =
                PLACEHOLDER_DEFS[i % PLACEHOLDER_DEFS.length] ?? PLACEHOLDER_DEFS[0]!;
            return {
                word,
                definition,
                difficulty: (i % 3 === 0 ? 'easy' : i % 3 === 1 ? 'medium' : 'hard') as
                    | 'easy'
                    | 'medium'
                    | 'hard',
                tags: [input.topic.toLowerCase().split(/\s+/).slice(0, 2).join('-') || 'general'],
            };
        });

        const draft: AiDeckDraft = {
            title: titleCase(input.topic),
            description: `AI-drafted vocabulary deck on "${input.topic}". Edit before saving.`,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            subject: 'languages',
            glyph: '✨',
            cards,
        };
        return draft;
    },

    async suggest(input) {
        const { context, dueCount, streak } = input;
        const out = ((): AiSuggestion => {
            if (context === 'review' || dueCount > 0) {
                return {
                    suggestion:
                        dueCount > 0
                            ? `You have ${dueCount} card${dueCount === 1 ? '' : 's'} due today — a quick review keeps your streak alive!`
                            : 'Nothing due right now. Try a fresh deck or polish an existing one.',
                    kind: 'review',
                    actions: [{ label: 'Start review', href: '/review' }],
                };
            }
            if (context === 'deck_detail') {
                return {
                    suggestion:
                        'Add a quick example sentence to each card to make recall easier.',
                    kind: 'tip',
                    actions: input.deckId
                        ? [{ label: 'Edit deck', href: `/decks/${input.deckId}` }]
                        : [],
                };
            }
            return streak >= 3
                ? {
                      suggestion: `You're on a ${streak}-day streak — keep it going with a 5-minute review.`,
                      kind: 'tip',
                      actions: [{ label: 'Quick review', href: '/review' }],
                  }
                : {
                      suggestion:
                          'Build a small deck on a topic you care about — 10 cards is enough to start.',
                      kind: 'deck',
                      actions: [{ label: 'Create deck', href: '/decks/new' }],
                  };
        })();
        return out;
    },
};

export const supportedContexts: SuggestContext[] = ['dashboard', 'deck_detail', 'review'];
