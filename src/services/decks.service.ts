import * as decksRepo from '../repositories/decks.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import {
    decodeCursor,
    encodeCursor,
    parseLimit,
    type Page,
} from '../shared/pagination.js';
import { NotFoundError } from '../shared/errors.js';
import { toPublicDeck, toPublicCard, type PublicDeck, type PublicCard } from '../shared/mappers.deck.js';
import type {
    CreateDeckInput,
    UpdateDeckInput,
    DeckListQuery,
    DeckDetailQuery,
} from '../schemas/deck.schema.js';

export const list = async (
    ownerId: string,
    query: DeckListQuery,
): Promise<Page<PublicDeck>> => {
    const limit = parseLimit(query.limit, 20);
    const cursor = decodeCursor(query.cursor);
    const rows = await decksRepo.listDecks({ ownerId, limit, cursor, q: query.q });

    let nextCursor: string | null = null;
    if (rows.length > limit) {
        const last = rows[limit - 1]!;
        nextCursor = encodeCursor({ ts: last.updatedAt.toISOString(), id: last.id });
    }
    return {
        items: rows.slice(0, limit).map(toPublicDeck),
        nextCursor,
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

export const getOne = async (
    ownerId: string,
    deckId: string,
    query: DeckDetailQuery,
): Promise<{ deck: PublicDeck; cards: Page<PublicCard> }> => {
    const deck = await decksRepo.findDeckById(deckId, ownerId);
    if (!deck) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');

    const cardsLimit = parseLimit(query.cardsLimit, 50);
    const cardsCursor = decodeCursor(query.cardsCursor);
    const rows = await cardsRepo.listCardsByPosition({
        deckId,
        limit: cardsLimit,
        cursor: cardsCursor,
    });

    let nextCursor: string | null = null;
    if (rows.length > cardsLimit) {
        const last = rows[cardsLimit - 1]!;
        nextCursor = encodeCursor({ ts: String(last.position), id: last.id });
    }

    return {
        deck: toPublicDeck(deck),
        cards: {
            items: rows.slice(0, cardsLimit).map(toPublicCard),
            nextCursor,
        },
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
