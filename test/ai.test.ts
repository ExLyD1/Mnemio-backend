import { describe, it, expect } from 'vitest';
import { prepareWords } from '../src/services/ai.service.js';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import type {
    EnrichWordsEvent,
    GenerateDeckEvent,
} from '../src/services/ai.provider.js';

const baseEnrich = (words: string[]) => ({
    words,
    sourceLanguage: 'en',
    targetLanguage: 'es',
});

describe('ai.service / prepareWords', () => {
    it('preserves the input order', () => {
        const out = prepareWords(baseEnrich(['agua', 'pan', 'leche']));
        expect(out.words).toEqual(['agua', 'pan', 'leche']);
    });

    it('trims whitespace', () => {
        const out = prepareWords(baseEnrich(['  agua  ', '\tpan\n', ' leche']));
        expect(out.words).toEqual(['agua', 'pan', 'leche']);
    });

    it('drops empty strings', () => {
        const out = prepareWords(baseEnrich(['agua', '   ', 'pan', '']));
        expect(out.words).toEqual(['agua', 'pan']);
    });

    it('dedupes case-insensitively while keeping the first occurrence form', () => {
        const out = prepareWords(baseEnrich(['Agua', 'pan', 'AGUA', 'agua', 'Pan']));
        expect(out.words).toEqual(['Agua', 'pan']);
    });

    it('preserves the rest of the input', () => {
        const out = prepareWords({
            ...baseEnrich(['hola']),
            context: 'greetings',
            fields: ['phonetic', 'example'],
        });
        expect(out.context).toBe('greetings');
        expect(out.fields).toEqual(['phonetic', 'example']);
    });
});

describe('ai.provider.mock / enrichWords', () => {
    it('returns one card per input word, in order', async () => {
        const input = baseEnrich(['agua', 'pan', 'leche', 'café']);
        const result = await mockProvider.enrichWords(input);
        expect(result.cards.map((c) => c.word)).toEqual(['agua', 'pan', 'leche', 'café']);
        expect(result.meta.requested).toBe(4);
        expect(result.meta.enriched).toBe(4);
    });

    it('emits card events in order when streaming, then a done event', async () => {
        const events: EnrichWordsEvent[] = [];
        await mockProvider.enrichWords(baseEnrich(['a', 'b', 'c']), {
            onCard: (e) => events.push(e),
        });
        const cardEvents = events.filter((e) => e.type === 'card');
        expect(cardEvents.map((e) => (e.type === 'card' ? e.position : -1))).toEqual([0, 1, 2]);
        expect(events.at(-1)?.type).toBe('done');
    });

    it('every card has a non-empty definition (no ai-unfilled in the mock path)', async () => {
        const result = await mockProvider.enrichWords(baseEnrich(['x', 'y']));
        for (const c of result.cards) {
            expect(c.definition.length).toBeGreaterThan(0);
            expect(c.tags ?? []).not.toContain('ai-unfilled');
        }
    });
});

describe('ai.provider.mock / generateDeck', () => {
    it('emits header → cards → done in that order when streaming', async () => {
        const events: GenerateDeckEvent[] = [];
        await mockProvider.generateDeck(
            { topic: 'Italian food', targetLanguage: 'it', sourceLanguage: 'en', count: 3 },
            { onEvent: (e) => events.push(e) },
        );
        expect(events[0]?.type).toBe('header');
        expect(events.filter((e) => e.type === 'card').length).toBe(3);
        expect(events.at(-1)?.type).toBe('done');
    });
});
