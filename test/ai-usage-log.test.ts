import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../src/services/ai.usage-log.js';

const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
});

describe('estimateCostUsd', () => {
    it('prices input, output, cache writes (1.25x) and cache reads (0.1x)', () => {
        // Haiku 4.5: $1 in / $5 out.
        expect(estimateCostUsd('claude-haiku-4-5-20251001', usage(1000, 1000, 1000, 1000))).toBe(
            (1000 * 1 + 1000 * 5 + 1000 * 1.25 + 1000 * 0.1) / 1e6,
        );
    });

    it('Sonnet 5.5 cache hits cost 0.05x input, not 0.1x', () => {
        expect(estimateCostUsd('claude-sonnet-5-5', usage(0, 0, 0, 1_000_000))).toBe(0.1);
        expect(estimateCostUsd('claude-sonnet-5', usage(0, 0, 0, 1_000_000))).toBe(0.2);
    });

    it('Haiku 5.5 bills a prompt over 100k tokens (cache included) on the higher card', () => {
        expect(estimateCostUsd('claude-haiku-5-5', usage(100_000, 1000))).toBe(
            (100_000 * 0.1 + 1000 * 0.5) / 1e6,
        );
        // 60k uncached + 50k cache read = 110k prompt → $0.50 / $2.50 card.
        expect(estimateCostUsd('claude-haiku-5-5', usage(60_000, 1000, 0, 50_000))).toBe(
            (60_000 * 0.5 + 50_000 * 0.5 * 0.1 + 1000 * 2.5) / 1e6,
        );
    });

    it('returns null for an unpriced model rather than guessing', () => {
        expect(estimateCostUsd('claude-unknown-9', usage(1, 1))).toBeNull();
    });
});
