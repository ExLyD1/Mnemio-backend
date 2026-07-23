import { describe, it, expect } from 'vitest';
import { alignByInputOrder, chatTurnContent } from '../src/services/ai.provider.anthropic.js';
import type { AiCardDraft, ChatTurn } from '../src/services/ai.provider.js';

const card = (word: string, definition: string): AiCardDraft => ({ word, definition });

describe('ai.provider.anthropic / alignByInputOrder', () => {
    it('returns one card per requested word, in request order, when LLM returns same order', () => {
        const out = alignByInputOrder(['agua', 'pan', 'leche'], [
            card('agua', 'water'),
            card('pan', 'bread'),
            card('leche', 'milk'),
        ]);
        expect(out.map((c) => c.word)).toEqual(['agua', 'pan', 'leche']);
        expect(out.map((c) => c.definition)).toEqual(['water', 'bread', 'milk']);
    });

    it('reorders LLM output to match request order', () => {
        const out = alignByInputOrder(['agua', 'pan', 'leche'], [
            card('leche', 'milk'),
            card('agua', 'water'),
            card('pan', 'bread'),
        ]);
        expect(out.map((c) => c.word)).toEqual(['agua', 'pan', 'leche']);
        expect(out.map((c) => c.definition)).toEqual(['water', 'bread', 'milk']);
    });

    it('is case-insensitive when matching LLM output back to the request', () => {
        const out = alignByInputOrder(['Agua', 'Pan'], [
            card('AGUA', 'water'),
            card('pan', 'bread'),
        ]);
        // Word field stays as the user wrote it (request form).
        expect(out.map((c) => c.word)).toEqual(['Agua', 'Pan']);
        expect(out.map((c) => c.definition)).toEqual(['water', 'bread']);
    });

    it('fills missing words with empty definition + ai-unfilled tag', () => {
        const out = alignByInputOrder(['agua', 'unknownword', 'pan'], [
            card('agua', 'water'),
            card('pan', 'bread'),
        ]);
        expect(out[1]?.word).toBe('unknownword');
        expect(out[1]?.definition).toBe('');
        expect(out[1]?.tags).toEqual(['ai-unfilled']);
    });

    it('keeps optional metadata from the LLM card (phonetic / example / tags / difficulty)', () => {
        const rich: AiCardDraft = {
            word: 'agua',
            definition: 'water',
            phonetic: '/ˈa.ɣwa/',
            partOfSpeech: 'noun',
            example: 'Bebo agua.',
            exampleTranslation: 'I drink water.',
            tags: ['drink'],
            difficulty: 'easy',
        };
        const out = alignByInputOrder(['agua'], [rich]);
        expect(out[0]).toMatchObject({
            word: 'agua',
            phonetic: '/ˈa.ɣwa/',
            partOfSpeech: 'noun',
            example: 'Bebo agua.',
            exampleTranslation: 'I drink water.',
            tags: ['drink'],
            difficulty: 'easy',
        });
    });

    it('drops extra LLM cards that don\'t match any requested word', () => {
        const out = alignByInputOrder(['agua', 'pan'], [
            card('agua', 'water'),
            card('pan', 'bread'),
            card('huevo', 'egg'),  // LLM volunteered an extra
        ]);
        expect(out).toHaveLength(2);
        expect(out.map((c) => c.word)).toEqual(['agua', 'pan']);
    });

    it('returns ai-unfilled placeholders for every word when LLM returns nothing', () => {
        const out = alignByInputOrder(['agua', 'pan'], []);
        expect(out).toHaveLength(2);
        expect(out.every((c) => c.definition === '')).toBe(true);
        expect(out.every((c) => c.tags?.includes('ai-unfilled'))).toBe(true);
    });
});

describe('ai.provider.anthropic / chatTurnContent', () => {
    it('passes plain text through unchanged for a turn with no image', () => {
        const turn: ChatTurn = { role: 'user', content: 'hello' };
        expect(chatTurnContent(turn)).toBe('hello');
    });

    it('builds an image + text content array when the turn has both', () => {
        const turn: ChatTurn = {
            role: 'user',
            content: 'what does this say?',
            image: { mediaType: 'image/png', dataBase64: 'ZmFrZQ==' },
        };
        const content = chatTurnContent(turn);
        expect(Array.isArray(content)).toBe(true);
        const blocks = content as Array<{ type: string }>;
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toMatchObject({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
        });
        expect(blocks[1]).toMatchObject({ type: 'text', text: 'what does this say?' });
    });

    it('omits the text block when the image-only turn has no content', () => {
        const turn: ChatTurn = {
            role: 'user',
            content: '',
            image: { mediaType: 'image/jpeg', dataBase64: 'ZmFrZQ==' },
        };
        const content = chatTurnContent(turn);
        const blocks = content as Array<{ type: string }>;
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ type: 'image' });
    });

    it('prior (imageless) turns are unaffected — only the flagged turn gets multimodal content', () => {
        const priorTurn: ChatTurn = { role: 'assistant', content: 'sure, go ahead' };
        expect(chatTurnContent(priorTurn)).toBe('sure, go ahead');
    });
});
