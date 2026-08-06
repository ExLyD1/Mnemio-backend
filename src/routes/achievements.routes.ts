import type { FastifyInstance } from 'fastify';
import * as achievementsController from '../controllers/achievements.controller.js';

const achievementsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);
    fastify.get('/achievements', achievementsController.list);
    fastify.get('/achievements/unseen', achievementsController.unseen);
    fastify.post('/achievements/ack', achievementsController.ack);
};

export default achievementsRoutes;
