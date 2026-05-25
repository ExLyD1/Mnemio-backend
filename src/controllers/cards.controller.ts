import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    createCardSchema,
    updateCardSchema,
    bulkCreateCardsSchema,
} from '../schemas/card.schema.js';
import * as cardsService from '../services/cards.service.js';

type DeckParams = { id: string };
type CardParams = { id: string };

export const create = async (
    request: FastifyRequest<{ Params: DeckParams }>,
    reply: FastifyReply,
) => {
    const input = createCardSchema.parse(request.body);
    const card = await cardsService.create(request.currentUser.sub, request.params.id, input);
    reply.code(201).send(card);
};

export const bulkCreate = async (
    request: FastifyRequest<{ Params: DeckParams }>,
    reply: FastifyReply,
) => {
    const input = bulkCreateCardsSchema.parse(request.body);
    const result = await cardsService.bulkCreate(request.currentUser.sub, request.params.id, input);
    reply.code(201).send(result);
};

export const update = async (
    request: FastifyRequest<{ Params: CardParams }>,
    reply: FastifyReply,
) => {
    const input = updateCardSchema.parse(request.body);
    const card = await cardsService.update(request.currentUser.sub, request.params.id, input);
    reply.send(card);
};

export const remove = async (
    request: FastifyRequest<{ Params: CardParams }>,
    reply: FastifyReply,
) => {
    await cardsService.remove(request.currentUser.sub, request.params.id);
    reply.code(204).send();
};
