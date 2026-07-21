import type { FastifyInstance } from 'fastify';
import * as authController from '../controllers/auth.controller.js';

const tightLimit = { max: 10, timeWindow: '1 minute' };
const otpLimit = { max: 5, timeWindow: '1 minute' };

const authRoutes = async (fastify: FastifyInstance) => {
    fastify.post(
        '/auth/register',
        { config: { rateLimit: tightLimit } },
        authController.register,
    );
    fastify.post(
        '/auth/verify-email',
        { config: { rateLimit: otpLimit } },
        authController.verifyEmail,
    );
    fastify.post(
        '/auth/resend-otp',
        { config: { rateLimit: otpLimit } },
        authController.resendOtp,
    );
    fastify.post(
        '/auth/login',
        { config: { rateLimit: tightLimit } },
        authController.login,
    );
    fastify.post(
        '/auth/refresh',
        { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        authController.refresh,
    );
    fastify.post('/auth/logout', authController.logout);

    fastify.get(
        '/auth/me',
        { preHandler: [fastify.authenticate] },
        authController.me,
    );

    // ---- Google OAuth ----
    // No auth here — the start endpoint sets state cookies and redirects
    // unauthenticated visitors to Google.
    fastify.get(
        '/auth/oauth/google',
        { config: { rateLimit: tightLimit } },
        authController.googleAuthStart,
    );
    fastify.get(
        '/auth/oauth/google/callback',
        { config: { rateLimit: tightLimit } },
        authController.googleAuthCallback,
    );
    fastify.post(
        '/auth/oauth/exchange',
        { config: { rateLimit: tightLimit } },
        authController.oauthExchangeCode,
    );
};

export default authRoutes;
