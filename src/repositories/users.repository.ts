import { prisma } from '../db/prisma.js';

export type UpdateMePatch = {
    fullName?: string;
    username?: string;
    birthday?: Date;
    avatarUrl?: string | null;
};

export const findUserById = (id: string) => prisma.user.findUnique({ where: { id } });

export const findByUsername = (username: string) =>
    prisma.user.findUnique({ where: { username } });

export const updateUser = (id: string, patch: UpdateMePatch) =>
    prisma.user.update({
        where: { id },
        data: patch,
    });
