import type { FastifyInstance } from 'fastify';
import { createUser } from '../controllers/user.controller.js';

const userRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/create-user', createUser);
};

export default userRoutes;
