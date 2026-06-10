import 'dotenv/config';
import { z } from 'zod';

const parseCsvOrigins = (value: string | undefined, ctx: z.RefinementCtx): string[] => {
    if (!value) {
        return [];
    }

    const origins = value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

    for (const origin of origins) {
        try {
            new URL(origin);
        } catch {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Invalid URL in WEB_URLS: ${origin}`,
            });
        }
    }

    return origins;
};

const envSchema = z
    .object({
        NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
        PORT: z.coerce.number().int().positive().default(3000),
        HOST: z.string().default('0.0.0.0'),
        LOG_LEVEL: z
            .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
            .default('info'),

        DATABASE_URL: z.string().url(),

        JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
        JWT_ACCESS_TTL: z.string().default('15m'),
        JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

        WEB_URL: z.string().url().default('http://localhost:3001'),
        WEB_URLS: z
            .string()
            .optional()
            .transform((value, ctx) => parseCsvOrigins(value, ctx)),
        APP_URL: z.string().url().default('http://localhost:3000'),

        MAIL_FROM: z.string().default('Mnemio <noreply@mnemio.local>'),
        MAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
        MAIL_PROVIDER_API_KEY: z.string().optional(),

        // AI provider for enrichment, deck generation, and suggestions.
        //   'mock'      → deterministic placeholders (default, FE-safe)
        //   'anthropic' → real LLM via @anthropic-ai/sdk (requires ANTHROPIC_API_KEY)
        AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
        ANTHROPIC_API_KEY: z.string().optional(),
        ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),

        // Per-user daily caps on each AI operation.
        AI_DAILY_ENRICH_CAP_PER_USER: z.coerce.number().int().positive().default(5),
        AI_DAILY_GENERATE_CAP_PER_USER: z.coerce.number().int().positive().default(20),
        AI_DAILY_SUGGEST_CAP_PER_USER: z.coerce.number().int().positive().default(60),

        // Hard ceiling on words per enrich call.
        AI_MAX_WORDS_PER_ENRICH: z.coerce.number().int().positive().max(200).default(100),

        // Real-time chat — daily per-user cap on user-message turns, context
        // window size (turns sent to the model), and per-reply output ceiling.
        AI_DAILY_CHAT_CAP_PER_USER: z.coerce.number().int().positive().default(50),
        AI_CHAT_CONTEXT_TURNS: z.coerce.number().int().positive().max(100).default(20),
        AI_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(8000).default(1024),

        // External-import cap (Quizlet scrape + paste-text). Shares the ai_usage
        // table — same atomic upsert pattern, no extra schema needed.
        IMPORT_DAILY_CAP_PER_USER: z.coerce.number().int().positive().default(20),
        // Hard ceiling on response size + request timeout for the Quizlet fetch.
        IMPORT_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
        IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),

        // Media storage. 'local' writes to MEDIA_DIR and serves under MEDIA_PUBLIC_BASE
        // via @fastify/static. For prod, swap to S3-compatible presigned PUTs (see
        // src/services/media.service.ts comment).
        MEDIA_STORAGE: z.enum(['local']).default('local'),
        MEDIA_DIR: z.string().default('./uploads'),
        MEDIA_PUBLIC_BASE: z.string().default('/media'),
        MEDIA_MAX_AVATAR_BYTES: z.coerce.number().int().positive().default(2_000_000),
        MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5_000_000),
        MEDIA_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(10_000_000),

        // Sentry — optional; when unset the plugin no-ops (local dev needs nothing).
        SENTRY_DSN: z.string().url().optional(),

        OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
        OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
        OAUTH_GOOGLE_REDIRECT_URL: z.string().url().optional(),
        OAUTH_FACEBOOK_CLIENT_ID: z.string().optional(),
        OAUTH_FACEBOOK_CLIENT_SECRET: z.string().optional(),
        OAUTH_APPLE_CLIENT_ID: z.string().optional(),
        OAUTH_APPLE_TEAM_ID: z.string().optional(),
        OAUTH_APPLE_KEY_ID: z.string().optional(),
        OAUTH_APPLE_PRIVATE_KEY: z.string().optional(),
    })
    .refine(
        (v) =>
            v.AI_PROVIDER !== 'anthropic' ||
            (v.ANTHROPIC_API_KEY && v.ANTHROPIC_API_KEY.length > 0),
        {
            message: 'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
            path: ['ANTHROPIC_API_KEY'],
        },
    )
    .refine(
        (v) =>
            v.MAIL_PROVIDER !== 'resend' ||
            (v.MAIL_PROVIDER_API_KEY && v.MAIL_PROVIDER_API_KEY.length > 0),
        {
            message: 'MAIL_PROVIDER_API_KEY is required when MAIL_PROVIDER=resend',
            path: ['MAIL_PROVIDER_API_KEY'],
        },
    );

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment configuration:');
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
