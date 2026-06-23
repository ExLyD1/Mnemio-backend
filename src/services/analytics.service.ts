import Mixpanel from 'mixpanel';
import { env } from '../config/env.js';
import type { AnalyticsEventName, PropsFor, UserProps } from '../analytics/events.js';

// Server-side Mixpanel. Mirrors the sentry.ts pattern: lazy-init once, no-op
// when MIXPANEL_TOKEN is unset so local dev and CI need nothing extra.
//
// Every call is fire-and-forget — wrapped in try/catch, never awaited in a hot
// path, never throws. A Mixpanel outage must never fail a request or delay a
// Stripe webhook ACK.
//
// The golden rule: distinct_id is ALWAYS our internal user.id (same as JWT sub
// and /auth/me), so server events merge onto the profile the client built via
// mixpanel.identify(user.id) — no aliasing needed.

let client: ReturnType<typeof Mixpanel.init> | null = null;

export const initAnalytics = (): void => {
    if (client) return;
    if (!env.MIXPANEL_TOKEN) return;

    client = Mixpanel.init(
        env.MIXPANEL_TOKEN,
        env.MIXPANEL_API_SECRET ? { secret: env.MIXPANEL_API_SECRET } : {},
    );
};

/**
 * Emit an analytics event onto a user's profile. Typed against the shared
 * AnalyticsEvent contract so names/props can't drift from the frontend.
 */
export const track = <N extends AnalyticsEventName>(
    userId: string,
    name: N,
    props: PropsFor<N>,
): void => {
    if (!client) return;
    try {
        client.track(name, { distinct_id: userId, ...props });
    } catch {
        // Fire-and-forget: analytics must never break the caller.
    }
};

/** Set allowlisted people-profile properties. Only call with props we own. */
export const setUserProps = (userId: string, props: Partial<UserProps>): void => {
    if (!client) return;
    try {
        client.people.set(userId, props);
    } catch {
        // Fire-and-forget.
    }
};
