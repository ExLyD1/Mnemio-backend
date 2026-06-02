import type { FastifyRequest, FastifyReply } from 'fastify';
import { updatePreferencesSchema } from '../schemas/preferences.schema.js';
import * as service from '../services/preferences.service.js';

export const get = async (request: FastifyRequest, reply: FastifyReply) => {
    const pref = await service.get(request.currentUser.sub);
    reply.send(pref);
};

export const update = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = updatePreferencesSchema.parse(request.body);
    const pref = await service.update(request.currentUser.sub, input);
    reply.send(pref);
};
