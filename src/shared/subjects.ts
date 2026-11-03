// The fixed deck subject taxonomy (spec 002). Every deck's `subject` is one of
// these 12 slugs — never free text. The list lives in code (no Postgres enum)
// so it can change without a DB migration; Zod enforces it on every write and
// GET /public/taxonomy serves it to the FE. Labels are the FE's job
// (`subject.<slug>` in en/uk).
import { normalizeLang } from './lang.js';

// Display order.
export const SUBJECTS = [
    'languages',
    'medicine',
    'science',
    'math',
    'technology',
    'humanities',
    'social',
    'business',
    'law',
    'arts',
    'test-prep',
    'other',
] as const;

export type Subject = (typeof SUBJECTS)[number];

// Where a deck's subject came from. 'pending' = the migration found no exact
// or legacy-slug match; scripts/backfill-subjects.ts classifies those with AI.
export const SUBJECT_SOURCES = ['user', 'rules', 'ai', 'pending'] as const;
export type SubjectSource = (typeof SUBJECT_SOURCES)[number];

// A deck is "being learned" once the user has studied this many distinct cards
// of it (or all of them, for a smaller deck). Drives GET /library's Learning.
export const LEARNING_THRESHOLD = 5;

const SUBJECT_SET: ReadonlySet<string> = new Set(SUBJECTS);

export const isSubject = (v: unknown): v is Subject => typeof v === 'string' && SUBJECT_SET.has(v);

// The pre-002 FE category slugs (app/utils/deckCategories.ts) → the 12. Also
// drives the FE's 301s from legacy /discover/<slug> URLs, so every old slug
// must be here. Keep in sync with the migration's subject_map.
export const LEGACY_SUBJECT_MAP: Readonly<Record<string, Subject>> = {
    vocabulary: 'languages',
    nursing: 'medicine',
    anatomy: 'medicine',
    pharmacology: 'medicine',
    biology: 'science',
    chemistry: 'science',
    physics: 'science',
    'computer-science': 'technology',
    programming: 'technology',
    engineering: 'technology',
    tech: 'technology',
    history: 'humanities',
    geography: 'humanities',
    philosophy: 'humanities',
    literature: 'humanities',
    religion: 'humanities',
    psychology: 'social',
    'social-science': 'social',
    finance: 'business',
    art: 'arts',
    music: 'arts',
    culinary: 'other',
    sports: 'other',
    trivia: 'other',
};

const has = (s: string, keys: string[]): boolean => keys.some((k) => s.includes(k));

// Keyword rules — a 1:1 port of the FE's normCategory() heuristics (same
// order, same substrings), each target mapped onto the 12. First match wins.
// They over-match ("Cardiology terms" → languages via 'term'), so they are
// only a fallback when the AI gives nothing valid; the migration never uses
// them.
const KEYWORD_RULES: readonly [Subject, (s: string) => boolean][] = [
    [
        'languages',
        (s) =>
            has(s, [
                'lang',
                'мова',
                'english',
                'ukrainian',
                'spanish',
                'french',
                'german',
                'italian',
                'japanese',
                'chinese',
                'korean',
                'portuguese',
            ]),
    ],
    ['languages', (s) => has(s, ['vocab', 'word', 'term'])],
    ['medicine', (s) => has(s, ['medic', 'health', 'clinic'])],
    ['medicine', (s) => has(s, ['nurs'])],
    ['medicine', (s) => has(s, ['anatom', 'physiol'])],
    ['medicine', (s) => has(s, ['pharma', 'drug'])],
    ['science', (s) => has(s, ['bio'])],
    ['science', (s) => has(s, ['chem'])],
    ['science', (s) => has(s, ['physic'])],
    ['math', (s) => has(s, ['math', 'calcul', 'algebra'])],
    ['technology', (s) => has(s, ['computer', 'cs ']) || s === 'cs'],
    ['technology', (s) => has(s, ['program', 'code', 'coding', 'software', 'developer'])],
    ['technology', (s) => has(s, ['engineer'])],
    ['humanities', (s) => has(s, ['histor'])],
    ['humanities', (s) => has(s, ['geograph', 'country', 'capital'])],
    ['law', (s) => has(s, ['law', 'legal', 'juris'])],
    ['business', (s) => has(s, ['business', 'econom', 'market'])],
    ['business', (s) => has(s, ['financ', 'account', 'invest'])],
    ['social', (s) => has(s, ['psych'])],
    ['humanities', (s) => has(s, ['philos'])],
    ['humanities', (s) => has(s, ['liter', 'book', 'grammar'])],
    ['arts', (s) => has(s, ['art', 'design', 'draw'])],
    ['arts', (s) => has(s, ['music', 'piano', 'guitar'])],
    ['social', (s) => has(s, ['social', 'sociol', 'anthrop'])],
    ['test-prep', (s) => has(s, ['test', 'exam', 'prep', 'sat', 'gre'])],
    ['humanities', (s) => has(s, ['religio', 'theol', 'bible', 'quran'])],
    ['other', (s) => has(s, ['culin', 'cook', 'food', 'recipe'])],
    ['other', (s) => has(s, ['sport', 'fitness', 'gym'])],
    ['other', (s) => has(s, ['trivia', 'general', 'quiz'])],
];

// Exact matches only: one of the 12 slugs or a pre-002 FE slug, ignoring case
// and surrounding whitespace. Null otherwise — free text is never guessed here.
// The migration's subject_map is the SQL twin of this.
export const normalizeSubject = (raw: string | null | undefined): Subject | null => {
    const s = raw?.trim().toLowerCase();
    if (!s) {
        return null;
    }
    if (isSubject(s)) {
        return s;
    }
    return LEGACY_SUBJECT_MAP[s] ?? null;
};

// The keyword heuristics over free text (a title, an off-list model answer),
// or null when nothing matches. Fallback only — see KEYWORD_RULES.
export const matchSubjectKeywords = (text: string | null | undefined): Subject | null => {
    const s = text?.trim().toLowerCase();
    if (!s) {
        return null;
    }
    for (const [subject, matches] of KEYWORD_RULES) {
        if (matches(s)) {
            return subject;
        }
    }
    // A bare language name ("German", "日本語") is a language deck. Names only:
    // 2–3 letter inputs like "it" are more likely abbreviations than codes.
    if (!/^[a-z]{2,3}$/.test(s) && normalizeLang(s)) {
        return 'languages';
    }
    return null;
};

// Rule fallback when nothing better is known: a deck whose words and
// definitions are in different languages is a vocabulary deck.
export const inferSubject = (sourceLanguage: string, targetLanguage: string): Subject =>
    sourceLanguage !== targetLanguage ? 'languages' : 'other';

// For a model's subject answer: exact/legacy, then the keyword fallback, then
// the language heuristic — always yields a valid slug.
export const resolveSubject = (
    raw: string | null | undefined,
    sourceLanguage: string,
    targetLanguage: string,
): Subject =>
    normalizeSubject(raw) ??
    matchSubjectKeywords(raw) ??
    inferSubject(sourceLanguage, targetLanguage);
