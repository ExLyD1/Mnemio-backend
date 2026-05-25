import type { FastifyRequest, FastifyReply } from 'fastify';
import { updateMeSchema } from '../schemas/users.schema.js';
import * as usersService from '../services/users.service.js';

export const updateMe = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = updateMeSchema.parse(request.body);
    const result = await usersService.updateMe(request.currentUser.sub, input);
    reply.send(result);
};
