import type { FastifyInstance } from 'fastify';
import * as sessionsController from '../controllers/sessions.controller.js';

const sessionsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.post('/sessions', sessionsController.start);
    fastify.patch('/sessions/:id', sessionsController.update);
    fastify.post('/sessions/:id/complete', sessionsController.complete);
    fastify.post('/sessions/:id/exit', sessionsController.exit);
    fastify.post('/sessions/:id/resume', sessionsController.resume);
    fastify.get('/sessions/active', sessionsController.active);
    fastify.get('/sessions/incomplete', sessionsController.latestIncomplete);
};

export default sessionsRoutes;
