import type { FastifyInstance } from 'fastify';
import * as cardsController from '../controllers/cards.controller.js';

const cardsRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.post('/decks/:id/cards', cardsController.create);
    fastify.post('/decks/:id/cards/bulk', cardsController.bulkCreate);
    fastify.patch('/cards/:id', cardsController.update);
    fastify.delete('/cards/:id', cardsController.remove);
};

export default cardsRoutes;
