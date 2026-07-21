import { describe, it, expect } from 'vitest';
import { normalizeLang } from '../src/shared/lang.js';

describe('shared/lang / normalizeLang', () => {
    it('passes through bare 2-letter codes', () => {
        expect(normalizeLang('en')).toBe('en');
        expect(normalizeLang('uk')).toBe('uk');
    });

    it('strips region subtags', () => {
        expect(normalizeLang('uk-UA')).toBe('uk');
        expect(normalizeLang('en_US')).toBe('en');
    });

    it('maps common full language names to codes, case-insensitively', () => {
        expect(normalizeLang('English')).toBe('en');
        expect(normalizeLang('ukrainian')).toBe('uk');
        expect(normalizeLang('Portuguese')).toBe('pt');
    });

    it('returns null for junk or empty input', () => {
        expect(normalizeLang('')).toBeNull();
        expect(normalizeLang('   ')).toBeNull();
        expect(normalizeLang(null)).toBeNull();
        expect(normalizeLang(undefined)).toBeNull();
        expect(normalizeLang('not a language')).toBeNull();
    });
});
