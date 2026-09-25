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

    it('maps common wrong codes (country codes, ISO 639-2) to the language code', () => {
        expect(normalizeLang('ua')).toBe('uk');
        expect(normalizeLang('UA')).toBe('uk');
        expect(normalizeLang('jp')).toBe('ja');
        expect(normalizeLang('cn')).toBe('zh');
        expect(normalizeLang('eng')).toBe('en');
        expect(normalizeLang('ukr')).toBe('uk');
        expect(normalizeLang('ger')).toBe('de');
    });

    it('maps language names written in Ukrainian or in the language itself', () => {
        expect(normalizeLang('українська')).toBe('uk');
        expect(normalizeLang('Німецька')).toBe('de');
        expect(normalizeLang('Deutsch')).toBe('de');
        expect(normalizeLang('español')).toBe('es');
        expect(normalizeLang('日本語')).toBe('ja');
    });

    it('rejects codes outside the supported set instead of passing them through', () => {
        expect(normalizeLang('xx')).toBeNull();
        expect(normalizeLang('la')).toBeNull();
        expect(normalizeLang('Klingon')).toBeNull();
    });

    it('returns null for junk or empty input', () => {
        expect(normalizeLang('')).toBeNull();
        expect(normalizeLang('   ')).toBeNull();
        expect(normalizeLang(null)).toBeNull();
        expect(normalizeLang(undefined)).toBeNull();
        expect(normalizeLang('not a language')).toBeNull();
    });
});
