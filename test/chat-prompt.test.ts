import { describe, it, expect } from 'vitest';
import {
    CHAT_SYSTEM_PROMPT,
    autoTitle,
    buildChatSystemPrompt,
} from '../src/services/chat.prompt.js';

describe('chat.prompt / CHAT_SYSTEM_PROMPT', () => {
    it('mentions Mnemio so the model knows where it is', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Mnemio');
    });

    // The UI calls the assistant Mimi everywhere ("Message Mimi…"), but the
    // assistant introduced itself as Mnemio — the app's name, not its own.
    it('identifies the assistant as Mimi, not as the app', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('You are Mimi');
    });

    it('forbids leaking tool names and internal codes to the user', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Never expose your own machinery');
    });

    it('lists the operations it cannot do, so it refuses instead of pretending', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('What you cannot do');
    });

    it('rules out "queued" / "try again in a moment" answers', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Failures are final');
    });
});

describe('chat.prompt / budget section', () => {
    const budget = {
        wordListRemaining: 2,
        wordListCap: 5,
        topicRemaining: 20,
        topicCap: 20,
        resetsAt: '2026-06-11T00:00:00.000Z',
        plan: 'free' as const,
    };

    it('states the real remaining counts so the model never invents a limit', () => {
        const prompt = buildChatSystemPrompt(undefined, 'en', false, undefined, budget);
        expect(prompt).toContain('2 of 5 left today');
        expect(prompt).toContain('20 of 20 left today');
        expect(prompt).toContain('2026-06-11T00:00:00.000Z');
    });

    it('tells the model not to call a tool once everything is used up', () => {
        const prompt = buildChatSystemPrompt(undefined, 'en', false, undefined, {
            ...budget,
            wordListRemaining: 0,
            topicRemaining: 0,
        });
        expect(prompt).toContain('do NOT call a tool');
        expect(prompt).toContain('Never say "try again in a moment"');
    });
});

describe('chat.prompt / deck context', () => {
    const deck = {
        deckId: 'd1',
        title: 'QA-Fruits',
        sourceLanguage: 'uk',
        targetLanguage: 'en',
    };

    it('pins add_cards to the open deck and forbids targeting another one', () => {
        const prompt = buildChatSystemPrompt(deck, 'en');
        expect(prompt).toContain('pass deckTitle exactly as "QA-Fruits"');
        expect(prompt).toContain('ONLY append to "QA-Fruits"');
    });
});

describe('chat.prompt / Ukrainian', () => {
    it('adds the product glossary only for the Ukrainian locale', () => {
        expect(buildChatSystemPrompt(undefined, 'uk')).toContain('«картка/картки»');
        expect(buildChatSystemPrompt(undefined, 'en')).not.toContain('«картка/картки»');
    });

    it('asks for concise replies (cost + UX)', () => {
        expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('concise');
    });

    it('mentions the create_deck tool so the model knows it exists', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('create_deck');
    });
});

describe('chat.prompt / autoTitle', () => {
    it('returns short messages verbatim', () => {
        expect(autoTitle('How do you say cat in Spanish?')).toBe('How do you say cat in Spanish?');
    });

    it('trims surrounding whitespace', () => {
        expect(autoTitle('   hello   ')).toBe('hello');
    });

    it('collapses runs of whitespace inside the title', () => {
        expect(autoTitle('how   do\nyou\tsay')).toBe('how do you say');
    });

    it('truncates to 60 chars with an ellipsis', () => {
        const long = 'A'.repeat(120);
        const title = autoTitle(long)!;
        expect(title.length).toBe(60);
        expect(title.endsWith('…')).toBe(true);
    });

    it('returns null for an empty / whitespace-only message', () => {
        expect(autoTitle('')).toBeNull();
        expect(autoTitle('   \n\t  ')).toBeNull();
    });
});
