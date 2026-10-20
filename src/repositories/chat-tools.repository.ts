import { prisma } from '../db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AiCardDraft } from '../services/ai.provider.js';
import type { ChatAttachment } from '../shared/mappers.chat.js';

// The message and side effect commit together. A reaped placeholder therefore
// carries its attachment even if the process dies before the provider returns.
export const writeDeck = async (params: {
    userId: string;
    assistantMessageId: string;
    deckId?: string;
    meta: { title: string; description?: string; sourceLanguage: string; targetLanguage: string };
    cards: AiCardDraft[];
    skippedCount?: number;
}): Promise<ChatAttachment> =>
    prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.findFirst({
            where: {
                id: params.assistantMessageId,
                role: 'assistant',
                status: 'streaming',
                conversation: { userId: params.userId },
            },
        });
        if (!message) {
            throw new Error('Assistant placeholder unavailable');
        }
        const deck = params.deckId
            ? await tx.deck.findFirst({ where: { id: params.deckId, authorId: params.userId } })
            : await tx.deck.create({ data: { authorId: params.userId, ...params.meta } });
        if (!deck) {
            throw new Error('Owned deck unavailable');
        }
        // Serialize append positions and the resulting count for this deck.
        await tx.$queryRaw`SELECT id FROM decks WHERE id = ${deck.id} FOR UPDATE`;
        const last = await tx.card.findFirst({
            where: { deckId: deck.id },
            orderBy: { position: 'desc' },
        });
        await tx.card.createMany({
            data: params.cards.map((card, i) => ({
                ...card,
                userId: params.userId,
                deckId: deck.id,
                position: (last ? last.position + 1 : 0) + i,
            })),
        });
        const cardCount = await tx.card.count({ where: { deckId: deck.id } });
        await tx.deck.update({ where: { id: deck.id }, data: { cardCount } });
        const attachment: ChatAttachment = {
            type: 'deck',
            deckId: deck.id,
            title: deck.title,
            cardCount,
            action: params.deckId ? 'appended' : 'created',
            ...(params.deckId ? { addedCount: params.cards.length } : {}),
            ...(params.skippedCount ? { skippedCount: params.skippedCount } : {}),
            sourceLanguage: deck.sourceLanguage,
            targetLanguage: deck.targetLanguage,
        };
        await tx.chatMessage.update({
            where: { id: message.id },
            data: { attachments: [attachment] as unknown as Prisma.InputJsonValue },
        });
        return attachment;
    });
