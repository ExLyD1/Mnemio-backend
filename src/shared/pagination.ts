import { BadRequestError } from './errors.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type Cursor = { ts: string; id: string };

export const parseLimit = (raw: unknown, fallback = DEFAULT_LIMIT): number => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new BadRequestError('INVALID_LIMIT', 'limit must be a positive integer');
    }
    return Math.min(Math.floor(n), MAX_LIMIT);
};

export const encodeCursor = (cursor: Cursor): string =>
    Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const decodeCursor = (raw: unknown): Cursor | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') {
        throw new BadRequestError('INVALID_CURSOR', 'cursor must be a string');
    }
    try {
        const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (
            typeof decoded === 'object' &&
            decoded !== null &&
            typeof decoded.ts === 'string' &&
            typeof decoded.id === 'string'
        ) {
            return { ts: decoded.ts, id: decoded.id };
        }
        throw new Error('shape');
    } catch {
        throw new BadRequestError('INVALID_CURSOR', 'cursor is malformed');
    }
};

export type Page<T> = {
    items: T[];
    nextCursor: string | null;
};

// Some endpoints expose a total count alongside the page (e.g. GET /decks,
// where the FE shows "X decks total" on the library header). Most endpoints
// omit `total` because counting on every page is expensive — opt in only.
export type PageWithTotal<T> = Page<T> & { total: number };
