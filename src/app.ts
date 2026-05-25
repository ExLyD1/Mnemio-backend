import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { registerErrorHandler } from './plugins/error-handler.js';

export const buildApp = async (): Promise<FastifyInstance> => {
    const fastify = Fastify({
        logger: {
            level: env.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken', 'req.body.code'],
            ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
        },
        trustProxy: true,
    });

    await fastify.register(cors, {
        origin: env.WEB_URL,
        credentials: true,
    });

    registerErrorHandler(fastify);

    fastify.get('/health', async () => ({ status: 'ok' }));

    return fastify;
};
