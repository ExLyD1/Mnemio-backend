import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as activityRepo from '../src/repositories/activity.repository.js';
import * as srsRepo from '../src/repositories/srs.repository.js';
import { overview } from '../src/services/stats.service.js';

vi.mock('../src/repositories/activity.repository.js', async () => {
    const actual = await vi.importActual<typeof activityRepo>(
        '../src/repositories/activity.repository.js',
    );
    return { ...actual, rangeDays: vi.fn(), allDays: vi.fn() };
});
vi.mock('../src/repositories/srs.repository.js', async () => {
    const actual = await vi.importActual<typeof srsRepo>('../src/repositories/srs.repository.js');
    return { ...actual, countDueCards: vi.fn() };
});

const mockedActivity = vi.mocked(activityRepo);
const mockedSrs = vi.mocked(srsRepo);

// allDays rows also feed computeStreak, which reads `date`.
const day = (reviews: number, correct: number, date = new Date('2026-09-18T00:00:00Z')) => ({
    reviews,
    correct,
    date,
});

describe('stats.service / overview', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockedSrs.countDueCards.mockResolvedValue(0);
        mockedActivity.allDays.mockResolvedValue([] as never);
        mockedActivity.rangeDays.mockResolvedValue([] as never);
    });

    it('reports zero retention for a user with no activity, without dividing by zero', async () => {
        const res = await overview('u1', '30', 'Europe/Vienna');
        expect(res.reviewed).toBe(0);
        expect(res.retention).toBe(0);
        expect(Number.isNaN(res.retention)).toBe(false);
    });

    it('computes retention as correct/reviewed, rounded', async () => {
        // First call = current window, second = previous window.
        mockedActivity.rangeDays
            .mockResolvedValueOnce([day(3, 1), day(3, 1)] as never)
            .mockResolvedValueOnce([] as never);
        const res = await overview('u1', '30', 'Europe/Vienna');
        expect(res.reviewed).toBe(6);
        expect(res.correct).toBe(2);
        expect(res.retention).toBe(33);
    });

    it('reports a real delta when both windows have data', async () => {
        mockedActivity.rangeDays
            .mockResolvedValueOnce([day(10, 5)] as never)
            .mockResolvedValueOnce([day(5, 5)] as never);
        const res = await overview('u1', '30', 'Europe/Vienna');
        expect(res.trends.reviewed).toMatchObject({ current: 10, previous: 5, deltaPct: 100 });
    });

    // Regression: range 'all' never loads a previous window, so any percentage
    // was fabricated — it always came out as +100%.
    it("reports no delta for range 'all', which has no comparison window", async () => {
        mockedActivity.allDays.mockResolvedValue([day(10, 8)] as never);
        const res = await overview('u1', 'all', 'Europe/Vienna');
        expect(res.reviewed).toBe(10);
        expect(res.trends.reviewed.deltaPct).toBeNull();
        expect(res.trends.retention.deltaPct).toBeNull();
    });

    it('reports a 0% delta rather than a spike when both windows are empty', async () => {
        const res = await overview('u1', '30', 'Europe/Vienna');
        expect(res.trends.reviewed.deltaPct).toBe(0);
    });

    it('passes the due count through from the SRS repository', async () => {
        mockedSrs.countDueCards.mockResolvedValue(7);
        const res = await overview('u1', '30', 'Europe/Vienna');
        expect(res.dueCount).toBe(7);
    });
});
