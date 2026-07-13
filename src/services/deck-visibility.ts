import { NotFoundError } from '../shared/errors.js';

// Default privacy for a deck created without an explicit is_public. Public-by-
// default preserves the app's pre-enforcement behaviour (decks were effectively
// always public).
export const DEFAULT_IS_PUBLIC = true;

export type DeckVisibility = { authorId: string; isPublic: boolean };

// The single access rule shared by deck-detail and copy: the owner always has
// access; everyone else only when the deck is public. Private decks are
// invisible to non-owners.
export const canAccessDeck = (deck: DeckVisibility, viewerId: string): boolean =>
    deck.authorId === viewerId || deck.isPublic;

// Guard for endpoints that fetch a deck by id for a viewer. A private deck the
// viewer can't access is reported as **404 DECK_NOT_FOUND** (never 403) so it is
// indistinguishable from a missing deck and thus not enumerable. Returns the
// deck (narrowed non-null) when access is allowed.
export function assertDeckAccessible<T extends DeckVisibility>(
    deck: T | null,
    viewerId: string,
): T {
    if (!deck || !canAccessDeck(deck, viewerId)) {
        throw new NotFoundError('DECK_NOT_FOUND', 'Deck not found');
    }
    return deck;
}
