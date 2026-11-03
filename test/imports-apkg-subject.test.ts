import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createApkgDecks = vi.hoisted(() => vi.fn());
const classify = vi.hoisted(() => vi.fn());
vi.mock('../src/repositories/imports.repository.js', () => ({ createApkgDecks }));
vi.mock('../src/services/subjects.service.js', () => ({ classify, CLASSIFY_MAX_WORDS: 10 }));
vi.mock('../src/services/ai.budget.service.js', () => ({ reserve: vi.fn(), release: vi.fn() }));
vi.mock('../src/services/achievements.service.js', () => ({
    evaluate: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/services/milestone.service.js', () => ({ checkFirstDeck: vi.fn() }));
vi.mock('../src/services/media.service.js', () => ({
    storeBuffer: vi.fn().mockResolvedValue({ url: '/media/u1/file.bin' }),
    removeStoredFile: vi.fn(),
}));

import { importApkg } from '../src/services/imports.apkg.service.js';

const bytes = readFileSync(new URL('./fixtures/anki/modern.apkg', import.meta.url));
const langs = { sourceLanguage: 'en', targetLanguage: 'ja' } as const;

beforeEach(() => {
    createApkgDecks.mockReset();
    classify.mockReset();
    createApkgDecks.mockResolvedValue([]);
});

const sentDecks = () =>
    createApkgDecks.mock.calls[0]?.[2] as {
        title: string;
        subject: string;
        subjectSource: string;
    }[];

describe('importApkg: subject', () => {
    it("applies the user's subject to every deck without classifying", async () => {
        await importApkg('u1', bytes, { ...langs, subject: 'law' });
        expect(classify).not.toHaveBeenCalled();
        const decks = sentDecks();
        expect(decks.length).toBeGreaterThan(1);
        expect(decks.every((d) => d.subject === 'law' && d.subjectSource === 'user')).toBe(true);
        // The subject is a deck field, not part of the languages argument.
        expect(createApkgDecks.mock.calls[0]?.[1]).toEqual(langs);
    });

    it('classifies each deck when no subject was chosen', async () => {
        classify.mockResolvedValue({ subject: 'languages', source: 'ai' });
        await importApkg('u1', bytes, { ...langs });
        const decks = sentDecks();
        expect(classify).toHaveBeenCalledTimes(decks.length);
        expect(classify).toHaveBeenCalledWith(
            expect.objectContaining({ words: expect.any(Array) }),
            { userId: 'u1', origin: 'import' },
        );
        expect(decks.every((d) => d.subject === 'languages' && d.subjectSource === 'ai')).toBe(
            true,
        );
    });

    it('records rules-picked subjects as rules', async () => {
        classify.mockResolvedValue({ subject: 'other', source: 'rules' });
        await importApkg('u1', bytes, { ...langs });
        expect(sentDecks().every((d) => d.subjectSource === 'rules')).toBe(true);
    });
});
