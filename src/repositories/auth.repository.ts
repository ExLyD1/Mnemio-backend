import { prisma } from '../db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
type InputJsonValue = Prisma.InputJsonValue;

export const findUserByEmail = (email: string) =>
    prisma.user.findUnique({ where: { email: email.toLowerCase() } });

export const findUserById = (id: string) => prisma.user.findUnique({ where: { id } });

export const createUser = (data: { email: string; passwordHash: string | null }) =>
    prisma.user.create({
        data: {
            email: data.email.toLowerCase(),
            passwordHash: data.passwordHash,
        },
    });

export const markEmailVerified = (userId: string) =>
    prisma.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: new Date() },
    });

// ---------- Email verifications ----------

export const createEmailVerification = (data: {
    userId: string;
    codeHash: string;
    expiresAt: Date;
}) =>
    prisma.emailVerification.create({
        data: { userId: data.userId, codeHash: data.codeHash, expiresAt: data.expiresAt },
    });

export const findActiveVerification = (userId: string) =>
    prisma.emailVerification.findFirst({
        where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
    });

export const findLatestVerification = (userId: string) =>
    prisma.emailVerification.findFirst({
        where: { userId, consumedAt: null },
        orderBy: { createdAt: 'desc' },
    });

export const incrementVerificationAttempts = (id: string) =>
    prisma.emailVerification.update({
        where: { id },
        data: { attempts: { increment: 1 } },
    });

export const consumeVerification = (id: string) =>
    prisma.emailVerification.update({
        where: { id },
        data: { consumedAt: new Date() },
    });

// ---------- Refresh tokens ----------

export const createRefreshToken = (data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ip?: string | null;
}) =>
    prisma.refreshToken.create({
        data: {
            userId: data.userId,
            tokenHash: data.tokenHash,
            expiresAt: data.expiresAt,
            userAgent: data.userAgent ?? null,
            ip: data.ip ?? null,
        },
    });

export const findRefreshTokenByHash = (tokenHash: string) =>
    prisma.refreshToken.findUnique({ where: { tokenHash } });

export const revokeRefreshToken = (id: string, replacedById?: string) =>
    prisma.refreshToken.update({
        where: { id },
        data: {
            revokedAt: new Date(),
            ...(replacedById ? { replacedById } : {}),
        },
    });

export const revokeAllUserRefreshTokens = (userId: string) =>
    prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });

// ---------- OAuth identities ----------

export const findOAuthIdentity = (provider: string, providerUserId: string) =>
    prisma.oAuthIdentity.findUnique({
        where: { provider_providerUserId: { provider, providerUserId } },
    });

export const createOAuthIdentity = (data: {
    userId: string;
    provider: string;
    providerUserId: string;
}) =>
    prisma.oAuthIdentity.create({
        data: {
            userId: data.userId,
            provider: data.provider,
            providerUserId: data.providerUserId,
        },
    });

// Creates an OAuth-origin user — email pre-verified (Google already confirmed
// it), no password hash (they'll sign in via Google going forward).
export const createOAuthUser = (data: { email: string; fullName?: string | null }) =>
    prisma.user.create({
        data: {
            email: data.email.toLowerCase(),
            passwordHash: null,
            emailVerifiedAt: new Date(),
            fullName: data.fullName ?? null,
        },
    });

// ---------- Audit log ----------

export const writeAuditLog = (data: {
    userId?: string | null;
    event: string;
    ip?: string | null;
    userAgent?: string | null;
    details?: Record<string, unknown> | null;
}) => {
    const base = {
        userId: data.userId ?? null,
        event: data.event,
        ip: data.ip ?? null,
        userAgent: data.userAgent ?? null,
    };
    return prisma.auditLog.create({
        data: data.details ? { ...base, details: data.details as InputJsonValue } : base,
    });
};
