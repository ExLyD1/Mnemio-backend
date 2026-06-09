import { describe, it, expect } from 'vitest';
import { parseText } from '../src/services/imports.text.js';

describe('imports.text / parseText', () => {
    describe('auto-detect', () => {
        it('detects TSV when the first line contains a tab', () => {
            const r = parseText('agua\twater\npan\tbread');
            expect(r.format).toBe('tsv');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ]);
        });

        it('detects CSV when the first line contains a comma but no tab', () => {
            const r = parseText('agua,water\npan,bread');
            expect(r.format).toBe('csv');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ]);
        });

        it('falls back to newline when there is no separator', () => {
            const r = parseText('agua\nwater\npan\nbread');
            expect(r.format).toBe('newline');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ]);
        });
    });

    describe('csv quoting', () => {
        it('keeps commas inside quoted definitions', () => {
            const r = parseText('agua,"water, the liquid"', 'csv');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water, the liquid' },
            ]);
        });

        it('un-escapes doubled quotes inside a quoted field', () => {
            const r = parseText('agua,"the ""water"" thing"', 'csv');
            expect(r.cards[0]?.definition).toBe('the "water" thing');
        });

        it('keeps subsequent commas as part of the definition (split on first only)', () => {
            const r = parseText('verb,run,jog,sprint', 'csv');
            expect(r.cards).toEqual([{ word: 'verb', definition: 'run,jog,sprint' }]);
        });
    });

    describe('edge cases', () => {
        it('skips blank lines and trims whitespace', () => {
            const r = parseText('  agua\twater  \n\n  pan\tbread\n', 'tsv');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ]);
        });

        it('drops malformed lines without crashing', () => {
            const r = parseText('agua\twater\nnotacard\npan\tbread', 'tsv');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ]);
        });

        it('returns no cards on an empty string', () => {
            const r = parseText('', 'auto');
            expect(r.cards).toEqual([]);
        });

        it('newline format pairs even-odd lines', () => {
            const r = parseText('agua\nwater\npan\nbread\nleche\nmilk', 'newline');
            expect(r.cards).toEqual([
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
                { word: 'leche', definition: 'milk' },
            ]);
        });

        it('newline format ignores trailing unpaired line', () => {
            const r = parseText('agua\nwater\norphan', 'newline');
            expect(r.cards).toEqual([{ word: 'agua', definition: 'water' }]);
        });
    });
});
