import type { FastifyRequest, FastifyReply } from 'fastify';
import { rateSchema, dueQuerySchema, progressQuerySchema } from '../schemas/srs.schema.js';
import * as srsService from '../services/srs.service.js';

export const rate = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = rateSchema.parse(request.body);
    const result = await srsService.rate(request.currentUser.sub, input);
    reply.send(result);
};

export const due = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = dueQuerySchema.parse(request.query);
    const items = await srsService.due(request.currentUser.sub, query.limit ?? 50);
    reply.send({ items });
};

export const progress = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = progressQuerySchema.parse(request.query);
    const items = await srsService.progress(request.currentUser.sub, query.limit ?? 2000);
    reply.send({ items });
};
