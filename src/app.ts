import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerJwt } from './plugins/jwt.js';
import { registerCookies } from './plugins/cookies.js';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from './routes/users.routes.js';
import decksRoutes from './routes/decks.routes.js';
import cardsRoutes from './routes/cards.routes.js';
import srsRoutes from './routes/srs.routes.js';
import sessionsRoutes from './routes/sessions.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';

export const API_PREFIX = '/api/v1';

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
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    });

    await fastify.register(rateLimit, {
        global: false,
        max: 120,
        timeWindow: '1 minute',
    });

    await registerCookies(fastify);
    await registerJwt(fastify);
    registerErrorHandler(fastify);

    fastify.get('/health', async () => ({ status: 'ok' }));

    await fastify.register(
        async (api) => {
            await api.register(authRoutes);
            await api.register(usersRoutes);
            await api.register(decksRoutes);
            await api.register(cardsRoutes);
            await api.register(srsRoutes);
            await api.register(sessionsRoutes);
            await api.register(dashboardRoutes);
        },
        { prefix: API_PREFIX },
    );

    return fastify;
};
