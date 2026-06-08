import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stash, consume } from '../src/services/oauth.exchange.js';
import type { AuthResult } from '../src/services/auth.service.js';

const fakeResult = (): AuthResult => ({
    accessToken: 'access',
    refreshToken: 'refresh',
    user: {
        id: 'u1',
        email: 'a@b.test',
        fullName: null,
        username: null,
        birthday: null,
        avatarUrl: null,
        emailVerified: true,
        role: 'user',
        xp: 0,
        streak: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    },
    needsProfile: true,
    welcome: { hasDeck: false, hasSession: false, hasReviewed: false },
});

describe('oauth.exchange', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('stash returns a code, consume returns the stashed result', () => {
        const r = fakeResult();
        const code = stash(r);
        expect(typeof code).toBe('string');
        expect(consume(code)).toBe(r);
    });

    it('consume is single-use — second call returns null', () => {
        const code = stash(fakeResult());
        consume(code);
        expect(consume(code)).toBeNull();
    });

    it('consume returns null for an unknown code', () => {
        expect(consume('not-a-real-code')).toBeNull();
    });

    it('stashed codes expire after 60s', () => {
        const code = stash(fakeResult());
        vi.advanceTimersByTime(60_001);
        expect(consume(code)).toBeNull();
    });
});
