import { prisma } from '../db/prisma.js';

export type UpdateMePatch = {
    displayName?: string;
    username?: string;
    birthday?: Date;
};

export const findUserById = (id: string) => prisma.user.findUnique({ where: { id } });

export const findByUsername = (username: string) =>
    prisma.user.findUnique({ where: { username } });

export const updateUser = (id: string, patch: UpdateMePatch) =>
    prisma.user.update({
        where: { id },
        data: patch,
    });
