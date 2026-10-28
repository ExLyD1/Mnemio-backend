import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { LEARNING_THRESHOLD, SUBJECTS, type Subject } from '../shared/subjects.js';
import type { LibraryScope } from '../schemas/library.schema.js';

// The library (spec 002): every deck the user authored, plus every deck —
// theirs or someone else's public one — they've studied enough of.
//
//   is_mine     authorId = me
//   is_learning a user_decks row with studiedCount >= LEAST(5, cardCount),
//               cardCount > 0, and the deck is still readable by me (mine, or
//               public). Flipping a deck private drops it from everyone else's
//               Learning; their user_decks row is kept, so it returns if the
//               deck becomes public again.
//   sort_ts     COALESCE(lastStudiedAt, createdAt): most recently studied
//               first, and a brand-new own deck lands at the top.
//
// Timestamps are compared as `timestamp` (UTC, no zone) to match how Prisma
// stores DateTime, independent of the DB session's time zone.

export type LibraryFilters = {
    userId: string;
    scope: LibraryScope;
    subject: Subject | undefined;
    lang: string | undefined;
};

const membership = (userId: string) => Prisma.sql`
    SELECT d.id,
           d.subject,
           d."targetLanguage",
           ud."studiedCount",
           ud."lastStudiedAt",
           (d."authorId" = ${userId}) AS is_mine,
           (ud."userId" IS NOT NULL
              AND d."cardCount" > 0
              AND ud."studiedCount" >= LEAST(${LEARNING_THRESHOLD}::int, d."cardCount")
              AND (d."authorId" = ${userId} OR d."isPublic")) AS is_learning,
           COALESCE(ud."lastStudiedAt", d."createdAt") AS sort_ts
      FROM decks d
      LEFT JOIN user_decks ud ON ud."deckId" = d.id AND ud."userId" = ${userId}
     WHERE d."authorId" = ${userId} OR ud."userId" IS NOT NULL
`;

const scopePredicate = (scope: LibraryScope) =>
    scope === 'my'
        ? Prisma.sql`is_mine`
        : scope === 'learning'
          ? Prisma.sql`is_learning`
          : Prisma.sql`(is_mine OR is_learning)`;

const facetFilters = ({ subject, lang }: Pick<LibraryFilters, 'subject' | 'lang'>) =>
    Prisma.sql`
        ${subject ? Prisma.sql`AND subject = ${subject}` : Prisma.empty}
        ${lang ? Prisma.sql`AND "targetLanguage" = ${lang}` : Prisma.empty}
    `;

export type LibraryRow = {
    id: string;
    studiedCount: number | null;
    lastStudiedAt: Date | null;
    sortTs: Date;
};

export const listLibrary = (
    f: LibraryFilters & { limit: number; cursor: { ts: string; id: string } | null },
): Promise<LibraryRow[]> =>
    prisma.$queryRaw<LibraryRow[]>`
        WITH m AS (${membership(f.userId)})
        SELECT id, "studiedCount", "lastStudiedAt", sort_ts AS "sortTs"
          FROM m
         WHERE ${scopePredicate(f.scope)}
               ${facetFilters(f)}
               ${
                   f.cursor
                       ? Prisma.sql`AND (sort_ts < ${f.cursor.ts}::timestamp
                                         OR (sort_ts = ${f.cursor.ts}::timestamp AND id < ${f.cursor.id}))`
                       : Prisma.empty
               }
         ORDER BY sort_ts DESC, id DESC
         LIMIT ${f.limit + 1}
    `;

export const countLibrary = async (f: LibraryFilters): Promise<number> => {
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
        WITH m AS (${membership(f.userId)})
        SELECT count(*) AS count FROM m
         WHERE ${scopePredicate(f.scope)} ${facetFilters(f)}
    `;
    return Number(row?.count ?? 0);
};

export type LibraryFacets = {
    scopes: { all: number; my: number; learning: number };
    subjects: { subject: Subject; count: number }[];
    languages: { lang: string; count: number }[];
};

// Chip counts. Scope counts ignore subject/lang and the current scope; the
// subject chips ignore subject/lang (but respect scope); the language chips
// are the languages of the user's `languages` decks within the scope.
export const libraryFacets = async (f: LibraryFilters): Promise<LibraryFacets> => {
    const [scopeRows, subjectRows, langRows] = await Promise.all([
        prisma.$queryRaw<{ all: bigint; my: bigint; learning: bigint }[]>`
            WITH m AS (${membership(f.userId)})
            SELECT count(*) FILTER (WHERE is_mine OR is_learning) AS "all",
                   count(*) FILTER (WHERE is_mine)                AS "my",
                   count(*) FILTER (WHERE is_learning)            AS "learning"
              FROM m
        `,
        prisma.$queryRaw<{ subject: string; count: bigint }[]>`
            WITH m AS (${membership(f.userId)})
            SELECT subject, count(*) AS count FROM m
             WHERE ${scopePredicate(f.scope)}
             GROUP BY subject
        `,
        prisma.$queryRaw<{ lang: string; count: bigint }[]>`
            WITH m AS (${membership(f.userId)})
            SELECT "targetLanguage" AS lang, count(*) AS count FROM m
             WHERE ${scopePredicate(f.scope)} AND subject = 'languages'
             GROUP BY "targetLanguage"
             ORDER BY count DESC, "targetLanguage" ASC
        `,
    ]);
    const s = scopeRows[0];
    const bySubject = new Map(subjectRows.map((r) => [r.subject, Number(r.count)]));
    return {
        scopes: {
            all: Number(s?.all ?? 0),
            my: Number(s?.my ?? 0),
            learning: Number(s?.learning ?? 0),
        },
        // Taxonomy order, empty subjects omitted.
        subjects: SUBJECTS.flatMap((subject) => {
            const count = bySubject.get(subject) ?? 0;
            return count > 0 ? [{ subject, count }] : [];
        }),
        languages: langRows.map((r) => ({ lang: r.lang, count: Number(r.count) })),
    };
};

export const findDecksWithAuthor = (ids: string[]) =>
    prisma.deck.findMany({
        where: { id: { in: ids } },
        include: { author: { select: { id: true, username: true, fullName: true } } },
    });
