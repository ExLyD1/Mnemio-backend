import type { FastifyReply } from 'fastify';

/**
 * Minimal Server-Sent Events writer for Fastify replies. Streams JSON
 * payloads with a per-event name; calls `end()` flush the connection.
 *
 * Used by /ai/enrich-words and /ai/generate-deck to push card-by-card output
 * to the FE as the LLM produces it.
 */
export type SseWriter = {
    write: (event: string, data: unknown) => void;
    end: () => void;
    closed: () => boolean;
};

export const startSse = (reply: FastifyReply): SseWriter => {
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-store');
    reply.raw.setHeader('Connection', 'keep-alive');
    // Push the headers out so the browser starts the streaming connection.
    reply.raw.flushHeaders?.();
    let isClosed = false;
    reply.raw.on('close', () => {
        isClosed = true;
    });
    return {
        write: (event, data) => {
            if (isClosed) return;
            const payload = JSON.stringify(data);
            reply.raw.write(`event: ${event}\n`);
            reply.raw.write(`data: ${payload}\n\n`);
        },
        end: () => {
            if (isClosed) return;
            reply.raw.end();
        },
        closed: () => isClosed,
    };
};

/**
 * Whether the client opted into SSE for this request. We honor either the
 * standard `Accept: text/event-stream` (preferred) or an explicit
 * `?stream=1` query for cases where setting Accept is awkward.
 */
export const wantsSse = (request: { headers: Record<string, unknown>; query: unknown }): boolean => {
    const accept = String(request.headers['accept'] ?? '').toLowerCase();
    if (accept.includes('text/event-stream')) return true;
    const q = request.query as { stream?: string } | undefined;
    return q?.stream === '1' || q?.stream === 'true';
};
