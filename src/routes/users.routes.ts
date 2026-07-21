import type { FastifyInstance } from 'fastify';
import * as usersController from '../controllers/users.controller.js';
import * as prefsController from '../controllers/preferences.controller.js';

const usersRoutes = async (fastify: FastifyInstance) => {
    fastify.patch(
        '/users/me',
        { preHandler: [fastify.authenticate] },
        usersController.updateMe,
    );

    fastify.delete(
        '/users/me',
        { preHandler: [fastify.authenticate] },
        usersController.deleteMe,
    );

    fastify.get(
        '/users/me/preferences',
        { preHandler: [fastify.authenticate] },
        prefsController.get,
    );
    fastify.patch(
        '/users/me/preferences',
        { preHandler: [fastify.authenticate] },
        prefsController.update,
    );
};

export default usersRoutes;
