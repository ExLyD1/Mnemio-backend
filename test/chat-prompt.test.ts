import { describe, it, expect } from 'vitest';
import { CHAT_SYSTEM_PROMPT, autoTitle } from '../src/services/chat.prompt.js';

describe('chat.prompt / CHAT_SYSTEM_PROMPT', () => {
    it('mentions Mnemio so the model knows where it is', () => {
        expect(CHAT_SYSTEM_PROMPT).toContain('Mnemio');
    });

    it('asks for concise replies (cost + UX)', () => {
        expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('concise');
    });
});

describe('chat.prompt / autoTitle', () => {
    it('returns short messages verbatim', () => {
        expect(autoTitle('How do you say cat in Spanish?')).toBe(
            'How do you say cat in Spanish?',
        );
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
