import { describe, it, expect } from 'vitest';
import { buildPerformance } from '../src/services/stats.service.js';

const row = (userId: string, reviews: number, correct: number) => ({ userId, reviews, correct });

describe('stats.service / buildPerformance', () => {
    it('ranks the user against eligible peers and buckets recall', () => {
        const result = buildPerformance('30', 'me', [
            row('me', 20, 16), // 80%
            row('a', 10, 5), // 50%
            row('b', 10, 9), // 90%
            row('c', 10, 10), // 100% -> last bucket
            row('tiny', 2, 2), // below PERF_MIN_REVIEWS, ignored
        ]);
        expect(result).toEqual({
            range: '30',
            userRecall: 80,
            percentile: 33,
            sampleSize: 4,
            buckets: [0, 0, 0, 0, 0, 1, 0, 0, 1, 2],
            enoughData: true,
        });
    });

    it('reports not enough data when the user is not eligible', () => {
        const result = buildPerformance('7', 'me', [
            row('me', 3, 3),
            row('a', 10, 5),
            row('b', 10, 9),
        ]);
        expect(result.userRecall).toBe(0);
        expect(result.percentile).toBe(0);
        expect(result.enoughData).toBe(false);
    });
});
