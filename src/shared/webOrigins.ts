import { env } from '../config/env.js';

// The frontend origins this backend is allowed to send a browser back to
// after the OAuth round-trip. Mirrors the same WEB_URLS / WEB_URL fallback
// app.ts already uses for CORS, so "who can call us" and "who we'll redirect
// back to" stay driven by the same allowlist instead of drifting apart.
const allowedWebOrigins = (): string[] => (env.WEB_URLS.length > 0 ? env.WEB_URLS : [env.WEB_URL]);

// Validates a caller-supplied origin against that allowlist and returns the
// canonical origin (scheme + host [+ port], no path/query/trailing slash) —
// or null if it's missing, malformed, or not on the allowlist. Never skip
// this check: blindly redirecting to whatever a query param says would be an
// open redirect. Callers should fall back to env.WEB_URL when this returns
// null, not fail the request outright — an unrecognized/missing origin just
// means "behave like before this feature existed".
export const resolveReturnOrigin = (candidate: string | null | undefined): string | null => {
    if (!candidate) {
        return null;
    }
    let normalized: string;
    try {
        normalized = new URL(candidate).origin;
    } catch {
        return null;
    }
    const allowed = allowedWebOrigins();
    return allowed.some((origin) => new URL(origin).origin === normalized) ? normalized : null;
};
