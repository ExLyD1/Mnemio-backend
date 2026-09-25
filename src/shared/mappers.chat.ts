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
// 'streaming' means a reply is being generated for this row right now. The FE
// renders the typing indicator and polls until it settles, instead of showing
// a completed-but-empty reply as "interrupted".
export type PublicMessageStatus = 'complete' | 'partial' | 'streaming';

// Structured side-effect of a tool-use turn. Only 'deck' exists today; the
// union shape leaves room for future tools (audio, image, study session, …)
// without breaking the FE contract.
//
// `action` distinguishes a freshly-created deck (`create_deck`) from cards
// appended to an existing one (`add_cards`); `addedCount` is the number of cards
// just appended (only set for 'appended') and `skippedCount` how many of the
// requested words were already in the deck and therefore not duplicated.
// `cardCount` is always the deck's current total so the FE can render/refresh it. `sourceLanguage`/
// `targetLanguage` are the deck's pair (absent on rows saved before they were
// added); chat.service also feeds them back to the model on later turns.
export type ChatAttachment = {
    type: 'deck';
    deckId: string;
    title: string;
    cardCount: number;
    action?: 'created' | 'appended';
    addedCount?: number;
    skippedCount?: number;
    sourceLanguage?: string;
    targetLanguage?: string;
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
export const fromDbAttachments = (raw: unknown): ChatAttachment[] | undefined => {
    if (!Array.isArray(raw) || raw.length === 0) {
        return undefined;
    }
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
                action?: unknown;
                addedCount?: unknown;
                skippedCount?: unknown;
                sourceLanguage?: unknown;
                targetLanguage?: unknown;
            };
            out.push({
                type: 'deck',
                deckId: o.deckId,
                title: o.title,
                cardCount: o.cardCount,
                ...(o.action === 'created' || o.action === 'appended' ? { action: o.action } : {}),
                ...(typeof o.addedCount === 'number' ? { addedCount: o.addedCount } : {}),
                ...(typeof o.skippedCount === 'number' ? { skippedCount: o.skippedCount } : {}),
                ...(typeof o.sourceLanguage === 'string'
                    ? { sourceLanguage: o.sourceLanguage }
                    : {}),
                ...(typeof o.targetLanguage === 'string'
                    ? { targetLanguage: o.targetLanguage }
                    : {}),
            });
        }
    }
    return out.length > 0 ? out : undefined;
};

// A 'streaming' row whose turn died with the process would otherwise keep the
// FE polling forever, so anything older than this reads as 'partial'. Mirrors
// STALE_STREAM_MS in chat.repository.ts, which reaps the row for real on the
// next send.
const STALE_STREAM_MS = 3 * 60 * 1000;

const publicStatus = (m: ChatMessageModel): PublicMessageStatus => {
    if (m.status === 'streaming' && Date.now() - m.createdAt.getTime() > STALE_STREAM_MS) {
        return 'partial';
    }
    return m.status as PublicMessageStatus;
};

export const toPublicMessage = (m: ChatMessageModel): PublicMessage => {
    const attachments = fromDbAttachments(m.attachments);
    return {
        id: m.id,
        conversationId: m.conversationId,
        role: m.role as PublicMessageRole,
        content: m.content,
        status: publicStatus(m),
        tokensInput: m.tokensInput,
        tokensOutput: m.tokensOutput,
        ...(attachments ? { attachments } : {}),
        createdAt: m.createdAt.toISOString(),
    };
};
