import type { UserModel as User } from '../../generated/prisma/models/User.js';

export type PublicUser = {
    id: string;
    email: string;
    fullName: string | null;
    username: string | null;
    birthday: string | null;
    avatarUrl: string | null;
    emailVerified: boolean;
    role: string;
    xp: number;
    streak: number;
    createdAt: string;
    updatedAt: string;
};

export const toPublicUser = (user: User): PublicUser => ({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    username: user.username,
    birthday: user.birthday ? user.birthday.toISOString().slice(0, 10) : null,
    avatarUrl: user.avatarUrl,
    emailVerified: user.emailVerifiedAt !== null,
    role: user.role,
    xp: user.xp,
    streak: user.streak,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
});

export const needsProfile = (user: User): boolean =>
    user.username === null || user.fullName === null;
