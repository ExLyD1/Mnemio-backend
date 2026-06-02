import { prisma } from '../db/prisma.js';

export type PreferencePatch = {
    interests?: string[];
    goal?: string | null;
    nativeLanguage?: string | null;
    learningLanguages?: string[];
    avatarHue?: number | null;
    mimiPlacement?: string | null;
    favorites?: string[];
};

export const findOrCreate = (userId: string) =>
    prisma.preference.upsert({
        where: { userId },
        update: {},
        create: { userId },
    });

export const update = (userId: string, patch: PreferencePatch) =>
    prisma.preference.upsert({
        where: { userId },
        update: patch,
        create: { userId, ...patch },
    });
