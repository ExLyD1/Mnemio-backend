import type { FastifyInstance } from 'fastify';
import * as chatController from '../controllers/chat.controller.js';

const chatRoutes = async (fastify: FastifyInstance) => {
    fastify.addHook('preHandler', fastify.authenticate);

    // Per-route rate limit matches /ai/*: 30/min/user. The daily-cap budget
    // (50 msgs/day default) is enforced inside chat.service.ts on send.
    const chatLimit = { max: 30, timeWindow: '1 minute' };

    fastify.get(
        '/chat/conversations',
        { config: { rateLimit: chatLimit } },
        chatController.listConversations,
    );
    fastify.post(
        '/chat/conversations',
        { config: { rateLimit: chatLimit } },
        chatController.createConversation,
    );
    fastify.get(
        '/chat/conversations/:id',
        { config: { rateLimit: chatLimit } },
        chatController.getConversation,
    );
    fastify.patch(
        '/chat/conversations/:id',
        { config: { rateLimit: chatLimit } },
        chatController.renameConversation,
    );
    fastify.delete(
        '/chat/conversations/:id',
        { config: { rateLimit: chatLimit } },
        chatController.deleteConversation,
    );
    fastify.post(
        '/chat/conversations/:id/messages',
        { config: { rateLimit: chatLimit } },
        chatController.sendMessage,
    );
};

export default chatRoutes;
