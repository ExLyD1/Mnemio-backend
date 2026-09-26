import { z } from 'zod';
import { normalizeLang } from '../shared/lang.js';

// Accepts free-form language input ("English", "uk-UA", "ua") and normalizes
// to a supported ISO 639-1 code so the FE's code-keyed <select> always has a
// match. Unsupported values are a 400, never persisted as-is.
export const langSchema = z
    .string()
    .trim()
    .min(2, 'Language code is required')
    .max(40)
    .transform((v, ctx) => {
        const code = normalizeLang(v);
        if (!code) {
            ctx.addIssue({ code: 'custom', message: 'Unrecognized language' });
            return z.NEVER;
        }
        return code;
    });
