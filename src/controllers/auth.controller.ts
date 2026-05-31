import type { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from '../services/auth.service.js';
import {
    registerSchema,
    loginSchema,
    verifyEmailSchema,
    resendOtpSchema,
} from '../schemas/auth.schema.js';
import {
    setRefreshCookie,
    clearRefreshCookie,
    readRefreshCookie,
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
