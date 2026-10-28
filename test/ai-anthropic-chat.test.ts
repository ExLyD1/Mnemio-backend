import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from '../src/services/ai.provider.anthropic.js';
import { env } from '../src/config/env.js';
import { setAiCallListener, type AiCallRecord } from '../src/services/ai.usage-log.js';
import { AiProviderError } from '../src/shared/errors.js';

const sdk = vi.hoisted(() => ({ stream: vi.fn(), finalMessage: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
    default: class {
        static APIError = class extends Error {};
        messages = { stream: sdk.stream };
    },
}));
vi.mock('../src/config/env.js', () => ({
    env: {
        ANTHROPIC_API_KEY: 'unit-test-placeholder',
        ANTHROPIC_MODEL: 'claude-haiku-5-5',
        ANTHROPIC_CHAT_EFFORT: 'low',
    },
}));

const reply = (text: string, extra: object = {}) => ({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
    ...extra,
});

const chat = () =>
    anthropicProvider.chat({
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'Test instructions',
        maxOutputTokens: 4096,
    });

let calls: AiCallRecord[] = [];

describe('Anthropic chat rounds', () => {
    beforeEach(() => {
        sdk.stream.mockReset();
        sdk.finalMessage.mockReset();
        sdk.stream.mockReturnValue({
            on: vi.fn(),
            abort: vi.fn(),
            finalMessage: sdk.finalMessage,
            currentMessage: undefined,
        });
        sdk.finalMessage.mockResolvedValue(reply('Hi!'));
        env.ANTHROPIC_MODEL = 'claude-haiku-5-5';
        env.ANTHROPIC_CHAT_EFFORT = 'low';
        calls = [];
        setAiCallListener((r) => calls.push(r));
    });
    afterEach(() => setAiCallListener(null));

    it.each(['low', 'medium', 'high'] as const)('sends output_config.effort=%s', async (effort) => {
        env.ANTHROPIC_CHAT_EFFORT = effort;
        await chat();
        expect(sdk.stream).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'claude-haiku-5-5',
                max_tokens: 4096,
                output_config: { effort },
            }),
        );
    });

    it('omits output_config entirely when effort is off', async () => {
        env.ANTHROPIC_CHAT_EFFORT = 'off';
        await chat();
        expect(sdk.stream.mock.calls[0]?.[0]).not.toHaveProperty('output_config');
    });

    it('drops effort for a model that rejects it instead of failing every turn', async () => {
        env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
        await chat();
        expect(sdk.stream.mock.calls[0]?.[0]).not.toHaveProperty('output_config');
    });

    it('never sends sampling parameters and never ends on an assistant turn', async () => {
        await chat();
        const body = sdk.stream.mock.calls[0]?.[0] as Record<string, unknown> & {
            messages: { role: string }[];
        };
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
            expect(body).not.toHaveProperty(key);
        }
        expect(body.messages.at(-1)?.role).toBe('user');
    });

    it('preserves refusal as an AiProviderError without re-wrapping its status', async () => {
        sdk.finalMessage.mockResolvedValue(reply('', { stop_reason: 'refusal' }));
        const error = await chat().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AiProviderError);
        expect(error).toMatchObject({
            code: 'AI_PROVIDER_ERROR',
            details: { providerStatus: 'refusal' },
        });
        expect(sdk.stream).toHaveBeenCalledTimes(1);
    });

    it('reads the reply by block type when thinking comes first', async () => {
        sdk.finalMessage.mockResolvedValue({
            ...reply('Answer'),
            content: [
                { type: 'thinking', thinking: '', signature: 'sig' },
                { type: 'text', text: 'Answer' },
            ],
        });
        await expect(chat()).resolves.toMatchObject({ tokensInput: 12 });
    });

    it.each([
        ['end_turn', 'Model returned an empty reply'],
        ['max_tokens', 'Reply ran out of tokens before any text'],
    ])('fails a turn that ends (%s) with thinking only', async (stopReason, message) => {
        sdk.finalMessage.mockResolvedValue({
            content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
            stop_reason: stopReason,
            usage: { input_tokens: 12, output_tokens: 4096 },
        });
        await expect(chat()).rejects.toMatchObject({
            message,
            details: { providerStatus: 'empty' },
        });
    });

    it('keeps a reply cut off by max_tokens when it has text', async () => {
        sdk.finalMessage.mockResolvedValue(
            reply('A long answer that', { stop_reason: 'max_tokens' }),
        );
        await expect(chat()).resolves.toBeDefined();
        expect(calls[0]?.stopReason).toBe('max_tokens');
    });

    it('logs usage once per call, with route, model and effort', async () => {
        await chat();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            op: 'chat_round1',
            route: 'chat',
            model: 'claude-haiku-5-5',
            effort: 'low',
            inputTokens: 12,
            outputTokens: 4,
        });
    });

    it('logs a call that fails midway, with the usage reported so far', async () => {
        sdk.stream.mockReturnValue({
            on: vi.fn(),
            abort: vi.fn(),
            finalMessage: sdk.finalMessage,
            currentMessage: { usage: { input_tokens: 30, output_tokens: 2 } },
        });
        sdk.finalMessage.mockRejectedValue(new Error('socket hang up'));
        await expect(chat()).rejects.toBeInstanceOf(AiProviderError);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ inputTokens: 30, error: 'socket hang up' });
    });

    it('does not log a call that was cancelled before any request went out', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            anthropicProvider.chat(
                {
                    messages: [{ role: 'user', content: 'Hello' }],
                    systemPrompt: 'Test instructions',
                    maxOutputTokens: 4096,
                },
                { signal: controller.signal },
            ),
        ).rejects.toBeInstanceOf(AiProviderError);
        expect(sdk.stream).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });

    it('round 2 keeps the tools (calls forbidden) and replays round 1 blocks unchanged', async () => {
        const round1Blocks = [
            { type: 'thinking', thinking: '', signature: 'sig-1' },
            { type: 'tool_use', id: 'call-1', name: 'create_deck', input: {} },
        ];
        sdk.finalMessage
            .mockResolvedValueOnce({
                content: round1Blocks,
                stop_reason: 'tool_use',
                usage: { input_tokens: 20, output_tokens: 8 },
            })
            .mockResolvedValueOnce(reply('Done!'));
        const defs = [{ name: 'create_deck', description: 'd', input_schema: {} }];
        const run = vi.fn().mockResolvedValue({ ok: true, data: {}, resultJson: '{}' });
        await anthropicProvider.chat({
            messages: [{ role: 'user', content: 'Create a deck' }],
            systemPrompt: 'Test instructions',
            maxOutputTokens: 4096,
            tools: { defs: defs as never, run },
        });
        const [round1, round2] = sdk.stream.mock.calls.map((c) => c[0] as Record<string, unknown>);
        expect(round1?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
        expect(round2?.tools).toEqual(round1?.tools);
        expect(round2?.tool_choice).toEqual({ type: 'none' });
        expect(round2?.system).toBe(round1?.system);
        const messages = round2?.messages as { role: string; content: unknown }[];
        expect(messages[1]).toEqual({ role: 'assistant', content: round1Blocks });
        expect(messages.at(-1)?.role).toBe('user');
        expect(calls.map((c) => c.op)).toEqual(['chat_round1', 'chat_round2']);
    });

    it('completes with the saved attachment when the confirmation round fails', async () => {
        sdk.finalMessage
            .mockResolvedValueOnce({
                content: [{ type: 'tool_use', id: 'call-1', name: 'create_deck', input: {} }],
                stop_reason: 'tool_use',
                usage: { input_tokens: 20, output_tokens: 8 },
            })
            .mockRejectedValueOnce(new Error('confirmation connection failed'));
        const attachment = { title: 'Saved deck', cardCount: 3, deckId: 'saved-1' };
        const run = vi.fn().mockResolvedValue({
            ok: true,
            data: attachment,
            resultJson: JSON.stringify(attachment),
        });
        const result = await anthropicProvider.chat({
            messages: [{ role: 'user', content: 'Create a deck' }],
            systemPrompt: 'Test instructions',
            maxOutputTokens: 4096,
            tools: { defs: [], run },
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(result.attachments).toEqual([attachment]);
        expect(result.content).toContain('Saved deck');
        expect(result.tokensInput).toBe(20);
        expect(result.tokensOutput).toBe(8);
        expect(sdk.stream).toHaveBeenCalledTimes(2);
    });
});
