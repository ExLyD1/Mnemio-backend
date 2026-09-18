import { describe, expect, it } from 'vitest';
import {
    classifyRefreshRecord,
    REFRESH_REUSE_GRACE_MS,
} from '../src/services/auth.service.js';

const now = new Date('2026-09-18T10:00:00Z');
const future = new Date('2026-10-18T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('auth.service / classifyRefreshRecord', () => {
    it('missing record is invalid', () => {
        expect(classifyRefreshRecord(null, now)).toBe('invalid');
    });

    it('live, unexpired token is valid', () => {
        expect(
            classifyRefreshRecord({ revokedAt: null, replacedById: null, expiresAt: future }, now),
        ).toBe('valid');
    });

    it('expired, never-revoked token is invalid (no family revoke)', () => {
        expect(
            classifyRefreshRecord({ revokedAt: null, replacedById: null, expiresAt: ago(1) }, now),
        ).toBe('invalid');
    });

    it('token rotated a few seconds ago is a benign race, not theft', () => {
        expect(
            classifyRefreshRecord(
                { revokedAt: ago(3_000), replacedById: 'next', expiresAt: future },
                now,
            ),
        ).toBe('rotated_grace');
    });

    it('token rotated longer ago than the grace window is reuse', () => {
        expect(
            classifyRefreshRecord(
                {
                    revokedAt: ago(REFRESH_REUSE_GRACE_MS + 1),
                    replacedById: 'next',
                    expiresAt: future,
                },
                now,
            ),
        ).toBe('reused');
    });

    it('token revoked by logout (no replacement) never gets grace', () => {
        expect(
            classifyRefreshRecord({ revokedAt: ago(1_000), replacedById: null, expiresAt: future }, now),
        ).toBe('reused');
    });
});
