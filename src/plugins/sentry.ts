import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

// Initialize once at module load. When SENTRY_DSN is unset, init() with a
// missing DSN is a no-op (the SDK silently skips capture), so local dev needs
// nothing extra. captureUnexpected() below also bails when capture is off so
// we don't waste a function call per error.
let initialized = false;

export const initSentry = (): void => {
    if (initialized) return;
    if (!env.SENTRY_DSN) return;

    Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        // Trace sampling — keep low at MVP, raise once we know what we're paying for.
        tracesSampleRate: 0.1,
    });

    initialized = true;
};

export const captureUnexpected = (err: unknown): void => {
    if (!initialized) return;
    Sentry.captureException(err);
};
