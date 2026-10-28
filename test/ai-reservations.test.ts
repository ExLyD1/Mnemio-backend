import { beforeEach, expect, it, vi } from 'vitest';
import * as budget from '../src/services/ai.budget.service.js';
import * as ai from '../src/services/ai.service.js';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import { importByText } from '../src/services/imports.service.js';
import type * as EnvModule from '../src/config/env.js';

vi.mock('../src/services/ai.budget.service.js', () => {
    const reserve = vi.fn();
    const release = vi.fn();
    // Same contract as the real `metered`, wired to the spies above.
    const metered = async (userId: string, kind: string, work: () => Promise<unknown>) => {
        await reserve(userId, kind);
        try {
            return await work();
        } catch (err) {
            await release(userId, kind);
            throw err;
        }
    };
    return { reserve, release, metered };
});
// ai.service.ts picks its provider from env.AI_PROVIDER at import time. Pin
// 'mock' so a local .env with AI_PROVIDER=anthropic never makes this suite
// fire real, billed API calls.
vi.mock('../src/config/env.js', async () => {
    const actual = await vi.importActual<typeof EnvModule>('../src/config/env.js');
    return { ...actual, env: { ...actual.env, AI_PROVIDER: 'mock' } };
});
vi.mock('../src/repositories/preferences.repository.js', () => ({
    findOrCreate: vi.fn().mockResolvedValue({ nativeLanguage: 'uk', learningLanguages: ['en'] }),
}));
vi.mock('../src/repositories/srs.repository.js', () => ({ countDueCards: async () => 0 }));
vi.mock('../src/repositories/activity.repository.js', () => ({ allDays: async () => [] }));

beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});
const calls = [
    [
        'action',
        'enrichWords',
        () => ai.enrichWords('u', { words: ['apple'], sourceLanguage: 'uk', targetLanguage: 'en' }),
    ],
    [
        'deck',
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
        'deck',
        'deckFromImage',
        () =>
            ai.deckFromImage('u', {
                image: { dataBase64: 'eA==', mediaType: 'image/png' },
                sourceLanguage: 'uk',
                targetLanguage: 'en',
            }),
    ],
    ['tip', 'suggest', () => ai.suggest('u', { context: 'dashboard' })],
] as const;

it.each(calls)('%s stays charged on success (%s)', async (kind, method, run) => {
    vi.spyOn(mockProvider, method).mockImplementation((async () => {
        expect(budget.reserve).toHaveBeenCalledWith('u', kind);
        return method === 'enrichWords'
            ? { cards: [] }
            : { cards: [], sourceLanguage: 'uk', targetLanguage: 'en' };
    }) as never);
    await run();
    expect(budget.release).not.toHaveBeenCalled();
});
it.each(calls)('%s releases provider failures (%s)', async (kind, method, run) => {
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
