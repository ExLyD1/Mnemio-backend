import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().url(),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    WEB_URL: z.string().url().default('http://localhost:3001'),
    APP_URL: z.string().url().default('http://localhost:3000'),

    MAIL_FROM: z.string().default('Mnemio <noreply@mnemio.local>'),
    MAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
    MAIL_PROVIDER_API_KEY: z.string().optional(),

    // AI provider for Mimi suggestions and deck generation. 'mock' returns
    // realistic-shaped placeholders so the FE can wire without a real key.
    AI_PROVIDER: z.enum(['mock']).default('mock'),

    // Media storage. 'local' writes to MEDIA_DIR and serves under MEDIA_PUBLIC_BASE
    // via @fastify/static. For prod, swap to S3-compatible presigned PUTs (see
    // src/services/media.service.ts comment).
    MEDIA_STORAGE: z.enum(['local']).default('local'),
    MEDIA_DIR: z.string().default('./uploads'),
    MEDIA_PUBLIC_BASE: z.string().default('/media'),
    MEDIA_MAX_AVATAR_BYTES: z.coerce.number().int().positive().default(2_000_000),
    MEDIA_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5_000_000),
    MEDIA_MAX_AUDIO_BYTES: z.coerce.number().int().positive().default(10_000_000),

    OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    OAUTH_FACEBOOK_CLIENT_ID: z.string().optional(),
    OAUTH_FACEBOOK_CLIENT_SECRET: z.string().optional(),
    OAUTH_APPLE_CLIENT_ID: z.string().optional(),
    OAUTH_APPLE_TEAM_ID: z.string().optional(),
    OAUTH_APPLE_KEY_ID: z.string().optional(),
    OAUTH_APPLE_PRIVATE_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment configuration:');
    console.error(z.treeifyError(parsed.error));
    process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
