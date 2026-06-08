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
): void => {
    reply.setCookie(OAUTH_STATE, state, oauthCookieOptions());
    reply.setCookie(OAUTH_VERIFIER, codeVerifier, oauthCookieOptions());
};

export const readOAuthCookies = (
    request: FastifyRequest,
): { state: string; codeVerifier: string } | null => {
    const state = request.cookies?.[OAUTH_STATE];
    const codeVerifier = request.cookies?.[OAUTH_VERIFIER];
    if (!state || !codeVerifier) return null;
    return { state, codeVerifier };
};

export const clearOAuthCookies = (reply: FastifyReply): void => {
    reply.clearCookie(OAUTH_STATE, { path: OAUTH_COOKIE_PATH });
    reply.clearCookie(OAUTH_VERIFIER, { path: OAUTH_COOKIE_PATH });
};

export const registerCookies = async (fastify: FastifyInstance): Promise<void> => {
    await fastify.register(cookie);
};
