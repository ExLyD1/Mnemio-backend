import { describe, expect, it } from 'vitest';
import {
    buildEnrichWordsPrompt,
    buildGenerateDeckPrompt,
    promptLang,
} from '../src/services/ai.prompts.js';
import { buildChatSystemPrompt } from '../src/services/chat.prompt.js';

// QA: decks for Ukrainian speakers came back with English definitions and no
// example translations. A bare "uk" in the prompt reads as "United Kingdom".
describe('ai.prompts — unambiguous language names', () => {
    it('expands ISO codes to "Name (code)"', () => {
        expect(promptLang('uk')).toBe('Ukrainian (uk)');
        expect(promptLang('en')).toBe('English (en)');
        expect(promptLang('uk-UA')).toBe('Ukrainian (uk)');
    });

    it('passes unknown values through unchanged', () => {
        expect(promptLang('xx')).toBe('xx');
    });

    it('enrich prompt names both languages and asks for example translations', () => {
        const { system, user } = buildEnrichWordsPrompt({
            words: ['school'],
            sourceLanguage: 'uk',
            targetLanguage: 'en',
        } as never);
        const text = system[0]!.text;
        expect(text).toContain('translated into Ukrainian (uk)');
        expect(text).toContain('exampleTranslation (REQUIRED whenever you give an example');
        expect(text).not.toMatch(/translated into uk\b/);
        expect(user).toContain('in English (en)');
    });

    it('generate-deck prompt names both languages', () => {
        const { user } = buildGenerateDeckPrompt({
            topic: 'school',
            sourceLanguage: 'uk',
            targetLanguage: 'en',
        } as never);
        expect(user).toContain('Source language (for definitions/translations): Ukrainian (uk)');
        expect(user).toContain('Target language (for the words being learned): English (en)');
    });
});

describe('chat.prompt — create_deck language defaults', () => {
    it('does not tell the model to use the app language as the target language', () => {
        const prompt = buildChatSystemPrompt(undefined, 'uk');
        expect(prompt).not.toContain('default sourceLanguage/targetLanguage');
        expect(prompt).toContain('Never set targetLanguage to "uk" just because it is the app language');
    });
});
