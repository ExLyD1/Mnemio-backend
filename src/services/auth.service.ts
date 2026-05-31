import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { UserModel as User } from '../../generated/prisma/models/User.js';
import * as authRepo from '../repositories/auth.repository.js';
import { toPublicUser, needsProfile, type PublicUser } from '../shared/mappers.js';
import { BadRequestError, ConflictError, UnauthorizedError, RateLimitedError } from '../shared/errors.js';
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
    const tokens = await issueTokens(fastify, user, ctx);
    return {
        ...tokens,
        user: toPublicUser(user),
        needsProfile: needsProfile(user),
    };
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
        throw new BadRequestError('AUTH_OTP_EXHAUSTED', 'Too many incorrect attempts; request a new code');
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
        throw new UnauthorizedError('EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', {
            userId: user.id,
        });
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
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
        // Reuse detection: if a previously-rotated token is presented again,
        // revoke all tokens for that user to defend against theft.
        if (record?.revokedAt) {
            await authRepo.revokeAllUserRefreshTokens(record.userId);
            await authRepo.writeAuditLog({
                userId: record.userId,
                event: 'refresh.reuse_detected',
                ip: ctx.ip ?? null,
            });
        }
        throw new UnauthorizedError('AUTH_INVALID_REFRESH', 'Invalid or expired refresh token');
    }

    const user = await authRepo.findUserById(record.userId);
    if (!user) throw new UnauthorizedError('AUTH_INVALID_REFRESH', 'Invalid refresh token');

    const tokens = await issueTokens(fastify, user, ctx);
    await authRepo.revokeRefreshToken(
        record.id,
        (await authRepo.findRefreshTokenByHash(hashToken(tokens.refreshToken)))?.id,
    );
    return {
        ...tokens,
        user: toPublicUser(user),
        needsProfile: needsProfile(user),
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

// ---------- Me ----------

export const me = async (userId: string): Promise<{ user: PublicUser; needsProfile: boolean }> => {
    const user = await authRepo.findUserById(userId);
    if (!user) throw new UnauthorizedError('AUTH_INVALID_TOKEN', 'User no longer exists');
    return { user: toPublicUser(user), needsProfile: needsProfile(user) };
};
