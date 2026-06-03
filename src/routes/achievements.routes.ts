import type { FastifyInstance } from 'fastify';
import * as achievementsController from '../controllers/achievements.controller.js';

const achievementsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);
    fastify.get('/achievements', achievementsController.list);
};

export default achievementsRoutes;
