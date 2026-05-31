import { z } from 'zod';

const RESERVED_USERNAMES = new Set([
    'admin', 'administrator', 'root', 'system', 'support', 'help',
    'mnemio', 'api', 'me', 'user', 'login', 'register', 'auth',
]);

export const usernameSchema = z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(24, 'Username must be at most 24 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers and underscores')
    .transform((s) => s.toLowerCase())
    .refine((s) => !RESERVED_USERNAMES.has(s), { message: 'This username is reserved' });

export const fullNameSchema = z.string().trim().min(1).max(64);

const MIN_AGE_YEARS = 13;
const today = () => new Date();
const yearsAgo = (n: number) => {
    const d = today();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
};

export const birthdaySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Birthday must be YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid birthday' })
    .refine((s) => new Date(s) <= yearsAgo(MIN_AGE_YEARS), {
        message: `You must be at least ${MIN_AGE_YEARS} years old`,
    });

export const updateMeSchema = z
    .object({
        fullName: fullNameSchema.optional(),
        username: usernameSchema.optional(),
        birthday: birthdaySchema.optional(),
    })
    .refine(
        (v) => v.fullName !== undefined || v.username !== undefined || v.birthday !== undefined,
        { message: 'At least one field is required' },
    );

export type UpdateMeInput = z.infer<typeof updateMeSchema>;
