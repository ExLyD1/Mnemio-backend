import { beforeEach, expect, it, vi } from 'vitest';
import * as budget from '../src/services/ai.budget.service.js';
import * as ai from '../src/services/ai.service.js';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import { importByText } from '../src/services/imports.service.js';

vi.mock('../src/services/ai.budget.service.js', () => ({ reserve: vi.fn(), release: vi.fn() }));
vi.mock('../src/repositories/srs.repository.js', () => ({ countDueCards: async () => 0 }));
vi.mock('../src/repositories/activity.repository.js', () => ({ allDays: async () => [] }));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});
const calls = [
    [
        'enrich',
        'enrichWords',
        () => ai.enrichWords('u', { words: ['apple'], sourceLanguage: 'uk', targetLanguage: 'en' }),
    ],
    [
        'generate',
        'generateDeck',
        () =>
            ai.generateDeck('u', {
                topic: 'Fruit',
                count: 2,
                sourceLanguage: 'uk',
                targetLanguage: 'en',
            }),
    ],
    [
        'image',
        'deckFromImage',
        () =>
            ai.deckFromImage('u', {
                image: { dataBase64: 'eA==', mediaType: 'image/png' },
                sourceLanguage: 'uk',
                targetLanguage: 'en',
            }),
    ],
    ['suggest', 'suggest', () => ai.suggest('u', { context: 'dashboard' })],
] as const;

it.each(calls)('%s stays charged on success', async (kind, method, run) => {
    vi.spyOn(mockProvider, method).mockImplementation((async () => {
        expect(budget.reserve).toHaveBeenCalledWith('u', kind);
        return method === 'enrichWords'
            ? { cards: [] }
            : { cards: [], sourceLanguage: 'uk', targetLanguage: 'en' };
    }) as never);
    await run();
    expect(budget.release).not.toHaveBeenCalled();
});
it.each(calls)('%s releases provider failures', async (kind, method, run) => {
    const error = new Error('provider failed');
    vi.spyOn(mockProvider, method).mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(budget.release).toHaveBeenCalledExactlyOnceWith('u', kind);
});
it('text import keeps successful work charged and releases parse failures', async () => {
    await importByText('u', 'apple\tяблуко');
    expect(budget.reserve).toHaveBeenCalledWith('u', 'import');
    expect(budget.release).not.toHaveBeenCalled();
    await expect(importByText('u', 'unparseable')).rejects.toBeDefined();
    expect(budget.release).toHaveBeenCalledExactlyOnceWith('u', 'import');
});
