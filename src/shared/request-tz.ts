import type { FastifyRequest } from 'fastify';
import { normalizeTz } from '../services/tz.js';

// The viewer's IANA time zone for local-day bucketing: the X-Timezone header
// (sent by the frontend on every request), else a `tz` query param, else UTC.
export const requestTz = (request: FastifyRequest): string => {
    const header = request.headers['x-timezone'];
    const rawHeader = Array.isArray(header) ? header[0] : header;
    // `??` only skips undefined, so an EMPTY header (a proxy that always sets
    // the name, a client that sends "") shadowed the `tz` query param and
    // silently fell back to UTC — reintroducing the wrong-day bucketing that
    // local-day stats exist to avoid. Treat blank as absent.
    const fromHeader =
        typeof rawHeader === 'string' && rawHeader.trim() !== '' ? rawHeader : undefined;
    const fromQuery = (request.query as { tz?: unknown } | undefined)?.tz;
    return normalizeTz(fromHeader ?? fromQuery);
};
