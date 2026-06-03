import type { PreferenceModel } from '../../generated/prisma/models/Preference.js';

export type PublicPreference = {
    interests: string[];
    goal: string | null;
    nativeLanguage: string | null;
    learningLanguages: string[];
    avatarHue: number | null;
    mimiPlacement: 'left' | 'right' | null;
    favorites: string[];
    updatedAt: string;
};

export const toPublicPreference = (p: PreferenceModel): PublicPreference => ({
    interests: p.interests,
    goal: p.goal,
    nativeLanguage: p.nativeLanguage,
    learningLanguages: p.learningLanguages,
    avatarHue: p.avatarHue,
    mimiPlacement: p.mimiPlacement as 'left' | 'right' | null,
    favorites: p.favorites,
    updatedAt: p.updatedAt.toISOString(),
});
