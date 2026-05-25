import type { FastifyRequest, FastifyReply } from 'fastify';
import { createSessionSchema, updateSessionSchema } from '../schemas/session.schema.js';
import * as sessionsService from '../services/sessions.service.js';

type IdParams = { id: string };

export const start = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = createSessionSchema.parse(request.body);
    const session = await sessionsService.start(request.currentUser.sub, input);
    reply.code(201).send(session);
};

export const update = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = updateSessionSchema.parse(request.body);
    const session = await sessionsService.updateProgress(
        request.currentUser.sub,
        request.params.id,
        input,
    );
    reply.send(session);
};

export const complete = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const session = await sessionsService.complete(request.currentUser.sub, request.params.id);
    reply.send(session);
};

export const latestIncomplete = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await sessionsService.latestIncomplete(request.currentUser.sub);
    reply.send({ session });
};
