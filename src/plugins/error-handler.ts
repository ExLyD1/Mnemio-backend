import type { FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';

export const registerErrorHandler = (fastify: FastifyInstance) => {
    fastify.setErrorHandler((error, request, reply) => {
        if (error instanceof AppError) {
            return reply.status(error.statusCode).send(error.toPayload());
        }

        if (error instanceof ZodError) {
            return reply.status(400).send({
                code: 'VALIDATION_ERROR',
                message: 'Invalid request payload',
                details: z.treeifyError(error),
            });
        }

        // Fastify built-in validation errors
        if (error.validation) {
            return reply.status(400).send({
                code: 'VALIDATION_ERROR',
                message: error.message,
                details: { issues: error.validation },
            });
        }

        // Prisma known constraint errors (P2002 unique, P2025 not found)
        const code = (error as { code?: string }).code;
        if (code === 'P2002') {
            return reply.status(409).send({
                code: 'CONFLICT',
                message: 'A record with this value already exists',
            });
        }
        if (code === 'P2025') {
            return reply.status(404).send({ code: 'NOT_FOUND', message: 'Record not found' });
        }

        request.log.error({ err: error }, 'Unhandled error');

        const message = env.NODE_ENV === 'production' ? 'Internal server error' : error.message;
        return reply.status(500).send({ code: 'INTERNAL', message });
    });

    fastify.setNotFoundHandler((request, reply) => {
        reply.status(404).send({ code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` });
    });
};
