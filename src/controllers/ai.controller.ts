import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    enrichWordsSchema,
    generateDeckSchema,
    suggestSchema,
} from '../schemas/ai.schema.js';
import * as aiService from '../services/ai.service.js';

export const enrichWords = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = enrichWordsSchema.parse(request.body);
    const result = await aiService.enrichWords(input);
    reply.send({ provider: aiService.providerName(), ...result });
};

export const generateDeck = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = generateDeckSchema.parse(request.body);
    const draft = await aiService.generateDeck(input);
    reply.send({ draft, provider: aiService.providerName() });
};

export const suggest = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = suggestSchema.parse(request.body);
    const suggestion = await aiService.suggest(request.currentUser.sub, input);
    reply.send(suggestion);
};
