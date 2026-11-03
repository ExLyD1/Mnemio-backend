import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeRaw = vi.hoisted(() => vi.fn());
vi.mock('../src/db/prisma.js', () => ({ prisma: { $executeRaw: executeRaw } }));

import { recordStudied } from '../src/repositories/user-decks.repository.js';

beforeEach(() => executeRaw.mockReset());

describe('user-decks.repository / recordStudied', () => {
    it('writes one upsert that unions the stored ids in SQL (safe across devices)', async () => {
        executeRaw.mockResolvedValue(1);
        await recordStudied('u1', 'd1', ['a', 'b', 'a']);
        expect(executeRaw).toHaveBeenCalledTimes(1);
        const [strings, ...values] = executeRaw.mock.calls[0] as [string[], ...unknown[]];
        const sql = strings.join('?');
        expect(sql).toContain('ON CONFLICT ("userId", "deckId") DO UPDATE');
        expect(sql).toContain('array_agg(DISTINCT c)');
        // user, deck, de-duplicated ids, count of the NEW ids
        expect(values).toEqual(['u1', 'd1', ['a', 'b'], 2]);
    });

    it('does nothing for an empty list', async () => {
        await recordStudied('u1', 'd1', []);
        expect(executeRaw).not.toHaveBeenCalled();
    });
});
