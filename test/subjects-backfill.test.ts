import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
    deck: { findMany: vi.fn() },
    card: { findMany: vi.fn() },
    $executeRaw: vi.fn(),
}));
const classify = vi.hoisted(() => vi.fn());
const detectLanguages = vi.hoisted(() => vi.fn());
vi.mock('../src/db/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../src/services/subjects.service.js', () => ({ classify }));
vi.mock('../src/services/ai.service.js', () => ({ detectLanguages }));

import { runBackfill } from '../src/services/subjects-backfill.service.js';

const pendingDeck = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `Deck ${id}`,
    description: '',
    sourceLanguage: 'en',
    targetLanguage: 'de',
    authorId: 'u1',
    subjectBackfill: { rawSubject: 'zzqx' },
    ...over,
});

const langDeck = (id: string, source: string, target: string) => ({
    id,
    title: `Lang ${id}`,
    sourceLanguage: source,
    targetLanguage: target,
});

// deck.findMany is called for the subject pass, then the language pass; each
// pass loops until it gets an empty page.
const queueDecks = (subjectPages: unknown[][], languagePages: unknown[][]) => {
    prismaMock.deck.findMany.mockImplementation((args: { where: { subjectSource?: string } }) =>
        Promise.resolve((args.where.subjectSource ? subjectPages : languagePages).shift() ?? []),
    );
};

const sqlOf = (i: number) => (prismaMock.$executeRaw.mock.calls[i]?.[0] as string[]).join('?');

beforeEach(() => {
    vi.resetAllMocks();
    prismaMock.card.findMany.mockResolvedValue([{ word: 'Haus', definition: 'house' }]);
    prismaMock.$executeRaw.mockResolvedValue(1);
    classify.mockResolvedValue({ subject: 'languages', source: 'ai' });
    detectLanguages.mockResolvedValue({ wordsLanguage: null, definitionsLanguage: null });
});

const run = (over: Partial<Parameters<typeof runBackfill>[0]> = {}) => {
    const lines: string[] = [];
    return runBackfill({ dryRun: true, log: (l) => lines.push(l), ...over }).then((report) => ({
        report,
        lines,
    }));
};

describe('backfill / dry run', () => {
    it('makes the AI calls and reports every change, but never writes', async () => {
        queueDecks([[pendingDeck('a'), pendingDeck('b')]], [[langDeck('x', 'en', 'xx')]]);
        detectLanguages.mockResolvedValue({ wordsLanguage: 'de', definitionsLanguage: null });
        const { report, lines } = await run({ dryRun: true });

        expect(classify).toHaveBeenCalledTimes(2);
        expect(detectLanguages).toHaveBeenCalledTimes(1);
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
        expect(report.dryRun).toBe(true);
        expect(report.subjects).toMatchObject({ considered: 2, ai: 2, written: 0 });
        expect(report.languages).toMatchObject({ considered: 1, resolved: 1, written: 0 });
        expect(report.subjectChanges.map((c) => c.deckId)).toEqual(['a', 'b']);
        expect(lines.join('\n')).toContain('"zzqx" → languages');
        expect(lines.join('\n')).toContain('target xx → de');
    });

    it('passes the raw pre-migration label to the classifier as context', async () => {
        queueDecks([[pendingDeck('a')]], []);
        await run();
        expect(classify.mock.calls[0]?.[0].description).toContain(
            'Previous category label: "zzqx"',
        );
        expect(classify.mock.calls[0]?.[1]).toEqual({ userId: 'u1', origin: 'backfill' });
    });
});

describe('backfill / apply', () => {
    it('writes the subject only while the deck is still pending, and records the method', async () => {
        queueDecks([[pendingDeck('a')]], []);
        classify.mockResolvedValue({ subject: 'medicine', source: 'rules' });
        const { report } = await run({ dryRun: false });

        expect(report.subjects.written).toBe(1);
        expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);
        expect(sqlOf(0)).toContain(`"subjectSource" = 'pending'`);
        expect(prismaMock.$executeRaw.mock.calls[0]).toEqual(
            expect.arrayContaining(['medicine', 'rules', 'a']),
        );
        expect(sqlOf(1)).toContain('deck_subject_backfill');
    });

    it('skips the audit row when the guarded update matched nothing (idempotent re-run)', async () => {
        queueDecks([[pendingDeck('a')]], []);
        prismaMock.$executeRaw.mockResolvedValue(0);
        const { report } = await run({ dryRun: false });
        expect(report.subjects.written).toBe(0);
        expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('never bumps updatedAt', async () => {
        queueDecks([[pendingDeck('a')]], [[langDeck('x', 'en', 'xx')]]);
        detectLanguages.mockResolvedValue({ wordsLanguage: 'de', definitionsLanguage: null });
        await run({ dryRun: false });
        for (let i = 0; i < prismaMock.$executeRaw.mock.calls.length; i++) {
            expect(sqlOf(i)).not.toContain('updatedAt');
        }
    });
});

describe('backfill / limit', () => {
    it('stops after --limit decks per pass', async () => {
        queueDecks([[pendingDeck('a'), pendingDeck('b')], [pendingDeck('c')]], []);
        await run({ limit: 2, batchSize: 2 });
        expect(classify).toHaveBeenCalledTimes(2);
        expect(prismaMock.deck.findMany.mock.calls[0]?.[0].take).toBe(2);
    });
});

describe('backfill / language pass', () => {
    it('replaces only the invalid side, with a supported code', async () => {
        queueDecks([], [[langDeck('x', 'en', 'xx')]]);
        detectLanguages.mockResolvedValue({ wordsLanguage: 'fr', definitionsLanguage: 'es' });
        const { report } = await run({ dryRun: false });
        // source "en" is valid → kept (not replaced by the detected "es")
        expect(report.languageChanges[0]).toMatchObject({
            sourceLanguage: { from: 'en', to: 'en' },
            targetLanguage: { from: 'xx', to: 'fr' },
        });
        expect(report.languages.written).toBe(1);
        expect(sqlOf(0)).toContain('AND "targetLanguage" =');
    });

    it('lists decks as unresolved when the model is unsure, and leaves them alone (across pages)', async () => {
        queueDecks([], [[langDeck('x', 'en', 'xx')], [langDeck('y', 'qq', 'de')]]);
        const { report } = await run({ dryRun: false });
        expect(report.languages.unresolved.map((u) => u.deckId)).toEqual(['x', 'y']);
        expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
    });

    it('treats a provider error as unresolved, not a crash', async () => {
        queueDecks([], [[langDeck('x', 'en', 'xx')]]);
        detectLanguages.mockRejectedValue(new Error('boom'));
        const { report } = await run();
        expect(report.languages.unresolved).toHaveLength(1);
    });

    it('does not ask the model about a deck with no cards', async () => {
        queueDecks([], [[langDeck('x', 'en', 'xx')]]);
        prismaMock.card.findMany.mockResolvedValue([]);
        const { report } = await run();
        expect(detectLanguages).not.toHaveBeenCalled();
        expect(report.languages.unresolved).toHaveLength(1);
    });
});
