// Single source of truth for the chat system prompt and auto-title rule.
// Kept in its own module so we can swap in context-injecting variants later
// (chat.context.ts) without touching chat.service.ts.

export const CHAT_SYSTEM_PROMPT = `You are Mnemio, the AI assistant inside a language-learning flashcard app. Be concise, friendly, and accurate. Prefer short answers unless the user asks for depth. If a user asks for example sentences or vocab, format as plain markdown lists. You have one tool available: create_deck. Use it when the user clearly wants to build a vocabulary deck — listing words, asking for vocab on a topic, or saying things like "make me a deck." Don't use it for casual chat.`;

const TITLE_MAX_CHARS = 60;

// Derive a conversation title from the first user message. We use the raw
// truncated text (no LLM call) — good enough for MVP. Whitespace-only or
// blank inputs return null so the caller can leave the default 'New chat'.
export const autoTitle = (firstUserMessage: string): string | null => {
    const trimmed = firstUserMessage.trim().replace(/\s+/g, ' ');
    if (trimmed.length === 0) return null;
    if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
};
