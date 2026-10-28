import { describe, it, expect, vi, beforeEach } from 'vitest';

const classifyRaw = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../src/services/ai.service.js', () => ({ classifySubject: classifyRaw }));
vi.mock('../src/services/analytics.service.js', () => ({ track: trackMock }));

import { classify, CLASSIFY_MAX_WORDS } from '../src/services/subjects.service.js';
import { mockProvider } from '../src/services/ai.provider.mock.js';
import { anthropicProvider } from '../src/services/ai.provider.anthropic.js';
import { classifySubjectSchema } from '../src/schemas/ai.schema.js';
import { SUBJECTS } from '../src/shared/subjects.js';

const input = {
    title: 'Anatomy basics',
    description: '',
    sourceLanguage: 'en',
    targetLanguage: 'en',
    words: ['femur', 'tibia'],
};

beforeEach(() => {
    classifyRaw.mockReset();
    trackMock.mockReset();
});

describe('subjects.service / classify', () => {
    it("returns the model's answer as ai", async () => {
        classifyRaw.mockResolvedValue({ subject: 'medicine' });
        expect(await classify(input)).toEqual({ subject: 'medicine', source: 'ai' });
    });

    it('normalizes a near-miss answer from the model', async () => {
        classifyRaw.mockResolvedValue({ subject: 'Biology' });
        expect(await classify(input)).toEqual({ subject: 'science', source: 'ai' });
    });

    it('accepts only an exact or legacy slug from the model', async () => {
        classifyRaw.mockResolvedValue({ subject: 'medical terminology' });
        expect((await classify(input)).source).toBe('rules');
    });

    it('keyword rules never override a valid AI answer', async () => {
        classifyRaw.mockResolvedValue({ subject: 'medicine' });
        // 'term' would send this to languages via the keyword rules.
        expect(await classify({ ...input, title: 'Cardiology terms' })).toEqual({
            subject: 'medicine',
            source: 'ai',
        });
    });

    it('falls back to rules on a provider error', async () => {
        classifyRaw.mockRejectedValue(new Error('boom'));
        // "anatomy" → medicine via the keyword rules
        expect(await classify(input)).toEqual({ subject: 'medicine', source: 'rules' });
    });

    it('falls back to rules on an off-list or empty answer', async () => {
        classifyRaw.mockResolvedValue({ subject: 'zzqx' });
        expect((await classify(input)).source).toBe('rules');
        classifyRaw.mockResolvedValue({ subject: null });
        expect((await classify(input)).source).toBe('rules');
    });

    it('uses the language heuristic when the rules find nothing', async () => {
        classifyRaw.mockRejectedValue(new Error('boom'));
        const plain = { ...input, title: 'Set 7', targetLanguage: 'de' };
        expect(await classify(plain)).toEqual({ subject: 'languages', source: 'rules' });
        expect(await classify({ ...plain, targetLanguage: 'en' })).toEqual({
            subject: 'other',
            source: 'rules',
        });
    });

    it('times out slow providers and degrades to rules', async () => {
        vi.useFakeTimers();
        try {
            classifyRaw.mockReturnValue(new Promise(() => {}));
            const p = classify(input);
            await vi.advanceTimersByTimeAsync(4001);
            expect(await p).toEqual({ subject: 'medicine', source: 'rules' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('sends at most CLASSIFY_MAX_WORDS words', async () => {
        classifyRaw.mockResolvedValue({ subject: 'other' });
        await classify({ ...input, words: Array.from({ length: 30 }, (_, i) => `w${i}`) });
        expect(classifyRaw.mock.calls[0]?.[0].words).toHaveLength(CLASSIFY_MAX_WORDS);
    });

    it('emits deck_subject_classified only when a user id is given', async () => {
        classifyRaw.mockResolvedValue({ subject: 'law' });
        await classify(input);
        expect(trackMock).not.toHaveBeenCalled();
        await classify(input, { userId: 'u1', origin: 'import' });
        expect(trackMock).toHaveBeenCalledWith(
            'u1',
            'deck_subject_classified',
            expect.objectContaining({ source: 'import', result: 'ai' }),
        );
    });

    it('never touches the AI budget', async () => {
        // ai.service is mocked with ONLY classifySubject: any budget.* call
        // would have to go through it. The service must not import the budget.
        classifyRaw.mockResolvedValue({ subject: 'law' });
        await expect(classify(input)).resolves.toBeDefined();
    });
});

describe('classify providers', () => {
    it('mock provider classifies deterministically with the keyword rules', async () => {
        expect(await mockProvider.classifySubject(input)).toEqual({ subject: 'medicine' });
        expect(await mockProvider.classifySubject({ ...input, title: 'Set 7' })).toEqual({
            subject: null,
        });
    });

    it('anthropic provider exposes classifySubject', () => {
        expect(typeof anthropicProvider.classifySubject).toBe('function');
    });
});

describe('classifySubjectSchema', () => {
    it('normalizes languages and defaults words', () => {
        const r = classifySubjectSchema.parse({
            title: 'T',
            sourceLanguage: 'ua',
            targetLanguage: 'English',
        });
        expect(r).toMatchObject({ sourceLanguage: 'uk', targetLanguage: 'en', words: [] });
    });

    it('caps title and words', () => {
        const base = { title: 'T', sourceLanguage: 'en', targetLanguage: 'de' };
        expect(classifySubjectSchema.safeParse({ ...base, title: 'x'.repeat(121) }).success).toBe(
            false,
        );
        expect(
            classifySubjectSchema.safeParse({ ...base, words: Array(21).fill('a') }).success,
        ).toBe(false);
        expect(SUBJECTS).toHaveLength(12);
    });
});
