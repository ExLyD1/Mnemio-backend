import type { FastifyInstance } from 'fastify';
import * as importsController from '../controllers/imports.controller.js';

const importsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    // Per-user rate limit. The daily-cap budget runs inside the service; this
    // is a per-minute throttle so a frantic FE can't hammer Quizlet on our IP.
    const importLimit = { max: 20, timeWindow: '1 minute' };

    fastify.post(
        '/imports/quizlet',
        { config: { rateLimit: importLimit } },
        importsController.importQuizlet,
    );
    fastify.post(
        '/imports/text',
        { config: { rateLimit: importLimit } },
        importsController.importText,
    );
};

export default importsRoutes;
