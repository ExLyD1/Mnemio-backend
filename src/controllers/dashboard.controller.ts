import type { FastifyRequest, FastifyReply } from 'fastify';
import * as dashboardService from '../services/dashboard.service.js';

export const get = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await dashboardService.get(request.currentUser.sub);
    reply.send(result);
};
