import type { FastifyRequest, FastifyReply } from 'fastify';
import { libraryQuerySchema } from '../schemas/library.schema.js';
import * as libraryService from '../services/library.service.js';

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = libraryQuerySchema.parse(request.query);
    reply.send(await libraryService.list(request.currentUser.sub, query));
};
