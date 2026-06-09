import { describe, it, expect } from 'vitest';
import { parseQuizletUrl, extractFromQuizletHtml } from '../src/services/imports.quizlet.js';

describe('imports.quizlet / parseQuizletUrl', () => {
    it('accepts a canonical Quizlet set URL', () => {
        expect(parseQuizletUrl('https://quizlet.com/123456789/spanish-cafe-flash-cards/')).toEqual({
            setId: '123456789',
        });
    });

    it('accepts the www variant', () => {
        expect(parseQuizletUrl('https://www.quizlet.com/42/whatever/')).toEqual({ setId: '42' });
    });

    it('rejects non-Quizlet URLs', () => {
        expect(parseQuizletUrl('https://example.com/123/whatever/')).toBeNull();
    });

    it('rejects Quizlet URLs without a numeric set id', () => {
        expect(parseQuizletUrl('https://quizlet.com/study/abc/')).toBeNull();
    });

    it('trims surrounding whitespace before matching', () => {
        expect(parseQuizletUrl('   https://quizlet.com/7/x/   ')?.setId).toBe('7');
    });
});

const wrapNextData = (payload: unknown): string => {
    return `<html><head></head><body>
        <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>
    </body></html>`;
};

describe('imports.quizlet / extractFromQuizletHtml', () => {
    it('returns null when __NEXT_DATA__ is missing', () => {
        expect(extractFromQuizletHtml('<html><body>no data here</body></html>', '1')).toBeNull();
    });

    it('returns null when __NEXT_DATA__ is unparseable JSON', () => {
        const html =
            '<script id="__NEXT_DATA__" type="application/json">{ not json }</script>';
        expect(extractFromQuizletHtml(html, '1')).toBeNull();
    });

    it('extracts cards from a {word,definition} flashcards array', () => {
        const html = wrapNextData({
            props: {
                pageProps: {
                    set: {
                        title: 'Spanish — Café',
                        flashcards: [
                            { word: 'agua', definition: 'water' },
                            { word: 'pan', definition: 'bread' },
                        ],
                    },
                },
            },
        });
        const out = extractFromQuizletHtml(html, '7');
        expect(out).toEqual({
            setId: '7',
            title: 'Spanish — Café',
            cards: [
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ],
        });
    });

    it('also accepts {term,definition} shape for older payloads', () => {
        const html = wrapNextData({
            data: {
                items: [
                    { term: 'agua', definition: 'water' },
                    { term: 'pan', definition: 'bread' },
                ],
            },
        });
        const out = extractFromQuizletHtml(html, '7');
        expect(out?.cards.map((c) => c.word)).toEqual(['agua', 'pan']);
    });

    it('falls back to a generic title when no title field exists', () => {
        const html = wrapNextData({
            items: [{ word: 'agua', definition: 'water' }],
        });
        const out = extractFromQuizletHtml(html, '7');
        expect(out?.title).toBe('Imported set');
    });

    it('returns null when no term-like array is found anywhere', () => {
        const html = wrapNextData({ props: { pageProps: { unrelated: 'data' } } });
        expect(extractFromQuizletHtml(html, '7')).toBeNull();
    });

    it('returns null when the term array is empty after filtering', () => {
        const html = wrapNextData({
            items: [{ word: '', definition: 'water' }, { word: 'pan', definition: '' }],
        });
        expect(extractFromQuizletHtml(html, '7')).toBeNull();
    });
});
