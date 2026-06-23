import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake Mixpanel client so we never touch the network.
const trackMock = vi.fn();
const peopleSetMock = vi.fn();
const initMock = vi.fn(() => ({ track: trackMock, people: { set: peopleSetMock } }));

vi.mock('mixpanel', () => ({
    default: { init: initMock },
}));

describe('analytics.service', () => {
    beforeEach(() => {
        // Each case re-imports the module fresh so the cached client / env are
        // re-evaluated against the process.env we set below.
        vi.resetModules();
        trackMock.mockReset();
        peopleSetMock.mockReset();
        initMock.mockClear();
        // Empty (not deleted): dotenv won't override an already-present key, so
        // this keeps the test independent of whatever the real .env contains.
        // An empty token is falsy, so initAnalytics() stays a no-op by default.
        process.env.MIXPANEL_TOKEN = '';
        process.env.MIXPANEL_API_SECRET = '';
    });

    it('is a no-op when MIXPANEL_TOKEN is unset', async () => {
        const analytics = await import('../src/services/analytics.service.js');
        analytics.initAnalytics();

        expect(initMock).not.toHaveBeenCalled();
        // Calls must neither throw nor reach a (non-existent) client.
        expect(() =>
            analytics.track('user-1', 'account_created', { method: 'email' }),
        ).not.toThrow();
        analytics.setUserProps('user-1', { plan: 'free' });
        expect(trackMock).not.toHaveBeenCalled();
        expect(peopleSetMock).not.toHaveBeenCalled();
    });

    it('initializes and forwards events with distinct_id = userId when token is set', async () => {
        process.env.MIXPANEL_TOKEN = 'mp_test_token';
        process.env.MIXPANEL_API_SECRET = 'mp_secret';
        const analytics = await import('../src/services/analytics.service.js');
        analytics.initAnalytics();

        expect(initMock).toHaveBeenCalledWith('mp_test_token', { secret: 'mp_secret' });

        analytics.track('user-1', 'ai_cap_reached', {
            ai_feature: 'enrich_words',
            cap_per_day: 5,
        });
        expect(trackMock).toHaveBeenCalledWith('ai_cap_reached', {
            distinct_id: 'user-1',
            ai_feature: 'enrich_words',
            cap_per_day: 5,
        });

        analytics.setUserProps('user-1', { plan: 'premium', is_ever_paid: true });
        expect(peopleSetMock).toHaveBeenCalledWith('user-1', {
            plan: 'premium',
            is_ever_paid: true,
        });
    });

    it('swallows client errors so analytics can never break the caller', async () => {
        process.env.MIXPANEL_TOKEN = 'mp_test_token';
        trackMock.mockImplementation(() => {
            throw new Error('mixpanel down');
        });
        const analytics = await import('../src/services/analytics.service.js');
        analytics.initAnalytics();

        expect(() =>
            analytics.track('user-1', 'trial_started', { billing_plan: 'monthly' }),
        ).not.toThrow();
    });
});
