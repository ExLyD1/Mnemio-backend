import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    createDeckSchema,
    updateDeckSchema,
    deckListQuerySchema,
    deckDetailQuerySchema,
} from '../schemas/deck.schema.js';
import * as decksService from '../services/decks.service.js';

type IdParams = { id: string };

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = deckListQuerySchema.parse(request.query);
    const result = await decksService.list(request.currentUser.sub, query);
    reply.send(result);
};

export const create = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = createDeckSchema.parse(request.body);
    const deck = await decksService.create(request.currentUser.sub, input);
    reply.code(201).send(deck);
};

export const getOne = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const query = deckDetailQuerySchema.parse(request.query);
    const result = await decksService.getOne(request.currentUser.sub, request.params.id, query);
    reply.send(result);
};

export const update = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = updateDeckSchema.parse(request.body);
    const deck = await decksService.update(request.currentUser.sub, request.params.id, input);
    reply.send(deck);
};

export const remove = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    await decksService.remove(request.currentUser.sub, request.params.id);
    reply.code(204).send();
};
