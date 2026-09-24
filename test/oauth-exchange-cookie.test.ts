import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import * as oauthExchange from '../src/services/oauth.exchange.js';
import { oauthExchangeCode } from '../src/controllers/auth.controller.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../src/plugins/cookies.js';

// Regression for the OAuth session bug: the refresh cookie used to be set
// during the Google callback, which runs on the BACKEND origin, while every
// later /auth/refresh goes to the FE origin through the Nuxt /api proxy. The
// cookie was invisible there, so every Google user was logged out when their
// 15-minute access token expired. POST /auth/oauth/exchange is the only
// same-origin step, so the cookie must be set here.
const buildApp = async () => {
    const app = Fastify();
    await app.register(cookie);
    registerErrorHandler(app);
    app.post('/auth/oauth/exchange', oauthExchangeCode);
    return app;
};

const authResult = {
    accessToken: 'access-1',
    refreshToken: 'refresh-opaque-1',
    user: { id: 'u1', email: 'a@b.c' },
    needsProfile: false,
    welcome: {},
    plan: 'free' as const,
};

describe('POST /auth/oauth/exchange', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('sets the refresh cookie on the same-origin exchange response', async () => {
        vi.spyOn(oauthExchange, 'consume').mockReturnValue(authResult as never);
        const app = await buildApp();
        const res = await app.inject({
            method: 'POST',
            url: '/auth/oauth/exchange',
            payload: { code: 'exchange-code' },
        });
        expect(res.statusCode).toBe(200);
        const setCookie = res.headers['set-cookie'];
        const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie ?? '');
        expect(raw).toContain(`${REFRESH_COOKIE_NAME}=refresh-opaque-1`);
        expect(raw).toContain(`Path=${REFRESH_COOKIE_PATH}`);
        expect(raw).toContain('HttpOnly');
        expect(raw).toContain('SameSite=Lax');
        // Persistent, not a session cookie — otherwise closing the browser
        // logs the user out regardless of the 30-day server-side lifetime.
        expect(raw).toMatch(/Max-Age=\d+/);
    });

    it('never puts the opaque refresh token in the JSON body', async () => {
        vi.spyOn(oauthExchange, 'consume').mockReturnValue(authResult as never);
        const app = await buildApp();
        const res = await app.inject({
            method: 'POST',
            url: '/auth/oauth/exchange',
            payload: { code: 'exchange-code' },
        });
        const body = res.json();
        expect(body.refreshToken).toBeUndefined();
        expect(body.accessToken).toBe('access-1');
        // The plan must ride along so a premium user is not treated as free.
        expect(body.plan).toBe('free');
    });

    it('rejects a missing exchange code without setting a cookie', async () => {
        const app = await buildApp();
        const res = await app.inject({ method: 'POST', url: '/auth/oauth/exchange', payload: {} });
        expect(res.statusCode).toBe(400);
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('rejects an expired or reused exchange code', async () => {
        vi.spyOn(oauthExchange, 'consume').mockReturnValue(null);
        const app = await buildApp();
        const res = await app.inject({
            method: 'POST',
            url: '/auth/oauth/exchange',
            payload: { code: 'stale' },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('OAUTH_EXCHANGE_EXPIRED');
        expect(res.headers['set-cookie']).toBeUndefined();
    });
});
