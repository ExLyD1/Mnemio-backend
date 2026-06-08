import type {
    AiDeckDraft,
    AiProvider,
    AiSuggestion,
    ChatResult,
    ChatStreamEvent,
    EnrichWordsEvent,
    EnrichWordsResult,
    GenerateDeckEvent,
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

    async enrichWords(input, opts): Promise<EnrichWordsResult> {
        const start = Date.now();
        const cards = input.words.map((word) => ({
            word,
            // Deterministic placeholder definition so the FE can wire
            // against the shape without burning real LLM credits.
            definition: `[mock] ${input.sourceLanguage} definition for "${word}"`,
            phonetic: `/${word.toLowerCase()}/`,
            partOfSpeech: 'noun',
            example: `Example sentence using ${word}.`,
            exampleTranslation: `Translation of example for ${word}.`,
            tags: input.context ? [input.context.toLowerCase().split(/\s+/)[0]!] : ['mock'],
            difficulty: 'medium' as const,
        }));

        // Fire per-card events so streaming callers can dev against the mock.
        if (opts?.onCard) {
            cards.forEach((card, position) => {
                opts.onCard!({ type: 'card', position, card });
            });
        }

        const meta = {
            requested: input.words.length,
            enriched: cards.length,
            durationMs: Date.now() - start,
            tokensInput: 0,
            tokensOutput: 0,
        };
        opts?.onCard?.({ type: 'done', meta } satisfies EnrichWordsEvent);
        return { cards, meta };
    },

    async generateDeck(input, opts) {
        const start = Date.now();
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

        const header = {
            title: titleCase(input.topic),
            description: `AI-drafted vocabulary deck on "${input.topic}". Edit before saving.`,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            subject: 'languages',
            glyph: '✨',
        };
        if (opts?.onEvent) {
            opts.onEvent({ type: 'header', deck: header } satisfies GenerateDeckEvent);
            cards.forEach((card, position) =>
                opts.onEvent!({ type: 'card', position, card } satisfies GenerateDeckEvent),
            );
            opts.onEvent({
                type: 'done',
                meta: { durationMs: Date.now() - start, tokensInput: 0, tokensOutput: 0 },
            } satisfies GenerateDeckEvent);
        }
        return { ...header, cards } satisfies AiDeckDraft;
    },

    async chat(input, opts): Promise<ChatResult> {
        // Deterministic 3-token reply so the FE can exercise streaming UI
        // without burning Anthropic credits. Picks tone from the last user
        // message length so the dev experience varies slightly.
        const lastUserTurn = [...input.messages].reverse().find((m) => m.role === 'user');
        const tokens =
            lastUserTurn && lastUserTurn.content.length > 40
                ? ['Here', ' is a quick', ' answer.']
                : ['Sure', ', happy to help', '.'];

        for (const delta of tokens) {
            opts?.onEvent?.({ type: 'token', delta } satisfies ChatStreamEvent);
        }
        const meta = { tokensInput: 0, tokensOutput: 0 };
        opts?.onEvent?.({ type: 'done', meta } satisfies ChatStreamEvent);
        return {
            content: tokens.join(''),
            tokensInput: meta.tokensInput,
            tokensOutput: meta.tokensOutput,
        };
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
