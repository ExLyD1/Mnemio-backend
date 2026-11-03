import * as libraryRepo from '../repositories/library.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import {
    decodeCursor,
    encodeCursor,
    parseLimit,
    type PageWithTotal,
} from '../shared/pagination.js';
import { buildStats, toLibraryDeck, type PublicLibraryDeck } from '../shared/mappers.deck.js';
import type { LibraryQuery } from '../schemas/library.schema.js';

export type LibraryPage = PageWithTotal<PublicLibraryDeck> & {
    // First page only (no cursor): chip counts for the tabs and filters.
    facets?: libraryRepo.LibraryFacets;
};

export const list = async (userId: string, query: LibraryQuery): Promise<LibraryPage> => {
    const limit = parseLimit(query.limit, 24);
    const cursor = decodeCursor(query.cursor);
    const filters: libraryRepo.LibraryFilters = {
        userId,
        scope: query.scope,
        subject: query.subject,
        lang: query.lang,
    };

    const [rows, total, facets] = await Promise.all([
        libraryRepo.listLibrary({ ...filters, limit, cursor }),
        libraryRepo.countLibrary(filters),
        cursor ? Promise.resolve(undefined) : libraryRepo.libraryFacets(filters),
    ]);

    // The repo fetches limit + 1 rows; an extra row means another page exists,
    // and the last row of this page is where it starts.
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    const nextCursor = last ? encodeCursor({ ts: last.sortTs.toISOString(), id: last.id }) : null;
    const pageRows = rows.slice(0, limit);
    const ids = pageRows.map((r) => r.id);

    const [decks, statRows] = await Promise.all([
        ids.length > 0 ? libraryRepo.findDecksWithAuthor(ids) : Promise.resolve([]),
        deckStatsRepo.aggregateDeckStats(userId, ids),
    ]);
    const deckById = new Map(decks.map((d) => [d.id, d]));
    const statsById = new Map(statRows.map((r) => [r.deckId, r]));

    const items = pageRows.flatMap((row) => {
        const deck = deckById.get(row.id);
        // Deleted between the two queries: just skip it.
        if (!deck) {
            return [];
        }
        return [
            toLibraryDeck(deck, userId, buildStats(deck.cardCount, statsById.get(row.id)), row),
        ];
    });
    return { items, nextCursor, total, ...(facets ? { facets } : {}) };
};
