import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as libraryRepo from '../src/repositories/library.repository.js';
import * as deckStatsRepo from '../src/repositories/deck-stats.repository.js';
import { list } from '../src/services/library.service.js';
import { libraryQuerySchema } from '../src/schemas/library.schema.js';
import { encodeCursor } from '../src/shared/pagination.js';

vi.mock('../src/repositories/library.repository.js', () => ({
    listLibrary: vi.fn(),
    countLibrary: vi.fn(),
    libraryFacets: vi.fn(),
    findDecksWithAuthor: vi.fn(),
}));
vi.mock('../src/repositories/deck-stats.repository.js', () => ({ aggregateDeckStats: vi.fn() }));

const mLib = vi.mocked(libraryRepo);
const mStats = vi.mocked(deckStatsRepo);

const deck = (id: string, over: Record<string, unknown> = {}) =>
    ({
        id,
        authorId: 'author',
        title: id,
        description: '',
        sourceLanguage: 'en',
        targetLanguage: 'de',
        isPublic: true,
        cardCount: 10,
        sourceData: null,
        coverColor: null,
        glyph: null,
        subject: 'languages',
        subjectSource: 'user',
        featured: false,
        copyCount: 0,
        sourceDeckId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        author: { id: 'author', username: 'ann', fullName: null },
        ...over,
    }) as never;

const row = (id: string, ts: string, studiedCount: number | null = 5) => ({
    id,
    studiedCount,
    lastStudiedAt: studiedCount === null ? null : new Date(ts),
    sortTs: new Date(ts),
});

const facets = {
    scopes: { all: 3, my: 1, learning: 2 },
    subjects: [{ subject: 'languages' as const, count: 3 }],
    languages: [{ lang: 'de', count: 3 }],
};

beforeEach(() => {
    vi.resetAllMocks();
    mLib.countLibrary.mockResolvedValue(0);
    mLib.libraryFacets.mockResolvedValue(facets);
    mLib.findDecksWithAuthor.mockResolvedValue([]);
    mStats.aggregateDeckStats.mockResolvedValue([]);
});

const q = (over: Record<string, unknown> = {}) => libraryQuerySchema.parse(over);

describe('libraryQuerySchema', () => {
    it('defaults to scope=all', () => {
        expect(q().scope).toBe('all');
    });
    it('rejects an unknown scope, subject or language, and an oversize limit', () => {
        for (const bad of [
            { scope: 'mine' },
            { subject: 'biology' },
            { lang: 'klingon' },
            { limit: '51' },
        ]) {
            expect(libraryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
        }
    });
    it('normalizes lang aliases', () => {
        expect(q({ lang: 'ua' }).lang).toBe('uk');
    });
});

describe('library.service / list', () => {
    it('maps decks with owner flag, studied progress and the requester-scoped stats', async () => {
        mLib.listLibrary.mockResolvedValue([
            row('mine', '2026-10-05T10:00:00.000Z', null),
            row('theirs', '2026-10-04T10:00:00.000Z', 7),
        ]);
        mLib.findDecksWithAuthor.mockResolvedValue([
            deck('mine', { authorId: 'me' }),
            deck('theirs'),
        ]);
        mStats.aggregateDeckStats.mockResolvedValue([
            { deckId: 'theirs', mastered: 4, learning: 3, due: 2 },
        ]);
        const r = await list('me', q());
        expect(r.items.map((i) => [i.id, i.isOwner, i.studiedCount, i.lastStudiedAt])).toEqual([
            ['mine', true, 0, null],
            ['theirs', false, 7, '2026-10-04T10:00:00.000Z'],
        ]);
        expect(r.items[1]?.author).toEqual({ id: 'author', username: 'ann', fullName: null });
        expect(r.items[1]?.stats).toMatchObject({ mastered: 4, learning: 3, due: 2 });
        expect(mStats.aggregateDeckStats).toHaveBeenCalledWith('me', ['mine', 'theirs']);
        expect(r.items[0]?.stats.mastered).toBe(0);
    });

    it('passes scope / subject / lang straight to the repository', async () => {
        mLib.listLibrary.mockResolvedValue([]);
        await list('me', q({ scope: 'learning', subject: 'languages', lang: 'de' }));
        expect(mLib.listLibrary).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'me',
                scope: 'learning',
                subject: 'languages',
                lang: 'de',
                limit: 24,
                cursor: null,
            }),
        );
    });

    it('emits nextCursor only when the repo returned limit+1 rows, pointing at the last page row', async () => {
        mLib.listLibrary.mockResolvedValue([
            row('a', '2026-10-05T10:00:00.000Z'),
            row('b', '2026-10-04T10:00:00.000Z'),
        ]);
        mLib.findDecksWithAuthor.mockResolvedValue([deck('a'), deck('b')]);
        const r = await list('me', q({ limit: 1 }));
        expect(r.items.map((i) => i.id)).toEqual(['a']);
        expect(r.nextCursor).toBe(encodeCursor({ ts: '2026-10-05T10:00:00.000Z', id: 'a' }));

        mLib.listLibrary.mockResolvedValue([row('a', '2026-10-05T10:00:00.000Z')]);
        expect((await list('me', q({ limit: 1 }))).nextCursor).toBeNull();
    });

    it('decodes the cursor for the repo and skips the facets on later pages', async () => {
        mLib.listLibrary.mockResolvedValue([]);
        const cursor = encodeCursor({ ts: '2026-10-05T10:00:00.000Z', id: 'a' });
        const r = await list('me', q({ cursor }));
        expect(mLib.listLibrary).toHaveBeenCalledWith(
            expect.objectContaining({ cursor: { ts: '2026-10-05T10:00:00.000Z', id: 'a' } }),
        );
        expect(mLib.libraryFacets).not.toHaveBeenCalled();
        expect(r.facets).toBeUndefined();
    });

    it('includes facets and the total on the first page', async () => {
        mLib.listLibrary.mockResolvedValue([]);
        mLib.countLibrary.mockResolvedValue(42);
        const r = await list('me', q());
        expect(r.facets).toEqual(facets);
        expect(r.total).toBe(42);
    });

    it('rejects a malformed cursor with INVALID_CURSOR', async () => {
        await expect(list('me', q({ cursor: '%%%' }))).rejects.toMatchObject({
            code: 'INVALID_CURSOR',
        });
    });

    it('skips a deck deleted between the two queries, and does not load decks for an empty page', async () => {
        mLib.listLibrary.mockResolvedValue([row('gone', '2026-10-05T10:00:00.000Z')]);
        mLib.findDecksWithAuthor.mockResolvedValue([]);
        expect((await list('me', q())).items).toEqual([]);

        mLib.listLibrary.mockResolvedValue([]);
        mLib.findDecksWithAuthor.mockClear();
        await list('me', q());
        expect(mLib.findDecksWithAuthor).not.toHaveBeenCalled();
    });
});
