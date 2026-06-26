// Single source of truth for the chat system prompt and auto-title rule.

// In-context deck the user currently has open. When present, the assistant is
// allowed to append cards to it via the add_cards tool.
export type ChatDeckContext = {
    deckId: string;
    title: string;
    sourceLanguage: string;
    targetLanguage: string;
};

const BASE_PROMPT = `You are Mnemio, the AI assistant inside a language-learning flashcard app. Be concise, friendly, and accurate. Prefer short answers unless the user asks for depth. If a user asks for example sentences or vocab, format as plain markdown lists.

Tools:
- create_deck — build a NEW vocabulary deck. Use when the user lists words, asks for vocab on a topic, or says things like "make me a deck." Don't use it for casual chat.
- add_cards — add cards to the deck the user is CURRENTLY VIEWING (only available when a deck is open). Use it when they say things like "add these words", "add a few more", or "add X to this deck" — do NOT create a new deck in that case.

Critical: NEVER state or imply that a deck was created or that cards were added/changed unless you actually called a tool and it returned a successful result. Any text you write before calling a tool must be a brief, neutral acknowledgement (e.g. "On it…") — never a completion claim. The user-facing confirmation comes only after the tool succeeds.`;

// Builds the chat system prompt, optionally injecting the open deck so the model
// knows it can append to it. Replaces the old static CHAT_SYSTEM_PROMPT.
export const buildChatSystemPrompt = (deck?: ChatDeckContext): string => {
    if (!deck) return BASE_PROMPT;
    return `${BASE_PROMPT}

The user is currently viewing the deck "${deck.title}" (${deck.sourceLanguage} → ${deck.targetLanguage}). When they ask to add words or cards to "this deck", "my deck", or the deck they're looking at, call add_cards (NOT create_deck). The cards will be appended to that deck.`;
};

// Kept for callers/tests that want the plain, no-deck-context prompt.
export const CHAT_SYSTEM_PROMPT = buildChatSystemPrompt();

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
