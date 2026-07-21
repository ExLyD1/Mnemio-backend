import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    enrichWordsSchema,
    generateDeckSchema,
    suggestSchema,
} from '../schemas/ai.schema.js';
import * as aiService from '../services/ai.service.js';
import { startSse, wantsSse } from '../shared/sse.js';
import { AppError } from '../shared/errors.js';

export const enrichWords = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = enrichWordsSchema.parse(request.body);
    if (!wantsSse(request)) {
        const result = await aiService.enrichWords(request.currentUser.sub, input);
        reply.send({ provider: aiService.providerName(), ...result });
        return reply;
    }

    // SSE path. Emit one `card` event per word, then `done`. On error mid-stream,
    // emit an `error` event so the FE can show a partial-failure toast without
    // re-throwing on the response that's already been flushed.
    const sse = startSse(reply);
    sse.write('start', { provider: aiService.providerName() });
    try {
        await aiService.enrichWords(request.currentUser.sub, input, {
            onCard: (event) => sse.write(event.type, event),
        });
    } catch (err) {
        const body =
            err instanceof AppError
                ? err.toPayload()
                : { code: 'INTERNAL', message: (err as Error).message };
        sse.write('error', body);
    }
    sse.end();
    return reply;
};

export const generateDeck = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = generateDeckSchema.parse(request.body);
    if (!wantsSse(request)) {
        const draft = await aiService.generateDeck(request.currentUser.sub, input);
        reply.send({ draft, provider: aiService.providerName() });
        return reply;
    }

    const sse = startSse(reply);
    sse.write('start', { provider: aiService.providerName() });
    try {
        await aiService.generateDeck(request.currentUser.sub, input, {
            onEvent: (event) => sse.write(event.type, event),
        });
    } catch (err) {
        const body =
            err instanceof AppError
                ? err.toPayload()
                : { code: 'INTERNAL', message: (err as Error).message };
        sse.write('error', body);
    }
    sse.end();
    return reply;
};

export const suggest = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = suggestSchema.parse(request.body);
    const suggestion = await aiService.suggest(request.currentUser.sub, input);
    reply.send(suggestion);
};
