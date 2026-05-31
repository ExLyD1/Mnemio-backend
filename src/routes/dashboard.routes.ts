import type { FastifyInstance } from 'fastify';
import * as dashboardController from '../controllers/dashboard.controller.js';

const dashboardRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);
    fastify.get('/dashboard', dashboardController.get);
};

export default dashboardRoutes;
