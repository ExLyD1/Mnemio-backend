import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { UserModel as User } from '../../generated/prisma/models/User.js';
import * as authRepo from '../repositories/auth.repository.js';
import { getWelcomeState, type WelcomeState } from '../repositories/welcome.repository.js';
import * as entitlementService from './entitlement.service.js';
import * as analytics from './analytics.service.js';
import { toPublicUser, needsProfile, type PublicUser } from '../shared/mappers.js';
import {
    BadRequestError,
    ConflictError,
    UnauthorizedError,
    RateLimitedError,
} from '../shared/errors.js';
import {
    generateOtpCode,
    hashOtp,
    verifyOtp,
    otpExpiry,
    OTP_MAX_ATTEMPTS,
    OTP_RESEND_COOLDOWN_SECONDS,
} from './otp.service.js';
import { generateOpaqueToken, hashToken, refreshTokenExpiry } from './token.service.js';
import { sendOtpEmail } from './mail.service.js';

const argonOpts: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // ~19 MiB
    timeCost: 2,
    parallelism: 1,
};

type RequestContext = {
    ip?: string | null;
    userAgent?: string | null;
};

export type AuthTokens = {
    accessToken: string;
    refreshToken: string;
};

export type AuthResult = AuthTokens & {
    user: PublicUser;
    needsProfile: boolean;
    welcome: WelcomeState;
    // Must match what GET /auth/me reports. Without it the FE defaulted every
    // freshly-authenticated user to 'free', so a premium user hit the paywall
    // for the whole SPA session (and was recorded as free in analytics).
    plan: 'free' | 'premium';
};

const signAccessToken = (fastify: FastifyInstance, user: User): string =>
    fastify.jwt.sign({
        sub: user.id,
        emailVerified: user.emailVerifiedAt !== null,
        role: user.role,
    });

const issueTokens = async (
    fastify: FastifyInstance,
    user: User,
    ctx: RequestContext,
): Promise<AuthTokens> => {
    const accessToken = signAccessToken(fastify, user);
    const refreshToken = generateOpaqueToken();
    await authRepo.createRefreshToken({
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiry(),
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
    });
    return { accessToken, refreshToken };
};

const buildAuthResult = async (
    fastify: FastifyInstance,
    user: User,
    ctx: RequestContext,
): Promise<AuthResult> => {
    const [tokens, welcome, plan] = await Promise.all([
        issueTokens(fastify, user, ctx),
        getWelcomeState(user.id),
        entitlementService.getPlan(user.id),
    ]);
    return {
        ...tokens,
        user: toPublicUser(user),
        needsProfile: needsProfile(user),
        welcome,
        plan,
    };
};

// Fire-and-forget analytics for a brand-new account. Called only at the genuine
// creation sites (first email verification / new OAuth user) so it never fires
// for returning logins. The backend is the only reliable source of new-vs-
// returning, especially for OAuth.
const emitAccountCreated = (user: User, method: 'email' | 'google'): void => {
    analytics.track(user.id, 'account_created', { method });
    analytics.setUserProps(user.id, {
        plan: 'free',
        signup_date: (user.createdAt ?? new Date()).toISOString(),
    });
};

// ---------- Public OTP issuance ----------

const issueOtp = async (userId: string, email: string): Promise<void> => {
    const code = generateOtpCode();
    await authRepo.createEmailVerification({
        userId,
        codeHash: hashOtp(code),
        expiresAt: otpExpiry(),
    });
    await sendOtpEmail(email, code);
};

// ---------- Register ----------

export const register = async (
    input: { email: string; password: string },
    ctx: RequestContext,
): Promise<{ userId: string; email: string }> => {
    const existing = await authRepo.findUserByEmail(input.email);
    if (existing) {
        // Avoid leaking that this email is already registered via timing; still
        // surface as conflict to the frontend so it can prompt "log in instead".
        throw new ConflictError('AUTH_EMAIL_TAKEN', 'An account with this email already exists');
    }

    const passwordHash = await argon2.hash(input.password, argonOpts);
    const user = await authRepo.createUser({ email: input.email, passwordHash });
    await issueOtp(user.id, user.email);
    await authRepo.writeAuditLog({
        userId: user.id,
        event: 'auth.register',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
    });

    return { userId: user.id, email: user.email };
};

// ---------- Verify email ----------

export const verifyEmail = async (
    fastify: FastifyInstance,
    input: { userId: string; code: string },
    ctx: RequestContext,
): Promise<AuthResult> => {
    const user = await authRepo.findUserById(input.userId);
    if (!user) throw new BadRequestError('AUTH_INVALID_CODE', 'Invalid verification code');

    if (user.emailVerifiedAt) {
        // Idempotent: already verified — just issue tokens.
        return buildAuthResult(fastify, user, ctx);
    }

    const verification = await authRepo.findActiveVerification(user.id);
    if (!verification) {
        await authRepo.writeAuditLog({
            userId: user.id,
            event: 'otp.verify.fail',
            ip: ctx.ip ?? null,
            details: { reason: 'no_active_code' },
        });
        throw new BadRequestError('AUTH_INVALID_CODE', 'Invalid or expired verification code');
    }

    if (verification.attempts >= OTP_MAX_ATTEMPTS) {
        await authRepo.consumeVerification(verification.id);
        throw new BadRequestError(
            'AUTH_OTP_EXHAUSTED',
            'Too many incorrect attempts; request a new code',
        );
    }

    if (!verifyOtp(input.code, verification.codeHash)) {
        await authRepo.incrementVerificationAttempts(verification.id);
        await authRepo.writeAuditLog({
            userId: user.id,
            event: 'otp.verify.fail',
            ip: ctx.ip ?? null,
            details: { reason: 'bad_code' },
        });
        throw new BadRequestError('AUTH_INVALID_CODE', 'Invalid verification code');
    }

    await authRepo.consumeVerification(verification.id);
    const verifiedUser = await authRepo.markEmailVerified(user.id);
    await authRepo.writeAuditLog({
        userId: user.id,
        event: 'otp.verify.success',
        ip: ctx.ip ?? null,
    });
    // First successful verification = the account is now real. The early-return
    // above means re-verifying an already-verified account won't re-fire this.
    emitAccountCreated(verifiedUser, 'email');
    return buildAuthResult(fastify, verifiedUser, ctx);
};

// ---------- Resend OTP ----------

export const resendOtp = async (
    input: { userId: string },
    ctx: RequestContext,
): Promise<{ ok: true; cooldownSeconds: number }> => {
    const user = await authRepo.findUserById(input.userId);
    if (!user) throw new BadRequestError('AUTH_INVALID_USER', 'Invalid user');
    if (user.emailVerifiedAt) {
        return { ok: true, cooldownSeconds: 0 };
    }

    const latest = await authRepo.findLatestVerification(user.id);
    if (latest) {
        const ageSeconds = (Date.now() - latest.createdAt.getTime()) / 1000;
        if (ageSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
            throw new RateLimitedError(
                'AUTH_OTP_COOLDOWN',
                `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - ageSeconds)}s before requesting a new code`,
            );
        }
    }

    await issueOtp(user.id, user.email);
    await authRepo.writeAuditLog({
        userId: user.id,
        event: 'otp.resend',
        ip: ctx.ip ?? null,
    });
    return { ok: true, cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS };
};

// ---------- Login ----------

const INVALID_CREDENTIALS = new UnauthorizedError(
    'AUTH_INVALID_CREDENTIALS',
    'Email or password is incorrect',
);

export const login = async (
    fastify: FastifyInstance,
    input: { email: string; password: string },
    ctx: RequestContext,
): Promise<AuthResult> => {
    const user = await authRepo.findUserByEmail(input.email);
    if (!user || !user.passwordHash) {
        await authRepo.writeAuditLog({
            event: 'login.fail',
            ip: ctx.ip ?? null,
            details: { email: input.email, reason: 'no_user_or_oauth_only' },
        });
        throw INVALID_CREDENTIALS;
    }

    const ok = await argon2.verify(user.passwordHash, input.password);
    if (!ok) {
        await authRepo.writeAuditLog({
            userId: user.id,
            event: 'login.fail',
            ip: ctx.ip ?? null,
            details: { reason: 'bad_password' },
        });
        throw INVALID_CREDENTIALS;
    }

    if (!user.emailVerifiedAt) {
        throw new UnauthorizedError(
            'EMAIL_NOT_VERIFIED',
            'Please verify your email before logging in',
            {
                userId: user.id,
            },
        );
    }

    await authRepo.writeAuditLog({
        userId: user.id,
        event: 'login.success',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
    });
    return buildAuthResult(fastify, user, ctx);
};

// ---------- Refresh ----------

// How long a just-rotated refresh token may still be presented without being
// treated as theft. Rotation is not atomic from the client's point of view:
// two tabs refreshing at once, or a mobile network dropping the /auth/refresh
// response after the server already rotated, both re-present the old cookie a
// moment later. Without a grace window that looked like token reuse and
// revoked EVERY session the user had — which users experienced as "the app
// logs me out when I reopen it" (QA (3) #10, Mnemio правки #10).
export const REFRESH_REUSE_GRACE_MS = 60_000;

export type RefreshRecordState = 'valid' | 'rotated_grace' | 'rotated_stale' | 'reused' | 'invalid';

// Pure: how to treat the presented refresh token's DB record.
export const classifyRefreshRecord = (
    record: { revokedAt: Date | null; replacedById: string | null; expiresAt: Date } | null,
    now: Date,
): RefreshRecordState => {
    if (!record) return 'invalid';
    if (record.revokedAt) {
        // A token revoked by LOGOUT (replacedById == null) is never re-issuable:
        // presenting it again is either a stale client or a genuine replay.
        if (record.replacedById === null) return 'reused';
        // Past its own 30-day life it is dead regardless of why it was revoked.
        if (record.expiresAt < now) return 'reused';
        const withinGrace = now.getTime() - record.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
        // A ROTATED token that is still inside its lifetime is a rotation
        // artifact, not theft. Two tabs racing land inside the grace window;
        // a second device, or a client that slept, shows up hours later. Both
        // are the same event — this client simply never saw the new token.
        // Treating the late case as theft revoked EVERY session on EVERY
        // device, which users experienced as "I get logged out the next day".
        return withinGrace ? 'rotated_grace' : 'rotated_stale';
    }
    if (record.expiresAt < now) return 'invalid';
    return 'valid';
};

export const refresh = async (
    fastify: FastifyInstance,
    refreshToken: string | null,
    ctx: RequestContext,
): Promise<AuthResult> => {
    if (!refreshToken) {
        throw new UnauthorizedError('AUTH_INVALID_REFRESH', 'Missing refresh token');
    }
    const tokenHash = hashToken(refreshToken);
    const record = await authRepo.findRefreshTokenByHash(tokenHash);
    const state = classifyRefreshRecord(record, new Date());
    if (state === 'reused' && record) {
        // Reuse detection: a token revoked by logout, or one replayed past its
        // own expiry, presented again — revoke everything to defend against theft.
        await authRepo.revokeAllUserRefreshTokens(record.userId);
        await authRepo.writeAuditLog({
            userId: record.userId,
            event: 'refresh.reuse_detected',
            ip: ctx.ip ?? null,
        });
    }
    if (state === 'rotated_stale' && record) {
        // Not theft — audited so a real attack is still visible in the log.
        await authRepo.writeAuditLog({
            userId: record.userId,
            event: 'refresh.rotated_stale',
            ip: ctx.ip ?? null,
        });
    }
    if (!record || (state !== 'valid' && state !== 'rotated_grace' && state !== 'rotated_stale')) {
        throw new UnauthorizedError('AUTH_INVALID_REFRESH', 'Invalid or expired refresh token');
    }

    const user = await authRepo.findUserById(record.userId);
    if (!user) throw new UnauthorizedError('AUTH_INVALID_REFRESH', 'Invalid refresh token');

    const [tokens, welcome, plan] = await Promise.all([
        issueTokens(fastify, user, ctx),
        getWelcomeState(user.id),
        entitlementService.getPlan(user.id),
    ]);
    // A rotated token (grace or stale) was already revoked by the request that
    // won the race — just hand this client its own fresh pair.
    if (state === 'valid') {
        await authRepo.revokeRefreshToken(
            record.id,
            (await authRepo.findRefreshTokenByHash(hashToken(tokens.refreshToken)))?.id,
        );
    }
    return {
        ...tokens,
        user: toPublicUser(user),
        needsProfile: needsProfile(user),
        welcome,
        plan,
    };
};

// ---------- Logout ----------

export const logout = async (refreshToken: string | null): Promise<void> => {
    if (!refreshToken) return; // Idempotent — clearing the cookie is enough.
    const record = await authRepo.findRefreshTokenByHash(hashToken(refreshToken));
    if (record && !record.revokedAt) {
        await authRepo.revokeRefreshToken(record.id);
    }
};

// ---------- OAuth sign-in (Google) ----------

// Link-or-create. Order of attempts (matches plan §3.1 + Open question #6):
//   1. If we already have an OAuthIdentity for (provider, providerUserId),
//      sign in that user.
//   2. Else if there's a user with this email AND they're already verified
//      (password account), link the OAuth identity to them.
//   3. Else create a brand-new user with the OAuth email (pre-verified).
export const signInWithProvider = async (
    fastify: FastifyInstance,
    params: {
        provider: 'google';
        providerUserId: string;
        email: string;
        fullName?: string | null;
        emailVerifiedByProvider: boolean;
    },
    ctx: RequestContext,
): Promise<AuthResult> => {
    const existingIdentity = await authRepo.findOAuthIdentity(
        params.provider,
        params.providerUserId,
    );
    if (existingIdentity) {
        const user = await authRepo.findUserById(existingIdentity.userId);
        if (!user) {
            // Identity row points at a deleted user — defensive recovery.
            throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'OAuth identity is stale');
        }
        await authRepo.writeAuditLog({
            userId: user.id,
            event: 'oauth.signin',
            ip: ctx.ip ?? null,
            details: { provider: params.provider },
        });
        return buildAuthResult(fastify, user, ctx);
    }

    const existingByEmail = await authRepo.findUserByEmail(params.email);
    if (existingByEmail) {
        // Only auto-link if the password account is verified (otherwise an
        // attacker who pre-registered the email could hijack the Google flow).
        if (!existingByEmail.emailVerifiedAt) {
            throw new BadRequestError(
                'AUTH_EMAIL_UNVERIFIED_LINK',
                'An unverified account already exists for this email. Verify it first or use a different Google account.',
            );
        }
        await authRepo.createOAuthIdentity({
            userId: existingByEmail.id,
            provider: params.provider,
            providerUserId: params.providerUserId,
        });
        await authRepo.writeAuditLog({
            userId: existingByEmail.id,
            event: 'oauth.linked',
            ip: ctx.ip ?? null,
            details: { provider: params.provider },
        });
        return buildAuthResult(fastify, existingByEmail, ctx);
    }

    // Brand-new user.
    if (!params.emailVerifiedByProvider) {
        throw new BadRequestError(
            'OAUTH_EMAIL_UNVERIFIED',
            'Google has not verified this email; cannot create an account from it',
        );
    }
    const created = await authRepo.createOAuthUser({
        email: params.email,
        fullName: params.fullName ?? null,
    });
    await authRepo.createOAuthIdentity({
        userId: created.id,
        provider: params.provider,
        providerUserId: params.providerUserId,
    });
    await authRepo.writeAuditLog({
        userId: created.id,
        event: 'oauth.register',
        ip: ctx.ip ?? null,
        details: { provider: params.provider },
    });
    // Brand-new OAuth user only — the two branches above (existing identity /
    // link to existing account) are returning users and must not fire this.
    emitAccountCreated(created, 'google');
    return buildAuthResult(fastify, created, ctx);
};

// ---------- Me ----------

export const me = async (
    userId: string,
): Promise<{
    user: PublicUser;
    needsProfile: boolean;
    welcome: WelcomeState;
    plan: 'free' | 'premium';
}> => {
    const [user, welcome, plan] = await Promise.all([
        authRepo.findUserById(userId),
        getWelcomeState(userId),
        entitlementService.getPlan(userId),
    ]);
    if (!user) throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'User no longer exists');
    return { user: toPublicUser(user), needsProfile: needsProfile(user), welcome, plan };
};
