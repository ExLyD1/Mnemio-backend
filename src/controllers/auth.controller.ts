import type { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from '../services/auth.service.js';
import * as googleOAuth from '../services/oauth.google.js';
import * as oauthExchange from '../services/oauth.exchange.js';
import { env } from '../config/env.js';
import {
    registerSchema,
    loginSchema,
    verifyEmailSchema,
    resendOtpSchema,
} from '../schemas/auth.schema.js';
import { BadRequestError } from '../shared/errors.js';
import {
    setRefreshCookie,
    clearRefreshCookie,
    readRefreshCookie,
    setOAuthCookies,
    readOAuthCookies,
    clearOAuthCookies,
} from '../plugins/cookies.js';

const ctxOf = (request: FastifyRequest) => ({
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
});

// Strip refreshToken from the JSON body — it lives in the cookie now.
const sendAuthResult = (
    reply: FastifyReply,
    result: authService.AuthResult,
    status = 200,
) => {
    setRefreshCookie(reply, result.refreshToken);
    const { refreshToken: _ignored, ...body } = result;
    void _ignored;
    reply.code(status).send(body);
};

export const register = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = registerSchema.parse(request.body);
    const result = await authService.register(input, ctxOf(request));
    reply.code(201).send(result);
};

export const verifyEmail = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = verifyEmailSchema.parse(request.body);
    const result = await authService.verifyEmail(request.server, input, ctxOf(request));
    sendAuthResult(reply, result);
};

export const resendOtp = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = resendOtpSchema.parse(request.body);
    const result = await authService.resendOtp(input, ctxOf(request));
    reply.send(result);
};

export const login = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = loginSchema.parse(request.body);
    const result = await authService.login(request.server, input, ctxOf(request));
    sendAuthResult(reply, result);
};

export const refresh = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readRefreshCookie(request);
    const result = await authService.refresh(request.server, token, ctxOf(request));
    sendAuthResult(reply, result);
};

export const logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readRefreshCookie(request);
    await authService.logout(token);
    clearRefreshCookie(reply);
    reply.code(204).send();
};

export const me = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await authService.me(request.currentUser.sub);
    reply.send(result);
};

// ---------- Google OAuth ----------

export const googleAuthStart = async (_request: FastifyRequest, reply: FastifyReply) => {
    googleOAuth.assertGoogleConfigured();
    const { state, codeVerifier } = googleOAuth.newStateAndVerifier();
    setOAuthCookies(reply, state, codeVerifier);
    const url = googleOAuth.buildAuthorizationUrl(state, codeVerifier);
    reply.redirect(url.toString(), 302);
};

type GoogleCallbackQuery = { code?: string; state?: string; error?: string };

export const googleAuthCallback = async (
    request: FastifyRequest<{ Querystring: GoogleCallbackQuery }>,
    reply: FastifyReply,
) => {
    const fail = (msg: string) => {
        const target = new URL('/auth/oauth/error', env.WEB_URL);
        target.searchParams.set('reason', msg);
        clearOAuthCookies(reply);
        return reply.redirect(target.toString(), 302);
    };

    if (request.query.error) return fail(request.query.error);

    const cookies = readOAuthCookies(request);
    if (!cookies) return fail('missing_state');
    if (!request.query.state || request.query.state !== cookies.state) {
        return fail('bad_state');
    }
    if (!request.query.code) return fail('missing_code');

    let profile: googleOAuth.GoogleProfile;
    try {
        profile = await googleOAuth.exchangeCodeAndFetchProfile(
            request.query.code,
            cookies.codeVerifier,
        );
    } catch (err) {
        request.log.warn({ err }, 'oauth google exchange failed');
        return fail('exchange_failed');
    }

    const result = await authService.signInWithProvider(
        request.server,
        {
            provider: 'google',
            providerUserId: profile.sub,
            email: profile.email,
            fullName: profile.name ?? null,
            emailVerifiedByProvider: profile.emailVerified,
        },
        { ip: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null },
    );
    // Set the refresh cookie immediately — the FE just needs to swap the
    // exchange code for the access token + user payload, the cookie comes
    // along automatically on the next request.
    setRefreshCookie(reply, result.refreshToken);
    clearOAuthCookies(reply);

    const exchangeCode = oauthExchange.stash(result);
    const target = new URL('/auth/oauth/callback', env.WEB_URL);
    target.searchParams.set('code', exchangeCode);
    reply.redirect(target.toString(), 302);
};

type ExchangeBody = { code?: unknown };

export const oauthExchangeCode = async (request: FastifyRequest, reply: FastifyReply) => {
    const code = (request.body as ExchangeBody)?.code;
    if (typeof code !== 'string' || code.length === 0) {
        throw new BadRequestError('OAUTH_BAD_EXCHANGE_CODE', 'Missing or invalid exchange code');
    }
    const result = oauthExchange.consume(code);
    if (!result) {
        throw new BadRequestError(
            'OAUTH_EXCHANGE_EXPIRED',
            'Exchange code expired or already used',
        );
    }
    // The cookie was already set at the callback step; only need to mirror
    // the JSON body so the FE can stash the access token.
    const { refreshToken: _ignored, ...body } = result;
    void _ignored;
    reply.send(body);
};
