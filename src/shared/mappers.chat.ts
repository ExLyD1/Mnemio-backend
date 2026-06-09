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

export type PublicMessage = {
    id: string;
    conversationId: string;
    role: PublicMessageRole;
    content: string;
    status: PublicMessageStatus;
    // tokensInput/Output only meaningful on assistant rows; null for user/system.
    tokensInput: number | null;
    tokensOutput: number | null;
    createdAt: string;
};

export const toPublicConversation = (c: ConversationModel): PublicConversation => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    lastMessageAt: c.lastMessageAt.toISOString(),
});

export const toPublicMessage = (m: ChatMessageModel): PublicMessage => ({
    id: m.id,
    conversationId: m.conversationId,
    role: m.role as PublicMessageRole,
    content: m.content,
    status: m.status as PublicMessageStatus,
    tokensInput: m.tokensInput,
    tokensOutput: m.tokensOutput,
    createdAt: m.createdAt.toISOString(),
});
