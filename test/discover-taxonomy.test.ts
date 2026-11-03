import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRaw = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());
vi.mock('../src/db/prisma.js', () => ({
    prisma: { $queryRaw: queryRaw, deck: { findMany, count: vi.fn() } },
}));

import { categories, listPublicDecks } from '../src/repositories/discover.repository.js';
import { discoverListQuerySchema } from '../src/schemas/discover.schema.js';
import { taxonomy } from '../src/services/public.service.js';
import { SUBJECTS, LEGACY_SUBJECT_MAP, isSubject } from '../src/shared/subjects.js';
import { SUPPORTED_LANG_LIST } from '../src/shared/lang.js';

beforeEach(() => {
    queryRaw.mockReset();
    findMany.mockReset();
});

describe('discover.repository / categories', () => {
    it('returns all 12 subjects in taxonomy order, zero counts included', async () => {
        queryRaw
            .mockResolvedValueOnce([
                { subject: 'science', count: 3n },
                { subject: 'languages', count: 7n },
            ])
            .mockResolvedValueOnce([
                { lang: 'de', count: 4n },
                { lang: 'es', count: 3n },
            ]);
        const r = await categories();
        expect(r.items.map((i) => i.subject)).toEqual([...SUBJECTS]);
        expect(r.items.find((i) => i.subject === 'languages')?.count).toBe(7);
        expect(r.items.find((i) => i.subject === 'science')?.count).toBe(3);
        expect(r.items.find((i) => i.subject === 'law')?.count).toBe(0);
        expect(r.languages).toEqual([
            { lang: 'de', count: 4 },
            { lang: 'es', count: 3 },
        ]);
    });

    it('ignores subjects outside the taxonomy (stale rows)', async () => {
        queryRaw
            .mockResolvedValueOnce([{ subject: 'Language', count: 9n }])
            .mockResolvedValueOnce([]);
        const r = await categories();
        expect(r.items).toHaveLength(12);
        expect(r.items.every((i) => i.count === 0)).toBe(true);
    });
});

describe('discover lang filter', () => {
    it('matches targetLanguage only (not sourceLanguage)', async () => {
        findMany.mockResolvedValue([]);
        await listPublicDecks({
            limit: 10,
            cursor: null,
            q: undefined,
            lang: 'de',
            subject: 'languages',
            sort: 'recent',
        });
        const where = findMany.mock.calls[0]?.[0].where;
        expect(where).toMatchObject({ isPublic: true, targetLanguage: 'de', subject: 'languages' });
        expect(JSON.stringify(where)).not.toContain('sourceLanguage');
    });

    it('query schema normalizes lang aliases and rejects unknown ones', () => {
        expect(discoverListQuerySchema.parse({ lang: 'ua' }).lang).toBe('uk');
        expect(discoverListQuerySchema.parse({ lang: 'German' }).lang).toBe('de');
        expect(discoverListQuerySchema.safeParse({ lang: 'klingon' }).success).toBe(false);
    });
});

describe('public.service / taxonomy', () => {
    it('serves the 12 subjects, the 28 languages and the legacy map', () => {
        const t = taxonomy();
        expect(t.subjects).toEqual([...SUBJECTS]);
        expect(t.languages).toEqual([...SUPPORTED_LANG_LIST]);
        expect(t.languages).toHaveLength(28);
        expect(t.legacySubjects).toEqual(LEGACY_SUBJECT_MAP);
        for (const target of Object.values(t.legacySubjects)) {
            expect(isSubject(target)).toBe(true);
        }
        // Every pre-002 FE slug that isn't itself one of the 12 must redirect.
        for (const old of [
            'biology',
            'computer-science',
            'nursing',
            'music',
            'tech',
            'vocabulary',
        ]) {
            expect(t.legacySubjects[old], old).toBeDefined();
        }
    });
});
