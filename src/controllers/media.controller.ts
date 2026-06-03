import type { FastifyRequest, FastifyReply } from 'fastify';
import { uploadQuerySchema } from '../schemas/media.schema.js';
import * as mediaService from '../services/media.service.js';
import { BadRequestError } from '../shared/errors.js';

export const upload = async (request: FastifyRequest, reply: FastifyReply) => {
    const { kind } = uploadQuerySchema.parse(request.query);
    const file = await request.file();
    if (!file) {
        throw new BadRequestError(
            'MEDIA_NO_FILE',
            'Send the file as a multipart/form-data field named "file"',
        );
    }
    if (kind === 'avatar') {
        const result = await mediaService.uploadAvatar(request.currentUser.sub, file);
        reply.code(201).send(result);
        return;
    }
    const result = await mediaService.uploadFile(request.currentUser.sub, kind, file);
    reply.code(201).send(result);
};
