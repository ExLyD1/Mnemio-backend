import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { env } from '../config/env.js';

export const REFRESH_COOKIE_NAME = 'mnemio_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const isProd = env.NODE_ENV === 'production';

const refreshCookieOptions = (maxAgeSeconds: number) => ({
    httpOnly: true,
    secure: isProd, // Dev runs over http; relax Secure so the browser still stores the cookie.
    sameSite: 'lax' as const,
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeSeconds,
    // Expires mirrors Max-Age so all browsers treat the cookie as persistent.
    // Max-Age takes precedence in modern browsers; Expires is the fallback.
    expires: new Date(Date.now() + maxAgeSeconds * 1000),
});

export const setRefreshCookie = (reply: FastifyReply, token: string): void => {
    const maxAge = env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60;
    reply.setCookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(maxAge));
};

export const clearRefreshCookie = (reply: FastifyReply): void => {
    reply.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
};

export const readRefreshCookie = (request: FastifyRequest): string | null => {
    const value = request.cookies?.[REFRESH_COOKIE_NAME];
    return value && value.length > 0 ? value : null;
};

// ---------- OAuth state + PKCE cookies ----------
//
// Used between GET /auth/oauth/google → Google → /callback. Scoped narrowly
// to the OAuth callback path and TTL'd to ~10 min so they don't linger.
const OAUTH_STATE = 'mnemio_oauth_state';
const OAUTH_VERIFIER = 'mnemio_oauth_verifier';
// Which frontend origin to send the browser back to once the OAuth
// round-trip completes — set only when the start request supplied a
// validated returnOrigin (see webOrigins.ts). Absent → callers fall back to
// env.WEB_URL, same as before this cookie existed.
const OAUTH_RETURN_ORIGIN = 'mnemio_oauth_return_origin';
const OAUTH_COOKIE_PATH = '/api/v1/auth/oauth';
const OAUTH_TTL = 10 * 60;

const oauthCookieOptions = () => ({
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_TTL,
});

export const setOAuthCookies = (
    reply: FastifyReply,
    state: string,
    codeVerifier: string,
    returnOrigin?: string | null,
): void => {
    reply.setCookie(OAUTH_STATE, state, oauthCookieOptions());
    reply.setCookie(OAUTH_VERIFIER, codeVerifier, oauthCookieOptions());
    if (returnOrigin) {
        reply.setCookie(OAUTH_RETURN_ORIGIN, returnOrigin, oauthCookieOptions());
    }
};

export const readOAuthCookies = (
    request: FastifyRequest,
): { state: string; codeVerifier: string; returnOrigin: string | null } | null => {
    const state = request.cookies?.[OAUTH_STATE];
    const codeVerifier = request.cookies?.[OAUTH_VERIFIER];
    if (!state || !codeVerifier) return null;
    const returnOrigin = request.cookies?.[OAUTH_RETURN_ORIGIN];
    return { state, codeVerifier, returnOrigin: returnOrigin && returnOrigin.length > 0 ? returnOrigin : null };
};

export const clearOAuthCookies = (reply: FastifyReply): void => {
    reply.clearCookie(OAUTH_STATE, { path: OAUTH_COOKIE_PATH });
    reply.clearCookie(OAUTH_VERIFIER, { path: OAUTH_COOKIE_PATH });
    reply.clearCookie(OAUTH_RETURN_ORIGIN, { path: OAUTH_COOKIE_PATH });
};

export const registerCookies = async (fastify: FastifyInstance): Promise<void> => {
    await fastify.register(cookie);
};
