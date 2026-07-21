// Unauthenticated read-only surface for SEO + marketing pages. Everything
// here is a thin wrapper around the existing discover machinery — the repo
// already filters `isPublic: true`, so all we add is the no-auth route layer
// and a sitemap-shaped projection.
//
// Three design rules:
//   1. Reuse the existing repo functions. Don't fork the filter logic — if a
//      deck stops being public, BOTH the authed Discover AND the SEO pages
//      must drop it in lock-step.
//   2. Never leak private data. The public deck-detail returns the deck
//      header + cards but trims author down to { username, fullName } only.
//   3. Pagination matches the authed Discover endpoint so the FE can wire
//      one client and parameterise the base path.

import * as discoverRepo from '../repositories/discover.repository.js';
import * as cardsRepo from '../repositories/cards.repository.js';
import {
    encodeCursor,
    decodeCursor,
    parseLimit,
    type PageWithTotal,
} from '../shared/pagination.js';
import { NotFoundError } from '../shared/errors.js';
import {
    toPublicDeckWithAuthor,
    buildStats,
    type PublicDeckWithAuthor,
    type PublicCard,
} from '../shared/mappers.deck.js';
import { toPublicCard } from '../shared/mappers.deck.js';
import type { DiscoverListQuery, DiscoverSort } from '../schemas/discover.schema.js';

const decodeDiscoverCursor = (raw: string | undefined) => {
    const c = decodeCursor(raw);
    return c ? { sortValue: c.ts, id: c.id } : null;
};

const encodeDiscoverCursor = (sortValue: string, id: string) =>
    encodeCursor({ ts: sortValue, id });

// ---------- /public/discover/decks ----------

export const listPublicDecks = async (
    query: DiscoverListQuery,
): Promise<PageWithTotal<PublicDeckWithAuthor>> => {
    const limit = parseLimit(query.limit, 20);
    const sort: DiscoverSort = query.sort ?? 'recent';
    const cursor = decodeDiscoverCursor(query.cursor);

    const [rows, total] = await Promise.all([
        discoverRepo.listPublicDecks({
            limit,
            cursor,
            sort,
            q: query.q,
            lang: query.lang,
            subject: query.subject,
        }),
        discoverRepo.countPublicDecks({ q: query.q, lang: query.lang, subject: query.subject }),
    ]);

    let nextCursor: string | null = null;
    if (rows.length > limit) {
        const last = rows[limit - 1]!;
        nextCursor =
            sort === 'recent'
                ? encodeDiscoverCursor(last.updatedAt.toISOString(), last.id)
                : encodeDiscoverCursor(String(last.copyCount), last.id);
    }

    return {
        items: rows
            .slice(0, limit)
            .map((d) => toPublicDeckWithAuthor(d, buildStats(d.cardCount, undefined))),
        nextCursor,
        total,
    };
};

// ---------- /public/discover/categories ----------

export const publicCategories = async (): Promise<{ items: { subject: string; count: number }[] }> => {
    const items = await discoverRepo.categories();
    return { items };
};

// ---------- /public/decks/:id ----------

// Same shape as the authed GET /decks/:id but never includes per-user stats
// (no viewer concept here). Cards are inlined the same way so the SEO page
// can render the full deck without a second fetch.
export const getPublicDeck = async (
    deckId: string,
): Promise<{ deck: PublicDeckWithAuthor; cards: PublicCard[] }> => {
    const row = await discoverRepo.findPublicDeckById(deckId);
    if (!row) throw new NotFoundError('DECK_NOT_FOUND', 'Public deck not found');

    const cards = await cardsRepo.listAllCardsForDeck(deckId);
    return {
        deck: toPublicDeckWithAuthor(row, buildStats(row.cardCount, undefined)),
        cards: cards.map(toPublicCard),
    };
};

// ---------- /public/sitemap/decks ----------

export type SitemapDeck = {
    id: string;
    updatedAt: string;  // ISO — drives <lastmod> in sitemap.xml
};

// Deliberately a minimal projection: the FE generates sitemap.xml from this
// and only needs the URL slug source + a lastmod hint. Returning the full
// deck DTO would waste bandwidth on every recrawl.
export const sitemapDecks = async (): Promise<{ items: SitemapDeck[] }> => {
    const rows = await discoverRepo.listAllPublicDeckIds();
    return {
        items: rows.map((r) => ({
            id: r.id,
            updatedAt: r.updatedAt.toISOString(),
        })),
    };
};
