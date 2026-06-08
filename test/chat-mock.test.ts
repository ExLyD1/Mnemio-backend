import { describe, it, expect, vi } from 'vitest';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import type { ChatStreamEvent } from '../src/services/ai.provider.js';

describe('ai.provider.mock / chat', () => {
    it('emits token events in order, then a done event', async () => {
        const events: ChatStreamEvent[] = [];
        const result = await mockProvider.chat(
            {
                messages: [{ role: 'user', content: 'hi' }],
                systemPrompt: 'be helpful',
                maxOutputTokens: 1024,
            },
            { onEvent: (e) => events.push(e) },
        );

        const tokens = events.filter((e) => e.type === 'token');
        expect(tokens.length).toBeGreaterThan(0);

        const last = events.at(-1);
        expect(last?.type).toBe('done');

        // The returned content matches the concatenated deltas.
        const concatenated = tokens
            .filter((e): e is { type: 'token'; delta: string } => e.type === 'token')
            .map((e) => e.delta)
            .join('');
        expect(result.content).toBe(concatenated);
    });

    it('returns the same content whether onEvent is supplied or not', async () => {
        const withEvents = await mockProvider.chat(
            {
                messages: [{ role: 'user', content: 'hi' }],
                systemPrompt: 'be helpful',
                maxOutputTokens: 1024,
            },
            { onEvent: vi.fn() },
        );
        const withoutEvents = await mockProvider.chat({
            messages: [{ role: 'user', content: 'hi' }],
            systemPrompt: 'be helpful',
            maxOutputTokens: 1024,
        });
        expect(withoutEvents.content).toBe(withEvents.content);
    });

    it('varies its reply based on the last user turn length', async () => {
        const shortReply = await mockProvider.chat({
            messages: [{ role: 'user', content: 'hi' }],
            systemPrompt: '',
            maxOutputTokens: 1024,
        });
        const longReply = await mockProvider.chat({
            messages: [
                { role: 'user', content: 'this is a much longer prompt that exceeds the threshold' },
            ],
            systemPrompt: '',
            maxOutputTokens: 1024,
        });
        expect(shortReply.content).not.toBe(longReply.content);
    });

    it('reports zero tokens (mock has no real provider)', async () => {
        const result = await mockProvider.chat({
            messages: [{ role: 'user', content: 'hi' }],
            systemPrompt: '',
            maxOutputTokens: 1024,
        });
        expect(result.tokensInput).toBe(0);
        expect(result.tokensOutput).toBe(0);
    });
});
