import type { FastifyInstance } from 'fastify';
import * as discoverController from '../controllers/discover.controller.js';

const discoverRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    fastify.get('/discover/decks', discoverController.list);
    fastify.get('/discover/featured', discoverController.featured);
    fastify.get('/discover/categories', discoverController.categories);

    // Clone a public deck into the viewer's account. Lives under /decks/:id/copy
    // (closer to the deck-resource verb than under /discover) but the FE call
    // is identical from a discover surface.
    fastify.post('/decks/:id/copy', discoverController.copy);
};

export default discoverRoutes;
