import { describe, expect, it } from 'vitest';
import {
    classifyRefreshRecord,
    REFRESH_REUSE_GRACE_MS,
} from '../src/services/auth.service.js';

const now = new Date('2026-09-18T10:00:00Z');
const future = new Date('2026-10-18T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const HOUR = 3_600_000;

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

    it('token revoked by logout (no replacement) never gets grace', () => {
        expect(
            classifyRefreshRecord(
                { revokedAt: ago(1_000), replacedById: null, expiresAt: future },
                now,
            ),
        ).toBe('reused');
    });

    // --- Regression: the "logged out the next day" family of bugs. ---
    // Every case below used to classify as `reused`, which made refresh() call
    // revokeAllUserRefreshTokens() and kill the session on every device.

    it('token rotated just past the grace window is a rotation artifact, not theft', () => {
        expect(
            classifyRefreshRecord(
                {
                    revokedAt: ago(REFRESH_REUSE_GRACE_MS + 1),
                    replacedById: 'next',
                    expiresAt: future,
                },
                now,
            ),
        ).toBe('rotated_stale');
    });

    it('second device holding a token the first rotated hours ago still refreshes', () => {
        expect(
            classifyRefreshRecord(
                { revokedAt: ago(3 * HOUR), replacedById: 'next', expiresAt: future },
                now,
            ),
        ).toBe('rotated_stale');
    });

    it('client that slept overnight (lost the rotation response) still refreshes', () => {
        expect(
            classifyRefreshRecord(
                { revokedAt: ago(20 * HOUR), replacedById: 'next', expiresAt: future },
                now,
            ),
        ).toBe('rotated_stale');
    });

    it('rotated token replayed after its own expiry is treated as reuse', () => {
        expect(
            classifyRefreshRecord(
                { revokedAt: ago(40 * 24 * HOUR), replacedById: 'next', expiresAt: ago(HOUR) },
                now,
            ),
        ).toBe('reused');
    });

    it('rotation artifact and logout replay are never confused', () => {
        const rotated = classifyRefreshRecord(
            { revokedAt: ago(5 * HOUR), replacedById: 'next', expiresAt: future },
            now,
        );
        const loggedOut = classifyRefreshRecord(
            { revokedAt: ago(5 * HOUR), replacedById: null, expiresAt: future },
            now,
        );
        expect(rotated).toBe('rotated_stale');
        expect(loggedOut).toBe('reused');
    });
});
