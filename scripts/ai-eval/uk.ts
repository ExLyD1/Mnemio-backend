/**
 * What the Ukrainian evals share: run loading, seeded sampling and the judge
 * prompts. Keeping the prompts here means every pass uses the same judge.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    FIXTURES,
    OUT,
    cardsOfOutput,
    readJson,
    readJsonl,
    type Card,
    type QualitySet,
} from './lib.js';

export const MODEL = 'claude-haiku-5-5';
export const JUDGE_MODEL = 'claude-sonnet-5-5';

export type Call = {
    evt: 'ai_call';
    arm: string;
    cell: string;
    run: number;
    attempt: number;
    stopReason: string | null;
};
export type Run = {
    evt: 'run';
    arm: string;
    op: string;
    run: number;
    wallMs: number;
    costUsd: number;
    error: { message: string } | null;
    output: unknown;
};

export const quality = readJson<QualitySet>('quality-set.json');
export const itemByWord = new Map(quality.items.map((i) => [i.word.toLowerCase(), i]));
export const rules = readFileSync(join(FIXTURES, 'uk-rules.md'), 'utf8').trim();

export const load = (arm: string, file: string) => {
    const rows = readJsonl<Run | Call>(join(OUT, file));
    return {
        runs: rows.filter((r): r is Run => r.evt === 'run' && r.arm === arm),
        calls: rows.filter((r): r is Call => r.evt === 'ai_call' && r.arm === arm),
    };
};

const CONTENT = /^(enrich|topic|photo|chat_create|chat_add)/;
export const JUDGED = new Set(['enrich_100', 'topic_20']);
export const isContent = (op: string) => CONTENT.test(op);
export const runKey = (r: Run) => `${r.op}|${r.run}`;
export const cardsOf = (r: Run) => cardsOfOutput(r.output);
export const filled = (c: Card) => c.definition.trim() !== '';
export const hashOf = (c: Card) =>
    createHash('sha1')
        .update(JSON.stringify([c.word, c.definition, c.example ?? '', c.exampleTranslation ?? '']))
        .digest('hex')
        .slice(0, 16);

// Seeded RNG so shuffles, samples and bootstrap are reproducible.
export const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const shuffle = <T>(xs: T[], seed: number): T[] => {
    const r = rng(seed);
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
};

export const bootstrap = (xs: number[], seed: number): [number, number] => {
    if (xs.length === 0) {
        return [NaN, NaN];
    }
    const r = rng(seed);
    const means = Array.from({ length: 2000 }, () => {
        let s = 0;
        for (let k = 0; k < xs.length; k++) {
            s += xs[Math.floor(r() * xs.length)] ?? 0;
        }
        return s / xs.length;
    }).sort((a, b) => a - b);
    return [
        means[Math.floor(0.025 * means.length)] ?? NaN,
        means[Math.floor(0.975 * means.length)] ?? NaN,
    ];
};

export const RUSSIAN = /[ыэъёЫЭЪЁ]/;
export const MISSPELLING =
    /(неправильне написання|помилков\w* написання|орфографічн\w+ помилк|misspell)/i;

export type Score = {
    meaning: number;
    example: number;
    ukrainian: number;
    critical: boolean;
    note: string;
};

export const scoreSchema = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    meaning: { type: 'integer', enum: [0, 1, 2] },
                    example: { type: 'integer', enum: [0, 1, 2] },
                    ukrainian: { type: 'integer', enum: [0, 1, 2] },
                    critical: { type: 'boolean' },
                    note: { type: 'string' },
                },
                required: ['id', 'meaning', 'example', 'ukrainian', 'critical', 'note'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
} as const;

// Same criteria as the Oct 27 judge, scored per card without a rival card.
export const judgeSystem = `You grade vocabulary flashcards for a learning app: the word is English, the definition and exampleTranslation are Ukrainian. Learners study the cards as written, so precision matters more than style. You do not know which system wrote a card.

Score each card 0, 1 or 2 on each criterion:
- meaning: the definition gives a correct meaning of the word in a sense a learner would expect (any established sense is fine for a word given without context). 0 = wrong or misleading; 1 = roughly right but vague, too narrow or partly wrong; 2 = correct and clear.
- example: the English example is natural, correct English that uses the word in the defined sense. 0 = missing, wrong sense or unnatural; 1 = acceptable but stiff; 2 = natural.
- ukrainian: the Ukrainian definition and example translation read like native, standard Ukrainian: no Russian words or forms (russisms), no word-for-word calques, correct agreement. 0 = a russism, calque or grammar error a teacher would mark; 1 = understandable but unidiomatic; 2 = native.
- critical: true when the card gives a wrong definition or translation, when the example uses a different sense from the definition, or when it invents a meaning for something that is not a real English word (a card for a non-word must be empty, or may only say it is a misspelling of a real word and name that word). An empty card for a real word is not critical.

Reference translations, where given, are an unreviewed draft: a hint, not the only acceptable answer. Keep each note under 15 words.`;

export const pairSchema = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    better: { type: 'string', enum: ['first', 'second', 'same'] },
                    note: { type: 'string' },
                },
                required: ['id', 'better', 'note'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
} as const;

export const changeSystem =
    'For each English headword you get two Ukrainian versions (first, second) of the flashcard definition and example translation. Say which is better Ukrainian for a learner: correct meaning in the most common sense, native standard Ukrainian with no russisms or calques, natural reading. Answer "same" when the difference does not matter. Notes under 15 words.';
