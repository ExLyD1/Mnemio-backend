import { describe, it, expect } from 'vitest';
import {
    SUBJECTS,
    LEGACY_SUBJECT_MAP,
    normalizeSubject,
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
        expect(normalizeSubject('Language')).toBe('languages');
        expect(normalizeSubject(' Finance ')).toBe('business');
        expect(normalizeSubject('BIOLOGY')).toBe('science');
    });

    it('applies the keyword heuristics to old free text', () => {
        expect(normalizeSubject('English vocabulary')).toBe('languages');
        expect(normalizeSubject('Українська мова')).toBe('languages');
        expect(normalizeSubject('Clinical skills')).toBe('medicine');
        expect(normalizeSubject('Organic Chemistry II')).toBe('science');
        expect(normalizeSubject('Linear algebra')).toBe('math');
        expect(normalizeSubject('Software interviews')).toBe('technology');
        expect(normalizeSubject('World capitals')).toBe('humanities');
        expect(normalizeSubject('Contract law')).toBe('law');
        expect(normalizeSubject('Microeconomics')).toBe('business');
        expect(normalizeSubject('Guitar chords')).toBe('arts');
        expect(normalizeSubject('SAT prep')).toBe('test-prep');
        expect(normalizeSubject('Cooking basics')).toBe('other');
    });

    it('treats a bare language name as a language deck, but not 2–3 letter codes', () => {
        expect(normalizeSubject('Deutsch')).toBe('languages');
        expect(normalizeSubject('日本語')).toBe('languages');
        expect(normalizeSubject('it')).toBeNull();
        expect(normalizeSubject('cs')).toBe('technology');
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
        expect(resolveSubject('zzqx', 'en', 'de')).toBe('languages');
        expect(resolveSubject(null, 'en', 'en')).toBe('other');
    });
});

describe('shared/lang / SUPPORTED_LANG_LIST', () => {
    it('is the 28 supported codes, unique, matching the set', () => {
        expect(SUPPORTED_LANG_LIST).toHaveLength(28);
        expect(new Set(SUPPORTED_LANG_LIST)).toEqual(SUPPORTED_LANGS);
        expect(SUPPORTED_LANG_LIST[0]).toBe('en');
        expect(SUPPORTED_LANG_LIST[1]).toBe('uk');
    });
});
