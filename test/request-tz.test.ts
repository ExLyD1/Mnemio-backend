import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requestTz } from '../src/shared/request-tz.js';

const req = (headers: Record<string, unknown>, query: unknown = {}) =>
    ({ headers, query }) as unknown as FastifyRequest;

describe('shared / requestTz', () => {
    it('prefers the X-Timezone header', () => {
        expect(requestTz(req({ 'x-timezone': 'Europe/Kyiv' }, { tz: 'Asia/Tokyo' }))).toBe(
            'Europe/Kyiv',
        );
    });

    it('falls back to the tz query param when no header is sent', () => {
        expect(requestTz(req({}, { tz: 'Europe/Vienna' }))).toBe('Europe/Vienna');
    });

    // Regression: `??` only skips undefined, so an empty header shadowed the
    // query param and silently fell back to UTC — the wrong-day bucketing that
    // local-day stats exist to avoid.
    it('treats an empty header as absent, not as a value', () => {
        expect(requestTz(req({ 'x-timezone': '' }, { tz: 'Europe/Vienna' }))).toBe('Europe/Vienna');
    });

    it('treats a whitespace-only header as absent', () => {
        expect(requestTz(req({ 'x-timezone': '   ' }, { tz: 'Europe/Vienna' }))).toBe(
            'Europe/Vienna',
        );
    });

    it('falls back to UTC when neither is usable', () => {
        expect(requestTz(req({ 'x-timezone': '' }, {}))).toBe('UTC');
    });

    it('rejects a junk zone rather than throwing', () => {
        expect(requestTz(req({ 'x-timezone': 'Not/AZone' }, {}))).toBe('UTC');
    });

    it('uses the first value when the header repeats', () => {
        expect(requestTz(req({ 'x-timezone': ['Europe/Kyiv', 'Asia/Tokyo'] }, {}))).toBe(
            'Europe/Kyiv',
        );
    });
});
