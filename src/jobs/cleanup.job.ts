import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

// Both tables grow unbounded otherwise:
//   - refresh_tokens accumulates expired/revoked rows (each login + refresh)
//   - email_verifications accumulates expired codes
// A 7-day grace window keeps rows around long enough to debug reuse-detection
// incidents but bounds the table at roughly (active users * 7 days * activity).
const GRACE_DAYS = 7;
const CRON_EXPR = '0 3 * * *'; // 03:00 UTC daily

export const runCleanupOnce = async (log: FastifyBaseLogger): Promise<void> => {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
    try {
        const [tokens, verifications] = await Promise.all([
            prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
            prisma.emailVerification.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
        ]);
        log.info(
            { refreshTokens: tokens.count, emailVerifications: verifications.count, cutoff },
            'cleanup job: deleted expired auth rows',
        );
    } catch (err) {
        log.warn({ err }, 'cleanup job failed (will retry tomorrow)');
    }
};

export const registerCleanupJob = (log: FastifyBaseLogger): (() => void) | undefined => {
    // Tests run in band — a daily cron would just be noise + extra DB load.
    if (env.NODE_ENV === 'test') return undefined;

    const task = cron.schedule(CRON_EXPR, () => {
        void runCleanupOnce(log);
    });

    log.info({ schedule: CRON_EXPR, graceDays: GRACE_DAYS }, 'cleanup job scheduled');
    return () => task.stop();
};
