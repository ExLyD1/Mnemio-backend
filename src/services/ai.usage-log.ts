/**
 * One structured JSON line per Anthropic call, on stdout (Railway log viewer).
 *
 * Why: tokens are only persisted for chat replies (chat_messages), and that
 * figure leaves out the generation call a chat tool makes and any retried
 * attempt. Logging at the SDK boundary captures every call, including retries,
 * failed calls and cache usage, so real per-operation cost can be read.
 *
 * Find them with:  evt="ai_call"   (fields: op, route, model, attempt, tokens, costUsd)
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
    // Missing when the call failed before the API reported any usage.
    usage: UsageLike | null | undefined;
    route?: string | undefined;
    effort?: string | undefined;
    stopReason?: string | null | undefined;
    attempt?: number | undefined;
    durationMs?: number | undefined;
    // Time to the first streamed text or tool-input delta.
    ttftMs?: number | null | undefined;
    stream?: boolean | undefined;
    error?: string | undefined;
};

export type AiCallRecord = {
    evt: 'ai_call';
    time: number;
    op: string;
    route: string | null;
    model: string;
    effort: string | null;
    attempt: number;
    stream: boolean;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    stopReason: string | null;
    durationMs: number | null;
    ttftMs: number | null;
    error: string | null;
    costUsd: number | null;
};

type Price = {
    input: number; // USD per million tokens
    output: number;
    cacheReadX: number; // cache hit, as a multiple of the input price
};

// Source: https://platform.claude.com/docs/en/about-claude/pricing (checked
// 2026-10-27). Unlisted models log costUsd: null rather than a guess.
const PRICES: Record<string, Price> = {
    'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheReadX: 0.1 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheReadX: 0.1 },
    'claude-sonnet-5': { input: 2, output: 10, cacheReadX: 0.1 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheReadX: 0.05 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheReadX: 0.1 },
};

// Haiku 5.5 bills a request whose prompt (input + cache reads + cache writes)
// is over 100k tokens at a second, higher rate card — the whole request.
const LONG_PROMPT: Record<string, { over: number; price: Price }> = {
    'claude-haiku-5-5': { over: 100_000, price: { input: 0.5, output: 2.5, cacheReadX: 0.1 } },
};

// 5-minute cache writes, as a multiple of the input price (every model).
const CACHE_WRITE_X = 1.25;

export const estimateCostUsd = (model: string, usage: UsageLike): number | null => {
    const base = PRICES[model];
    if (!base) {
        return null;
    }
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const promptTokens = usage.input_tokens + cacheWrite + cacheRead;
    const long = LONG_PROMPT[model];
    const price = long && promptTokens > long.over ? long.price : base;
    const usd =
        (usage.input_tokens * price.input +
            cacheWrite * price.input * CACHE_WRITE_X +
            cacheRead * price.input * price.cacheReadX +
            usage.output_tokens * price.output) /
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
        const usage = event.usage ?? { input_tokens: 0, output_tokens: 0 };
        const record: AiCallRecord = {
            evt: 'ai_call',
            time: Date.now(),
            op: event.op,
            route: event.route ?? null,
            model: event.model,
            effort: event.effort ?? null,
            attempt: event.attempt ?? 1,
            stream: event.stream ?? false,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            stopReason: event.stopReason ?? null,
            durationMs: event.durationMs ?? null,
            ttftMs: event.ttftMs ?? null,
            error: event.error ?? null,
            costUsd: estimateCostUsd(event.model, usage),
        };
        listener?.(record);
        if (!process.env['VITEST']) {
            process.stdout.write(`${JSON.stringify(record)}\n`);
        }
    } catch {
        // Telemetry must never break a user request.
    }
};
