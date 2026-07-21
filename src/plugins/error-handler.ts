import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';
import { captureUnexpected } from './sentry.js';

export const registerErrorHandler = (fastify: FastifyInstance) => {
    fastify.setErrorHandler((rawError, request, reply) => {
        const error = rawError as FastifyError & { code?: string };

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
                message: error.message ?? 'Validation failed',
                details: { issues: error.validation },
            });
        }

        // Prisma known constraint errors (P2002 unique, P2025 not found)
        if (error.code === 'P2002') {
            return reply.status(409).send({
                code: 'CONFLICT',
                message: 'A record with this value already exists',
            });
        }
        if (error.code === 'P2025') {
            return reply.status(404).send({ code: 'NOT_FOUND', message: 'Record not found' });
        }

        request.log.error({ err: error }, 'Unhandled error');
        // Only unexpected failures get reported — AppError/Zod/Prisma constraint
        // errors are domain-expected and would just be noise in Sentry.
        captureUnexpected(error);

        const message = env.NODE_ENV === 'production' ? 'Internal server error' : (error.message ?? 'Internal error');
        return reply.status(500).send({ code: 'INTERNAL', message });
    });

    fastify.setNotFoundHandler((request, reply) => {
        reply.status(404).send({ code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` });
    });
};
