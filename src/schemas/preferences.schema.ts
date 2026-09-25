import { z } from 'zod';
import { langSchema } from './lang.schema.js';

export const MIMI_PLACEMENTS = ['left', 'right'] as const;

export const updatePreferencesSchema = z
    .object({
        interests: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
        goal: z.string().trim().min(1).max(120).nullable().optional(),
        nativeLanguage: langSchema.nullable().optional(),
        learningLanguages: z.array(langSchema).max(10).optional(),
        avatarHue: z.number().int().min(0).max(360).nullable().optional(),
        mimiPlacement: z.enum(MIMI_PLACEMENTS).nullable().optional(),
        favorites: z.array(z.string().uuid()).max(500).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
        message: 'At least one field is required',
    });

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
