import { describe, it, expect } from 'vitest';
import {
    DEFAULT_IS_PUBLIC,
    canAccessDeck,
    assertDeckAccessible,
} from '../src/services/deck-visibility.js';
import { AppError } from '../src/shared/errors.js';

const OWNER = 'user-owner';
const OTHER = 'user-other';

const publicDeck = { authorId: OWNER, isPublic: true };
const privateDeck = { authorId: OWNER, isPublic: false };

describe('deck privacy — access rule (GET /decks/:id + copy)', () => {
    it('defaults new decks to public', () => {
        expect(DEFAULT_IS_PUBLIC).toBe(true);
    });

    describe('canAccessDeck', () => {
        it('owner sees their own private deck', () => {
            expect(canAccessDeck(privateDeck, OWNER)).toBe(true);
        });

        it('owner sees their own public deck', () => {
            expect(canAccessDeck(publicDeck, OWNER)).toBe(true);
        });

        it('non-owner sees a public deck', () => {
            expect(canAccessDeck(publicDeck, OTHER)).toBe(true);
        });

        it('non-owner CANNOT see a private deck', () => {
            expect(canAccessDeck(privateDeck, OTHER)).toBe(false);
        });
    });

    describe('assertDeckAccessible — 404 (not 403) so private decks are not enumerable', () => {
        const expectNotFound = (fn: () => unknown) => {
            try {
                fn();
                throw new Error('expected assertDeckAccessible to throw');
            } catch (err) {
                expect(err).toBeInstanceOf(AppError);
                const e = err as AppError;
                expect(e.statusCode).toBe(404);
                expect(e.code).toBe('DECK_NOT_FOUND');
            }
        };

        it('non-owner on a private deck → 404 DECK_NOT_FOUND', () => {
            expectNotFound(() => assertDeckAccessible(privateDeck, OTHER));
        });

        it('missing deck → 404 DECK_NOT_FOUND (same shape as private)', () => {
            expectNotFound(() => assertDeckAccessible(null, OTHER));
        });

        it('owner on a private deck → returns the deck', () => {
            expect(assertDeckAccessible(privateDeck, OWNER)).toBe(privateDeck);
        });

        it('non-owner on a public deck → returns the deck', () => {
            expect(assertDeckAccessible(publicDeck, OTHER)).toBe(publicDeck);
        });

        it('preserves the full row it was given (used as the deck to serve)', () => {
            const row = { id: 'd1', authorId: OWNER, isPublic: true, title: 'X' };
            expect(assertDeckAccessible(row, OTHER)).toEqual(row);
        });
    });

    describe('copy uses the same rule', () => {
        it('non-owner copying a private deck is blocked (404)', () => {
            expect(() => assertDeckAccessible(privateDeck, OTHER)).toThrow();
            expect(canAccessDeck(privateDeck, OTHER)).toBe(false);
        });

        it('non-owner copying a public deck is allowed', () => {
            expect(canAccessDeck(publicDeck, OTHER)).toBe(true);
        });

        it('owner copying their own private deck is allowed', () => {
            expect(canAccessDeck(privateDeck, OWNER)).toBe(true);
        });
    });
});
