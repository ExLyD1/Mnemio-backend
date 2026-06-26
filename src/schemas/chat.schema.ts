import { z } from 'zod';

export const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    // When present, the new conversation immediately persists this as the
    // first user message and the controller proceeds to stream a reply.
    firstMessage: z.string().trim().min(1).max(4000).optional(),
});

export const renameConversationSchema = z.object({
    title: z.string().trim().min(1).max(120),
});

export const sendMessageSchema = z.object({
    content: z.string().trim().min(1).max(4000),
    // The deck the user currently has open, if any. Unlocks the add_cards tool
    // so "add these words to this deck" appends instead of creating a new deck.
    deckId: z.string().uuid().optional(),
});

export const listConversationsQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type RenameConversationInput = z.infer<typeof renameConversationSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
