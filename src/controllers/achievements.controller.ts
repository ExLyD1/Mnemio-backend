import type { FastifyRequest, FastifyReply } from 'fastify';
import * as service from '../services/achievements.service.js';

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const items = await service.list(request.currentUser.sub);
    reply.send({ items });
};
