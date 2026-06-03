import * as repo from '../repositories/preferences.repository.js';
import { toPublicPreference, type PublicPreference } from '../shared/mappers.preferences.js';
import type { UpdatePreferencesInput } from '../schemas/preferences.schema.js';

export const get = async (userId: string): Promise<PublicPreference> => {
    const row = await repo.findOrCreate(userId);
    return toPublicPreference(row);
};

export const update = async (
    userId: string,
    input: UpdatePreferencesInput,
): Promise<PublicPreference> => {
    const patch: repo.PreferencePatch = {};
    if (input.interests !== undefined) patch.interests = input.interests;
    if (input.goal !== undefined) patch.goal = input.goal;
    if (input.nativeLanguage !== undefined) patch.nativeLanguage = input.nativeLanguage;
    if (input.learningLanguages !== undefined) patch.learningLanguages = input.learningLanguages;
    if (input.avatarHue !== undefined) patch.avatarHue = input.avatarHue;
    if (input.mimiPlacement !== undefined) patch.mimiPlacement = input.mimiPlacement;
    if (input.favorites !== undefined) patch.favorites = input.favorites;
    const row = await repo.update(userId, patch);
    return toPublicPreference(row);
};
