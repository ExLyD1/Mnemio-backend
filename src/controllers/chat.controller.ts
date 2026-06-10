import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    createConversationSchema,
    listConversationsQuerySchema,
    renameConversationSchema,
    sendMessageSchema,
} from '../schemas/chat.schema.js';
import * as chatService from '../services/chat.service.js';
import { startSse, wantsSse } from '../shared/sse.js';
import { AppError } from '../shared/errors.js';
import {
    DEFAULT_LIMIT,
    decodeCursor,
    parseLimit,
} from '../shared/pagination.js';

type IdParams = { id: string };

export const listConversations = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = listConversationsQuerySchema.parse(request.query);
    const page = await chatService.listConversations(request.currentUser.sub, {
        cursor: decodeCursor(query.cursor),
        limit: parseLimit(query.limit, DEFAULT_LIMIT),
    });
    reply.send(page);
};

export const createConversation = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = createConversationSchema.parse(request.body ?? {});
    const conversation = await chatService.createConversation(
        request.currentUser.sub,
        input.title,
    );
    // Optional firstMessage path: defer to sendMessage so the same SSE
    // protocol applies. The FE typically POSTs the firstMessage on a
    // separate call, so we keep the two flows distinct here.
    reply.code(201).send(conversation);
};

export const getConversation = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const result = await chatService.getConversationWithMessages(
        request.currentUser.sub,
        request.params.id,
    );
    reply.send(result);
};

export const renameConversation = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = renameConversationSchema.parse(request.body);
    const conversation = await chatService.renameConversation(
        request.currentUser.sub,
        request.params.id,
        input.title,
    );
    reply.send(conversation);
};

export const deleteConversation = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    await chatService.deleteConversation(request.currentUser.sub, request.params.id);
    reply.code(204).send();
};

export const sendMessage = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = sendMessageSchema.parse(request.body);

    if (!wantsSse(request)) {
        // Non-streaming: collect frames into the final response shape.
        const result = await chatService.sendMessage(
            request.currentUser.sub,
            request.params.id,
            input.content,
            () => undefined,
        );
        reply.send(result);
        return reply;
    }

    // SSE path — emit one event per frame yielded by the service.
    const sse = startSse(reply);
    try {
        await chatService.sendMessage(
            request.currentUser.sub,
            request.params.id,
            input.content,
            (frame) => {
                switch (frame.type) {
                    case 'start':
                        sse.write('start', {
                            userMessage: frame.userMessage,
                            assistantMessageId: frame.assistantMessageId,
                        });
                        break;
                    case 'token':
                        sse.write('token', { delta: frame.delta });
                        break;
                    case 'tool_use':
                        sse.write('tool_use', {
                            name: frame.name,
                            input: frame.input,
                        });
                        break;
                    case 'tool_result':
                        sse.write('tool_result', {
                            name: frame.name,
                            ok: frame.ok,
                            data: frame.data,
                        });
                        break;
                    case 'done':
                        sse.write('done', {
                            assistantMessage: frame.assistantMessage,
                            conversationTitle: frame.conversationTitle,
                            tokensInput: frame.tokensInput,
                            tokensOutput: frame.tokensOutput,
                        });
                        break;
                }
            },
        );
    } catch (err) {
        // The service already finalized the partial assistant row before
        // re-throwing; we just need to surface the error frame to the FE.
        const body =
            err instanceof AppError
                ? err.toPayload()
                : { code: 'INTERNAL', message: (err as Error).message };
        sse.write('error', body);
    }
    sse.end();
    return reply;
};
