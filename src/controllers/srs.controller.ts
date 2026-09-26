import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    rateSchema,
    dueQuerySchema,
    queueQuerySchema,
    progressQuerySchema,
} from '../schemas/srs.schema.js';
import * as srsService from '../services/srs.service.js';
import { requestTz } from '../shared/request-tz.js';

export const rate = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = rateSchema.parse(request.body);
    const result = await srsService.rate(request.currentUser.sub, input, requestTz(request));
    reply.send(result);
};

export const due = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = dueQuerySchema.parse(request.query);
    const items = await srsService.due(request.currentUser.sub, query.limit ?? 50);
    reply.send({ items });
};

// The whole review queue in one response — see srsService.queue.
export const queue = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = queueQuerySchema.parse(request.query);
    const items = await srsService.queue(request.currentUser.sub, query.limit ?? 500);
    reply.send({ items });
};

export const progress = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = progressQuerySchema.parse(request.query);
    const items = await srsService.progress(request.currentUser.sub, query.limit ?? 2000);
    reply.send({ items });
};
