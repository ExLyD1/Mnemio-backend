import type { FastifyInstance } from 'fastify';
import * as usersController from '../controllers/users.controller.js';

const usersRoutes = async (fastify: FastifyInstance) => {
    fastify.patch(
        '/users/me',
        { preHandler: [fastify.authenticate] },
        usersController.updateMe,
    );
};

export default usersRoutes;
