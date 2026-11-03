import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as decksRepo from '../src/repositories/decks.repository.js';
import { create, update } from '../src/services/decks.service.js';
import { createDeckSchema, updateDeckSchema } from '../src/schemas/deck.schema.js';
import { discoverListQuerySchema } from '../src/schemas/discover.schema.js';
import { toPublicDeck } from '../src/shared/mappers.deck.js';

vi.mock('../src/repositories/decks.repository.js', async () => {
    const actual = await vi.importActual<typeof decksRepo>(
        '../src/repositories/decks.repository.js',
    );
    return { ...actual, createDeck: vi.fn(), updateDeck: vi.fn(), findDeckById: vi.fn() };
});
vi.mock('../src/services/milestone.service.js', () => ({
    checkFirstDeck: vi.fn(),
}));

const base = {
    title: 'Deck',
    description: '',
    sourceLanguage: 'en',
    targetLanguage: 'de',
};

const row = (over: Record<string, unknown> = {}) =>
    ({
        id: 'd1',
        authorId: 'u1',
        title: 'Deck',
        description: '',
        sourceLanguage: 'en',
        targetLanguage: 'de',
        isPublic: false,
        cardCount: 0,
        sourceData: null,
        coverColor: null,
        glyph: null,
        subject: 'languages',
        subjectSource: 'rules',
        featured: false,
        copyCount: 0,
        sourceDeckId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    }) as never;

beforeEach(() => {
    vi.mocked(decksRepo.createDeck).mockResolvedValue(row());
    vi.mocked(decksRepo.updateDeck).mockResolvedValue({ count: 1 });
    vi.mocked(decksRepo.findDeckById).mockResolvedValue(row());
});

describe('deck schema: subject', () => {
    it('accepts each fixed subject and the omitted case', () => {
        expect(createDeckSchema.parse({ ...base, subject: 'science' }).subject).toBe('science');
        expect(createDeckSchema.parse(base).subject).toBeUndefined();
    });

    it('rejects legacy slugs, free text and null', () => {
        expect(createDeckSchema.safeParse({ ...base, subject: 'biology' }).success).toBe(false);
        expect(createDeckSchema.safeParse({ ...base, subject: 'Science' }).success).toBe(false);
        expect(createDeckSchema.safeParse({ ...base, subject: null }).success).toBe(false);
        expect(updateDeckSchema.safeParse({ subject: null }).success).toBe(false);
        expect(updateDeckSchema.safeParse({ subject: 'science' }).success).toBe(true);
    });

    it('discover subject filter is the fixed list too', () => {
        expect(discoverListQuerySchema.safeParse({ subject: 'math' }).success).toBe(true);
        expect(discoverListQuerySchema.safeParse({ subject: 'Language' }).success).toBe(false);
    });
});

describe('decks.service.create: subject', () => {
    it('infers languages (rules) when omitted and the languages differ', async () => {
        await create('u1', createDeckSchema.parse(base));
        expect(decksRepo.createDeck).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ subject: 'languages', subjectSource: 'rules' }),
        );
    });

    it('infers other (rules) when omitted and the languages match', async () => {
        await create('u1', createDeckSchema.parse({ ...base, targetLanguage: 'en' }));
        expect(decksRepo.createDeck).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ subject: 'other', subjectSource: 'rules' }),
        );
    });

    it('stores an explicit subject as user-chosen, or ai when the caller says so', async () => {
        await create('u1', createDeckSchema.parse({ ...base, subject: 'law' }));
        expect(decksRepo.createDeck).toHaveBeenLastCalledWith(
            'u1',
            expect.objectContaining({ subject: 'law', subjectSource: 'user' }),
        );
        await create('u1', createDeckSchema.parse({ ...base, subject: 'law' }), {
            subjectSource: 'ai',
        });
        expect(decksRepo.createDeck).toHaveBeenLastCalledWith(
            'u1',
            expect.objectContaining({ subject: 'law', subjectSource: 'ai' }),
        );
    });
});

describe('decks.service.update: subject', () => {
    it('marks an edited subject as user-chosen', async () => {
        await update('u1', 'd1', updateDeckSchema.parse({ subject: 'arts' }));
        expect(decksRepo.updateDeck).toHaveBeenCalledWith(
            'd1',
            'u1',
            expect.objectContaining({ subject: 'arts', subjectSource: 'user' }),
        );
    });

    it('does not touch subject when it is not in the patch', async () => {
        await update('u1', 'd1', updateDeckSchema.parse({ title: 'New title' }));
        const patch = vi.mocked(decksRepo.updateDeck).mock.calls[0]?.[2] ?? {};
        expect(patch).not.toHaveProperty('subject');
        expect(patch).not.toHaveProperty('subjectSource');
    });
});

describe('toPublicDeck: subject', () => {
    it('never leaks a non-taxonomy value', () => {
        expect(toPublicDeck(row({ subject: 'languages' })).subject).toBe('languages');
        expect(toPublicDeck(row({ subject: 'Language' })).subject).toBe('other');
    });
});
