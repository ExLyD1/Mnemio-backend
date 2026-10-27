import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { getConversation } from '../src/controllers/chat.controller.js';
import * as service from '../src/services/chat.service.js';
import { encodeCursor } from '../src/shared/pagination.js';
import { ChatNotFoundError } from '../src/shared/errors.js';

vi.mock('../src/services/chat.service.js', () => ({ getConversationWithMessages: vi.fn() }));

it('GET validates and forwards the before cursor and returns hasMore', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
        request.currentUser = { sub: 'u', emailVerified: true, role: 'user' };
    });
    app.setErrorHandler((err, _req, reply) => {
        const error = err as { statusCode?: number; code?: string };
        reply.code(error.statusCode ?? 400).send({ code: error.code });
    });
    app.get('/chat/conversations/:id', getConversation);
    const cursor = { ts: '2026-10-20T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' };
    const page = { conversation: { id: 'c' }, messages: [], hasMore: false, before: null };
    vi.mocked(service.getConversationWithMessages).mockResolvedValue(page as never);
    try {
        const response = await app.inject(`/chat/conversations/c?before=${encodeCursor(cursor)}`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(page);
        expect(service.getConversationWithMessages).toHaveBeenCalledWith('u', 'c', cursor);
        for (const value of [
            'broken',
            encodeCursor({ ts: 'bad-date', id: cursor.id }),
            encodeCursor({ ts: cursor.ts, id: 'bad-id' }),
        ]) {
            const bad = await app.inject(`/chat/conversations/c?before=${value}`);
            expect(bad.statusCode).toBe(400);
            expect(bad.json().code).toBe('INVALID_CURSOR');
        }
        vi.mocked(service.getConversationWithMessages).mockRejectedValue(new ChatNotFoundError());
        expect(
            (await app.inject(`/chat/conversations/foreign?before=${encodeCursor(cursor)}`))
                .statusCode,
        ).toBe(404);
    } finally {
        await app.close();
    }
});
