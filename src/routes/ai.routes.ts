import type { FastifyInstance } from 'fastify';
import * as aiController from '../controllers/ai.controller.js';

const aiRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    // Tight per-user rate limit — generation prompts are expensive once a real
    // provider is wired. The numbers are mock-friendly today.
    const aiLimit = { max: 30, timeWindow: '1 minute' };

    fastify.post(
        '/ai/enrich-words',
        { config: { rateLimit: aiLimit } },
        aiController.enrichWords,
    );
    fastify.post(
        '/ai/generate-deck',
        { config: { rateLimit: aiLimit } },
        aiController.generateDeck,
    );
    fastify.post(
        '/ai/suggest',
        { config: { rateLimit: aiLimit } },
        aiController.suggest,
    );
};

export default aiRoutes;
