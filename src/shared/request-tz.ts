import type { FastifyRequest } from 'fastify';
import { normalizeTz } from '../services/tz.js';

// The viewer's IANA time zone for local-day bucketing: the X-Timezone header
// (sent by the frontend on every request), else a `tz` query param, else UTC.
export const requestTz = (request: FastifyRequest): string => {
    const header = request.headers['x-timezone'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const fromQuery = (request.query as { tz?: unknown } | undefined)?.tz;
    return normalizeTz(fromHeader ?? fromQuery);
};
