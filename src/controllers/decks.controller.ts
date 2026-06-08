import type { FastifyRequest, FastifyReply } from 'fastify';
import {
    createDeckSchema,
    updateDeckSchema,
    deckListQuerySchema,
    deckDetailQuerySchema,
} from '../schemas/deck.schema.js';
import { deckExportQuerySchema, deckImportSchema } from '../schemas/imports.schema.js';
import * as decksService from '../services/decks.service.js';
import * as deckExportService from '../services/deck-export.service.js';
import * as deckImportService from '../services/deck-import.service.js';

type IdParams = { id: string };

export const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = deckListQuerySchema.parse(request.query);
    const result = await decksService.list(request.currentUser.sub, query);
    reply.send(result);
};

export const create = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = createDeckSchema.parse(request.body);
    const deck = await decksService.create(request.currentUser.sub, input);
    reply.code(201).send(deck);
};

export const getOne = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const query = deckDetailQuerySchema.parse(request.query);
    const result = await decksService.getOne(request.currentUser.sub, request.params.id, query);
    reply.send(result);
};

export const update = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = updateDeckSchema.parse(request.body);
    const deck = await decksService.update(request.currentUser.sub, request.params.id, input);
    reply.send(deck);
};

export const remove = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    await decksService.remove(request.currentUser.sub, request.params.id);
    reply.code(204).send();
};

export const exportDeck = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const { format } = deckExportQuerySchema.parse(request.query);
    const result = await deckExportService.exportDeck(
        request.currentUser.sub,
        request.params.id,
        format,
    );
    reply
        .header('Content-Type', result.contentType)
        .header('Content-Disposition', `attachment; filename="${result.filename}"`)
        .send(result.body);
};

export const importCards = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
) => {
    const input = deckImportSchema.parse(request.body);
    const result = await deckImportService.importIntoDeck(
        request.currentUser.sub,
        request.params.id,
        input.format,
        input.text,
    );
    reply.code(201).send(result);
};
