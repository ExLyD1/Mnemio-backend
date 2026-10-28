// Deck subject classification (spec 002). A deck made without a subject the
// user chose (Anki import, "Auto-detect" in the AI import dialog, the backfill
// script) gets one from a one-enum model call on the title and a few words.
//
// Never fails and never blocks: any provider error, timeout, or off-list
// answer degrades to the keyword rules, then to the language heuristic. It is
// a system cost — no per-user budget reservation — so free and premium users
// behave the same and the premium gate can never fire from here.
import * as aiService from './ai.service.js';
import { track } from './analytics.service.js';
import type { ClassifySubjectInput } from './ai.provider.js';
import { inferSubject, normalizeSubject, type Subject } from '../shared/subjects.js';

export const CLASSIFY_TIMEOUT_MS = 4000;
// Words sent to the model; more adds cost, not signal.
export const CLASSIFY_MAX_WORDS = 10;

export type Classification = { subject: Subject; source: 'ai' | 'rules' };

export const classifyByRules = (input: ClassifySubjectInput): Subject =>
    normalizeSubject(`${input.title} ${input.description ?? ''}`) ??
    inferSubject(input.sourceLanguage, input.targetLanguage);

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('classify timeout')), ms);
        work.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e: unknown) => {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            },
        );
    });

export const classify = async (
    input: ClassifySubjectInput,
    opts: { userId?: string; origin: 'import' | 'classify_endpoint' | 'backfill' } = {
        origin: 'classify_endpoint',
    },
): Promise<Classification> => {
    const started = Date.now();
    const trimmed = { ...input, words: input.words.slice(0, CLASSIFY_MAX_WORDS) };
    let result: Classification;
    try {
        const { subject } = await withTimeout(
            aiService.classifySubject(trimmed),
            CLASSIFY_TIMEOUT_MS,
        );
        const picked = normalizeSubject(subject);
        result = picked
            ? { subject: picked, source: 'ai' }
            : { subject: classifyByRules(trimmed), source: 'rules' };
    } catch {
        result = { subject: classifyByRules(trimmed), source: 'rules' };
    }
    if (opts.userId) {
        track(opts.userId, 'deck_subject_classified', {
            source: opts.origin,
            result: result.source,
            ms: Date.now() - started,
        });
    }
    return result;
};
