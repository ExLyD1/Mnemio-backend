import type { FastifyInstance } from 'fastify';
import * as libraryController from '../controllers/library.controller.js';

const libraryRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.get('/library', libraryController.list);
};

export default libraryRoutes;
