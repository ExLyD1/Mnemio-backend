import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';

const queryRaw = vi.hoisted(() => vi.fn());
vi.mock('../src/db/prisma.js', () => ({ prisma: { $queryRaw: queryRaw, deck: {} } }));

import {
    countLibrary,
    libraryFacets,
    listLibrary,
} from '../src/repositories/library.repository.js';

// Render the tagged-template call to its final SQL text + bind values.
const rendered = (i = 0) => {
    const [strings, ...values] = queryRaw.mock.calls[i] as [TemplateStringsArray, ...unknown[]];
    const q = Prisma.sql(strings, ...values);
    return { sql: q.text.replace(/\s+/g, ' '), values: q.values };
};

beforeEach(() => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([]);
});

const base = { userId: 'me', subject: undefined, lang: undefined } as const;

describe('library.repository / SQL shape', () => {
    it('membership: threshold is LEAST(5, cardCount), public-or-mine, sort key falls back to createdAt', async () => {
        await listLibrary({ ...base, scope: 'all', limit: 24, cursor: null });
        const { sql, values } = rendered();
        expect(sql).toContain('LEAST($');
        expect(sql).toContain('d."cardCount" > 0');
        expect(sql).toContain('d."authorId" = $');
        expect(sql).toContain('OR d."isPublic"');
        expect(sql).toContain('COALESCE(ud."lastStudiedAt", d."createdAt") AS sort_ts');
        expect(sql).toContain('ORDER BY sort_ts DESC, id DESC');
        expect(values).toContain(5); // LEARNING_THRESHOLD
        expect(values.at(-1)).toBe(25); // limit + 1
    });

    it.each([
        ['all', '(is_mine OR is_learning)'],
        ['my', 'WHERE is_mine'],
        ['learning', 'WHERE is_learning'],
    ] as const)('scope=%s filters with %s', async (scope, fragment) => {
        await listLibrary({ ...base, scope, limit: 10, cursor: null });
        expect(rendered().sql).toContain(fragment);
    });

    it('adds subject and language filters (targetLanguage) only when given', async () => {
        await listLibrary({ ...base, scope: 'all', limit: 10, cursor: null });
        expect(rendered(0).sql).not.toContain('AND subject =');
        await listLibrary({
            ...base,
            scope: 'all',
            subject: 'languages',
            lang: 'de',
            limit: 10,
            cursor: null,
        });
        const { sql, values } = rendered(1);
        expect(sql).toContain('AND subject = $');
        expect(sql).toContain('AND "targetLanguage" = $');
        expect(values).toEqual(expect.arrayContaining(['languages', 'de']));
    });

    it('keyset cursor compares (sort_ts, id) as UTC timestamps', async () => {
        await listLibrary({
            ...base,
            scope: 'all',
            limit: 10,
            cursor: { ts: '2026-10-05T10:00:00.000Z', id: 'x' },
        });
        const { sql, values } = rendered();
        expect(sql).toContain('sort_ts < $');
        expect(sql).toContain('::timestamp');
        expect(sql).toContain('sort_ts = $');
        expect(values).toEqual(expect.arrayContaining(['2026-10-05T10:00:00.000Z', 'x']));
    });

    it('count ignores the cursor and applies the same filters', async () => {
        queryRaw.mockResolvedValue([{ count: 7n }]);
        expect(
            await countLibrary({ ...base, scope: 'learning', subject: 'math', lang: undefined }),
        ).toBe(7);
        const { sql } = rendered();
        expect(sql).toContain('WHERE is_learning');
        expect(sql).toContain('AND subject = $');
        expect(sql).not.toContain('sort_ts <');
    });

    it('facets: scope counts ignore filters; language chips only count subject=languages', async () => {
        queryRaw
            .mockResolvedValueOnce([{ all: 5n, my: 2n, learning: 4n }])
            .mockResolvedValueOnce([
                { subject: 'science', count: 2n },
                { subject: 'languages', count: 3n },
            ])
            .mockResolvedValueOnce([{ lang: 'de', count: 3n }]);
        const r = await libraryFacets({
            ...base,
            scope: 'all',
            subject: 'science',
            lang: 'fr',
        });
        expect(r).toEqual({
            scopes: { all: 5, my: 2, learning: 4 },
            // taxonomy order (languages before science), empty subjects omitted
            subjects: [
                { subject: 'languages', count: 3 },
                { subject: 'science', count: 2 },
            ],
            languages: [{ lang: 'de', count: 3 }],
        });
        const scopes = rendered(0);
        expect(scopes.sql).not.toContain('AND subject =');
        expect(scopes.values).not.toContain('science');
        expect(rendered(1).values).not.toContain('science');
        expect(rendered(2).sql).toContain("subject = 'languages'");
        expect(rendered(2).values).not.toContain('fr');
    });
});
