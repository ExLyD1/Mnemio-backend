import type { FastifyRequest, FastifyReply } from 'fastify';
import * as service from '../services/achievements.service.js';
import { ackAchievementsSchema } from '../schemas/achievements.schema.js';

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const items = await service.list(request.currentUser.sub);
    reply.send({ items });
};

export const unseen = async (request: FastifyRequest, reply: FastifyReply) => {
    const items = await service.listUnseen(request.currentUser.sub);
    reply.send({ items });
};

export const ack = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = ackAchievementsSchema.parse(request.body ?? {});
    const acknowledged = await service.acknowledge(request.currentUser.sub, input.keys);
    reply.send({ acknowledged });
};
