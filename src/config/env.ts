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
        ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),
        // Thinking effort for chat replies. 'low' matched 'medium' on our chat
        // eval at lower cost. 'off' omits the parameter — needed for models
        // without effort support (e.g. claude-haiku-4-5), which reject it.
        ANTHROPIC_CHAT_EFFORT: z.enum(['off', 'low', 'medium', 'high']).default('low'),
        // Card CONTENT (enrich / generate / deck-from-image) for decks with a
        // Ukrainian side. Haiku's Ukrainian came back with Russian words and
        // broken agreement, and cards are the product — a stronger model is
        // worth the extra cost on the few calls that write them. Chat replies
        // stay on ANTHROPIC_MODEL.
        ANTHROPIC_CONTENT_MODEL_UK: z.string().default('claude-sonnet-5'),

        // What a user can ask Mimi for each day. Free users see these three
        // ("2 decks · 50 messages · 5 card additions left today"), and only when
        // they are running low.
        //   DECKS    — Mimi makes a new deck (from a topic, a word list or a photo).
        //   MESSAGES — the user sends Mimi a chat message (with or without a photo).
        //   ACTIONS  — Mimi generates cards into an existing deck.
        // Premium is UNLIMITED as far as users can tell: the *_PREMIUM values are
        // hidden safety caps against abuse and are never shown to anyone.
        MIMI_DECKS_PER_DAY_FREE: z.coerce.number().int().positive().default(2),
        MIMI_DECKS_PER_DAY_PREMIUM: z.coerce.number().int().positive().default(100),
        MIMI_MESSAGES_PER_DAY_FREE: z.coerce.number().int().positive().default(50),
        MIMI_MESSAGES_PER_DAY_PREMIUM: z.coerce.number().int().positive().default(1000),
        MIMI_ACTIONS_PER_DAY_FREE: z.coerce.number().int().positive().default(5),
        MIMI_ACTIONS_PER_DAY_PREMIUM: z.coerce.number().int().positive().default(200),

        // Mimi's automatic tips (dashboard / review). Users never ask for these,
        // so they aren't shown as a limit — this only stops runaway clients.
        MIMI_TIPS_PER_DAY: z.coerce.number().int().positive().default(100),

        // Most words Mimi fills in one go (one pasted word list).
        MIMI_MAX_WORDS_PER_REQUEST: z.coerce.number().int().positive().max(200).default(100),

        // Hard byte ceiling on an uploaded image (images are never persisted).
        AI_IMAGE_MAX_BYTES: z.coerce.number().int().positive().default(5_000_000),

        // Chat — how many recent messages Mimi remembers, and the longest reply.
        // The ceiling includes thinking tokens, so it sits well above reply length.
        AI_CHAT_CONTEXT_TURNS: z.coerce.number().int().positive().max(100).default(20),
        AI_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(16000).default(8000),

        // External-import cap (Quizlet scrape + paste-text). Shares the ai_usage
        // table — same atomic upsert pattern, no extra schema needed.
        IMPORT_DAILY_CAP_PER_USER: z.coerce.number().int().positive().default(20),
        // Hard ceiling on response size + request timeout for the Quizlet fetch.
        IMPORT_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
        IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),
        IMPORT_APKG_MAX_BYTES: z.coerce.number().int().positive().default(100_000_000),

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

        // Paddle billing. All optional: with PADDLE_API_KEY unset every
        // /billing/* route answers BILLING_NOT_CONFIGURED and the frontend hides
        // its billing UI, so local dev works without a Paddle account.
        PADDLE_API_KEY: z.string().optional(),
        // The webhook notification SIGNING SECRET (pdl_ntfset_…), NOT the API
        // key. Used only to verify delivery signatures.
        PADDLE_WEBHOOK_SECRET: z.string().optional(),
        PADDLE_ENV: z.enum(['sandbox', 'production']).optional(),
        // Price IDs (pri_…) are environment-scoped — a sandbox id does not exist
        // in production. Must match app/data/plans.ts in mnemio-frontend.
        PADDLE_PRICE_MONTHLY: z.string().optional(),
        PADDLE_PRICE_ANNUAL: z.string().optional(),

        // Mixpanel server-side analytics (no-op when unset)
        MIXPANEL_TOKEN: z.string().optional(),
        MIXPANEL_API_SECRET: z.string().optional(),

        IMPORT_DAILY_CAP_PREMIUM_PER_USER: z.coerce.number().int().positive().default(200),
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
    // The logger isn't built yet — config is validated before the app starts.
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:');
    // eslint-disable-next-line no-console
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
