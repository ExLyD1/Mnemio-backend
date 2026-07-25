import { describe, it, expect, vi } from 'vitest';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import type { DeckFromImageProviderInput, GenerateDeckEvent } from '../src/services/ai.provider.js';

vi.mock('../src/services/ai.budget.service.js', () => ({
    assertWithinBudget: vi.fn().mockResolvedValue(undefined),
    recordUse: vi.fn().mockResolvedValue(undefined),
}));

// ai.service.ts picks its provider from env.AI_PROVIDER at import time. Force
// 'mock' here so this suite is deterministic regardless of a local dev .env
// that may set AI_PROVIDER=anthropic with a real key (which would otherwise
// make these tests fire real, billed network calls).
vi.mock('../src/config/env.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config/env.js')>(
        '../src/config/env.js',
    );
    return { ...actual, env: { ...actual.env, AI_PROVIDER: 'mock' } };
});

const baseInput = (overrides: Partial<DeckFromImageProviderInput> = {}): DeckFromImageProviderInput => ({
    sourceLanguage: 'en',
    targetLanguage: 'es',
    image: { mediaType: 'image/png', dataBase64: 'ZmFrZQ==' },
    ...overrides,
});

describe('ai.provider.mock / deckFromImage', () => {
    it('emits header → cards → done in that order when streaming', async () => {
        const events: GenerateDeckEvent[] = [];
        await mockProvider.deckFromImage(baseInput({ count: 3 }), {
            onEvent: (e) => events.push(e),
        });
        expect(events[0]?.type).toBe('header');
        expect(events.filter((e) => e.type === 'card').length).toBe(3);
        expect(events.at(-1)?.type).toBe('done');
    });

    it('every card has an example (the value-add of this feature)', async () => {
        const draft = await mockProvider.deckFromImage(baseInput({ count: 2 }));
        expect(draft.cards.length).toBe(2);
        for (const c of draft.cards) {
            expect(c.example).toBeTruthy();
        }
    });

    it('returns an empty cards array for the deterministic no-text fixture', async () => {
        const draft = await mockProvider.deckFromImage(
            baseInput({ instructions: 'mock:no-text' }),
        );
        expect(draft.cards).toEqual([]);
    });

    it('no-text fixture still emits header + done (zero card events) when streaming', async () => {
        const events: GenerateDeckEvent[] = [];
        await mockProvider.deckFromImage(baseInput({ instructions: 'mock:no-text' }), {
            onEvent: (e) => events.push(e),
        });
        expect(events[0]?.type).toBe('header');
        expect(events.filter((e) => e.type === 'card')).toHaveLength(0);
        expect(events.at(-1)?.type).toBe('done');
    });
});

describe('ai.service / deckFromImage', () => {
    it('maps an empty draft to note: "no_text"', async () => {
        const { deckFromImage } = await import('../src/services/ai.service.js');
        const result = await deckFromImage(
            'user-1',
            baseInput({ instructions: 'mock:no-text' }),
        );
        expect(result.draft.cards).toEqual([]);
        expect(result.note).toBe('no_text');
    });

    it('omits note when the draft has cards', async () => {
        const { deckFromImage } = await import('../src/services/ai.service.js');
        const result = await deckFromImage('user-1', baseInput({ count: 3 }));
        expect(result.draft.cards.length).toBe(3);
        expect(result.note).toBeUndefined();
    });
});
