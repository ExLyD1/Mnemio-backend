import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as srsRepo from '../src/repositories/srs.repository.js';
import { progress } from '../src/services/srs.service.js';

vi.mock('../src/repositories/srs.repository.js', async () => {
    const actual = await vi.importActual<typeof srsRepo>('../src/repositories/srs.repository.js');
    return { ...actual, findAllProgress: vi.fn() };
});

const mockedRepo = vi.mocked(srsRepo);

const row = (cardId: string, deckId: string) => ({
    userId: 'u1',
    cardId,
    interval: 3,
    easeFactor: 2.5,
    repetitions: 2,
    nextReviewAt: new Date('2026-09-20T10:00:00Z'),
    lastReviewedAt: new Date('2026-09-17T10:00:00Z'),
    masteredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    card: { deckId },
});

describe('srs.service / progress', () => {
    beforeEach(() => vi.resetAllMocks());

    // Without deckId the client could not tell which deck a row belonged to, so
    // it fetched every deck individually to rebuild the mapping — and any deck
    // past the first page of 20 was missing from the due queue entirely.
    it('reports the owning deck for every progress row', async () => {
        mockedRepo.findAllProgress.mockResolvedValue([
            row('c1', 'deck-a'),
            row('c2', 'deck-b'),
        ] as never);
        const rows = await progress('u1');
        expect(rows.map((r) => r.deckId)).toEqual(['deck-a', 'deck-b']);
    });

    it('still reports the SRS fields the scheduler needs', async () => {
        mockedRepo.findAllProgress.mockResolvedValue([row('c1', 'deck-a')] as never);
        const [r] = await progress('u1');
        expect(r).toMatchObject({
            cardId: 'c1',
            deckId: 'deck-a',
            interval: 3,
            easeFactor: 2.5,
            repetitions: 2,
            nextReviewAt: '2026-09-20T10:00:00.000Z',
        });
    });
});
