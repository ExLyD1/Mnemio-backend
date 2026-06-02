import type { FastifyInstance } from 'fastify';
import * as mediaController from '../controllers/media.controller.js';

const mediaRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.post(
        '/media/uploads',
        { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        mediaController.upload,
    );
};

export default mediaRoutes;
