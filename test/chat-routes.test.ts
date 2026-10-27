import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi } from 'vitest';
import chatRoutes from '../src/routes/chat.routes.js';

vi.mock('../src/controllers/chat.controller.js', () => {
    const ok = async () => ({ ok: true });
    return {
        listConversations: ok,
        createConversation: ok,
        getConversation: ok,
        renameConversation: ok,
        deleteConversation: ok,
        sendMessage: ok,
        cancelReply: ok,
    };
});

describe('chat throttle', () => {
    it('isolates customers sharing an IP and authenticates before reading the user id', async () => {
        const app = Fastify();
        await app.register(rateLimit, { global: false });
        app.decorate('authenticate', async (request, reply) => {
            if (!request.headers.authorization) {
                await reply.code(401).send({ code: 'AUTH_INVALID_TOKEN' });
                return;
            }
            request.currentUser = {
                sub: request.headers.authorization,
                emailVerified: true,
                role: 'user',
            };
        });
        await app.register(chatRoutes);
        try {
            for (let i = 0; i < 30; i++) {
                expect(
                    (
                        await app.inject({
                            method: 'POST',
                            url: '/chat/conversations/c/messages',
                            headers: { authorization: 'user-a' },
                            payload: { content: 'hi' },
                        })
                    ).statusCode,
                ).toBe(200);
            }
            expect(
                (
                    await app.inject({
                        method: 'POST',
                        url: '/chat/conversations/c/messages',
                        headers: { authorization: 'user-a' },
                        payload: { content: 'hi' },
                    })
                ).statusCode,
            ).toBe(429);
            expect(
                (
                    await app.inject({
                        method: 'POST',
                        url: '/chat/conversations/c/messages',
                        headers: { authorization: 'user-b' },
                        payload: { content: 'hi' },
                    })
                ).statusCode,
            ).toBe(200);
            expect(
                (
                    await app.inject({
                        method: 'POST',
                        url: '/chat/conversations/c/messages',
                        payload: { content: 'hi' },
                    })
                ).statusCode,
            ).toBe(401);
        } finally {
            await app.close();
        }
    });
});
