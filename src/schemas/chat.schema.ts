import { z } from 'zod';
import { normalizeLang } from '../shared/lang.js';

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
    // The UI/chat language (e.g. "uk", "en-US"), normalized to an ISO 639-1
    // code. Drives the reply language and the default deck language for
    // create_deck/add_cards when the user doesn't ask for a specific pair.
    locale: z
        .string()
        .trim()
        .min(2)
        .max(10)
        .transform((v) => normalizeLang(v))
        .optional(),
});

export const listConversationsQuerySchema = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type RenameConversationInput = z.infer<typeof renameConversationSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;
