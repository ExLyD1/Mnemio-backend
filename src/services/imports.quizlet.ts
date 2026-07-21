import type { AiCardDraft } from './ai.provider.js';

export type QuizletExtractResult = {
    setId: string;
    title: string;
    cards: AiCardDraft[];
};

const QUIZLET_URL_RE = /^https?:\/\/(?:www\.)?quizlet\.com\/(\d+)\b/i;

export const parseQuizletUrl = (url: string): { setId: string } | null => {
    const m = QUIZLET_URL_RE.exec(url.trim());
    if (!m || !m[1]) return null;
    return { setId: m[1] };
};

// Quizlet's set pages are Next.js — full set data is embedded in a
// <script id="__NEXT_DATA__"> JSON blob during SSR. We grab that, parse, and
// walk for the cards. The shape isn't stable; if Quizlet reshuffles it the
// extractor returns null and the route surfaces IMPORT_PARSE_FAILED so the
// FE can fall back to the paste-text flow.
const NEXT_DATA_RE =
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/i;

const extractNextData = (html: string): unknown | null => {
    const m = NEXT_DATA_RE.exec(html);
    if (!m || !m[1]) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
};

// Walk an arbitrary JSON value looking for the first array whose elements
// look like Quizlet term objects. We accept either
//   { word, definition }     (newer Next responses)
// or
//   { term, definition }     (older responses sometimes embed this)
// and ignore everything else. Stops at the first hit.
const findTermArray = (
    value: unknown,
    depth = 0,
): { word: string; definition: string }[] | null => {
    if (depth > 12 || value === null || value === undefined) return null;

    if (Array.isArray(value)) {
        if (value.length > 0 && value.every((it) => isTermLike(it))) {
            return value.map(toTerm);
        }
        for (const item of value) {
            const found = findTermArray(item, depth + 1);
            if (found) return found;
        }
        return null;
    }

    if (typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
            const found = findTermArray(v, depth + 1);
            if (found) return found;
        }
    }
    return null;
};

const isTermLike = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    const hasWord = typeof o.word === 'string' || typeof o.term === 'string';
    const hasDef = typeof o.definition === 'string';
    return hasWord && hasDef;
};

const toTerm = (v: unknown): { word: string; definition: string } => {
    const o = v as Record<string, unknown>;
    const word = (typeof o.word === 'string' ? o.word : (o.term as string)) ?? '';
    const definition = (o.definition as string) ?? '';
    return { word: word.trim(), definition: definition.trim() };
};

const findTitle = (root: unknown): string => {
    // Walk shallowly looking for a string title; default to a generic label.
    const seen: unknown[] = [root];
    let depth = 0;
    while (seen.length > 0 && depth < 8) {
        const next: unknown[] = [];
        for (const node of seen) {
            if (!node || typeof node !== 'object') continue;
            const o = node as Record<string, unknown>;
            if (typeof o.title === 'string' && o.title.trim().length > 0) {
                return o.title.trim();
            }
            for (const v of Object.values(o)) next.push(v);
        }
        seen.length = 0;
        seen.push(...next);
        depth++;
    }
    return 'Imported set';
};

export const extractFromQuizletHtml = (
    html: string,
    setId: string,
): QuizletExtractResult | null => {
    const data = extractNextData(html);
    if (data === null) return null;
    const terms = findTermArray(data);
    if (!terms || terms.length === 0) return null;
    const title = findTitle(data);
    const cards: AiCardDraft[] = terms
        .filter((t) => t.word.length > 0 && t.definition.length > 0)
        .map((t) => ({ word: t.word, definition: t.definition }));
    if (cards.length === 0) return null;
    return { setId, title, cards };
};
