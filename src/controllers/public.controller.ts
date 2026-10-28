import type { FastifyRequest, FastifyReply } from 'fastify';
import { discoverListQuerySchema } from '../schemas/discover.schema.js';
import * as publicService from '../services/public.service.js';

type IdParams = { id: string };

export const discoverDecks = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = discoverListQuerySchema.parse(request.query);
    const result = await publicService.listPublicDecks(query);
    reply.send(result);
};

export const discoverCategories = async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await publicService.publicCategories();
    reply.send(result);
};

export const deckById = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const result = await publicService.getPublicDeck(request.params.id);
    reply.send(result);
};

export const sitemapDecks = async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await publicService.sitemapDecks();
    reply.send(result);
};

export const taxonomy = async (_request: FastifyRequest, reply: FastifyReply) => {
    // Changes only on deploy; let browsers and the SSR layer reuse it.
    reply.header('Cache-Control', 'public, max-age=3600');
    reply.send(publicService.taxonomy());
};
