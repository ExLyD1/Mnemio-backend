import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import * as repo from '../repositories/subscription.repository.js';
import { sendBillingEmail } from '../services/billing-mail.service.js';

export const runTrialEndingOnce = async (log: FastifyBaseLogger): Promise<void> => {
    const now = new Date();
    const until = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    try {
        const rows = await repo.trialEndingCandidates(now, until);
        for (const row of rows) {
            // Atomic compare-and-set BEFORE sending: concurrent workers cannot both claim.
            const claim = await repo.claimTrialEnding(row.id, now, until);
            if (claim.count === 1) {
                await sendBillingEmail('trial-ending', row, log, row.user.email);
            }
        }
    } catch (err) {
        log.warn({ err }, 'trial-ending job failed');
    }
};

export const registerTrialEndingJob = (log: FastifyBaseLogger): (() => void) | undefined => {
    if (env.NODE_ENV === 'test') {
        return undefined;
    }
    const task = cron.schedule(
        '0 * * * *',
        () => {
            void runTrialEndingOnce(log);
        },
        { timezone: 'UTC' },
    );
    log.info({ schedule: '0 * * * *' }, 'trial-ending job scheduled');
    return () => {
        void task.stop();
    };
};
