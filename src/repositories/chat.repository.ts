import { Prisma } from '../../generated/prisma/client.js';
import type { ChatMessageModel } from '../../generated/prisma/models/ChatMessage.js';
import { prisma } from '../db/prisma.js';
import type { ChatAttachment } from '../shared/mappers.chat.js';

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
//
// Conversations with no messages are hidden. The FE creates a conversation
// before it sends the first message, so every send that fails validation or
// the budget check used to leave an untitled "New chat" behind forever.
export const listConversations = (params: {
    userId: string;
    limit: number;
    cursor: { ts: string; id: string } | null;
}) => {
    const where: Prisma.ConversationWhereInput = {
        userId: params.userId,
        messages: { some: {} },
    };
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

// 'streaming' is the live placeholder: a reply is being generated right now.
// It becomes 'complete' or 'partial' when the turn ends, and a crashed process
// leaves it behind, which STALE_STREAM_MS below reaps.
export type MessageStatus = 'complete' | 'partial' | 'streaming';

// How long a 'streaming' row may sit untouched before we treat it as abandoned
// (the process died mid-turn). Longer than any realistic turn, short enough
// that the user isn't locked out of their own conversation for long.
export const STALE_STREAM_MS = 3 * 60 * 1000;

export const createMessage = (data: {
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    status?: MessageStatus;
}) =>
    prisma.chatMessage.create({
        data: {
            conversationId: data.conversationId,
            role: data.role,
            content: data.content,
            status: data.status ?? 'complete',
        },
    });

/**
 * Start a turn: save the user message and claim the conversation's single
 * streaming slot, atomically.
 *
 * Two sends racing on one conversation (a second tab, a retried POST) used to
 * both go through, and each one's model context picked up the other's
 * unanswered user row — the second reply came back as the first reply plus its
 * own, twice. A row-level lock on the conversation serializes the claim, so
 * the loser gets `null` and the service turns that into 409 CHAT_BUSY.
 *
 * Abandoned placeholders (process died mid-turn) older than STALE_STREAM_MS are
 * reaped to 'partial' inside the same lock, so a crash can't wedge a
 * conversation permanently.
 *
 * `retryOf` deletes a previous failed attempt (the partial assistant row and
 * the user row that produced it) in the same transaction, so retrying replaces
 * that turn instead of appending a duplicate pair.
 */
export const claimTurn = async (params: {
    conversationId: string;
    content: string;
    retryOf?: string | undefined;
}): Promise<{
    userRow: ChatMessageModel;
    placeholder: ChatMessageModel;
} | null> =>
    prisma.$transaction(async (tx) => {
        // Serializes concurrent sends on this conversation. Held until commit.
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${params.conversationId} FOR UPDATE`;

        if (params.retryOf) {
            const failed = await tx.chatMessage.findFirst({
                where: {
                    id: params.retryOf,
                    conversationId: params.conversationId,
                    role: 'assistant',
                    status: 'partial',
                },
            });
            if (failed) {
                // The user turn that produced it: the row immediately before.
                const priorUser = await tx.chatMessage.findFirst({
                    where: {
                        conversationId: params.conversationId,
                        role: 'user',
                        createdAt: { lt: failed.createdAt },
                    },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                });
                await tx.chatMessage.deleteMany({
                    where: {
                        id: { in: priorUser ? [failed.id, priorUser.id] : [failed.id] },
                    },
                });
            }
        }

        const staleBefore = new Date(Date.now() - STALE_STREAM_MS);
        await tx.chatMessage.updateMany({
            where: {
                conversationId: params.conversationId,
                status: 'streaming',
                createdAt: { lt: staleBefore },
            },
            data: { status: 'partial' },
        });

        const live = await tx.chatMessage.count({
            where: { conversationId: params.conversationId, status: 'streaming' },
        });
        if (live > 0) {
            return null;
        }

        const userRow = await tx.chatMessage.create({
            data: { conversationId: params.conversationId, role: 'user', content: params.content },
        });
        // +1ms so the placeholder always sorts after its user row even when
        // both land inside the same clock tick.
        const placeholder = await tx.chatMessage.create({
            data: {
                conversationId: params.conversationId,
                role: 'assistant',
                content: '',
                status: 'streaming',
                createdAt: new Date(userRow.createdAt.getTime() + 1),
            },
        });
        return { userRow, placeholder };
    });

// Release a claimed slot without a finalize (e.g. the budget check threw after
// the claim). Leaves no 'streaming' row behind to block the next send.
export const releaseTurn = (assistantId: string) =>
    prisma.chatMessage.deleteMany({ where: { id: assistantId, status: 'streaming' } });

// Used when the streaming reply finishes: replace the placeholder content
// and flip status to 'complete'. tokensInput/Output are nullable in the
// schema but always set on assistant rows. `attachments` is set only when a
// tool fired during the turn; we explicitly null it out otherwise so a retry
// after a tool failure clears stale data from the partial placeholder.
export const finalizeAssistantMessage = (data: {
    id: string;
    content: string;
    tokensInput: number;
    tokensOutput: number;
    status?: 'complete' | 'partial';
    attachments?: ChatAttachment[];
}) =>
    prisma.chatMessage.update({
        where: { id: data.id },
        data: {
            content: data.content,
            tokensInput: data.tokensInput,
            tokensOutput: data.tokensOutput,
            status: data.status ?? 'complete',
            attachments:
                data.attachments && data.attachments.length > 0
                    ? (data.attachments as unknown as Prisma.InputJsonValue)
                    : Prisma.JsonNull,
        },
    });

// Tail (last N by createdAt). The default 50 is what the FE renders on
// conversation open; the model context window asks for the last 20 instead.
// Ordered desc then reversed so a long conversation returns its NEWEST 50 —
// ascending + take returned the oldest 50, hiding everything recent.
export const listMessages = async (conversationId: string, take = 50) => {
    const rows = await prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
    });
    return rows.reverse();
};

/**
 * Prior turns for the LLM: user + assistant rows only (chat.prompt.ts is the
 * single source of the system prompt), oldest-first.
 *
 * `before` excludes the current turn's own rows. They are already persisted by
 * the time the model context is built, so without it every turn sent the
 * current user message twice — once as history, once as the live turn.
 *
 * Trailing user rows with no assistant answer after them are dropped: they are
 * abandoned turns (a failed send, a concurrent send) and re-sending them makes
 * the model answer an old question alongside the new one.
 */
export const lastTurnsForModel = async (
    conversationId: string,
    take: number,
    before?: Date,
): Promise<{ role: 'user' | 'assistant'; content: string; attachments: unknown }[]> => {
    const rows = await prisma.chatMessage.findMany({
        where: {
            conversationId,
            role: { in: ['user', 'assistant'] },
            status: 'complete',
            ...(before ? { createdAt: { lt: before } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
    });
    const turns = rows.reverse().map((r) => ({
        role: r.role as 'user' | 'assistant',
        content: r.content,
        attachments: r.attachments,
    }));
    while (turns.length > 0 && turns[turns.length - 1]?.role === 'user') {
        turns.pop();
    }
    return turns;
};

// Used to decide whether the first user message should set the conversation
// title. Counts only user rows so an empty conversation pre-populated with
// system context (future) still triggers auto-titling on the real first turn.
export const countUserMessages = (conversationId: string, before?: Date) =>
    prisma.chatMessage.count({
        where: {
            conversationId,
            role: 'user',
            ...(before ? { createdAt: { lt: before } } : {}),
        },
    });
