import { describe, it, expect, vi } from 'vitest';
import { wantsSse } from '../src/shared/sse.js';

describe('shared/sse / wantsSse negotiation', () => {
    it('opts in on Accept: text/event-stream', () => {
        expect(
            wantsSse({ headers: { accept: 'text/event-stream' }, query: {} }),
        ).toBe(true);
    });

    it('opts in on a comma-separated Accept header that includes event-stream', () => {
        expect(
            wantsSse({
                headers: { accept: 'application/json, text/event-stream;q=0.9' },
                query: {},
            }),
        ).toBe(true);
    });

    it('opts in on ?stream=1 (escape hatch for clients that can\'t set Accept)', () => {
        expect(wantsSse({ headers: {}, query: { stream: '1' } })).toBe(true);
        expect(wantsSse({ headers: {}, query: { stream: 'true' } })).toBe(true);
    });

    it('falls back to non-streaming on a plain JSON Accept', () => {
        expect(
            wantsSse({ headers: { accept: 'application/json' }, query: {} }),
        ).toBe(false);
    });

    it('falls back to non-streaming on missing Accept and missing ?stream', () => {
        expect(wantsSse({ headers: {}, query: {} })).toBe(false);
    });

    it('is case-insensitive on the Accept header', () => {
        expect(
            wantsSse({ headers: { accept: 'TEXT/EVENT-STREAM' }, query: {} }),
        ).toBe(true);
    });
});

// Also exercise startSse via a fake reply.
import { startSse } from '../src/shared/sse.js';

describe('shared/sse / startSse', () => {
    it('writes event + data frames and ends', () => {
        const writes: string[] = [];
        const raw = {
            setHeader: vi.fn(),
            flushHeaders: vi.fn(),
            on: vi.fn(),
            write: (chunk: string) => {
                writes.push(chunk);
                return true;
            },
            end: vi.fn(),
        };
        const sse = startSse({ raw } as never);
        sse.write('card', { type: 'card', position: 0, word: 'agua' });
        sse.end();

        expect(raw.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
        expect(raw.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        expect(writes.join('')).toMatch(/^event: card\ndata: \{"type":"card","position":0,"word":"agua"\}\n\n$/);
        expect(raw.end).toHaveBeenCalled();
    });

    it('stops writing once the underlying connection closes', () => {
        const writes: string[] = [];
        let closeHandler: () => void = () => undefined;
        const raw = {
            setHeader: vi.fn(),
            flushHeaders: vi.fn(),
            on: (event: string, fn: () => void) => {
                if (event === 'close') closeHandler = fn;
            },
            write: (chunk: string) => {
                writes.push(chunk);
                return true;
            },
            end: vi.fn(),
        };
        const sse = startSse({ raw } as never);
        sse.write('card', { n: 1 });
        closeHandler();
        sse.write('card', { n: 2 });
        sse.end();
        // Only the first write got through; closed() flips to true.
        expect(writes.filter((w) => w.includes('data:'))).toHaveLength(1);
        expect(sse.closed()).toBe(true);
        expect(raw.end).not.toHaveBeenCalled();
    });
});
