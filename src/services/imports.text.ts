import type { AiCardDraft } from './ai.provider.js';

export type TextFormat = 'tsv' | 'csv' | 'newline' | 'auto';

export type TextParseResult = {
    cards: AiCardDraft[];
    // The format actually used (after auto-detect, if any).
    format: 'tsv' | 'csv' | 'newline';
};

// Decide which format to use by looking at the first non-empty line:
//   contains a tab → TSV
//   contains a comma → CSV
//   else            → newline (term, definition, term, definition, …)
const detectFormat = (text: string): 'tsv' | 'csv' | 'newline' => {
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    if (firstLine.includes('\t')) return 'tsv';
    if (firstLine.includes(',')) return 'csv';
    return 'newline';
};

const splitOnce = (line: string, sep: string): [string, string] | null => {
    const idx = line.indexOf(sep);
    if (idx < 0) return null;
    return [line.slice(0, idx), line.slice(idx + 1)];
};

const parseTsv = (text: string): AiCardDraft[] => {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => splitOnce(line, '\t'))
        .filter((pair): pair is [string, string] => pair !== null)
        .map(([w, d]) => ({ word: w.trim(), definition: d.trim() }))
        .filter((c) => c.word.length > 0 && c.definition.length > 0);
};

// Lightweight CSV: handles quoted fields with embedded commas / escaped quotes
// ("" → "). Anything fancier (newlines inside quoted fields) is rejected as a
// parse failure so a confused paste fails loud instead of silently swallowing
// data.
const parseCsvLine = (line: string): [string, string] | null => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i] as string;
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                cur += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',' && out.length === 0) {
                // Only split on the FIRST comma so commas in the definition
                // survive (Quizlet exports sometimes have multi-word defs).
                out.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
    }
    out.push(cur);
    if (out.length < 2) return null;
    return [out[0]!.trim(), out[1]!.trim()];
};

const parseCsv = (text: string): AiCardDraft[] => {
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map(parseCsvLine)
        .filter((pair): pair is [string, string] => pair !== null)
        .map(([w, d]) => ({ word: w, definition: d }))
        .filter((c) => c.word.length > 0 && c.definition.length > 0);
};

// Term on odd lines, definition on even lines. Blank lines separate cards.
const parseNewline = (text: string): AiCardDraft[] => {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const out: AiCardDraft[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const word = lines[i]!;
        const definition = lines[i + 1]!;
        if (word && definition) {
            out.push({ word, definition });
        }
    }
    return out;
};

export const parseText = (text: string, format: TextFormat = 'auto'): TextParseResult => {
    const resolved = format === 'auto' ? detectFormat(text) : format;
    switch (resolved) {
        case 'tsv':
            return { cards: parseTsv(text), format: 'tsv' };
        case 'csv':
            return { cards: parseCsv(text), format: 'csv' };
        case 'newline':
            return { cards: parseNewline(text), format: 'newline' };
    }
};
