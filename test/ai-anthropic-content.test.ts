import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from '../src/services/ai.provider.anthropic.js';
import { env } from '../src/config/env.js';
import { setAiCallListener, type AiCallRecord } from '../src/services/ai.usage-log.js';
import { AiProviderError, AiValidationFailedError } from '../src/shared/errors.js';
import type { GenerateDeckEvent } from '../src/services/ai.provider.js';
import { SUBJECTS } from '../src/shared/subjects.js';

const sdk = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
    default: class {
        static APIError = class extends Error {};
        messages = { stream: sdk.stream };
    },
}));
vi.mock('../src/config/env.js', () => ({
    env: {
        ANTHROPIC_API_KEY: 'unit-test-placeholder',
        ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
        ANTHROPIC_CHAT_EFFORT: 'off',
        ANTHROPIC_CONTENT_MODEL_EN: undefined,
        ANTHROPIC_CONTENT_EFFORT_EN: 'off',
        ANTHROPIC_CONTENT_MODEL_UK: 'claude-sonnet-5',
        ANTHROPIC_CONTENT_EFFORT_UK: 'off',
        ANTHROPIC_PHOTO_MODEL: undefined,
        ANTHROPIC_PHOTO_EFFORT: 'off',
    },
}));

type Final = {
    content: unknown[];
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
};

// A stand-in for the SDK's MessageStream: replays `snapshots` to the
// inputJson listeners, then resolves (or rejects) the final message.
const fakeStream = (final: Final | Error, snapshots: unknown[] = []) => {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    return {
        on: (event: string, fn: (...a: unknown[]) => void) => {
            (handlers[event] ??= []).push(fn);
        },
        abort: vi.fn(),
        currentMessage: { usage: { input_tokens: 7, output_tokens: 1 } },
        finalMessage: () => {
            for (const s of snapshots) {
                for (const fn of handlers['inputJson'] ?? []) {
                    fn('', s);
                }
            }
            return final instanceof Error ? Promise.reject(final) : Promise.resolve(final);
        },
    };
};

const toolReply = (name: string, input: unknown, stopReason = 'tool_use'): Final => ({
    content: [{ type: 'tool_use', id: 't1', name, input }],
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 50 },
});

const card = (word: string) => ({ word, definition: `def of ${word}` });
const deck = (n: number) => ({
    title: 'T',
    description: 'D',
    sourceLanguage: 'en',
    targetLanguage: 'de',
    cards: Array.from({ length: n }, (_, i) => card(`w${i}`)),
});
const enrich = (words: string[], lang = 'en') =>
    anthropicProvider.enrichWords({ words, sourceLanguage: lang, targetLanguage: 'de' });
const generate = (count: number, lang = 'en', onEvent?: (e: GenerateDeckEvent) => void) =>
    anthropicProvider.generateDeck(
        { topic: 'Food', sourceLanguage: lang, targetLanguage: 'de', count },
        onEvent ? { onEvent } : undefined,
    );
const body = (i: number) => sdk.stream.mock.calls[i]?.[0] as Record<string, unknown>;

let calls: AiCallRecord[] = [];

beforeEach(() => {
    sdk.stream.mockReset();
    env.ANTHROPIC_CONTENT_MODEL_UK = 'claude-sonnet-5';
    env.ANTHROPIC_CONTENT_MODEL_EN = undefined;
    env.ANTHROPIC_CONTENT_EFFORT_EN = 'off';
    env.ANTHROPIC_CONTENT_EFFORT_UK = 'off';
    calls = [];
    setAiCallListener((r) => calls.push(r));
});
afterEach(() => setAiCallListener(null));

describe('content routing', () => {
    it('keeps today’s routing by default: non-UK on ANTHROPIC_MODEL, UK on its own model', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
        );
        await enrich(['a']);
        await enrich(['a'], 'uk');
        expect(body(0).model).toBe('claude-haiku-4-5-20251001');
        expect(body(1).model).toBe('claude-sonnet-5');
        expect(calls.map((c) => c.route)).toEqual(['content_en', 'content_uk']);
    });

    it('sends the route’s effort, and omits it when off', async () => {
        env.ANTHROPIC_CONTENT_MODEL_EN = 'claude-haiku-5-5';
        env.ANTHROPIC_CONTENT_EFFORT_EN = 'medium';
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
        );
        await enrich(['a']);
        await enrich(['a'], 'uk');
        expect(body(0).output_config).toEqual({ effort: 'medium' });
        expect(body(1)).not.toHaveProperty('output_config');
    });

    it('forces the tool where the model allows it', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
        );
        await enrich(['a']);
        expect(body(0).tool_choice).toEqual({ type: 'tool', name: 'emit_cards' });
        expect((body(0).tools as { strict?: boolean }[])[0]).not.toHaveProperty('strict');
    });

    it('uses auto + a strict tool on Sonnet 5.5, which rejects forced tool_choice', async () => {
        env.ANTHROPIC_CONTENT_MODEL_UK = 'claude-sonnet-5-5';
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
        );
        await enrich(['a'], 'uk');
        expect(body(0).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
        expect((body(0).tools as { strict?: boolean }[])[0]?.strict).toBe(true);
        // Room for thinking before the tool call.
        expect(body(0).max_tokens).toBe(1000 + 8000);
    });

    it('scales max_tokens for Haiku 5.5’s heavier tokenizer', async () => {
        env.ANTHROPIC_CONTENT_MODEL_EN = 'claude-haiku-5-5';
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
        );
        await enrich(Array.from({ length: 10 }, (_, i) => `w${i}`));
        expect(body(0).max_tokens).toBe(Math.ceil(2000 * 1.3));
    });

    it('never sends sampling parameters or an assistant prefill', async () => {
        sdk.stream.mockImplementation(() => fakeStream(toolReply('emit_deck', deck(3))));
        await generate(3);
        for (const key of ['temperature', 'top_p', 'top_k']) {
            expect(body(0)).not.toHaveProperty(key);
        }
        const messages = body(0).messages as { role: string }[];
        expect(messages.map((m) => m.role)).toEqual(['user']);
    });
});

describe('retry policy (non-streaming)', () => {
    it('reads the tool call by type when thinking comes first', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream({
                ...toolReply('emit_deck', deck(3)),
                content: [
                    { type: 'thinking', thinking: '', signature: 's' },
                    { type: 'text', text: 'Here you go' },
                    { type: 'tool_use', id: 't', name: 'emit_deck', input: deck(3) },
                ],
            }),
        );
        await expect(generate(3)).resolves.toMatchObject({ title: 'T' });
        expect(sdk.stream).toHaveBeenCalledTimes(1);
    });

    it('never retries a refusal', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream({
                content: [],
                stop_reason: 'refusal',
                usage: { input_tokens: 9, output_tokens: 0 },
            }),
        );
        await expect(generate(3)).rejects.toMatchObject({ details: { providerStatus: 'refusal' } });
        expect(sdk.stream).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1);
    });

    it('retries invalid output once with a note, then gives up', async () => {
        sdk.stream.mockImplementation(() => fakeStream(toolReply('emit_deck', { title: 'T' })));
        await expect(generate(3)).rejects.toBeInstanceOf(AiValidationFailedError);
        expect(sdk.stream).toHaveBeenCalledTimes(2);
        const retryMessage = (body(1).messages as { content: string }[])[0]?.content;
        expect(retryMessage).toContain('Retry: your previous output failed schema validation');
        expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    });

    it('retries a missing tool call once', async () => {
        sdk.stream
            .mockImplementationOnce(() =>
                fakeStream({
                    content: [{ type: 'text', text: 'Sure!' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 5, output_tokens: 5 },
                }),
            )
            .mockImplementationOnce(() => fakeStream(toolReply('emit_deck', deck(3))));
        await expect(generate(3)).resolves.toMatchObject({ title: 'T' });
        expect(sdk.stream).toHaveBeenCalledTimes(2);
    });

    it('never accepts a cut-off deck: retries with twice the tokens, then fails', async () => {
        // Truncated JSON still parses into a valid-looking, shorter deck.
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_deck', deck(2), 'max_tokens')),
        );
        await expect(generate(20)).rejects.toThrow('cut off');
        expect(sdk.stream).toHaveBeenCalledTimes(2);
        expect(body(1).max_tokens).toBe(2 * body(0).max_tokens);
        expect(calls.map((c) => c.stopReason)).toEqual(['max_tokens', 'max_tokens']);
    });

    it('a truncated first attempt can succeed on the bigger retry; tokens are summed', async () => {
        sdk.stream
            .mockImplementationOnce(() =>
                fakeStream(toolReply('emit_cards', { cards: [] }, 'max_tokens')),
            )
            .mockImplementationOnce(() =>
                fakeStream(toolReply('emit_cards', { cards: [card('a')] })),
            );
        const result = await enrich(['a']);
        expect(result.meta).toMatchObject({ enriched: 1, tokensInput: 200, tokensOutput: 100 });
    });

    it('logs every call once, including a call that fails midway', async () => {
        sdk.stream.mockImplementation(() => fakeStream(new Error('overloaded')));
        await expect(generate(3)).rejects.toBeInstanceOf(AiProviderError);
        expect(sdk.stream).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            op: 'generate_deck',
            inputTokens: 7,
            error: 'overloaded',
        });
    });
});

describe('streaming (SSE) callers', () => {
    it('fails a cut-off deck instead of saving it short, and does not retry', async () => {
        const events: GenerateDeckEvent[] = [];
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_deck', deck(2), 'max_tokens'), [deck(2)]),
        );
        await expect(generate(20, 'en', (e) => events.push(e))).rejects.toThrow('cut off');
        expect(sdk.stream).toHaveBeenCalledTimes(1);
        expect(events.some((e) => e.type === 'done')).toBe(false);
    });

    it('emits each card once, then done', async () => {
        const events: GenerateDeckEvent[] = [];
        const full = deck(3);
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_deck', full), [
                { ...full, cards: full.cards.slice(0, 2) },
                full,
            ]),
        );
        await generate(3, 'en', (e) => events.push(e));
        const positions = events.flatMap((e) => (e.type === 'card' ? [e.position] : []));
        expect(positions).toEqual([0, 1, 2]);
        expect(events.at(-1)?.type).toBe('done');
    });

    it('a cut-off word list keeps the whole cards and marks the rest ai-unfilled', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream(
                toolReply('emit_cards', { cards: [card('a'), { word: 'b' }] }, 'max_tokens'),
            ),
        );
        const result = await anthropicProvider.enrichWords(
            { words: ['a', 'b', 'c'], sourceLanguage: 'en', targetLanguage: 'de' },
            { onCard: () => undefined },
        );
        expect(result.cards.map((c) => c.definition !== '')).toEqual([true, false, false]);
        expect(result.cards[2]?.tags).toEqual(['ai-unfilled']);
        expect(sdk.stream).toHaveBeenCalledTimes(1);
    });
});

describe('subject enum in tool schemas', () => {
    const toolOf = (i: number) =>
        (
            body(i)['tools'] as {
                name: string;
                input_schema: { properties: Record<string, unknown> };
            }[]
        )[0];

    it('emit_deck constrains subject to the 12', async () => {
        sdk.stream.mockImplementation(() => fakeStream(toolReply('emit_deck', deck(3))));
        await generate(3);
        const props = toolOf(0)?.input_schema.properties as { subject: { enum: string[] } };
        expect(props.subject.enum).toEqual([...SUBJECTS]);
    });

    it('classifySubject calls emit_subject with the same enum and returns the pick', async () => {
        sdk.stream.mockImplementation(() =>
            fakeStream(toolReply('emit_subject', { subject: 'medicine' })),
        );
        const r = await anthropicProvider.classifySubject({
            title: 'Anatomy',
            sourceLanguage: 'en',
            targetLanguage: 'en',
            words: ['femur'],
        });
        expect(r).toEqual({ subject: 'medicine' });
        const tool = toolOf(0);
        expect(tool?.name).toBe('emit_subject');
        const props = tool?.input_schema.properties as { subject: { enum: string[] } };
        expect(props.subject.enum).toEqual([...SUBJECTS]);
        expect(calls[0]?.op).toBe('classify_subject');
    });
});
