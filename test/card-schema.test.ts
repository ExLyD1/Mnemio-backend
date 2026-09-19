import { describe, expect, it } from 'vitest';
import { createCardSchema, updateCardSchema } from '../src/schemas/card.schema.js';

const base = { word: 'Katze', definition: 'cat' };

describe('card.schema / media URLs', () => {
    // Regression: MEDIA_PUBLIC_BASE defaults to '/media', so every upload this
    // app produces is a root-relative path. z.string().url() rejected all of
    // them — the file was written, then the card save 400'd.
    it('accepts the app-relative path the media service actually returns', () => {
        const parsed = createCardSchema.parse({
            ...base,
            imageUrl: '/media/user-1/abc.png',
            audioUrl: '/media/user-1/abc.mp3',
        });
        expect(parsed.imageUrl).toBe('/media/user-1/abc.png');
        expect(parsed.audioUrl).toBe('/media/user-1/abc.mp3');
    });

    it('accepts an absolute https URL (remote/CDN storage)', () => {
        const parsed = createCardSchema.parse({
            ...base,
            imageUrl: 'https://cdn.example.com/a.png',
        });
        expect(parsed.imageUrl).toBe('https://cdn.example.com/a.png');
    });

    it('rejects a protocol-relative URL', () => {
        expect(() => createCardSchema.parse({ ...base, imageUrl: '//evil.com/a.png' })).toThrow();
    });

    it('rejects a non-http protocol', () => {
        expect(() =>
            createCardSchema.parse({ ...base, imageUrl: 'javascript:alert(1)' }),
        ).toThrow();
    });

    it('rejects a bare string that is neither a URL nor a path', () => {
        expect(() => createCardSchema.parse({ ...base, imageUrl: 'not-a-url' })).toThrow();
    });
});

describe('card.schema / clearing optional fields', () => {
    // Regression: optional fields were `.optional()` only, so there was no wire
    // representation for "erase this value".
    it('accepts null on update to clear a field', () => {
        const parsed = updateCardSchema.parse({ example: null, phonetic: null });
        expect(parsed.example).toBeNull();
        expect(parsed.phonetic).toBeNull();
    });

    it('accepts null media on update', () => {
        const parsed = updateCardSchema.parse({ imageUrl: null, audioUrl: null });
        expect(parsed.imageUrl).toBeNull();
        expect(parsed.audioUrl).toBeNull();
    });

    it('still requires at least one field', () => {
        expect(() => updateCardSchema.parse({})).toThrow();
    });

    it('still enforces max length', () => {
        expect(() => createCardSchema.parse({ ...base, phonetic: 'x'.repeat(121) })).toThrow();
    });
});
