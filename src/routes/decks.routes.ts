import type { FastifyInstance } from 'fastify';
import * as decksController from '../controllers/decks.controller.js';

const decksRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.get('/decks', decksController.list);
    fastify.post('/decks', decksController.create);
    fastify.get('/decks/:id', decksController.getOne);
    fastify.patch('/decks/:id', decksController.update);
    fastify.delete('/decks/:id', decksController.remove);
};

export default decksRoutes;
