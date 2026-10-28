// One-off cleanup for spec 002, run by scripts/backfill-subjects.ts AFTER the
// migration and deploy:
//   1. subjects  — decks the migration couldn't place (subjectSource 'pending')
//                  are classified from title + a few card words.
//   2. languages — decks whose stored language is outside the supported list
//                  (the 20260924 migration left unrecognized values alone) get
//                  the language read from their cards.
//
// DRY RUN IS A HARD NO-WRITE MODE: it makes the AI calls and reports every
// proposed change, but nothing in this file issues an UPDATE unless
// `dryRun` is false. Every write is guarded (`... AND "subjectSource" =
// 'pending'`) so re-running touches only what is still unresolved, and none
// of them bumps `updatedAt` (a taxonomy repair is not a user edit and must not
// reorder anyone's deck list).
import { prisma } from '../db/prisma.js';
import * as aiService from './ai.service.js';
import * as subjects from './subjects.service.js';
import { SUPPORTED_LANG_LIST, isSupportedLang } from '../shared/lang.js';
import type { Subject } from '../shared/subjects.js';

export type BackfillOptions = {
    dryRun: boolean;
    // Stop after this many decks per pass (0 / undefined = no limit).
    limit?: number | undefined;
    batchSize?: number;
    log: (line: string) => void;
};

export type SubjectChange = {
    deckId: string;
    title: string;
    rawSubject: string | null;
    subject: Subject;
    source: 'ai' | 'rules';
};

export type LanguageChange = {
    deckId: string;
    title: string;
    sourceLanguage: { from: string; to: string };
    targetLanguage: { from: string; to: string };
};

export type BackfillReport = {
    dryRun: boolean;
    subjects: { considered: number; ai: number; rules: number; written: number };
    languages: {
        considered: number;
        resolved: number;
        written: number;
        unresolved: {
            deckId: string;
            title: string;
            sourceLanguage: string;
            targetLanguage: string;
        }[];
    };
    subjectChanges: SubjectChange[];
    languageChanges: LanguageChange[];
};

const CONCURRENCY = 4;
const SAMPLE_CARDS = 10;

// Runs `fn` over `items`, a few at a time, keeping results in input order.
const pool = async <T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> => {
    const out: R[] = [];
    let next = 0;
    const worker = async () => {
        for (let i = next++; i < items.length; i = next++) {
            out[i] = await fn(items[i] as T);
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return out;
};

const sampleCards = (deckId: string) =>
    prisma.card.findMany({
        where: { deckId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        take: SAMPLE_CARDS,
        select: { word: true, definition: true },
    });

const subjectPass = async (opts: BackfillOptions, report: BackfillReport): Promise<void> => {
    const batchSize = opts.batchSize ?? 50;
    let afterId = '';
    let remaining = opts.limit && opts.limit > 0 ? opts.limit : Infinity;

    while (remaining > 0) {
        const decks = await prisma.deck.findMany({
            where: { subjectSource: 'pending', id: { gt: afterId } },
            orderBy: { id: 'asc' },
            take: Math.min(batchSize, remaining),
            select: {
                id: true,
                title: true,
                description: true,
                sourceLanguage: true,
                targetLanguage: true,
                authorId: true,
                subjectBackfill: { select: { rawSubject: true } },
            },
        });
        if (decks.length === 0) {
            return;
        }
        afterId = decks[decks.length - 1]?.id ?? afterId;
        remaining -= decks.length;

        const results = await pool(decks, async (deck) => {
            const cards = await sampleCards(deck.id);
            const raw = deck.subjectBackfill?.rawSubject ?? null;
            const result = await subjects.classify(
                {
                    title: deck.title,
                    description: [deck.description, raw ? `Previous category label: "${raw}"` : '']
                        .filter(Boolean)
                        .join('\n'),
                    sourceLanguage: deck.sourceLanguage,
                    targetLanguage: deck.targetLanguage,
                    words: cards.map((c) => c.word),
                },
                { userId: deck.authorId, origin: 'backfill' },
            );
            return { deck, raw, result };
        });

        for (const { deck, raw, result } of results) {
            report.subjects.considered += 1;
            report.subjects[result.source] += 1;
            const change: SubjectChange = {
                deckId: deck.id,
                title: deck.title,
                rawSubject: raw,
                subject: result.subject,
                source: result.source,
            };
            report.subjectChanges.push(change);
            opts.log(
                `subject  ${deck.id}  ${JSON.stringify(deck.title)}  ${JSON.stringify(raw)} → ${result.subject}  [${result.source}]`,
            );
            if (opts.dryRun) {
                continue;
            }
            // Guarded: only a deck that is still pending, so a re-run (or a
            // user edit made meanwhile) is never overwritten.
            const written = await prisma.$executeRaw`
                UPDATE "decks"
                   SET "subject" = ${result.subject}, "subjectSource" = ${result.source}
                 WHERE "id" = ${deck.id} AND "subjectSource" = 'pending'
            `;
            if (written > 0) {
                report.subjects.written += 1;
                await prisma.$executeRaw`
                    UPDATE "deck_subject_backfill"
                       SET "subject" = ${result.subject}, "method" = ${result.source}
                     WHERE "deckId" = ${deck.id}
                `;
            }
        }
    }
};

const languagePass = async (opts: BackfillOptions, report: BackfillReport): Promise<void> => {
    const batchSize = opts.batchSize ?? 50;
    const list = [...SUPPORTED_LANG_LIST];
    let afterId = '';
    let remaining = opts.limit && opts.limit > 0 ? opts.limit : Infinity;

    while (remaining > 0) {
        const decks = await prisma.deck.findMany({
            where: {
                id: { gt: afterId },
                OR: [{ sourceLanguage: { notIn: list } }, { targetLanguage: { notIn: list } }],
            },
            orderBy: { id: 'asc' },
            take: Math.min(batchSize, remaining),
            select: { id: true, title: true, sourceLanguage: true, targetLanguage: true },
        });
        if (decks.length === 0) {
            return;
        }
        afterId = decks[decks.length - 1]?.id ?? afterId;
        remaining -= decks.length;

        const results = await pool(decks, async (deck) => {
            const cards = await sampleCards(deck.id);
            if (cards.length === 0) {
                return { deck, detected: null };
            }
            try {
                const detected = await aiService.detectLanguages({
                    words: cards.map((c) => c.word),
                    definitions: cards.map((c) => c.definition),
                });
                return { deck, detected };
            } catch {
                return { deck, detected: null };
            }
        });

        for (const { deck, detected } of results) {
            report.languages.considered += 1;
            // Convention: targetLanguage = the cards' fronts, sourceLanguage =
            // their backs. Only an invalid side is replaced, and only with a
            // supported code the model named.
            const nextSource =
                !isSupportedLang(deck.sourceLanguage) && detected?.definitionsLanguage
                    ? detected.definitionsLanguage
                    : deck.sourceLanguage;
            const nextTarget =
                !isSupportedLang(deck.targetLanguage) && detected?.wordsLanguage
                    ? detected.wordsLanguage
                    : deck.targetLanguage;
            const fixed = isSupportedLang(nextSource) && isSupportedLang(nextTarget);
            if (!fixed) {
                report.languages.unresolved.push({
                    deckId: deck.id,
                    title: deck.title,
                    sourceLanguage: deck.sourceLanguage,
                    targetLanguage: deck.targetLanguage,
                });
                opts.log(
                    `language ${deck.id}  ${JSON.stringify(deck.title)}  ${deck.sourceLanguage}/${deck.targetLanguage} → UNRESOLVED (left as is)`,
                );
                continue;
            }
            report.languages.resolved += 1;
            report.languageChanges.push({
                deckId: deck.id,
                title: deck.title,
                sourceLanguage: { from: deck.sourceLanguage, to: nextSource },
                targetLanguage: { from: deck.targetLanguage, to: nextTarget },
            });
            opts.log(
                `language ${deck.id}  ${JSON.stringify(deck.title)}  source ${deck.sourceLanguage} → ${nextSource}, target ${deck.targetLanguage} → ${nextTarget}`,
            );
            if (opts.dryRun) {
                continue;
            }
            const written = await prisma.$executeRaw`
                UPDATE "decks"
                   SET "sourceLanguage" = ${nextSource}, "targetLanguage" = ${nextTarget}
                 WHERE "id" = ${deck.id}
                   AND "sourceLanguage" = ${deck.sourceLanguage}
                   AND "targetLanguage" = ${deck.targetLanguage}
            `;
            report.languages.written += written > 0 ? 1 : 0;
        }
    }
};

export const runBackfill = async (opts: BackfillOptions): Promise<BackfillReport> => {
    const report: BackfillReport = {
        dryRun: opts.dryRun,
        subjects: { considered: 0, ai: 0, rules: 0, written: 0 },
        languages: { considered: 0, resolved: 0, written: 0, unresolved: [] },
        subjectChanges: [],
        languageChanges: [],
    };
    await subjectPass(opts, report);
    await languagePass(opts, report);
    return report;
};
