import type { FastifyRequest, FastifyReply } from 'fastify';
import { rangeQuerySchema, rangeTzQuerySchema } from '../schemas/stats.schema.js';
import * as service from '../services/stats.service.js';

export const overview = async (request: FastifyRequest, reply: FastifyReply) => {
    const { range } = rangeQuerySchema.parse(request.query);
    const result = await service.overview(request.currentUser.sub, range);
    reply.send(result);
};

export const series = async (request: FastifyRequest, reply: FastifyReply) => {
    const { range } = rangeQuerySchema.parse(request.query);
    const result = await service.series(request.currentUser.sub, range);
    reply.send(result);
};

export const activity = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await service.activity(request.currentUser.sub);
    reply.send(result);
};

export const decks = async (request: FastifyRequest, reply: FastifyReply) => {
    const items = await service.decks(request.currentUser.sub);
    reply.send({ items });
};

export const studyTime = async (request: FastifyRequest, reply: FastifyReply) => {
    const { range, tz } = rangeTzQuerySchema.parse(request.query);
    const result = await service.studyTime(request.currentUser.sub, range, tz);
    reply.send(result);
};

export const decksStudied = async (request: FastifyRequest, reply: FastifyReply) => {
    const { range, tz } = rangeTzQuerySchema.parse(request.query);
    const result = await service.decksStudied(request.currentUser.sub, range, tz);
    reply.send(result);
};

export const cardSeries = async (request: FastifyRequest, reply: FastifyReply) => {
    const { range, tz } = rangeTzQuerySchema.parse(request.query);
    const result = await service.cardSeries(request.currentUser.sub, range, tz);
    reply.send(result);
};
