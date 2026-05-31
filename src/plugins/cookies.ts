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

export const registerCookies = async (fastify: FastifyInstance): Promise<void> => {
    await fastify.register(cookie);
};
