import { z } from 'zod';
import * as cardsService from './cards.service.js';
import { ImportParseFailedError } from '../shared/errors.js';
import type { CreateCardInput } from '../schemas/card.schema.js';

export type DeckImportFormat = 'csv' | 'json';

// Schema for the JSON variant — mirrors the export shape and is intentionally
// generous: every advanced field is optional, only word/definition required.
const importedCardSchema = z.object({
    word: z.string().trim().min(1),
    definition: z.string().trim().min(1),
    phonetic: z.string().trim().min(1).optional(),
    reading: z.string().trim().min(1).optional(),
    partOfSpeech: z.string().trim().min(1).optional(),
    example: z.string().trim().min(1).optional(),
    exampleTranslation: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    type: z.enum(['basic', 'cloze', 'image']).optional(),
});

// Accept either { deck, cards } (full export shape) or just cards[]/array.
const jsonPayloadSchema = z.union([
    z.array(importedCardSchema),
    z.object({ cards: z.array(importedCardSchema) }),
    z.object({ deck: z.any().optional(), cards: z.array(importedCardSchema) }),
]);

// CSV parser specific to the deck-export shape (multiple columns) — distinct
// from imports.text which is intentionally word+definition only.
const parseCsvHeader = (header: string): string[] =>
    header.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

const parseCsvLineWithHeaders = (line: string, headers: string[]): Record<string, string> => {
    const cells: string[] = [];
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
            } else if (ch === ',') {
                cells.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
        row[h] = (cells[i] ?? '').trim();
    });
    return row;
};

const fromCsv = (text: string): CreateCardInput[] => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) {
        throw new ImportParseFailedError('CSV must include a header row and at least one card');
    }
    const headers = parseCsvHeader(lines[0]!);
    if (!headers.includes('word') || !headers.includes('definition')) {
        throw new ImportParseFailedError("CSV header must include at least 'word' and 'definition'");
    }
    const out: CreateCardInput[] = [];
    for (let i = 1; i < lines.length; i++) {
        const row = parseCsvLineWithHeaders(lines[i]!, headers);
        const word = row.word;
        const definition = row.definition;
        if (!word || !definition) continue;
        const card: CreateCardInput = {
            word,
            definition,
            ...(row.phonetic ? { phonetic: row.phonetic } : {}),
            ...(row.reading ? { reading: row.reading } : {}),
            ...(row.partOfSpeech ? { partOfSpeech: row.partOfSpeech } : {}),
            ...(row.example ? { example: row.example } : {}),
            ...(row.exampleTranslation ? { exampleTranslation: row.exampleTranslation } : {}),
            ...(row.tags
                ? { tags: row.tags.split(';').map((t) => t.trim()).filter(Boolean) }
                : {}),
            ...(isDifficulty(row.difficulty) ? { difficulty: row.difficulty } : {}),
            ...(isCardType(row.type) ? { type: row.type } : {}),
        };
        out.push(card);
    }
    return out;
};

const isDifficulty = (v: string | undefined): v is 'easy' | 'medium' | 'hard' =>
    v === 'easy' || v === 'medium' || v === 'hard';

const isCardType = (v: string | undefined): v is 'basic' | 'cloze' | 'image' =>
    v === 'basic' || v === 'cloze' || v === 'image';

const fromJson = (text: string): CreateCardInput[] => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new ImportParseFailedError('JSON payload was not parseable');
    }
    const parsed = jsonPayloadSchema.safeParse(raw);
    if (!parsed.success) {
        throw new ImportParseFailedError('JSON payload did not match the expected card shape');
    }
    const cards = Array.isArray(parsed.data) ? parsed.data : parsed.data.cards;
    return cards.map((c) => {
        const out: CreateCardInput = { word: c.word, definition: c.definition };
        if (c.phonetic) out.phonetic = c.phonetic;
        if (c.reading) out.reading = c.reading;
        if (c.partOfSpeech) out.partOfSpeech = c.partOfSpeech;
        if (c.example) out.example = c.example;
        if (c.exampleTranslation) out.exampleTranslation = c.exampleTranslation;
        if (c.tags && c.tags.length > 0) out.tags = c.tags;
        if (c.difficulty) out.difficulty = c.difficulty;
        if (c.type) out.type = c.type;
        return out;
    });
};

export const importIntoDeck = async (
    ownerId: string,
    deckId: string,
    format: DeckImportFormat,
    text: string,
): Promise<{ created: number }> => {
    const cards = format === 'csv' ? fromCsv(text) : fromJson(text);
    if (cards.length === 0) {
        throw new ImportParseFailedError('No valid cards found in the input');
    }
    // Defer to the existing bulk-create flow — ownership check, position
    // assignment, recompute count, achievements all stay in one place.
    return cardsService.bulkCreate(ownerId, deckId, { cards });
};
