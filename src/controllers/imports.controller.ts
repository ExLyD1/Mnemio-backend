import type { FastifyRequest, FastifyReply } from 'fastify';
import { importQuizletSchema, importTextSchema } from '../schemas/imports.schema.js';
import * as importsService from '../services/imports.service.js';

export const importQuizlet = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = importQuizletSchema.parse(request.body);
    const result = await importsService.importQuizletByUrl(request.currentUser.sub, input.url);
    reply.send(result);
};

export const importText = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = importTextSchema.parse(request.body);
    const result = await importsService.importByText(
        request.currentUser.sub,
        input.text,
        input.format,
    );
    reply.send(result);
};
