import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as envModule from '../src/config/env.js';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import { draftDeck } from '../src/services/ai.service.js';

// ai.service picks its provider from env at import time; force the mock so no
// test depends on the developer's .env (which may say AI_PROVIDER=anthropic).
vi.mock('../src/config/env.js', async (importOriginal) => {
    const actual = await importOriginal<typeof envModule>();
    return { ...actual, env: { ...actual.env, AI_PROVIDER: 'mock' } };
});

afterEach(() => vi.restoreAllMocks());

const draft = (subject: string | undefined) => ({
    title: 'T',
    description: 'D',
    sourceLanguage: 'en',
    targetLanguage: 'de',
    ...(subject === undefined ? {} : { subject }),
    cards: [{ word: 'a', definition: 'b' }],
});

// sourceLanguage is passed so the user's preferences are never read.
const run = (targetLanguage: string) =>
    draftDeck('u1', { topic: 'x', sourceLanguage: 'en', targetLanguage });

describe('ai.service / draftDeck: subject', () => {
    it.each([
        ['Biology', 'science'],
        ['languages', 'languages'],
        ['computer-science', 'technology'],
    ])('normalizes the model subject %s → %s', async (raw, expected) => {
        vi.spyOn(mockProvider, 'generateDeck').mockResolvedValue(draft(raw));
        expect((await run('de')).subject).toBe(expected);
    });

    it('falls back to the language heuristic for an off-list or missing subject', async () => {
        const spy = vi.spyOn(mockProvider, 'generateDeck');
        spy.mockResolvedValue(draft('zzqx'));
        expect((await run('de')).subject).toBe('languages');
        spy.mockResolvedValue(draft(undefined));
        expect((await run('en')).subject).toBe('other');
    });
});
