import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as repo from '../src/repositories/achievements.repository.js';

vi.mock('../src/repositories/achievements.repository.js', () => ({
    findUserAchievements: vi.fn(),
    findUnseen: vi.fn(),
    markNotified: vi.fn(),
    upsertProgress: vi.fn(),
    countSessionsCompleted: vi.fn(),
    countPerfectSessions: vi.fn(),
    countCardsRated: vi.fn(),
    countCardsCreated: vi.fn(),
    countDistinctTargetLanguages: vi.fn(),
}));

const mocked = vi.mocked(repo);

// Import after the mock so `evaluate`/`listUnseen`/`acknowledge` see the mocked repo.
const service = await import('../src/services/achievements.service.js');

const zeroStats = () => {
    mocked.countSessionsCompleted.mockResolvedValue(0);
    mocked.countPerfectSessions.mockResolvedValue(0);
    mocked.countCardsRated.mockResolvedValue(0);
    mocked.countCardsCreated.mockResolvedValue(0);
    mocked.countDistinctTargetLanguages.mockResolvedValue(0);
};

describe('achievements.service', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        zeroStats();
        mocked.findUserAchievements.mockResolvedValue([]);
        mocked.findUnseen.mockResolvedValue([]);
        mocked.upsertProgress.mockResolvedValue({} as never);
        mocked.markNotified.mockResolvedValue({ count: 0 } as never);
    });

    describe('evaluate()', () => {
        it('returns the full achievement object (not just the key) on a fresh unlock', async () => {
            mocked.countSessionsCompleted.mockResolvedValue(1);
            const result = await service.evaluate('u1', 'session_complete');

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                key: 'first_steps',
                id: 'first_steps',
                name: 'First steps',
                earned: true,
                progress: 100,
            });
            expect(result[0]?.earnedAt).toEqual(expect.any(String));
        });

        it('is idempotent — an already-earned achievement is not re-stamped or re-returned', async () => {
            mocked.countSessionsCompleted.mockResolvedValue(1);
            mocked.findUserAchievements.mockResolvedValue([
                { userId: 'u1', key: 'first_steps', earnedAt: new Date('2026-01-01') },
            ] as never);

            const result = await service.evaluate('u1', 'session_complete');

            // Not re-earned/re-returned...
            expect(result).toEqual([]);
            // ...and its row is never touched again (other session_complete
            // candidates still get their progress tracked, just not this one).
            expect(mocked.upsertProgress).not.toHaveBeenCalledWith(
                'u1',
                'first_steps',
                expect.anything(),
            );
        });

        it('only re-evaluates achievements whose triggers include the fired trigger', async () => {
            mocked.countCardsRated.mockResolvedValue(999); // would unlock reviewer_100
            const result = await service.evaluate('u1', 'card_create');
            expect(result.map((a) => a.key)).not.toContain('reviewer_100');
        });
    });

    describe('listUnseen()', () => {
        it('maps unseen rows through the catalog', async () => {
            mocked.findUnseen.mockResolvedValue([
                { userId: 'u1', key: 'first_steps', earnedAt: new Date('2026-01-01') },
            ] as never);

            const result = await service.listUnseen('u1');
            expect(result).toEqual([
                expect.objectContaining({ key: 'first_steps', earned: true, progress: 100 }),
            ]);
        });

        it('drops rows for unknown/removed catalog keys', async () => {
            mocked.findUnseen.mockResolvedValue([
                { userId: 'u1', key: 'not_a_real_key', earnedAt: new Date() },
            ] as never);

            expect(await service.listUnseen('u1')).toEqual([]);
        });
    });

    describe('acknowledge()', () => {
        it('acks the given keys directly without a lookup', async () => {
            const acked = await service.acknowledge('u1', ['first_steps', 'builder_50']);
            expect(acked).toEqual(['first_steps', 'builder_50']);
            expect(mocked.markNotified).toHaveBeenCalledWith('u1', ['first_steps', 'builder_50']);
            expect(mocked.findUnseen).not.toHaveBeenCalled();
        });

        it('acks everything unseen when no keys are given', async () => {
            mocked.findUnseen.mockResolvedValue([
                { userId: 'u1', key: 'first_steps', earnedAt: new Date() },
                { userId: 'u1', key: 'builder_50', earnedAt: new Date() },
            ] as never);

            const acked = await service.acknowledge('u1');
            expect(acked).toEqual(['first_steps', 'builder_50']);
            expect(mocked.markNotified).toHaveBeenCalledWith('u1', ['first_steps', 'builder_50']);
        });

        it('is a no-op (and skips the write) when nothing is unseen', async () => {
            const acked = await service.acknowledge('u1');
            expect(acked).toEqual([]);
            expect(mocked.markNotified).not.toHaveBeenCalled();
        });
    });
});
