import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    SUBJECTS,
    LEGACY_SUBJECT_MAP,
    normalizeSubject,
    matchSubjectKeywords,
    inferSubject,
    resolveSubject,
    isSubject,
} from '../src/shared/subjects.js';
import { SUPPORTED_LANG_LIST, SUPPORTED_LANGS } from '../src/shared/lang.js';

// The 30 pre-002 FE slugs (mnemio-frontend app/utils/deckCategories.ts) and
// where each one lands. Every one must resolve — legacy /discover URLs 301 on it.
const OLD_FE_SLUGS: Record<string, string> = {
    languages: 'languages',
    vocabulary: 'languages',
    medicine: 'medicine',
    nursing: 'medicine',
    anatomy: 'medicine',
    pharmacology: 'medicine',
    biology: 'science',
    chemistry: 'science',
    physics: 'science',
    math: 'math',
    'computer-science': 'technology',
    programming: 'technology',
    engineering: 'technology',
    history: 'humanities',
    geography: 'humanities',
    law: 'law',
    business: 'business',
    finance: 'business',
    psychology: 'social',
    philosophy: 'humanities',
    literature: 'humanities',
    art: 'arts',
    music: 'arts',
    'social-science': 'social',
    'test-prep': 'test-prep',
    religion: 'humanities',
    culinary: 'other',
    sports: 'other',
    trivia: 'other',
    other: 'other',
};

describe('shared/subjects', () => {
    it('has exactly the 12 subjects in display order', () => {
        expect(SUBJECTS).toEqual([
            'languages',
            'medicine',
            'science',
            'math',
            'technology',
            'humanities',
            'social',
            'business',
            'law',
            'arts',
            'test-prep',
            'other',
        ]);
    });

    it('maps every new slug to itself', () => {
        for (const s of SUBJECTS) {
            expect(normalizeSubject(s)).toBe(s);
        }
    });

    it('maps all 30 old FE slugs per the spec table', () => {
        expect(Object.keys(OLD_FE_SLUGS)).toHaveLength(30);
        for (const [old, expected] of Object.entries(OLD_FE_SLUGS)) {
            expect(normalizeSubject(old), old).toBe(expected);
        }
    });

    it('legacy map only targets valid subjects and covers every non-identity old slug', () => {
        for (const target of Object.values(LEGACY_SUBJECT_MAP)) {
            expect(isSubject(target)).toBe(true);
        }
        for (const old of Object.keys(OLD_FE_SLUGS)) {
            if (!isSubject(old)) {
                expect(LEGACY_SUBJECT_MAP[old], old).toBeDefined();
            }
        }
        expect(LEGACY_SUBJECT_MAP.tech).toBe('technology');
    });

    it('normalizes case and whitespace', () => {
        expect(normalizeSubject(' Languages ')).toBe('languages');
        expect(normalizeSubject('Language')).toBeNull();
        expect(normalizeSubject(' Finance ')).toBe('business');
        expect(normalizeSubject('BIOLOGY')).toBe('science');
    });

    it('never keyword-guesses free text', () => {
        expect(normalizeSubject('Cardiology terms')).toBeNull();
        expect(normalizeSubject('English vocabulary')).toBeNull();
        expect(normalizeSubject('Contract law')).toBeNull();
        expect(normalizeSubject('German')).toBeNull();
        expect(normalizeSubject('cs')).toBeNull();
    });

    it('matchSubjectKeywords applies the heuristics to free text', () => {
        expect(matchSubjectKeywords('English vocabulary')).toBe('languages');
        expect(matchSubjectKeywords('Українська мова')).toBe('languages');
        expect(matchSubjectKeywords('Clinical skills')).toBe('medicine');
        expect(matchSubjectKeywords('Organic Chemistry II')).toBe('science');
        expect(matchSubjectKeywords('Linear algebra')).toBe('math');
        expect(matchSubjectKeywords('Software interviews')).toBe('technology');
        expect(matchSubjectKeywords('World capitals')).toBe('humanities');
        expect(matchSubjectKeywords('Contract law')).toBe('law');
        expect(matchSubjectKeywords('Microeconomics')).toBe('business');
        expect(matchSubjectKeywords('Guitar chords')).toBe('arts');
        expect(matchSubjectKeywords('SAT prep')).toBe('test-prep');
        expect(matchSubjectKeywords('Cooking basics')).toBe('other');
        // The known over-match that keeps these rules out of the migration.
        expect(matchSubjectKeywords('Cardiology terms')).toBe('languages');
    });

    it('matchSubjectKeywords treats a bare language name as a language deck, but not 2–3 letter codes', () => {
        expect(matchSubjectKeywords('Deutsch')).toBe('languages');
        expect(matchSubjectKeywords('日本語')).toBe('languages');
        expect(matchSubjectKeywords('it')).toBeNull();
        expect(matchSubjectKeywords('cs')).toBe('technology');
        expect(matchSubjectKeywords(null)).toBeNull();
        expect(matchSubjectKeywords('zzqx')).toBeNull();
    });

    it('returns null for empty or unmatchable input', () => {
        expect(normalizeSubject(null)).toBeNull();
        expect(normalizeSubject(undefined)).toBeNull();
        expect(normalizeSubject('   ')).toBeNull();
        expect(normalizeSubject('zzqx')).toBeNull();
    });

    it('inferSubject: different languages → languages, same → other', () => {
        expect(inferSubject('en', 'uk')).toBe('languages');
        expect(inferSubject('en', 'en')).toBe('other');
    });

    it('resolveSubject always yields a valid slug', () => {
        expect(resolveSubject('Biology', 'en', 'en')).toBe('science');
        expect(resolveSubject('Contract law', 'en', 'en')).toBe('law');
        expect(resolveSubject('zzqx', 'en', 'de')).toBe('languages');
        expect(resolveSubject(null, 'en', 'en')).toBe('other');
    });
});

// The migration and its read-only preview map only exact / legacy-slug values;
// their subject_map must be exactly SUBJECTS + LEGACY_SUBJECT_MAP.
describe('fixed_subjects migration SQL', () => {
    const files = [
        'prisma/migrations/20261029000000_fixed_subjects/migration.sql',
        'scripts/sql/preview-subject-mapping.sql',
    ];
    const expected = Object.fromEntries([
        ...SUBJECTS.map((s) => [s, s]),
        ...Object.entries(LEGACY_SUBJECT_MAP),
    ]);

    for (const file of files) {
        const sql = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        const code = sql.replace(/--.*$/gm, '');

        it(`${file}: subject_map mirrors SUBJECTS + LEGACY_SUBJECT_MAP`, () => {
            const pairs = [...code.matchAll(/\('([^']+)',\s*'([^']+)'\)/g)];
            expect(Object.fromEntries(pairs.map((m) => [m[1], m[2]]))).toEqual(expected);
            expect(pairs).toHaveLength(Object.keys(expected).length);
        });

        it(`${file}: has no keyword rules`, () => {
            expect(code).not.toMatch(/\bLIKE\b/i);
            expect(code).not.toMatch(/'keyword'/);
        });
    }
});

describe('shared/lang / SUPPORTED_LANG_LIST', () => {
    it('is the 28 supported codes, unique, matching the set', () => {
        expect(SUPPORTED_LANG_LIST).toHaveLength(28);
        expect(new Set(SUPPORTED_LANG_LIST)).toEqual(SUPPORTED_LANGS);
        expect(SUPPORTED_LANG_LIST[0]).toBe('en');
        expect(SUPPORTED_LANG_LIST[1]).toBe('uk');
    });
});
