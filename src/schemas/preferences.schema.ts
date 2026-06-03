import { z } from 'zod';

export const MIMI_PLACEMENTS = ['left', 'right'] as const;

const lang = z.string().trim().min(2).max(10);

export const updatePreferencesSchema = z
    .object({
        interests: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
        goal: z.string().trim().min(1).max(120).nullable().optional(),
        nativeLanguage: lang.nullable().optional(),
        learningLanguages: z.array(lang).max(10).optional(),
        avatarHue: z.number().int().min(0).max(360).nullable().optional(),
        mimiPlacement: z.enum(MIMI_PLACEMENTS).nullable().optional(),
        favorites: z.array(z.string().uuid()).max(500).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
        message: 'At least one field is required',
    });

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
