import * as cardsRepo from '../repositories/cards.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import { NotFoundError } from '../shared/errors.js';
import type { CardModel } from '../../generated/prisma/models/Card.js';

export type ExportFormat = 'csv' | 'json';

export type DeckExportResult = {
    format: ExportFormat;
    filename: string;
    contentType: string;
    body: string;
};

const csvEscape = (value: string): string => {
    if (value.includes('"') || value.includes(',') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
};

// Round-trip-friendly columns: every field carried through the public DTO
// except IDs, timestamps, audio/image URLs (those need re-upload on import).
const CSV_HEADERS = [
    'word',
    'definition',
    'phonetic',
    'reading',
    'partOfSpeech',
    'example',
    'exampleTranslation',
    'tags',
    'difficulty',
    'type',
] as const;

const toCsvRow = (card: CardModel): string =>
    CSV_HEADERS.map((h) => {
        if (h === 'tags') return csvEscape((card.tags ?? []).join(';'));
        const v = card[h as keyof CardModel];
        if (v === null || v === undefined) return '';
        return csvEscape(String(v));
    }).join(',');

const slugify = (s: string): string =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'deck';

export const exportDeck = async (
    ownerId: string,
    deckId: string,
    format: ExportFormat,
): Promise<DeckExportResult> => {
    const deck = await decksRepo.findDeckById(deckId, ownerId);
    if (!deck) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');

    const cards = await cardsRepo.listAllCardsForDeck(deckId);
    const slug = slugify(deck.title);

    if (format === 'json') {
        const payload = {
            deck: {
                title: deck.title,
                description: deck.description,
                sourceLanguage: deck.sourceLanguage,
                targetLanguage: deck.targetLanguage,
            },
            cards: cards.map((c) => ({
                word: c.word,
                definition: c.definition,
                phonetic: c.phonetic,
                reading: c.reading,
                partOfSpeech: c.partOfSpeech,
                example: c.example,
                exampleTranslation: c.exampleTranslation,
                tags: c.tags,
                difficulty: c.difficulty,
                type: c.type,
            })),
        };
        return {
            format: 'json',
            filename: `${slug}.json`,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(payload, null, 2),
        };
    }

    const lines = [CSV_HEADERS.join(','), ...cards.map(toCsvRow)];
    return {
        format: 'csv',
        filename: `${slug}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: lines.join('\n'),
    };
};
