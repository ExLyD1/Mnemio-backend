import { Google, generateCodeVerifier, generateState } from 'arctic';
import { env } from '../config/env.js';
import { BadRequestError } from '../shared/errors.js';

// Lazily constructed so the rest of the app boots without Google creds.
// Endpoints that touch this guard with assertGoogleConfigured() first.
let client: Google | null = null;

export const assertGoogleConfigured = (): {
    clientId: string;
    clientSecret: string;
    redirectUrl: string;
} => {
    const clientId = env.OAUTH_GOOGLE_CLIENT_ID;
    const clientSecret = env.OAUTH_GOOGLE_CLIENT_SECRET;
    const redirectUrl = env.OAUTH_GOOGLE_REDIRECT_URL;
    if (!clientId || !clientSecret || !redirectUrl) {
        throw new BadRequestError(
            'OAUTH_NOT_CONFIGURED',
            'Google sign-in is not configured on this server',
        );
    }
    return { clientId, clientSecret, redirectUrl };
};

const getClient = (): Google => {
    if (client) return client;
    const { clientId, clientSecret, redirectUrl } = assertGoogleConfigured();
    client = new Google(clientId, clientSecret, redirectUrl);
    return client;
};

export const newStateAndVerifier = (): { state: string; codeVerifier: string } => ({
    state: generateState(),
    codeVerifier: generateCodeVerifier(),
});

export const buildAuthorizationUrl = (state: string, codeVerifier: string): URL =>
    getClient().createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);

export type GoogleProfile = {
    sub: string;
    email: string;
    emailVerified: boolean;
    name?: string;
};

const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const exchangeCodeAndFetchProfile = async (
    code: string,
    codeVerifier: string,
): Promise<GoogleProfile> => {
    const tokens = await getClient().validateAuthorizationCode(code, codeVerifier);
    const accessToken = tokens.accessToken();
    const res = await fetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        throw new BadRequestError(
            'OAUTH_USERINFO_FAILED',
            'Could not fetch profile from Google',
        );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const sub = typeof raw.sub === 'string' ? raw.sub : null;
    const email = typeof raw.email === 'string' ? raw.email : null;
    if (!sub || !email) {
        throw new BadRequestError('OAUTH_BAD_PROFILE', 'Google profile missing email or sub');
    }
    return {
        sub,
        email,
        emailVerified: raw.email_verified === true,
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    };
};
