import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';

// ---------- Conversations ----------

export const createConversation = (userId: string, title?: string) =>
    prisma.conversation.create({
        data: title ? { userId, title } : { userId },
    });

// Ownership-scoped find — returns null when the caller doesn't own the row,
// which the service maps to CHAT_NOT_FOUND (not 403). Matches the deck/card
// pattern.
export const findConversation = (id: string, userId: string) =>
    prisma.conversation.findFirst({ where: { id, userId } });

export const renameConversation = (id: string, userId: string, title: string) =>
    prisma.conversation.updateMany({
        where: { id, userId },
        data: { title },
    });

export const deleteConversation = (id: string, userId: string) =>
    prisma.conversation.deleteMany({ where: { id, userId } });

// Sidebar list: lastMessageAt DESC, id DESC for a stable keyset.
export const listConversations = (params: {
    userId: string;
    limit: number;
    cursor: { ts: string; id: string } | null;
}) => {
    const where: Prisma.ConversationWhereInput = { userId: params.userId };
    if (params.cursor) {
        const ts = new Date(params.cursor.ts);
        where.AND = [
            {
                OR: [
                    { lastMessageAt: { lt: ts } },
                    { lastMessageAt: ts, id: { lt: params.cursor.id } },
                ],
            },
        ];
    }
    return prisma.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: params.limit + 1,
    });
};

// Bumped explicitly by the service when an assistant reply finishes so the
// sidebar order tracks new replies, not just the user-send timestamp.
export const touchLastMessageAt = (id: string, when: Date = new Date()) =>
    prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: when },
    });

// Combined: rename + touch in one round-trip for the auto-title path.
export const renameAndTouch = (id: string, title: string, when: Date = new Date()) =>
    prisma.conversation.update({
        where: { id },
        data: { title, lastMessageAt: when },
    });

// ---------- Messages ----------

export const createMessage = (data: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    status?: 'complete' | 'partial';
}) =>
    prisma.chatMessage.create({
        data: {
            conversationId: data.conversationId,
            role: data.role,
            content: data.content,
            status: data.status ?? 'complete',
        },
    });

// Used when the streaming reply finishes: replace the placeholder content
// and flip status to 'complete'. tokensInput/Output are nullable in the
// schema but always set on assistant rows.
export const finalizeAssistantMessage = (data: {
    id: string;
    content: string;
    tokensInput: number;
    tokensOutput: number;
    status?: 'complete' | 'partial';
}) =>
    prisma.chatMessage.update({
        where: { id: data.id },
        data: {
            content: data.content,
            tokensInput: data.tokensInput,
            tokensOutput: data.tokensOutput,
            status: data.status ?? 'complete',
        },
    });

// Tail (last N by createdAt). The default 50 is what the FE renders on
// conversation open; the model context window asks for the last 20 instead.
export const listMessages = (conversationId: string, take = 50) =>
    prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
    });

// Only user + assistant rows, capped at N, for sending to the LLM. Excludes
// system rows (chat.prompt.ts is the single source of the system prompt).
export const lastTurnsForModel = async (
    conversationId: string,
    take: number,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> => {
    const rows = await prisma.chatMessage.findMany({
        where: { conversationId, role: { in: ['user', 'assistant'] }, status: 'complete' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
    });
    return rows
        .reverse()
        .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
};

// Used to decide whether the first user message should set the conversation
// title. Counts only user rows so an empty conversation pre-populated with
// system context (future) still triggers auto-titling on the real first turn.
export const countUserMessages = (conversationId: string) =>
    prisma.chatMessage.count({ where: { conversationId, role: 'user' } });
