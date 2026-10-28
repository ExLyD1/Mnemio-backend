/**
 * Which Claude model (and thinking effort) each AI route uses, and the API
 * differences between those models that the provider has to respect.
 *
 * Kept apart from the provider so routing is unit-testable and so the eval
 * script (scripts/ai-calibrate.ts) can reason about the same routes.
 */
import { env } from '../config/env.js';
import { normalizeLang } from '../shared/lang.js';

export type Effort = 'off' | 'low' | 'medium' | 'high';

// 'chat' covers chat replies and tips; 'content_*' writes card content; 'photo'
// is photo → deck when ANTHROPIC_PHOTO_MODEL overrides the content route.
export type AiRoute = 'chat' | 'content_en' | 'content_uk' | 'photo';

export type RouteChoice = { route: AiRoute; model: string; effort: Effort };

const hasUkrainian = (langs: (string | undefined)[]): boolean =>
    langs.some((l) => l && normalizeLang(l) === 'uk');

/**
 * Card content. Ukrainian gets its own model: the fast one produced Russian
 * loanwords and broken agreement on the very text learners study.
 */
export const contentRoute = (...langs: (string | undefined)[]): RouteChoice =>
    hasUkrainian(langs)
        ? {
              route: 'content_uk',
              model: env.ANTHROPIC_CONTENT_MODEL_UK,
              effort: env.ANTHROPIC_CONTENT_EFFORT_UK,
          }
        : {
              route: 'content_en',
              model: env.ANTHROPIC_CONTENT_MODEL_EN ?? env.ANTHROPIC_MODEL,
              effort: env.ANTHROPIC_CONTENT_EFFORT_EN,
          };

export const photoRoute = (...langs: (string | undefined)[]): RouteChoice =>
    env.ANTHROPIC_PHOTO_MODEL
        ? { route: 'photo', model: env.ANTHROPIC_PHOTO_MODEL, effort: env.ANTHROPIC_PHOTO_EFFORT }
        : contentRoute(...langs);

export const chatRoute = (): RouteChoice => ({
    route: 'chat',
    model: env.ANTHROPIC_MODEL,
    effort: env.ANTHROPIC_CHAT_EFFORT,
});

export type ModelCaps = {
    // Accepts output_config.effort. Haiku 4.5 rejects it with a 400.
    supportsEffort: boolean;
    // Accepts tool_choice {type:'tool'}. Sonnet 5.5 and newer reject it with a
    // 400, so content calls use 'auto' + a strict tool there.
    forcedToolChoice: boolean;
    // Tokens for the same text relative to the model the max_tokens formulas
    // were tuned on (Haiku 4.5 / Sonnet 5). Haiku 5.5's tokenizer counts ~30%
    // more.
    tokenFactor: number;
};

export const modelCaps = (model: string): ModelCaps => {
    if (model.startsWith('claude-haiku-4-5')) {
        return { supportsEffort: false, forcedToolChoice: true, tokenFactor: 1 };
    }
    if (model === 'claude-sonnet-5') {
        return { supportsEffort: true, forcedToolChoice: true, tokenFactor: 1 };
    }
    if (model === 'claude-haiku-5-5') {
        // A forced tool call skips thinking on this model, so no headroom.
        return { supportsEffort: true, forcedToolChoice: true, tokenFactor: 1.3 };
    }
    // Sonnet 5.5 (same tokenizer as Sonnet 5) and anything newer we don't know
    // yet: assume the newest API surface.
    return { supportsEffort: true, forcedToolChoice: false, tokenFactor: 1 };
};

// Room for adaptive thinking before an 'auto' tool call. Thinking counts
// toward max_tokens, and running out of it truncates the tool JSON.
export const THINKING_HEADROOM_TOKENS = 8000;

/** max_tokens for a call, from a formula tuned on Haiku 4.5 / Sonnet 5. */
export const scaledMaxTokens = (base: number, caps: ModelCaps): number =>
    Math.ceil(base * caps.tokenFactor) + (caps.forcedToolChoice ? 0 : THINKING_HEADROOM_TOKENS);

const warnedEffort = new Set<string>();

/**
 * The `output_config` to send, or nothing. Effort on a model that rejects it
 * would fail every call on that route, so it is dropped with a one-time
 * warning instead of taking the route down.
 */
export const effortParam = (
    model: string,
    effort: Effort,
): { output_config: { effort: Exclude<Effort, 'off'> } } | Record<string, never> => {
    if (effort === 'off') {
        return {};
    }
    if (!modelCaps(model).supportsEffort) {
        if (!warnedEffort.has(model)) {
            warnedEffort.add(model);
            // eslint-disable-next-line no-console
            console.warn(
                JSON.stringify({ evt: 'ai_config_warning', model, effort, msg: 'effort ignored' }),
            );
        }
        return {};
    }
    return { output_config: { effort } };
};
