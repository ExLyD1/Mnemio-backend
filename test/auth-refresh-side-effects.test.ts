import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as authRepo from '../src/repositories/auth.repository.js';
import * as welcomeRepo from '../src/repositories/welcome.repository.js';
import { refresh, REFRESH_REUSE_GRACE_MS } from '../src/services/auth.service.js';

vi.mock('../src/repositories/auth.repository.js', async () => {
    const actual = await vi.importActual<typeof authRepo>(
        '../src/repositories/auth.repository.js',
    );
    return {
        ...actual,
        findRefreshTokenByHash: vi.fn(),
        findUserById: vi.fn(),
        createRefreshToken: vi.fn(),
        revokeRefreshToken: vi.fn(),
        revokeAllUserRefreshTokens: vi.fn(),
        writeAuditLog: vi.fn(),
    };
});

vi.mock('../src/repositories/welcome.repository.js', async () => {
    const actual = await vi.importActual<typeof welcomeRepo>(
        '../src/repositories/welcome.repository.js',
    );
    return { ...actual, getWelcomeState: vi.fn() };
});

const mockedRepo = vi.mocked(authRepo);
const mockedWelcome = vi.mocked(welcomeRepo);

// Only `jwt.sign` is reached by the refresh path.
const fastify = { jwt: { sign: () => 'access-token' } } as unknown as FastifyInstance;
const ctx = { ip: '127.0.0.1', userAgent: 'vitest' };

const HOUR = 3_600_000;
const now = () => Date.now();

const user = {
    id: 'user-1',
    email: 'a@b.c',
    username: 'tester',
    fullName: 'Tester',
    birthday: null,
    avatarUrl: null,
    emailVerifiedAt: new Date('2026-09-01T00:00:00Z'),
    role: 'USER',
    xp: 0,
    streak: 0,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
} as unknown as Awaited<ReturnType<typeof authRepo.findUserById>>;

const givenRecord = (over: Partial<{ revokedAt: Date | null; replacedById: string | null; expiresAt: Date }>) => ({
    id: 'rt-1',
    userId: 'user-1',
    revokedAt: null,
    replacedById: null,
    expiresAt: new Date(now() + 30 * 24 * HOUR),
    ...over,
});

describe('auth.service / refresh side effects', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedRepo.findUserById.mockResolvedValue(user);
        mockedWelcome.getWelcomeState.mockResolvedValue({} as never);
        mockedRepo.createRefreshToken.mockResolvedValue({} as never);
        mockedRepo.revokeRefreshToken.mockResolvedValue({} as never);
        mockedRepo.revokeAllUserRefreshTokens.mockResolvedValue({} as never);
        mockedRepo.writeAuditLog.mockResolvedValue({} as never);
    });

    it('a live token refreshes and rotates only itself', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(givenRecord({}) as never);
        const result = await refresh(fastify, 'the-token', ctx);
        expect(result.accessToken).toBe('access-token');
        expect(mockedRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    // The regression this milestone exists for: a rotated token presented late
    // must NOT nuke every session the user has.
    it('a token rotated 3 hours ago (second device) refreshes without revoking the family', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(
            givenRecord({ revokedAt: new Date(now() - 3 * HOUR), replacedById: 'rt-2' }) as never,
        );
        const result = await refresh(fastify, 'the-token', ctx);
        expect(result.accessToken).toBe('access-token');
        expect(mockedRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it('a token rotated overnight refreshes without revoking the family', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(
            givenRecord({ revokedAt: new Date(now() - 20 * HOUR), replacedById: 'rt-2' }) as never,
        );
        await expect(refresh(fastify, 'the-token', ctx)).resolves.toBeTruthy();
        expect(mockedRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it('concurrent-tab rotation (inside the grace window) still refreshes', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(
            givenRecord({
                revokedAt: new Date(now() - REFRESH_REUSE_GRACE_MS / 2),
                replacedById: 'rt-2',
            }) as never,
        );
        await expect(refresh(fastify, 'the-token', ctx)).resolves.toBeTruthy();
        expect(mockedRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    // Theft defence must survive the fix.
    it('a token revoked by logout is rejected AND revokes the family', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(
            givenRecord({ revokedAt: new Date(now() - HOUR), replacedById: null }) as never,
        );
        await expect(refresh(fastify, 'the-token', ctx)).rejects.toMatchObject({
            code: 'AUTH_INVALID_REFRESH',
        });
        expect(mockedRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith('user-1');
    });

    it('a rotated token replayed after expiry is rejected AND revokes the family', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(
            givenRecord({
                revokedAt: new Date(now() - 40 * 24 * HOUR),
                replacedById: 'rt-2',
                expiresAt: new Date(now() - HOUR),
            }) as never,
        );
        await expect(refresh(fastify, 'the-token', ctx)).rejects.toMatchObject({
            code: 'AUTH_INVALID_REFRESH',
        });
        expect(mockedRepo.revokeAllUserRefreshTokens).toHaveBeenCalledWith('user-1');
    });

    it('a missing refresh token is rejected without touching the family', async () => {
        mockedRepo.findRefreshTokenByHash.mockResolvedValue(null as never);
        await expect(refresh(fastify, 'the-token', ctx)).rejects.toMatchObject({
            code: 'AUTH_INVALID_REFRESH',
        });
        expect(mockedRepo.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });
});
