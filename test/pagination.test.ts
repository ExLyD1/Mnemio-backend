import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    decodeCursor,
    encodeCursor,
    parseLimit,
} from '../src/shared/pagination.js';

describe('pagination / parseLimit', () => {
    it('falls back when the value is absent or blank', () => {
        expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
        expect(parseLimit(null)).toBe(DEFAULT_LIMIT);
        expect(parseLimit('')).toBe(DEFAULT_LIMIT);
    });

    it('honours an explicit fallback', () => {
        expect(parseLimit(undefined, 50)).toBe(50);
    });

    it('accepts a numeric string (query params arrive as strings)', () => {
        expect(parseLimit('25')).toBe(25);
    });

    it('caps at MAX_LIMIT so a client cannot ask for the whole table', () => {
        expect(parseLimit('100000')).toBe(MAX_LIMIT);
    });

    it('floors a fractional limit', () => {
        expect(parseLimit('10.9')).toBe(10);
    });

    it('rejects zero, negatives and junk', () => {
        expect(() => parseLimit('0')).toThrow();
        expect(() => parseLimit('-5')).toThrow();
        expect(() => parseLimit('abc')).toThrow();
        expect(() => parseLimit(Infinity)).toThrow();
    });
});

describe('pagination / cursor round-trip', () => {
    // A cursor that does not survive a round-trip silently drops or repeats
    // rows on page 2+, which reads as missing data rather than an error.
    it('round-trips exactly', () => {
        const cursor = { ts: '2026-09-18T10:00:00.000Z', id: 'deck-123' };
        expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it('round-trips values containing url-unsafe characters', () => {
        const cursor = { ts: '2026-09-18T10:00:00.000Z', id: 'a+b/c=d?e&f' };
        const encoded = encodeCursor(cursor);
        expect(encoded).not.toMatch(/[+/=]/); // base64url, safe in a query string
        expect(decodeCursor(encoded)).toEqual(cursor);
    });

    it('treats an absent cursor as the first page', () => {
        expect(decodeCursor(undefined)).toBeNull();
        expect(decodeCursor(null)).toBeNull();
        expect(decodeCursor('')).toBeNull();
    });

    it('rejects a non-string cursor', () => {
        expect(() => decodeCursor(42)).toThrow();
        expect(() => decodeCursor({ ts: 'x', id: 'y' })).toThrow();
    });

    it('rejects corrupted base64 rather than paging from a wrong position', () => {
        expect(() => decodeCursor('!!!not-base64!!!')).toThrow();
    });

    it('rejects a well-formed cursor with the wrong shape', () => {
        const wrong = Buffer.from(JSON.stringify({ ts: 1, id: 'x' }), 'utf8').toString('base64url');
        expect(() => decodeCursor(wrong)).toThrow();
    });

    it('rejects valid base64 that is not JSON', () => {
        expect(() => decodeCursor(Buffer.from('hello', 'utf8').toString('base64url'))).toThrow();
    });
});
