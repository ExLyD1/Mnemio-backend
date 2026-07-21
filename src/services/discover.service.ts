import * as discoverRepo from '../repositories/discover.repository.js';
import * as deckStatsRepo from '../repositories/deck-stats.repository.js';
import * as milestone from './milestone.service.js';
import { prisma } from '../db/prisma.js';
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
    type PublicDeck,
} from '../shared/mappers.deck.js';
import { toPublicDeck } from '../shared/mappers.deck.js';
import type { DiscoverListQuery, DiscoverSort } from '../schemas/discover.schema.js';

const decodeDiscoverCursor = (raw: string | undefined) => {
    const c = decodeCursor(raw);
    return c ? { sortValue: c.ts, id: c.id } : null;
};

const encodeDiscoverCursor = (sortValue: string, id: string) =>
    encodeCursor({ ts: sortValue, id });

const attachStats = async (
    viewerId: string | null,
    decks: Awaited<ReturnType<typeof discoverRepo.listPublicDecks>>,
) => {
    // Discover decks aren't (necessarily) owned by the viewer, so per-user
    // stats are zeroed unless the viewer happens to be the owner. For now,
    // expose neutral stats — FE shows mastery only on owned decks.
    return decks.map((d) => toPublicDeckWithAuthor(d, buildStats(d.cardCount, undefined)));
};

export const list = async (
    viewerId: string | null,
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
        items: await attachStats(viewerId, rows.slice(0, limit)),
        nextCursor,
        total,
    };
};

export const featured = async (): Promise<{ items: PublicDeckWithAuthor[] }> => {
    const rows = await discoverRepo.listFeatured(12);
    return { items: await attachStats(null, rows) };
};

export const categories = async (): Promise<{ items: { subject: string; count: number }[] }> => {
    const items = await discoverRepo.categories();
    return { items };
};

export const copy = async (viewerId: string, sourceDeckId: string): Promise<PublicDeck> => {
    const source = await discoverRepo.findPublicDeckById(sourceDeckId);
    if (!source) throw new NotFoundError('DECK_NOT_FOUND', 'Public deck not found');

    // Atomic: clone deck + cards + bump source copyCount.
    const newDeckId = await prisma.$transaction(async (tx) => {
        const clone = await tx.deck.create({
            data: {
                authorId: viewerId,
                title: source.title,
                description: source.description,
                sourceLanguage: source.sourceLanguage,
                targetLanguage: source.targetLanguage,
                isPublic: false,             // clones default to private
                coverColor: source.coverColor,
                glyph: source.glyph,
                subject: source.subject,
                sourceDeckId: source.id,
                cardCount: source.cardCount,
            },
        });

        const sourceCards = await tx.card.findMany({
            where: { deckId: source.id },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
        });

        if (sourceCards.length > 0) {
            await tx.card.createMany({
                data: sourceCards.map((c) => ({
                    userId: viewerId,
                    deckId: clone.id,
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
                    audioUrl: c.audioUrl,
                    imageUrl: c.imageUrl,
                    position: c.position,
                })),
            });
        }

        await tx.deck.update({
            where: { id: source.id },
            data: { copyCount: { increment: 1 } },
        });

        return clone.id;
    });

    // Cloning a public deck is also a "first deck" path — count it as activation.
    void milestone.checkFirstDeck(viewerId);

    const fresh = await prisma.deck.findUnique({ where: { id: newDeckId } });
    const stats = await deckStatsRepo.aggregateDeckStats(viewerId, [newDeckId]);
    return toPublicDeck(fresh!, buildStats(fresh!.cardCount, stats[0]));
};
