import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importIntoDeck } from '../src/services/deck-import.service.js';
import * as cardsService from '../src/services/cards.service.js';
import { ImportParseFailedError } from '../src/shared/errors.js';

vi.mock('../src/services/cards.service.js', () => ({
    bulkCreate: vi.fn(),
}));

const mocked = vi.mocked(cardsService);

describe('deck-import / CSV', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocked.bulkCreate.mockResolvedValue({ created: 0 });
    });

    it('parses a minimal word,definition CSV', async () => {
        const csv = 'word,definition\nagua,water\npan,bread\n';
        mocked.bulkCreate.mockResolvedValue({ created: 2 });
        const res = await importIntoDeck('u1', 'd1', 'csv', csv);
        expect(res).toEqual({ created: 2 });
        expect(mocked.bulkCreate).toHaveBeenCalledWith('u1', 'd1', {
            cards: [
                { word: 'agua', definition: 'water' },
                { word: 'pan', definition: 'bread' },
            ],
        });
    });

    it('keeps quoted commas in definitions and survives reordered columns', async () => {
        const csv = 'definition,word\n"water, the liquid",agua\n';
        await importIntoDeck('u1', 'd1', 'csv', csv);
        expect(mocked.bulkCreate).toHaveBeenCalledWith('u1', 'd1', {
            cards: [{ word: 'agua', definition: 'water, the liquid' }],
        });
    });

    it('splits tags column on semicolons', async () => {
        const csv = 'word,definition,tags\nagua,water,drink;noun\n';
        await importIntoDeck('u1', 'd1', 'csv', csv);
        expect(mocked.bulkCreate.mock.calls[0]?.[2].cards[0]?.tags).toEqual(['drink', 'noun']);
    });

    it('coerces difficulty and type when they match the enum', async () => {
        const csv = 'word,definition,difficulty,type\nagua,water,easy,basic\n';
        await importIntoDeck('u1', 'd1', 'csv', csv);
        const card = mocked.bulkCreate.mock.calls[0]?.[2].cards[0];
        expect(card?.difficulty).toBe('easy');
        expect(card?.type).toBe('basic');
    });

    it('drops invalid difficulty silently rather than failing the import', async () => {
        const csv = 'word,definition,difficulty\nagua,water,impossible\n';
        await importIntoDeck('u1', 'd1', 'csv', csv);
        const card = mocked.bulkCreate.mock.calls[0]?.[2].cards[0];
        expect(card?.difficulty).toBeUndefined();
    });

    it('throws when the CSV is missing the required word/definition headers', async () => {
        const csv = 'foo,bar\nagua,water\n';
        await expect(importIntoDeck('u1', 'd1', 'csv', csv)).rejects.toBeInstanceOf(
            ImportParseFailedError,
        );
    });

    it('throws when there are no data rows', async () => {
        const csv = 'word,definition\n';
        await expect(importIntoDeck('u1', 'd1', 'csv', csv)).rejects.toBeInstanceOf(
            ImportParseFailedError,
        );
    });
});

describe('deck-import / JSON', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocked.bulkCreate.mockResolvedValue({ created: 0 });
    });

    it('accepts a {deck, cards} export envelope', async () => {
        const json = JSON.stringify({
            deck: { title: 'Spanish' },
            cards: [{ word: 'agua', definition: 'water' }],
        });
        await importIntoDeck('u1', 'd1', 'json', json);
        expect(mocked.bulkCreate).toHaveBeenCalledWith('u1', 'd1', {
            cards: [{ word: 'agua', definition: 'water' }],
        });
    });

    it('accepts a bare cards[] array', async () => {
        const json = JSON.stringify([
            { word: 'agua', definition: 'water', tags: ['drink'], difficulty: 'easy' },
        ]);
        await importIntoDeck('u1', 'd1', 'json', json);
        const card = mocked.bulkCreate.mock.calls[0]?.[2].cards[0];
        expect(card).toMatchObject({
            word: 'agua',
            definition: 'water',
            tags: ['drink'],
            difficulty: 'easy',
        });
    });

    it('rejects unparseable JSON', async () => {
        await expect(importIntoDeck('u1', 'd1', 'json', 'not json')).rejects.toBeInstanceOf(
            ImportParseFailedError,
        );
    });

    it('rejects JSON that doesn\'t match the card shape', async () => {
        const json = JSON.stringify([{ foo: 'bar' }]);
        await expect(importIntoDeck('u1', 'd1', 'json', json)).rejects.toBeInstanceOf(
            ImportParseFailedError,
        );
    });
});
