import type { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from '../services/auth.service.js';
import {
    registerSchema,
    loginSchema,
    verifyEmailSchema,
    resendOtpSchema,
    refreshSchema,
    logoutSchema,
} from '../schemas/auth.schema.js';

const ctxOf = (request: FastifyRequest) => ({
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
});

export const register = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = registerSchema.parse(request.body);
    const result = await authService.register(input, ctxOf(request));
    reply.code(201).send(result);
};

export const verifyEmail = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = verifyEmailSchema.parse(request.body);
    const result = await authService.verifyEmail(request.server, input, ctxOf(request));
    reply.send(result);
};

export const resendOtp = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = resendOtpSchema.parse(request.body);
    const result = await authService.resendOtp(input, ctxOf(request));
    reply.send(result);
};

export const login = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = loginSchema.parse(request.body);
    const result = await authService.login(request.server, input, ctxOf(request));
    reply.send(result);
};

export const refresh = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = refreshSchema.parse(request.body);
    const result = await authService.refresh(request.server, input, ctxOf(request));
    reply.send(result);
};

export const logout = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = logoutSchema.parse(request.body);
    await authService.logout(input);
    reply.code(204).send();
};

export const me = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await authService.me(request.currentUser.sub);
    reply.send(result);
};
