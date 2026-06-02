import * as decksRepo from '../repositories/decks.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import {
    decodeCursor,
    encodeCursor,
    parseLimit,
    type PageWithTotal,
} from '../shared/pagination.js';
import { NotFoundError } from '../shared/errors.js';
import {
    toPublicDeck,
    toPublicCard,
    buildStats,
    type PublicDeck,
    type PublicCard,
    type DeckStats,
} from '../shared/mappers.deck.js';
import type {
    CreateDeckInput,
    UpdateDeckInput,
    DeckListQuery,
    DeckDetailQuery,
} from '../schemas/deck.schema.js';

const statsByDeckId = async (
    ownerId: string,
    deckIds: string[],
    cardCountById: Map<string, number>,
): Promise<Map<string, DeckStats>> => {
    const out = new Map<string, DeckStats>();
    if (deckIds.length === 0) return out;
    const rows = await deckStatsRepo.aggregateDeckStats(ownerId, deckIds);
    const aggById = new Map(rows.map((r) => [r.deckId, r]));
    for (const deckId of deckIds) {
        out.set(deckId, buildStats(cardCountById.get(deckId) ?? 0, aggById.get(deckId)));
    }
    return out;
};

export const list = async (
    ownerId: string,
    query: DeckListQuery,
): Promise<PageWithTotal<PublicDeck>> => {
    const limit = parseLimit(query.limit, 20);
    const cursor = decodeCursor(query.cursor);
    const [rows, total] = await Promise.all([
        decksRepo.listDecks({ ownerId, limit, cursor, q: query.q }),
        decksRepo.countDecks({ ownerId, q: query.q }),
    ]);

    let nextCursor: string | null = null;
    if (rows.length > limit) {
        const last = rows[limit - 1]!;
        nextCursor = encodeCursor({ ts: last.updatedAt.toISOString(), id: last.id });
    }
    const pageRows = rows.slice(0, limit);
    const stats = await statsByDeckId(
        ownerId,
        pageRows.map((d) => d.id),
        new Map(pageRows.map((d) => [d.id, d.cardCount])),
    );
    return {
        items: pageRows.map((d) => toPublicDeck(d, stats.get(d.id))),
        nextCursor,
        total,
    };
};

export const create = async (
    ownerId: string,
    input: CreateDeckInput,
): Promise<PublicDeck> => {
    const deck = await decksRepo.createDeck(ownerId, {
        title: input.title,
        description: input.description ?? '',
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
    });
    return toPublicDeck(deck);
};

// Reconciliation per backend-plan.md §Reconciliations #2: FE expects the full
// cards array inline (Deck Detail list, study queue, Add Card "card N"). Cap
// at 1000 — matches the FE per-deck limit. A paged GET /decks/:id/cards can be
// added later for content beyond the cap.
const MAX_INLINE_CARDS = 1000;

export const getOne = async (
    ownerId: string,
    deckId: string,
    query: DeckDetailQuery,
): Promise<{ deck: PublicDeck; cards: PublicCard[] }> => {
    const deck = await decksRepo.findDeckById(deckId, ownerId);
    if (!deck) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');

    const cap = query.cardsLimit ?? MAX_INLINE_CARDS;
    const [rows, statsRows] = await Promise.all([
        cardsRepo.listAllCardsForDeck(deckId, cap),
        deckStatsRepo.aggregateDeckStats(ownerId, [deckId]),
    ]);
    const stats = buildStats(deck.cardCount, statsRows[0]);

    return {
        deck: toPublicDeck(deck, stats),
        cards: rows.map(toPublicCard),
    };
};

export const update = async (
    ownerId: string,
    deckId: string,
    input: UpdateDeckInput,
): Promise<PublicDeck> => {
    const patch: Partial<{
        title: string;
        description: string;
        sourceLanguage: string;
        targetLanguage: string;
    }> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.sourceLanguage !== undefined) patch.sourceLanguage = input.sourceLanguage;
    if (input.targetLanguage !== undefined) patch.targetLanguage = input.targetLanguage;

    const { count } = await decksRepo.updateDeck(deckId, ownerId, patch);
    if (count === 0) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');

    const fresh = await decksRepo.findDeckById(deckId, ownerId);
    if (!fresh) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
    return toPublicDeck(fresh);
};

export const remove = async (ownerId: string, deckId: string): Promise<void> => {
    const { count } = await decksRepo.deleteDeck(deckId, ownerId);
    if (count === 0) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
};
