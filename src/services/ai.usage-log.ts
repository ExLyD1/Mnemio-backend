/**
 * One structured JSON line per Anthropic call, on stdout (Railway log viewer).
 *
 * Why: tokens are only persisted for chat replies (chat_messages), and that
 * figure leaves out the generation call a chat tool makes and any retried
 * attempt. Logging at the SDK boundary captures every call, including retries
 * and cache usage, so real per-operation cost can be read once users exist.
 *
 * Find them with:  evt="ai_call"   (fields: op, model, attempt, tokens, costUsd)
 */

type UsageLike = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null | undefined;
    cache_read_input_tokens?: number | null | undefined;
};

export type AiCallEvent = {
    op: string;
    model: string;
    usage: UsageLike;
    stopReason?: string | null | undefined;
    attempt?: number | undefined;
    durationMs?: number | undefined;
    stream?: boolean | undefined;
};

export type AiCallRecord = {
    evt: 'ai_call';
    time: number;
    op: string;
    model: string;
    attempt: number;
    stream: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    stopReason: string | null;
    durationMs: number | null;
    costUsd: number | null;
};

// USD per million tokens, [input, output]. Source:
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-10).
// Unlisted models log costUsd: null rather than a guess.
const PRICES: Record<string, readonly [number, number]> = {
    'claude-haiku-4-5-20251001': [1, 5],
    'claude-haiku-4-5': [1, 5],
    'claude-sonnet-5': [2, 10],
    'claude-sonnet-5-5': [2, 10],
};

// Prompt-cache multipliers on the input price (5-minute write, read).
const CACHE_WRITE_X = 1.25;
const CACHE_READ_X = 0.1;

export const estimateCostUsd = (model: string, usage: UsageLike): number | null => {
    const price = PRICES[model];
    if (!price) {
        return null;
    }
    const [inPrice, outPrice] = price;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const usd =
        (usage.input_tokens * inPrice +
            cacheWrite * inPrice * CACHE_WRITE_X +
            cacheRead * inPrice * CACHE_READ_X +
            usage.output_tokens * outPrice) /
        1_000_000;
    return Math.round(usd * 1e7) / 1e7;
};

let listener: ((record: AiCallRecord) => void) | null = null;

/** Lets a script (scripts/ai-calibrate.ts) collect records instead of reading logs. */
export const setAiCallListener = (fn: ((record: AiCallRecord) => void) | null): void => {
    listener = fn;
};

export const logAiCall = (event: AiCallEvent): void => {
    try {
        const record: AiCallRecord = {
            evt: 'ai_call',
            time: Date.now(),
            op: event.op,
            model: event.model,
            attempt: event.attempt ?? 1,
            stream: event.stream ?? false,
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
            stopReason: event.stopReason ?? null,
            durationMs: event.durationMs ?? null,
            costUsd: estimateCostUsd(event.model, event.usage),
        };
        listener?.(record);
        if (!process.env['VITEST']) {
            process.stdout.write(`${JSON.stringify(record)}\n`);
        }
    } catch {
        // Telemetry must never break a user request.
    }
};
