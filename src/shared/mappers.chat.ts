import type { ConversationModel } from '../../generated/prisma/models/Conversation.js';
import type { ChatMessageModel } from '../../generated/prisma/models/ChatMessage.js';

export type PublicConversation = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    lastMessageAt: string;
};

export type PublicMessageRole = 'user' | 'assistant' | 'system';
export type PublicMessageStatus = 'complete' | 'partial';

// Structured side-effect of a tool-use turn. Only 'deck' exists today; the
// union shape leaves room for future tools (audio, image, study session, …)
// without breaking the FE contract.
export type ChatAttachment = {
    type: 'deck';
    deckId: string;
    title: string;
    cardCount: number;
};

export type PublicMessage = {
    id: string;
    conversationId: string;
    role: PublicMessageRole;
    content: string;
    status: PublicMessageStatus;
    // tokensInput/Output only meaningful on assistant rows; null for user/system.
    tokensInput: number | null;
    tokensOutput: number | null;
    attachments?: ChatAttachment[];
    createdAt: string;
};

export const toPublicConversation = (c: ConversationModel): PublicConversation => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
});

// Defensive: the DB column is Json so anything could theoretically be there
// (legacy rows, migrations gone wrong). Only forward shapes that match the
// current ChatAttachment union; silently drop anything else.
const fromDbAttachments = (raw: unknown): ChatAttachment[] | undefined => {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: ChatAttachment[] = [];
    for (const item of raw) {
        if (
            item &&
            typeof item === 'object' &&
            (item as { type?: unknown }).type === 'deck' &&
            typeof (item as { deckId?: unknown }).deckId === 'string' &&
            typeof (item as { title?: unknown }).title === 'string' &&
            typeof (item as { cardCount?: unknown }).cardCount === 'number'
        ) {
            const o = item as {
                deckId: string;
                title: string;
                cardCount: number;
            };
            out.push({ type: 'deck', deckId: o.deckId, title: o.title, cardCount: o.cardCount });
        }
    }
    return out.length > 0 ? out : undefined;
};

export const toPublicMessage = (m: ChatMessageModel): PublicMessage => {
    const attachments = fromDbAttachments(m.attachments);
    return {
        id: m.id,
        conversationId: m.conversationId,
        role: m.role as PublicMessageRole,
        content: m.content,
        status: m.status as PublicMessageStatus,
        tokensInput: m.tokensInput,
        tokensOutput: m.tokensOutput,
        ...(attachments ? { attachments } : {}),
        createdAt: m.createdAt.toISOString(),
    };
};
