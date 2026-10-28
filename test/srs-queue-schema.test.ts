import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { queueQuerySchema } from '../src/schemas/srs.schema.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('srs.schema / queueQuerySchema deckIds', () => {
    it('trims and dedupes, keeping first-occurrence order', () => {
        const q = queueQuerySchema.parse({ deckIds: ` ${id(2)}, ${id(1)} ,${id(2)}` });
        expect(q.deckIds).toEqual([id(2), id(1)]);
    });

    it('leaves deckIds undefined when absent', () => {
        expect(queueQuerySchema.parse({}).deckIds).toBeUndefined();
    });

    it('accepts exactly 50 ids', () => {
        const ids = Array.from({ length: 50 }, (_, i) => id(i));
        expect(queueQuerySchema.parse({ deckIds: ids.join(',') }).deckIds).toHaveLength(50);
    });

    it.each([
        ['51 ids', { deckIds: Array.from({ length: 51 }, (_, i) => id(i)).join(',') }],
        ['an empty list', { deckIds: '' }],
        ['only commas', { deckIds: ' , ,' }],
        ['a non-uuid', { deckIds: `${id(1)},nope` }],
        ['deckId together with deckIds', { deckId: id(1), deckIds: id(2) }],
    ])('rejects %s', (_label, query) => {
        expect(() => queueQuerySchema.parse(query)).toThrow(ZodError);
    });
});
