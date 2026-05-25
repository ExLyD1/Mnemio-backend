import type { FastifyInstance } from 'fastify';
import * as srsController from '../controllers/srs.controller.js';

const srsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.post('/srs/rate', srsController.rate);
    fastify.get('/srs/due', srsController.due);
};

export default srsRoutes;
