import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

const AUTHOR_SELECT = { select: { id: true, username: true, fullName: true } } as const;

export type DiscoverCursorKind = 'recent' | 'popular';

export type DiscoverCursor = {
    /** ISO updatedAt for 'recent', stringified copyCount for 'popular' */
    sortValue: string;
    id: string;
};

export type ListPublicDecksParams = {
    limit: number;
    cursor: DiscoverCursor | null;
    q: string | undefined;
    lang: string | undefined;
    subject: string | undefined;
    sort: DiscoverCursorKind;
};

const baseWhere = (params: Pick<ListPublicDecksParams, 'q' | 'lang' | 'subject'>): Prisma.DeckWhereInput => {
    const where: Prisma.DeckWhereInput = { isPublic: true };
    if (params.q && params.q.length > 0) {
        where.OR = [
            { title: { contains: params.q, mode: 'insensitive' } },
            { description: { contains: params.q, mode: 'insensitive' } },
        ];
    }
    if (params.lang) {
        // Match either source or target language — FE filter is "language",
        // not a directional pair.
        where.AND = [
            { OR: [{ sourceLanguage: params.lang }, { targetLanguage: params.lang }] },
        ];
    }
    if (params.subject) where.subject = params.subject;
    return where;
};

export const listPublicDecks = ({
    limit,
    cursor,
    sort,
    ...rest
}: ListPublicDecksParams) => {
    const where = baseWhere(rest);

    if (cursor) {
        if (sort === 'recent') {
            const ts = new Date(cursor.sortValue);
            where.AND = [
                ...((where.AND as Prisma.DeckWhereInput[] | undefined) ?? []),
                {
                    OR: [
                        { updatedAt: { lt: ts } },
                        { updatedAt: ts, id: { lt: cursor.id } },
                    ],
                },
            ];
        } else {
            const cc = Number.parseInt(cursor.sortValue, 10);
            where.AND = [
                ...((where.AND as Prisma.DeckWhereInput[] | undefined) ?? []),
                {
                    OR: [
                        { copyCount: { lt: cc } },
                        { copyCount: cc, id: { lt: cursor.id } },
                    ],
                },
            ];
        }
    }

    const orderBy: Prisma.DeckOrderByWithRelationInput[] =
        sort === 'recent'
            ? [{ updatedAt: 'desc' }, { id: 'desc' }]
            : [{ copyCount: 'desc' }, { id: 'desc' }];

    return prisma.deck.findMany({
        where,
        orderBy,
        take: limit + 1,
        include: { author: AUTHOR_SELECT },
    });
};

export const countPublicDecks = (params: Pick<ListPublicDecksParams, 'q' | 'lang' | 'subject'>) =>
    prisma.deck.count({ where: baseWhere(params) });

export const listFeatured = (limit: number) =>
    prisma.deck.findMany({
        where: { isPublic: true, featured: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: { author: AUTHOR_SELECT },
    });

export const categories = async (): Promise<{ subject: string; count: number }[]> => {
    const rows = await prisma.$queryRaw<{ subject: string; count: bigint }[]>`
        SELECT "subject", COUNT(*) AS count
          FROM "decks"
         WHERE "isPublic" = true AND "subject" IS NOT NULL
         GROUP BY "subject"
         ORDER BY count DESC, "subject" ASC
         LIMIT 50
    `;
    return rows.map((r) => ({ subject: r.subject, count: Number(r.count) }));
};

export const findPublicDeckById = (deckId: string) =>
    prisma.deck.findFirst({
        where: { id: deckId, isPublic: true },
        include: { author: AUTHOR_SELECT },
    });

export const bumpCopyCount = (deckId: string) =>
    prisma.deck.update({
        where: { id: deckId },
        data: { copyCount: { increment: 1 } },
    });

// Sitemap projection: id + updatedAt only, ordered for stable diffs. Hard cap
// of 50k matches the sitemap.xml protocol limit; FE should split into multiple
// sitemaps before then anyway.
export const listAllPublicDeckIds = () =>
    prisma.deck.findMany({
        where: { isPublic: true },
        select: { id: true, updatedAt: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 50_000,
    });
