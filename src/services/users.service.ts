import * as usersRepo from '../repositories/users.repository.js';
import * as authRepo from '../repositories/auth.repository.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';
import { needsProfile, toPublicUser, type PublicUser } from '../shared/mappers.js';
import type { UpdateMeInput } from '../schemas/users.schema.js';

export const updateMe = async (
    userId: string,
    input: UpdateMeInput,
): Promise<{ user: PublicUser; needsProfile: boolean }> => {
    if (input.username !== undefined) {
        const taken = await usersRepo.findByUsername(input.username);
        if (taken && taken.id !== userId) {
            throw new ConflictError('AUTH_USERNAME_TAKEN', 'This username is already taken');
        }
    }

    const patch: usersRepo.UpdateMePatch = {};
    if (input.fullName !== undefined) patch.fullName = input.fullName;
    if (input.username !== undefined) patch.username = input.username;
    if (input.birthday !== undefined) patch.birthday = new Date(input.birthday);

    try {
        const user = await usersRepo.updateUser(userId, patch);
        return { user: toPublicUser(user), needsProfile: needsProfile(user) };
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') throw new NotFoundError('USER_NOT_FOUND', 'User not found');
        if (code === 'P2002') throw new ConflictError('AUTH_USERNAME_TAKEN', 'This username is already taken');
        throw err;
    }
};

type DeleteMeContext = {
    ip?: string | null;
    userAgent?: string | null;
};

export const deleteMe = async (userId: string, ctx: DeleteMeContext): Promise<void> => {
    // Audit log first — once the cascade fires, audit_log.userId is SET NULL
    // automatically, but the event row itself survives.
    await authRepo.writeAuditLog({
        userId,
        event: 'user.deleted',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
    });
    try {
        await usersRepo.deleteUser(userId);
    } catch (err) {
        // Idempotent: if a stale token races a delete, swallow not-found.
        const code = (err as { code?: string }).code;
        if (code !== 'P2025') throw err;
    }
};
