import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from '../src/services/ai.provider.anthropic.js';
import { env } from '../src/config/env.js';
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

const chat = () =>
    anthropicProvider.chat!({
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'Test instructions',
        maxOutputTokens: 4096,
    });

describe('Anthropic chat rounds', () => {
    beforeEach(() => {
        sdk.stream.mockReturnValue({ on: vi.fn(), finalMessage: sdk.finalMessage });
        sdk.finalMessage.mockResolvedValue({
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 4 },
        });
        env.ANTHROPIC_CHAT_EFFORT = 'low';
    });

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

    it('preserves refusal as an AiProviderError without re-wrapping its status', async () => {
        sdk.finalMessage.mockResolvedValue({ content: [], stop_reason: 'refusal' });
        const error = await chat().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(AiProviderError);
        expect(error).toMatchObject({
            code: 'AI_PROVIDER_ERROR',
            details: { providerStatus: 'refusal' },
        });
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
        const result = await anthropicProvider.chat!({
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
        expect(sdk.stream.mock.calls[1]?.[0]).not.toHaveProperty('tools');
    });
});
