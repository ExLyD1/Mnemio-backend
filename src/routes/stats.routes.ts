import type { FastifyInstance } from 'fastify';
import * as statsController from '../controllers/stats.controller.js';

const statsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.get('/stats/overview', statsController.overview);
    fastify.get('/stats/series', statsController.series);
    fastify.get('/stats/activity', statsController.activity);
    fastify.get('/stats/decks', statsController.decks);
};

export default statsRoutes;
