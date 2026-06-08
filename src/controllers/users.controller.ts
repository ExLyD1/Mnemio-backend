import type { FastifyRequest, FastifyReply } from 'fastify';
import { updateMeSchema } from '../schemas/users.schema.js';
import * as usersService from '../services/users.service.js';
import { clearRefreshCookie } from '../plugins/cookies.js';

export const updateMe = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = updateMeSchema.parse(request.body);
    const result = await usersService.updateMe(request.currentUser.sub, input);
    reply.send(result);
};

export const deleteMe = async (request: FastifyRequest, reply: FastifyReply) => {
    await usersService.deleteMe(request.currentUser.sub, {
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
    });
    // Cascade already revokes the refresh token row; also clear the cookie
    // so the browser doesn't send a stale value on its next request.
    clearRefreshCookie(reply);
    reply.code(204).send();
};
