/**
 * Shared pieces of the AI eval: fixture loading, the JSONL output, and the
 * spend ledger every paid call (runs and the judge) goes through, so the
 * whole eval stays under one dollar ceiling across invocations.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ai-eval');
export const OUT = join(FIXTURES, 'out');

export const readJson = <T>(name: string): T =>
    JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

export type Lang = 'en' | 'uk';

export type QualityItem = {
    word: string;
    kind:
        | 'plain'
        | 'polysemous'
        | 'phrasal'
        | 'false_friend'
        | 'rare'
        | 'nonexistent'
        | 'typo'
        | 'duplicate'
        | 'injection';
    refUk?: string[];
    wrongUk?: string[];
    duplicateOf?: string;
    intended?: string;
    unsure?: boolean;
    note?: string;
};

export type QualitySet = {
    items: QualityItem[];
    lists: Record<'1' | '10' | '50' | '100', string[]>;
};

export type ChatScript = {
    locale: string;
    userLangs: { native: string | null; learning: string[] };
    userTurns: string[];
    createDeck: string;
    openDeck: { title: string; sourceLanguage: string; targetLanguage: string; words: string[] };
    addCards: string;
};

export type ChatHistory = {
    generatedBy: string;
    generatedAt: string;
    en: { user: string; assistant: string }[];
    uk: { user: string; assistant: string }[];
};

/** Append one JSON object per line. */
export const appendJsonl = (file: string, row: unknown): void => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
};

export const readJsonl = <T>(file: string): T[] =>
    existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter((l) => l.trim() !== '')
              .map((l) => JSON.parse(l) as T)
        : [];

// ---------- spend ledger ----------

type LedgerEntry = { time: string; key: string; costUsd: number };
type LedgerFile = { entries: LedgerEntry[] };

const LEDGER = join(OUT, 'ledger.json');

/**
 * Cumulative spend across every eval invocation. Before each paid unit of
 * work, `reserve` checks spent + in-flight + this unit's projection against
 * the ceiling; `settle` records what the unit actually cost.
 */
export class Ledger {
    private entries: LedgerEntry[];
    private inFlight = 0;

    constructor(readonly budgetUsd: number) {
        this.entries = existsSync(LEDGER)
            ? (JSON.parse(readFileSync(LEDGER, 'utf8')) as LedgerFile).entries
            : [];
    }

    get spentUsd(): number {
        return this.entries.reduce((a, e) => a + e.costUsd, 0);
    }

    /** Largest cost seen so far for this key (e.g. arm + cell), if any. */
    lastCost(key: string): number | undefined {
        const costs = this.entries.filter((e) => e.key === key).map((e) => e.costUsd);
        return costs.length ? Math.max(...costs) : undefined;
    }

    /** False when running this unit could take the eval over budget. */
    reserve(projectedUsd: number): boolean {
        if (this.spentUsd + this.inFlight + projectedUsd > this.budgetUsd) {
            return false;
        }
        this.inFlight += projectedUsd;
        return true;
    }

    settle(key: string, projectedUsd: number, costUsd: number): void {
        this.inFlight -= projectedUsd;
        this.entries.push({ time: new Date().toISOString(), key, costUsd });
        mkdirSync(OUT, { recursive: true });
        writeFileSync(LEDGER, JSON.stringify({ entries: this.entries }, null, 2));
    }
}

/** Run `tasks` with at most `limit` in flight; results keep input order. */
export const pool = async <T>(limit: number, tasks: (() => Promise<T>)[]): Promise<T[]> => {
    const results: T[] = new Array<T>(tasks.length);
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const i = next++;
            const task = tasks[i];
            if (task) {
                results[i] = await task();
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
};

// ---------- shared helpers (grader and variant eval) ----------

export type Card = {
    word: string;
    definition: string;
    partOfSpeech?: string;
    example?: string;
    exampleTranslation?: string;
    tags?: string[];
};

export const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length === 0
        ? NaN
        : s.length % 2
          ? (s[m] ?? NaN)
          : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
export const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 0
        ? NaN
        : (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN);
};
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export const compareKey = (s: string) =>
    s
        .toLowerCase()
        .replace(/[«»"'`’‘”“]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

/** Cards a run's raw output holds, whatever the op. */
export const cardsOfOutput = (output: unknown): Card[] => {
    const o = output as {
        cards?: Card[];
        draft?: { cards?: Card[] };
        generated?: { cards?: Card[] } | null;
    } | null;
    return o?.cards ?? o?.draft?.cards ?? o?.generated?.cards ?? [];
};

// Lenient Ukrainian match: every word of a reference must appear by stem
// (Ukrainian inflects the last letters), e.g. «доглядати» ~ «доглядає».
const stem = (w: string) => w.slice(0, Math.max(4, w.length - 2));
const norm = (s: string) => s.toLowerCase().replace(/[’ʼ`]/g, "'");
const mentions = (text: string, ref: string) => {
    const t = norm(text);
    return norm(ref)
        .split(/\s+/)
        .filter((w) => w.length >= 3)
        .every((w) => t.includes(stem(w)));
};
export const refMatch = (
    item: QualityItem | undefined,
    card: Card,
): 'match' | 'trap' | 'miss' | 'n/a' => {
    if (!item?.refUk) {
        return 'n/a';
    }
    const text = `${card.definition} ${card.exampleTranslation ?? ''}`;
    if (item.refUk.some((r) => mentions(text, r))) {
        return 'match';
    }
    return item.wrongUk?.some((r) => mentions(card.definition, r)) ? 'trap' : 'miss';
};
