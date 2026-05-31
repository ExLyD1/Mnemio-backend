import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { UnauthorizedError } from '../shared/errors.js';

export type JwtPayload = {
    sub: string;
    emailVerified: boolean;
    role: string;
};

declare module '@fastify/jwt' {
    interface FastifyJWT {
        payload: JwtPayload;
        user: JwtPayload;
    }
}

declare module 'fastify' {
    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
        requireVerified: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
    interface FastifyRequest {
        currentUser: JwtPayload;
    }
}

export const registerJwt = async (fastify: FastifyInstance) => {
    await fastify.register(fastifyJwt, {
        secret: env.JWT_SECRET,
        sign: { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL },
        verify: { algorithms: ['HS256'] },
    });

    fastify.decorate('authenticate', async (request: FastifyRequest) => {
        try {
            await request.jwtVerify();
            request.currentUser = request.user;
        } catch {
            throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'Invalid or expired access token');
        }
    });

    fastify.decorate('requireVerified', async (request: FastifyRequest) => {
        if (!request.currentUser) {
            try {
                await request.jwtVerify();
                request.currentUser = request.user;
            } catch {
                throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'Invalid or expired access token');
            }
        }
        if (!request.currentUser.emailVerified) {
            throw new UnauthorizedError('EMAIL_NOT_VERIFIED', 'Email verification required');
        }
    });
};
