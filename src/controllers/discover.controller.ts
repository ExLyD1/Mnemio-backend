import type { FastifyRequest, FastifyReply } from 'fastify';
import { discoverListQuerySchema } from '../schemas/discover.schema.js';
import * as discoverService from '../services/discover.service.js';

type IdParams = { id: string };

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = discoverListQuerySchema.parse(request.query);
    const result = await discoverService.list(request.currentUser.sub, query);
    reply.send(result);
};

export const featured = async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await discoverService.featured();
    reply.send(result);
};

export const categories = async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await discoverService.categories();
    reply.send(result);
};

export const copy = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const deck = await discoverService.copy(request.currentUser.sub, request.params.id);
    reply.code(201).send(deck);
};
