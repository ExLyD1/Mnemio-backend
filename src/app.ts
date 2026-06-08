import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { registerCleanupJob } from './jobs/cleanup.job.js';
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
import achievementsRoutes from './routes/achievements.routes.js';
import statsRoutes from './routes/stats.routes.js';
import discoverRoutes from './routes/discover.routes.js';
import aiRoutes from './routes/ai.routes.js';
import mediaRoutes from './routes/media.routes.js';

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
        // Match our standard { code, message, details } envelope so the FE
        // doesn't need to special-case 429s from @fastify/rate-limit.
        errorResponseBuilder: (_req, context) => ({
            code: 'RATE_LIMITED',
            message: `Rate limit exceeded, retry in ${context.after}.`,
            details: { retryAfter: context.after, max: context.max },
        }),
    });

    await fastify.register(multipart, {
        // Hard ceiling for any upload; per-kind enforcement is in media.service.ts.
        limits: { fileSize: Math.max(env.MEDIA_MAX_AVATAR_BYTES, env.MEDIA_MAX_IMAGE_BYTES, env.MEDIA_MAX_AUDIO_BYTES) },
    });

    // Serve uploaded files from MEDIA_DIR under MEDIA_PUBLIC_BASE. Production
    // moves this to S3 via presigned URLs (see media.service.ts comment).
    if (env.MEDIA_STORAGE === 'local') {
        await fastify.register(fastifyStatic, {
            root: path.resolve(env.MEDIA_DIR),
            prefix: `${env.MEDIA_PUBLIC_BASE}/`,
            decorateReply: false,
        });
    }

    await registerCookies(fastify);
    await registerJwt(fastify);
    registerErrorHandler(fastify);

    // Liveness — cheap, no I/O. Uptime monitors target this.
    fastify.get('/health', async () => ({ status: 'ok' }));

    // Readiness — touches the DB. Container orchestrators (Railway, k8s)
    // target this; a 503 here means "don't route traffic yet."
    fastify.get('/ready', async (_req, reply) => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            return { status: 'ready' };
        } catch (err) {
            fastify.log.warn({ err }, 'readiness probe failed');
            return reply.code(503).send({
                code: 'NOT_READY',
                message: 'Database is not reachable.',
            });
        }
    });

    await fastify.register(
        async (api) => {
            await api.register(authRoutes);
            await api.register(usersRoutes);
            await api.register(decksRoutes);
            await api.register(cardsRoutes);
            await api.register(srsRoutes);
            await api.register(sessionsRoutes);
            await api.register(dashboardRoutes);
            await api.register(achievementsRoutes);
            await api.register(statsRoutes);
            await api.register(discoverRoutes);
            await api.register(aiRoutes);
            await api.register(mediaRoutes);
        },
        { prefix: API_PREFIX },
    );

    const stopCleanup = registerCleanupJob(fastify.log);
    if (stopCleanup) {
        fastify.addHook('onClose', async () => {
            stopCleanup();
        });
    }

    return fastify;
};
