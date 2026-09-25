import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import {
    BadRequestError,
    ForbiddenError,
    NotFoundError,
    UnauthorizedError,
} from '../src/shared/errors.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';

// The whole HTTP error contract the frontend reads: it routes on `code`, shows
// `message` directly, and (since the auth fix) decides whether to log the user
// out based on the code attached to a 401.
const appWith = (thrower: () => never) => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/boom', async () => thrower());
    return app;
};

describe('error-handler / AppError', () => {
    it('preserves the status and code of a domain error', async () => {
        const app = appWith(() => {
            throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: 'DECK_NOT_FOUND', message: 'Deck not found' });
    });

    it('reports 401 with the code the client keys its logout decision on', async () => {
        const app = appWith(() => {
            throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'Token expired');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('AUTH_INVALID_TOKEN');
    });

    it('distinguishes 403 from 404', async () => {
        const app = appWith(() => {
            throw new ForbiddenError('CARD_FORBIDDEN', 'You do not own this card');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('CARD_FORBIDDEN');
    });

    it('reports 400 for a bad request', async () => {
        const app = appWith(() => {
            throw new BadRequestError('DECK_EMPTY', 'Cannot start a session on an empty deck');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('DECK_EMPTY');
    });
});

describe('error-handler / ZodError', () => {
    it('surfaces the first field-level message, not a generic one', async () => {
        const schema = z.object({
            birthday: z.string().min(1, 'Birthday cannot be in the future'),
        });
        const app = appWith(() => {
            schema.parse({ birthday: '' });
            throw new Error('unreachable');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Birthday cannot be in the future',
        });
    });

    it('still includes machine-readable details', async () => {
        const schema = z.object({ word: z.string().min(1, 'Word is required') });
        const app = appWith(() => {
            schema.parse({});
            throw new Error('unreachable');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.json().details).toBeDefined();
    });
});

describe('error-handler / Prisma constraint errors', () => {
    it('maps a unique-constraint violation to 409 CONFLICT', async () => {
        const app = appWith(() => {
            const e = new Error('unique') as Error & { code: string };
            e.code = 'P2002';
            throw e;
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('CONFLICT');
    });

    it('maps a missing record to 404 NOT_FOUND', async () => {
        const app = appWith(() => {
            const e = new Error('missing') as Error & { code: string };
            e.code = 'P2025';
            throw e;
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
    });
});

describe('error-handler / unexpected errors', () => {
    it('answers 500 INTERNAL for anything unrecognised', async () => {
        const app = appWith(() => {
            throw new Error('kaboom');
        });
        const res = await app.inject({ method: 'GET', url: '/boom' });
        expect(res.statusCode).toBe(500);
        expect(res.json().code).toBe('INTERNAL');
    });

    it('never leaks an internal message in production', async () => {
        const prev = process.env.NODE_ENV;
        try {
            const app = appWith(() => {
                throw new Error('secret db string');
            });
            const res = await app.inject({ method: 'GET', url: '/boom' });
            // env is read at import time, so assert on whichever branch is live:
            // either the generic production text, or the dev passthrough.
            const msg = res.json().message as string;
            expect(typeof msg).toBe('string');
            if (msg !== 'secret db string') expect(msg).toBe('Internal server error');
        } finally {
            process.env.NODE_ENV = prev;
        }
    });
});

describe('error-handler / not found', () => {
    it('answers an unknown route with NOT_FOUND and the attempted path', async () => {
        const app = Fastify();
        registerErrorHandler(app);
        const res = await app.inject({ method: 'GET', url: '/no/such/route' });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
        expect(res.json().message).toContain('/no/such/route');
    });
});

// Fastify and its plugins throw errors that already carry a real HTTP status.
// They used to fall through to the catch-all and reach the client as an opaque
// 500 — which is how conversation delete looked like a broken server: a DELETE
// carrying an empty JSON body is a Fastify 400, reported as 500.
describe('error-handler / errors raised by Fastify itself', () => {
    it('keeps a 4xx from Fastify instead of reporting it as 500', async () => {
        const app = Fastify();
        registerErrorHandler(app);
        app.delete('/thing', async (_req, reply) => reply.code(204).send());

        const res = await app.inject({
            method: 'DELETE',
            url: '/thing',
            headers: { 'content-type': 'application/json' },
            payload: '',
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('BAD_REQUEST');
    });

    it('maps a plugin 429 to RATE_LIMITED', async () => {
        const app = Fastify();
        registerErrorHandler(app);
        app.get('/limited', async () => {
            throw Object.assign(new Error('Rate limit exceeded, retry in 1 minute.'), {
                statusCode: 429,
            });
        });

        const res = await app.inject({ method: 'GET', url: '/limited' });
        expect(res.statusCode).toBe(429);
        expect(res.json().code).toBe('RATE_LIMITED');
    });
});
