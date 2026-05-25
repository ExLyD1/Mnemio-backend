import * as cardsRepo from '../repositories/cards.repository.js';
import * as decksRepo from '../repositories/decks.repository.js';
import { ForbiddenError, NotFoundError } from '../shared/errors.js';
import { toPublicCard, type PublicCard } from '../shared/mappers.deck.js';
import type {
    CreateCardInput,
    UpdateCardInput,
    BulkCreateCardsInput,
} from '../schemas/card.schema.js';

const assertOwnsDeck = async (deckId: string, ownerId: string) => {
    const deck = await decksRepo.findDeckById(deckId, ownerId);
    if (!deck) throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
    return deck;
};

const assertOwnsCard = async (cardId: string, ownerId: string) => {
    const card = await cardsRepo.findCardWithOwner(cardId);
    if (!card) throw new NotFoundError('CARD_NOT_FOUND', 'Card not found');
    if (card.deck.authorId !== ownerId) {
        throw new ForbiddenError('CARD_FORBIDDEN', 'You do not own this card');
    }
    return card;
};

export const create = async (
    ownerId: string,
    deckId: string,
    input: CreateCardInput,
): Promise<PublicCard> => {
    await assertOwnsDeck(deckId, ownerId);
    const position = await cardsRepo.nextPositionForDeck(deckId);
    const card = await cardsRepo.createCard({
        userId: ownerId,
        deckId,
        word: input.word,
        definition: input.definition,
        phonetic: input.phonetic ?? null,
        position,
    });
    await decksRepo.recomputeCardCount(deckId);
    return toPublicCard(card);
};

export const bulkCreate = async (
    ownerId: string,
    deckId: string,
    input: BulkCreateCardsInput,
): Promise<{ created: number }> => {
    await assertOwnsDeck(deckId, ownerId);
    const startPos = await cardsRepo.nextPositionForDeck(deckId);
    const rows = input.cards.map((c, i) => ({
        userId: ownerId,
        deckId,
        word: c.word,
        definition: c.definition,
        phonetic: c.phonetic ?? null,
        position: startPos + i,
    }));
    const { count } = await cardsRepo.createCardsBulk(rows);
    await decksRepo.recomputeCardCount(deckId);
    return { created: count };
};

export const update = async (
    ownerId: string,
    cardId: string,
    input: UpdateCardInput,
): Promise<PublicCard> => {
    await assertOwnsCard(cardId, ownerId);
    const patch: Partial<{ word: string; definition: string; phonetic: string | null; position: number }> = {};
    if (input.word !== undefined) patch.word = input.word;
    if (input.definition !== undefined) patch.definition = input.definition;
    if (input.phonetic !== undefined) patch.phonetic = input.phonetic;
    if (input.position !== undefined) patch.position = input.position;

    const updated = await cardsRepo.updateCard(cardId, patch);
    return toPublicCard(updated);
};

export const remove = async (ownerId: string, cardId: string): Promise<void> => {
    const card = await assertOwnsCard(cardId, ownerId);
    await cardsRepo.deleteCard(cardId);
    await decksRepo.recomputeCardCount(card.deckId);
};
