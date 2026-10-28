# 002 — Fixed categories + learning library

> Status: **Backend implemented (tasks 1–9); frontend pending** · Date: 2026-10-28
>
> **Rev 2 (approval changes):**
> (1) chat `create_deck` takes `subject` + `targetLanguage` as enum-constrained
> tool input, so Mimi picks them in the same call, with no extra AI call. Falls
> back to rules only on an invalid or missing value.
> (2) Explicit SEO rule: every legacy `/discover/<old-subject>` URL returns 301
> to the new slug, and the sitemap is generated from the 12 new slugs only.
> (3) Ops starts with a production DB backup. The backfill script's dry-run
> prints every proposed change without writing and is run first.
> Repos: `mnemio-backend` (API, migration, scripts) + `mnemio-frontend` (UI)
>
> Two linked changes:
> **A. Categories.** Every deck gets one of **12 fixed subjects**. A language
> deck's language is its `targetLanguage`, taken from **one fixed list of 28
> codes**. Both are enforced on every write path, existing rows are backfilled,
> and labels are localized in en and uk. Ukrainian displays as **"UA"**
> everywhere a code is shown; the internal code stays `uk`.
> **B. Library.** `/decks` lists every deck the user is learning: their own
> decks plus anyone else's they have studied ≥ 5 cards of. It is sorted by most
> recently studied, with My / Learning / All tabs and subject + language
> filters.

## Goal

1. A deck's subject is always one of 12 slugs, never free text, on every path:
   create, edit, AI generate, deck-from-image, chat `create_deck`, Anki import,
   Discover copy. Discover and the library filter on exactly those 12, shown
   with localized labels.
2. Language decks are faceted by `targetLanguage` from one backend-served list
   of 28 codes. The FE form, Discover and the library all use that list with
   localized names.
3. All existing decks are cleaned up with deterministic rules first, then a
   one-off AI pass for whatever the rules couldn't place.
4. The library shows **what I'm learning**, not only **what I authored**. A
   public deck by someone else that I've studied 5+ cards of (in any mode) sits
   next to my own decks. Server-side filters and pagination give correct counts
   beyond the first page.
5. Ukrainian reads "UA" wherever a language or locale code is displayed.

## Non-goals

- **No SRS, XP, streak, DailyActivity, achievement or `/stats/*` change.**
  Library tracking is a side-effect write that never changes what those systems
  compute.
- Library text search (out of scope; the Topbar quick search stays client-side).
- "Remove from library" / hiding someone else's deck. A deck leaves Learning
  only if it becomes private or is deleted.
- Changing the internal locale code (`uk` stays `uk` in cookies, i18n, the DB
  and the API).
- Sub-categories beyond Languages → language. There is no per-subject
  taxonomy tree.
- Premium gating. The library, filters and auto-classification are free on
  every plan.
- Changing `GET /decks`. It stays "my decks" for its other consumers (Topbar
  and dashboard move off it; see FE changes).
- Re-classifying decks after the backfill. Users fix subjects in edit.
- Quizlet / paste-text imports. They don't persist (`/imports/quizlet|text`
  return a preview); the deck is saved through `POST /decks` with the create
  page's picker.

## Current state

- `Deck.subject String?` is free text, validated as 1–40 chars
  (`prisma/deck.prisma:14`, `src/schemas/deck.schema.ts:9`). The local DB holds
  `languages`, `Language`, `finance`, `test-prep` and nulls. Prod is messier.
- The only fixed list lives on the FE: 30 slugs plus the `normCategory()`
  keyword heuristic (`mnemio-frontend/app/utils/deckCategories.ts`), applied
  on the client at edit/AI time only.
- AI prompts ask for a free-text subject (`ai.prompts.ts:152,237`; tool schema
  `ai.provider.anthropic.ts:89`). Anki import (`imports.repository.ts:19`) and
  chat `create_deck` (`chat-tools.repository.ts:30`) store no subject.
- Discover categories = `DISTINCT subject` top 50, shown raw in English
  (`discover.repository.ts:91`, `pages/discover/index.vue:54`). `/discover/[subject]`
  slugifies raw values. The `lang` filter matches source OR target. Discover
  language chips are 7 hardcoded English names (`useDiscover.ts:25`).
- The backend accepts 28 language codes (`src/shared/lang.ts`). The FE form
  offers 12 (`app/schemas/deck.ts:3`). Codes are displayed `toUpperCase()`, so
  Ukrainian reads "UK" (`decks/[id]/index.vue:41`, `ai.vue:558`,
  `ai/DeckCard.vue:51`, `studyCard.ts:33,42`).
- The library (`pages/decks/index.vue`) = `GET /decks`: own decks by
  `updatedAt`. Filters run **client-side over loaded pages**, so counts are
  wrong past page 1. "Mine" actually means favorites.
- Users already study others' public decks: sessions and `/srs/rate` allow
  `isPublic`, and `CardProgress` is per user. Nothing records "user X is
  learning deck Y". Browse mode (SRS off) leaves no per-card trace.

## User stories + acceptance criteria

### Categories

**C1 — Pick from a fixed list.** As a creator, I pick a subject from 12
localized options when creating or editing a deck.
- The create page, the edit form, the Anki import dialog and the AI import
  dialog (create mode) show the same 12 options, labelled in the UI language.
- The create page pre-selects a suggestion: `languages` if source ≠ target,
  else `other`. The suggestion follows language changes until the user picks
  manually.
- Import dialogs default to **"Auto-detect"**. If the user leaves it there, the
  server classifies with AI. If AI fails, a rule-based guess is used. The user
  never sees an error from classification.
- Any `subject` outside the 12 → `400 VALIDATION_ERROR`. `subject: null` on
  PATCH → 400. Omitted on create → server rule fallback.

**C2 — AI decks are categorized.** Generate-deck, deck-from-image and chat
`create_deck` always produce one of the 12. Model output outside the list is
normalized server-side and never persisted raw. For chat, `subject` and
`targetLanguage` are part of the `create_deck` tool input, constrained by
`enum` to the fixed lists, so Mimi picks them in the same call. There is **no
separate classification call**. If the model's value is missing or invalid,
the rules mapping (`normalizeSubject` → `inferSubject`) decides.

**C3 — Language facet.** A deck with `subject = languages` is filterable by its
`targetLanguage`. Every language picker offers the same 28 codes with localized
names (en + uk).

**C4 — Discover uses the fixed list.** Category tiles = the 12 subjects with
localized labels and counts. Zero-count tiles are hidden. `/discover/<slug>`
uses the new slugs. **Every** legacy URL `/discover/<old-subject>` (all 30
old FE slugs plus `tech`, case-insensitive) returns an HTTP **301** to
`/discover/<new-slug>`, server-side during SSR, so crawlers get a real 301 and
not a client redirect. An unknown slug shows the existing "no match" state.
**The sitemap lists the 12 new subject URLs only**, never a legacy slug. Choosing Languages shows language chips (only languages with ≥ 1 public
deck) that filter by `targetLanguage`. The same applies to the public SEO pages
(`/public/discover/*`).

**C5 — Existing decks cleaned.** After deploy and the backfill script, every
deck has `subject ∈ 12` and `subjectSource ≠ 'pending'`. Every deck's
`targetLanguage` and `sourceLanguage` is in the 28 (or the script's report
lists it, with reasons).

**C6 — "UA".** Wherever a language or locale code is shown in caps (locale
switcher, "UA → EN" on deck detail, AI deck card, study card region), Ukrainian
reads `UA`. `uk` is unchanged in URLs, cookies, API payloads and the DB.

### Library

**L1 — Learning includes others' decks.** Studying 5 distinct cards of someone
else's public deck (any mode: SRS rate, flashcard flip / browse, multiple
choice, review run) puts it in my library under Learning and All.
- Threshold = `LEAST(5, cardCount)`, so a fully studied 3-card deck qualifies.
- Re-studying the same card doesn't count twice.
- Abandoned sessions count the cards actually reached (`cardIds[0..cardIndex)`).

**L2 — Tabs.** **All** (default) = My ∪ Learning. **My** = every deck I
authored, studied or not. **Learning** = decks (mine or others') I've studied
≥ threshold. Each tab shows its count.

**L3 — Sort.** Most recently studied first. Sort key =
`COALESCE(lastStudiedAt, deck.createdAt)`, so a brand-new own deck appears at
the top. Ties are broken by deck id.

**L4 — Filters.** Subject chips (12, localized, counts within the current tab;
zero-count hidden). Picking Languages reveals language chips (counts within
tab + languages). Filters and counts are server-side and correct past page 1.

**L5 — Others' cards.** A card for someone else's deck shows "by @username"
(falling back to full name, then "someone"), Practice and the favorite heart.
There is no Add cards / edit. Clicking opens `/decks/:id` in viewer mode.

**L6 — Disappearing decks.** If another user's deck goes private or is
deleted, it disappears from my library on next load. My progress rows are kept
(cascade on delete), so if the deck becomes public again it reappears.

**L7 — Other screens.**
- Dashboard "Up next" / "mostly from" / resume title draw from the library
  (own + learning).
- Topbar quick search matches library decks.
- The Rail **drops its Library deck rows**; only the Library link remains.

**L8 — States.** Skeleton grid while loading. Empty states:
- All/My when the user has no decks → existing "create your first deck" CTA.
- Learning empty → "Study 5 cards of any deck to see it here" + "Browse
  Discover" CTA.
- Filter with no results → "Nothing here" + "Clear filters".

A fetch error shows an inline error with Retry; previously loaded items stay.

## Data model + migration

### Schema

```prisma
// deck.prisma
model Deck {
  …
  subject        String   @default("other")   // one of SUBJECTS (src/shared/subjects.ts)
  // Where `subject` came from: 'user' | 'rules' | 'ai' | 'pending'.
  // 'pending' = backfill couldn't place it; scripts/backfill-subjects.ts picks it up.
  subjectSource  String   @default("user")
  …
  learners       UserDeck[]
  @@index([isPublic, subject, targetLanguage])   // Discover + library language facet
}

// user-deck.prisma (new)
// "User U is learning deck D": the distinct cards U has studied in D, in any
// mode. Written as a side-effect of /srs/rate and session progress; read only
// by GET /library. Never feeds XP, streaks, DailyActivity or stats.
model UserDeck {
  userId          String
  deckId          String
  studiedCardIds  String[] @default([])   // distinct; ≤ deck size (≤ 1000)
  studiedCount    Int      @default(0)    // = cardinality(studiedCardIds)
  lastStudiedAt   DateTime @default(now())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  deck Deck @relation(fields: [deckId], references: [id], onDelete: Cascade)

  @@id([userId, deckId])
  @@index([userId, lastStudiedAt])
  @@map("user_decks")
}
```

There is no Postgres enum or CHECK on `subject`; the list lives in code
(`SUBJECTS`) so it can change without a DB migration. Zod enforces it on every
write.

### Migration `20261029000000_fixed_subjects_and_user_decks` (SQL, idempotent)

1. Add `subjectSource TEXT NOT NULL DEFAULT 'user'`.
2. Temp table `subject_map(raw, slug)`: the 12 new slugs map to themselves, and
   the 30 old FE slugs map through the 12-way table below. Also add `tech` →
   `technology` and `vocabulary` → `languages`.
3. `UPDATE decks SET subject = m.slug, subjectSource = 'rules'` where
   `lower(trim(subject))` matches the map exactly.
4. Keyword pass for remaining non-null values: an SQL `CASE` port of
   `normCategory()`'s keyword rules (each rule's target mapped to the 12).
   Matched rows get `subjectSource = 'rules'`.
5. Everything left over, including `NULL`, gets `subject = 'other'` and
   `subjectSource = 'pending'`.
6. `ALTER COLUMN subject SET NOT NULL, SET DEFAULT 'other'`.
7. Create `user_decks` and its index.
8. **Backfill `user_decks`** from the union of:
   - `card_progresses` joined to `cards`: per (userId, deckId), the distinct
     cardIds, with `lastStudiedAt = max(lastReviewedAt, updatedAt)`.
   - `study_sessions`: completed → all `cardIds`; active/exited → the first
     `cardIndex` cardIds. `lastStudiedAt = max(coalesce(endedAt, updatedAt))`.

   Card ids are intersected with existing cards. `studiedCount` =
   `cardinality`.
9. Index `decks(isPublic, subject, targetLanguage)`.

Old → new mapping (`src/shared/subjects.ts`, `LEGACY_SUBJECT_MAP`):

| New slug     | Old slugs                                              |
| ------------ | ------------------------------------------------------ |
| `languages`  | languages, vocabulary                                  |
| `medicine`   | medicine, nursing, anatomy, pharmacology               |
| `science`    | biology, chemistry, physics                            |
| `math`       | math                                                   |
| `technology` | computer-science, programming, engineering, tech       |
| `humanities` | history, geography, philosophy, literature, religion   |
| `social`     | psychology, social-science                             |
| `business`   | business, finance                                      |
| `law`        | law                                                    |
| `arts`       | art, music                                             |
| `test-prep`  | test-prep                                              |
| `other`      | culinary, sports, trivia, anything unresolved          |

### One-off script `scripts/backfill-subjects.ts` (run after deploy)

- Selects `subjectSource = 'pending'` in batches of 50. For each deck it sends
  title, description, source/target language and the first 10 card words to
  `subjectsService.classify()` (the cheapest Claude model, `claude-haiku-5-5`,
  with a strict enum tool schema). It writes `subject` and
  `subjectSource = 'ai'`. On any AI failure it uses the rule fallback with
  `subjectSource = 'rules'`.
- Second pass: decks whose `sourceLanguage`/`targetLanguage` is **not** in the
  28 (left untouched by `20260924…normalize_language_codes`). It asks the model
  to detect the language from the card words and the definitions. A confident
  answer inside the 28 is written. Anything else is listed in the report, not
  guessed.
- Flags: `--dry-run`, `--limit N`. **Dry-run is a hard no-write mode.** It
  makes the AI calls and prints every proposed change (deck id, title, old →
  new subject or language, source `ai|rules`) plus totals and token usage. It
  never issues an UPDATE. The ops step requires running dry-run first.
  Idempotent: re-running touches only `pending` rows and still-invalid
  languages.
- Logs each call to the AI usage log with `feature: 'classify'`. It is not
  charged to any user's budget.

## API contract diff (`docs/api-contract.md`)

### 1. Domain types

```ts
type Subject =
  | 'languages' | 'medicine' | 'science' | 'math' | 'technology' | 'humanities'
  | 'social' | 'business' | 'law' | 'arts' | 'test-prep' | 'other';

type Deck = {
  …
  subject: Subject;                 // was: string | null — now always set
  …
};

type LibraryDeck = DeckWithAuthor & {
  isOwner: boolean;
  studiedCount: number;             // distinct cards the requester studied
  lastStudiedAt: string | null;     // ISO; null = never studied (own decks only)
  // deck.stats = the REQUESTER's progress (as GET /decks/:id)
};
```

### 2. `POST /decks`, `PATCH /decks/:id` — **changed**

- `subject?: Subject`. It was `string | null` (1–40 chars). Any other value →
  `400 VALIDATION_ERROR`. On PATCH, `null` → 400.
- Omitted on create: `languages` if `sourceLanguage ≠ targetLanguage`, else
  `other` (`subjectSource = 'rules'`). An explicit value → `subjectSource = 'user'`.
- `sourceLanguage` / `targetLanguage` are unchanged: they accept the 28 codes
  (and aliases), normalized to ISO 639-1.

### 3. `GET /public/taxonomy` — **new** *(public, cacheable 1 h)*

```ts
// 200
{
  subjects: Subject[];                        // display order
  languages: string[];                        // the 28 ISO 639-1 codes
  legacySubjects: Record<string, Subject>;    // old slug → new, for 301s
}
```
This is the single source of the lists. The FE owns the labels
(`subject.<slug>`, `lang.<code>` in en and uk).

### 4. `GET /library` — **new** *(auth)*

```ts
// Query
?scope?='all' | 'my' | 'learning'     // default 'all'
&subject?=Subject
&lang?=string                         // ISO 639-1; matches targetLanguage
&cursor?=string&limit?=number(<=50)   // default 24

// 200: PageWithTotal<LibraryDeck> & { facets?: LibraryFacets }
type LibraryFacets = {                // only on the first page (no cursor)
  scopes: { all: number; my: number; learning: number };   // ignore subject/lang
  subjects: { subject: Subject; count: number }[];         // within scope, ignore subject/lang
  languages: { lang: string; count: number }[];            // within scope + subject='languages'
};
// Errors: 400 VALIDATION_ERROR (bad scope/subject/lang/cursor)
```

Membership:
- **my**: `authorId = me`.
- **learning**: a UserDeck row exists with
  `studiedCount >= LEAST(5, cardCount)`, `cardCount > 0`, and
  (`authorId = me` OR `isPublic`).
- **all**: my ∪ learning.

Sort: `COALESCE(ud.lastStudiedAt, d.createdAt) DESC, d.id DESC`, with a keyset
cursor on `{ ts, id }` (same opaque encoding as `GET /decks`).

### 5. `GET /discover/decks`, `GET /public/discover/decks` — **changed**

- `subject?: Subject`. Unknown → 400 (it was a free string).
- `lang` now matches **`targetLanguage` only**. It used to match
  source OR target. The only FE caller is updated in the same release.

### 6. `GET /discover/categories`, `GET /public/discover/categories` — **changed (additive shape)**

```ts
// 200
{
  items: { subject: Subject; count: number }[];   // all 12, incl. zero counts, taxonomy order
  languages: { lang: string; count: number }[];   // public decks with subject='languages', count > 0
}
```

### 7. `POST /imports/apkg` — **changed (additive)**

The multipart field `subject?: Subject` is new. If it is present, every
created deck gets it with `subjectSource = 'user'`. If it is absent, each
created deck is classified with AI (title + first 10 cards, system cost, ≤ 4 s
timeout). On failure the rule fallback is used. Invalid → 400.

### 8. `POST /ai/classify-subject` — **new** *(auth)*

Used by the AI-import dialog when the picker is left on Auto-detect. It is not
budgeted and does not reserve `AiUsage`, so it never triggers the premium gate.
Rate limit: 30/min per user.

```ts
// Request
{ title: string; description?: string; sourceLanguage: string; targetLanguage: string; words: string[] /* ≤ 20 */ }
// 200 — never fails on AI errors; falls back to rules
{ subject: Subject; source: 'ai' | 'rules' }
// Errors: 400 VALIDATION_ERROR, 429 RATE_LIMITED
```

### 9. AI generate / deck-from-image / chat `create_deck`

- Response field `subject` is now always a `Subject`. The tool and JSON schemas
  constrain it with `enum`. The server runs `normalizeSubject()` on model
  output, with the rule fallback on a miss.
- Chat `create_deck` gains `subject` (enum = the 12) and `targetLanguage` (enum =
  the 28) as tool input, so the model picks both in the same call. There is no
  separate classification call. If either value is missing or invalid:
  `subject` → `normalizeSubject()`, then `inferSubject(src, tgt)`.
  `targetLanguage` → the existing `wordsLanguage` / profile fallback.
  `wordsLanguage` stays accepted as an alias for older prompts.

### 10. Invariants section

Add: *"`deck.subject` is always one of the 12 `Subject` slugs; language decks
facet on `targetLanguage`; the lists come from `GET /public/taxonomy`."* Also
bump the endpoint inventory (+3: `/library`, `/public/taxonomy`,
`/ai/classify-subject`).

## Backend changes

| Layer | File | Change |
|---|---|---|
| shared | `src/shared/subjects.ts` (new) | `SUBJECTS`, `LEGACY_SUBJECT_MAP`, `normalizeSubject(raw) → Subject \| null` (exact/legacy/keyword), `inferSubject(src, tgt)` rule fallback, `LEARNING_THRESHOLD = 5` |
| shared | `src/shared/lang.ts` | export `SUPPORTED_LANG_LIST` (ordered array) for taxonomy |
| schema | `deck.schema.ts`, `discover.schema.ts`, `imports.schema.ts` | `subjectSchema = z.enum(SUBJECTS)`; PATCH non-nullable; discover `lang` via `langSchema` |
| schema | `library.schema.ts` (new), `ai.schema.ts` | library query; classify body |
| repo | `user-decks.repository.ts` (new) | `recordStudied(userId, deckId, cardIds[])` single upsert with distinct-union SQL; `recordStudiedByCards(userId, cardIds[])` (resolves deckIds) |
| repo | `library.repository.ts` (new) | `$queryRaw` page + count + facets (one CTE for membership) |
| repo | `discover.repository.ts` | categories over fixed list + language counts; `lang` → `targetLanguage` |
| repo | `decks.repository.ts`, `imports.repository.ts`, `chat-tools.repository.ts`, `discover.service.ts` copy | write `subject` + `subjectSource` |
| service | `subjects.service.ts` (new) | `classify({title, description, langs, words})` → AI with enum tool + 4 s timeout → fallback `inferSubject`; logs usage `feature:'classify'`; emits `deck_subject_classified` |
| service | `srs.service.ts` `rate` | after successful rate: `userDecks.recordStudied(userId, card.deckId, [cardId]).catch(log)` |
| service | `sessions.service.ts` `updateProgress` / `complete` | record `cardIds.slice(0, cardIndex)` / all `cardIds`, `.catch(log)`; **no change** to XP or activity lines |
| service | `library.service.ts` (new) | cursor decode, stats via `deckStatsRepo.aggregateDeckStats(requester, ids)`, map to `LibraryDeck` |
| service | `ai.prompts.ts`, `ai.provider.anthropic.ts`, `ai.provider.mock.ts`, `chat.tools.ts` | subject enum in prompts and tool schemas; normalize output |
| controller/routes | `library.*`, `public.*` (taxonomy), `ai.*` (classify), `imports.*` | wire up; taxonomy sets `Cache-Control: public, max-age=3600` |
| mapper | `mappers.deck.ts` | `subject: Subject`; new `toLibraryDeck` |
| analytics | `src/analytics/events.ts` | `deck_subject_classified { source: 'import'\|'classify_endpoint'\|'backfill', result: 'ai'\|'rules', ms }` (chat doesn't emit it; it makes no classifier call) |
| script | `scripts/backfill-subjects.ts` (new) | see migration section |

`UserDeck` writes are best-effort and outside the XP / activity code paths. A
failure is logged and swallowed, the same as `activityRepo.recordReview` in
`sessions.service.complete`.

## FE changes (page → composable → store → app/api → http.ts)

### Shared plumbing

- `app/api/taxonomy.ts` → `getTaxonomy()` via **`publicHttp`**, because the
  SSR Discover pages need it. `app/composables/useTaxonomy.ts` caches it in
  `useState('taxonomy')`, fetched once via `useAsyncData`.
- `app/utils/deckCategories.ts` → rewritten as **`app/utils/subjects.ts`**:
  `Subject` type, `subjectLabel(t, slug)`, `langLabel(t, code)`,
  `displayLangCode(code)` (`'uk' → 'UA'`, else upper-case). Delete
  `normCategory` and the 30-slug list. The server owns normalization now.
- `app/schemas/deck.ts`: drop the hardcoded 12 `LANGUAGES`. Validate against
  the taxonomy (`z.enum` built at runtime) and `subject: z.enum(SUBJECTS)`.
- `UiCategorySelect` stays as the picker. Options come from the taxonomy plus
  i18n. An optional `allowAuto` prop adds an "Auto-detect" first option
  (value `''`).
- i18n (`en.json` + `uk.json`): `subject.<12>`, `lang.<28>`,
  `library.{tabAll,tabMy,tabLearning,byAuthor,emptyLearningTitle,emptyLearningMsg,
  browseDiscover,emptyFiltered,clearFilters,loadError}`, `deck.subjectAuto`.
  Remove `deck.category.*` and `deck.filterMine`.
- "UA": replace every `.toUpperCase()` of a language code with
  `displayLangCode()` in `decks/[id]/index.vue:41,531`, `ai.vue:558`,
  `ai/DeckCard.vue:51` and `studyCard.ts:33,42`. `deckVm.ts` tag →
  `langLabel(t, code)` (localized). The `LanguageSwitcher` segmented variant
  stays on full names; the menu variant already shows `UA`.

### Library — `pages/decks/index.vue`

- **page**: header "Library · {total}". `SharedFilterChips` tabs
  All/My/Learning with counts from `facets.scopes`. A subject chip row comes
  from `facets.subjects` (count > 0). When `subject = languages`, a language
  chip row comes from `facets.languages`. Grid of `SharedDeckCard
  variant="library"`. Load more, skeleton, empty and error states as in L8.
  Filter state lives in the URL query (`?scope=&subject=&lang=`) so back/refresh
  keeps it.
- **composable** `useLibrary()` → wraps store actions with `useAsync`.
- **store** `app/stores/library.ts` (new, setup store): `items`, `nextCursor`,
  `total`, `facets`, `filters`, `fetch({reset})`, `loadMore()`,
  `invalidate()`. `invalidate()` is called by the decks store on
  create/update/delete/copy and by session complete.
- **api** `app/api/library.ts` → `listLibrary(params)` over `http`. It adapts
  `LibraryDeck` → `DeckSummary & { isOwner, author, lastStudiedAt }`, with
  `normLang` on the languages.
- `SharedDeckCard`: when `!isOwner`, show "by @author" and hide Add cards.
  Practice and the heart stay.
- `deckToCardVm` gets `author` / `isOwner` passthrough.

### Category pickers

- `pages/decks/create.vue`: options from the taxonomy. The default is the
  inferred suggestion (C1) until the user touches the picker. Languages come
  from the taxonomy (28).
- `components/deck/Form.vue` and `pages/decks/[id]/edit.vue`: the same lists.
  Stop running `normCategory` on the stored value; the server value is already
  valid.
- `components/deck/AnkiImportDialog.vue` → `stores/imports.ts` → `api/imports.ts`
  `importApkg(…, subject?)`. Picker with `allowAuto`.
- `components/ai/ImportDialog.vue` (create mode) → `useAiImport`. If the picker
  is on Auto, call `api/ai.ts classifySubject()` with the title and the
  enriched words before `create`. Otherwise send the picked slug.
- `useImageDeck.ts:219`, `create.vue:676`: drop `normCategory`; use
  `h.subject` as-is (server-validated).

### Discover

- `pages/discover/index.vue`: category tiles from `categories.items`
  (count > 0) with `subjectLabel`, linking to `/discover/<slug>`. Language
  chips → `categories.languages` with `langLabel`, shown only when the
  Languages tile or chip is active.
- `useDiscover.ts`: delete the hardcoded 7-language `filters`.
- `pages/discover/[subject].vue`: validate the slug against
  `taxonomy.subjects`. If it is a key of `taxonomy.legacySubjects`,
  `navigateTo('/discover/<new>', { redirectCode: 301 })` (works during SSR).
  Labels are localized. The SEO title/description use the localized label.
- **SEO rule:** every legacy `/discover/<old-subject>` returns **301** to its
  new slug, issued server-side during SSR (`navigateTo(..., { redirectCode: 301 })`
  in the SSR pass, or a Nitro `routeRules` / server middleware entry generated
  from `legacySubjects`). The sitemap is generated **from the 12 new slugs
  only**: `taxonomy.subjects`, never from DB values or legacy keys.

### Dashboard / Topbar / Rail

- `pages/dashboard.vue`: `topDueDeck`, `upNextDecks` and `resumeDeckTitle` read
  from `useLibraryStore()`, first page with `scope=all, limit=50`.
- `components/app/Topbar.vue`: suggestions over `useLibraryStore().items`.
- `components/app/Rail.vue`: remove `libraryDecks` and its rows. Keep the
  Library nav link. Update the `AppRail` note in FE `CLAUDE.md`.

### Analytics (`app/analytics/events.ts`)

- `library_filter_changed { scope, subject: Subject | null, lang: string | null }`.
- Add `subject` to the existing deck-created / deck-imported events.

## Edge cases

- **Deck < 5 cards**: the threshold is `LEAST(5, cardCount)`. An empty deck
  (`cardCount = 0`) is never in Learning (it is still in My if owned).
- **Cards deleted after being studied**: `studiedCardIds` may hold stale ids,
  so `studiedCount` doesn't drop. "Studied once" stays studied, which is
  accepted. The backfill intersects with existing cards.
- **Own deck studied < threshold**: in My and All, sorted by its
  `lastStudiedAt`. Not in Learning.
- **Other's deck goes private**: excluded by the membership predicate. The
  UserDeck row is kept, so it reappears if made public again.
- **Copy of a deck I'm learning**: the copy is a new deck with no UserDeck row.
  The source stays in Learning. There is no progress transfer (matches today's
  SRS).
- **Same deck studied on two devices concurrently**: the upsert is a single SQL
  statement with a distinct union, so it is safe under concurrency.
- **Review runs (`decks=all`)**: each per-deck completed session records its
  `cardIds`. Each live `/srs/rate` also records, so the run's decks are covered
  even if the flush fails.
- **Session PATCH frequency**: `recordStudied` runs on every PATCH carrying
  `cardIndex` (about one write per answer). The upsert is a single-row PK
  write, which is acceptable. No extra FE requests.
- **Subject `languages` with source = target** (monolingual vocab) is allowed.
  The facet still uses `targetLanguage`.
- **Non-language deck**: still has source/target (required today). Its
  language facet is simply not shown unless `subject = languages`.
- **AI returns a subject outside the enum**: `normalizeSubject`, then
  `inferSubject`. A raw value is never persisted.
- **Classification timeout during Anki import of N decks**: classification
  runs in parallel (concurrency 4), each with a 4 s timeout and rule fallback.
  Import latency grows by at most about 4 s.
- **Legacy Discover URL with odd casing** (`/discover/Biology`): lower-cased
  before the legacy lookup.
- **Taxonomy fetch fails on the FE**: pickers fall back to the `SUBJECTS`
  constant compiled into `subjects.ts`, the languages already on the deck, and
  `en`/`uk`. Discover tiles render from `categories` (which already carries the
  slugs).
- **Old FE tab open during deploy** sends a legacy slug → 400 on save. The
  form shows the generic error, and a reload fixes it. Acceptable for a
  same-release FE/BE deploy.

## Risks + failure modes

| Risk | Mitigation |
|---|---|
| Keyword SQL mis-maps a deck (e.g. "art" in "cartography" → arts) | Keyword pass runs only on values that aren't exact slugs; rules ported 1:1 from `normCategory` (already shipped); user can edit; dry-run report lists every non-exact mapping before deploy |
| Backfill script cost / runaway | `--dry-run` with estimated cost; Haiku, ≤ 10 words per deck, batches of 50; `--limit`; idempotent |
| Migration lock time on `decks` | Single-table UPDATEs on a small table; `user_decks` backfill is an INSERT…SELECT. Fine at current scale. If prod > 1 M sessions, split step 8 into the script |
| `/library` query slow (CTE + facets) | `user_decks(userId, lastStudiedAt)` index plus existing `decks(authorId, updatedAt)`; facets only on page 1; `EXPLAIN` checked in test plan |
| Library tracking write fails | Best-effort `.catch(log)`; never breaks rate/session; a missed card is re-recorded on the next study |
| Discover `lang` semantics change breaks a caller | Only caller is our FE (same release); contract updated; public SEO pages use the same param |
| SEO: category URLs change | 301 legacy → new; sitemap updated; canonical on new URLs |
| Classify endpoint abused as free AI | Output is one enum value; input capped (title ≤ 120, ≤ 20 words); 30/min rate limit; usage logged |
| FE i18n missing a `lang.<code>` key | `langLabel` falls back to `displayLangCode(code)`; validate script checks both catalogs have all 28 + 12 keys |

## Test plan

### Backend — Vitest

- `test/subjects.test.ts`
  - `normalizeSubject`: each of the 12 slugs is the identity. Each of the 30
    old slugs maps per the table. `tech` → technology, `Language` → languages,
    `" Finance "` → business. Garbage → null.
  - `inferSubject('en','uk')` → languages. `inferSubject('en','en')` → other.
- `test/deck-schema-subject.test.ts`: create without subject → inferred and
  `subjectSource='rules'`. Explicit slug → `'user'`. `'biology'` → 400.
  PATCH `subject:null` → 400. PATCH `'science'` → OK.
- `test/user-decks-record.test.ts`
  - `srs.rate` on someone else's public deck creates a UserDeck with that card.
    Rating the same card twice → `studiedCount` 1.
  - Session `PATCH cardIndex=3` (SRS off) records exactly the first 3
    `cardIds`. `complete` records all of them.
  - A `recordStudied` failure doesn't fail `rate` or `complete`, and XP plus
    the DailyActivity calls are unchanged (assert the same values as the
    existing `sessions-complete-activity` / `xp` tests).
- `test/library-service.test.ts`
  - scope=my includes an own deck with 0 studied. scope=learning excludes it.
    scope=all includes both.
  - Another user's public deck with 4 of 10 studied is not in learning; with 5
    it is. A 3-card deck with 3 studied is in learning.
  - Another user's deck that turns private disappears.
  - Sort `COALESCE(lastStudiedAt, createdAt)` desc. Cursor pagination is
    stable across ties (same ts).
  - `subject` / `lang` filters. Facets: scope counts ignore subject/lang;
    `languages` facet only counts `subject='languages'`.
  - Bad scope or subject → 400.
- `test/discover-categories.test.ts`: all 12 returned in order, including
  zeros. `languages` counts only public language decks. `lang` filter matches
  `targetLanguage` only.
- `test/public-taxonomy.test.ts`: shape, 12 subjects, 28 languages, and a
  legacy map covering all 30 old slugs. Cache header set.
- `test/subjects-classify.test.ts` (mock provider): an enum answer → `ai`. A
  provider error or timeout → `rules`. An off-list answer → normalized or
  `rules`. No `AiUsage` reservation is made.
- `test/imports-apkg.test.ts` (extend): with `subject` → applied to all decks.
  Without → classifier called once per deck.
- `test/chat-tool-write.test.ts` / `chat-tools.test.ts` (extend): the tool
  schema has `subject.enum = SUBJECTS` and `targetLanguage.enum = SUPPORTED_LANG_LIST`.
  `create_deck` with a valid subject → persisted with `subjectSource='ai'`.
  Missing or invalid → rules mapping, with `'rules'`. The classifier is
  **never** called.
- `test/ai-anthropic*.test.ts` (extend): tool schema `subject.enum` equals
  `SUBJECTS`. A model draft with `subject: "Biology"` → `science`.
- Migration: `scripts/sql/check-subjects.sql` (assert 0 decks with subject not
  in list, 0 `pending` after the script). It runs in CI against a seeded DB
  with legacy values (`Language`, `biology`, `NULL`, `cartography`).

### Frontend — `npm run validate` + manual click-path

1. Switch the locale to UA. The account-menu switcher reads `UA`. A Ukrainian
   deck's detail reads "UA → EN". The AI deck card and study card region show
   `UA`.
2. `/decks/create`: change languages en→uk; the subject suggestion flips to
   Мови/Languages. Pick Science, save, and edit: Science is preselected. The
   language picker lists 28 localized names.
3. Anki import with Auto-detect → the deck lands with a sensible subject. With
   an explicit Law → Law.
4. AI import dialog (create mode) on Auto → subject set. Generate a deck from
   an image → subject is one of the 12.
5. `/discover`: 12-tile max with localized labels, zero-count tiles hidden.
   Click Languages → language chips → filter works. Open `/discover/biology` →
   301 to `/discover/science`.
6. As user B, study 5 cards of user A's public deck in browse mode (SRS off),
   then go to `/decks`: the deck is under All and Learning with "by @A", and it
   is first (most recent). Add cards is hidden; Practice and the heart work.
7. Study 4 cards of another public deck → not in Learning. Study 1 more → it
   appears.
8. Tabs My / Learning / All: counts correct. Subject chips plus language chips
   are correct after Load more (> 24 decks). URL query persists across refresh.
9. User A makes the deck private → user B reloads → it is gone. User A makes
   it public again → it is back.
10. Empty states: a new user (no decks) sees the create CTA. Learning empty
    shows the Discover CTA. A filter with no results shows Clear filters.
    Kill the backend → inline error with Retry.
11. The dashboard "Up next" includes due cards from user A's public deck I'm
    learning. The Topbar search finds it. The Rail shows no deck rows.
12. Mobile (375 px): tabs and chip rows scroll horizontally, cards stack in
    one column, no horizontal page scroll.

## Implementation plan

Each task is independently committable and leaves both repos green.

1. **BE: subjects module.** Add `src/shared/subjects.ts` (`SUBJECTS`,
   `LEGACY_SUBJECT_MAP`, `normalizeSubject`, `inferSubject`,
   `LEARNING_THRESHOLD`) and `SUPPORTED_LANG_LIST`, with
   `test/subjects.test.ts`. No behaviour change.
2. **BE: migration (subjects).** Schema `subject` NOT NULL plus
   `subjectSource`. Migration steps 1–6 and 9. Add
   `scripts/sql/check-subjects.sql`. Run `prisma generate` and fix types
   (`subject: string`).
3. **BE: enforce on write.** Deck create/patch schema enum and inference,
   discover schemas, mapper type, Discover copy, `imports.repository` and
   `chat-tools.repository` defaults. Update the deck-schema tests.
4. **BE: taxonomy + Discover.** `GET /public/taxonomy`. Categories over the
   fixed list plus `languages`. `lang` → `targetLanguage`. Public variants
   too. Tests.
5. **BE: classifier.** `subjects.service.classify`, `POST /ai/classify-subject`,
   apkg `subject` field and auto-classify, chat `create_deck` `subject` and
   `targetLanguage` enum inputs (no classifier call),
   AI prompts and tool schemas as enum plus normalization, the
   `deck_subject_classified` event. Tests.
6. **BE: UserDeck model + backfill.** Schema, migration steps 7–8,
   `user-decks.repository`, hooks in `srs.rate` and
   `sessions.updateProgress/complete`. Tests (including the XP/activity
   no-change assertions).
7. **BE: `GET /library`.** Schema, repository (CTE, keyset, facets), service,
   controller, route. Tests.
8. **BE: contract + docs.** `docs/api-contract.md` (sections 1–10 above),
   AGENTS.md endpoint checklist, inventory count.
9. **BE: backfill script.** `scripts/backfill-subjects.ts` (`--dry-run`,
   `--limit`, language pass, report). Run a dry-run against a prod snapshot
   and record the result in "Decisions made during build".
10. **FE: taxonomy + subjects utils + i18n.** `api/taxonomy.ts`,
    `useTaxonomy`, `utils/subjects.ts` (`displayLangCode`), the 12 + 28 + library
    keys in `en.json`/`uk.json`, remove `deckCategories.ts`. Fix all importers.
11. **FE: "UA" display.** Replace the `toUpperCase()` call sites with
    `displayLangCode`, and localize the `deckVm` tag.
12. **FE: pickers.** Create page (suggestion), edit Form, deck schema langs
    from the taxonomy, `UiCategorySelect` `allowAuto`, Anki dialog `subject`,
    AI import classify-or-pick, `useImageDeck`.
13. **FE: Discover.** Tiles, language sub-chips, `[subject].vue` validation and
    301, `useDiscover` cleanup, sitemap.
14. **FE: library.** `api/library.ts`, `stores/library.ts`, `useLibrary`, the
    `pages/decks/index.vue` rewrite (tabs, chips, URL state, states),
    `SharedDeckCard` author / non-owner, the `library_filter_changed` event.
15. **FE: dashboard / Topbar / Rail.** Dashboard and Topbar switch to the
    library store. Remove the Rail deck rows. Update FE `CLAUDE.md` (Rail note,
    deckCategories → subjects, the library store in the layout table).
16. **Ops (in this order):**
    1. **Take a production DB backup** (Railway snapshot or `pg_dump -Fc`) and
       verify it lists `decks`, `study_sessions` and `card_progresses`.
    2. Run `scripts/sql/check-subjects.sql` read-only against a prod snapshot
       to preview the rule mapping.
    3. Deploy the BE (the migration runs), then the FE.
    4. Run `scripts/backfill-subjects.ts --dry-run`. The owner reviews the
       printed proposed changes.
    5. Run `scripts/backfill-subjects.ts` for real.
    6. Run `check-subjects.sql` and expect 0 violations, 0 `pending`.

## Decisions made during build

Backend (tasks 1–9):

1. **Branches.** `feat/fixed-categories-library` in both repos, cut from
   `feat/deck-scoped-review` (29 commits ahead of `main`; this spec builds on its
   session code), not from `main`.
2. **28 languages, not 29.** `chinese` and `mandarin` both map to `zh`; the spec's
   count was wrong.
3. **`deck_subject_backfill` audit table** (not in the spec): one row per deck the
   migration changed, with its raw old value and the rule used. It gives the AI
   script the original label as context and lets ops revert a bad mapping. Drop it
   once the backfill is verified in production.
4. **`updatedAt` is never bumped** by the migration or the backfill script (raw SQL,
   not Prisma `update`): a taxonomy repair is not a user edit and must not reorder
   anyone's deck list.
5. **Keyword rules are a 1:1 port** of the FE `normCategory` (same order, same
   substrings), in both TS and the migration's SQL. They over-match (`cartography`
   → arts via `art`, `terms` → languages via `term`). Accepted: they only run on
   non-exact legacy values and as the AI fallback; `preview-subject-mapping.sql`
   lets you read every mapping before deploy.
6. **A bare language name** ("Deutsch", "日本語") resolves to `languages`, but 2–3
   letter strings ("it", "cs") do not, since they are more likely abbreviations.
7. **Session status** is `'complete'` in this codebase (not `'completed'`), which the
   `user_decks` backfill uses.
8. **`user_decks` writes** are fire-and-forget through
   `services/user-decks.service.ts#trackStudied` (never awaited, errors swallowed) —
   outside the XP / activity path, as the spec requires. Existing tests that call
   `rate` / `complete` mock that helper so they never touch a database.
9. **Classification model.** `classifySubject` uses the existing chat route
   (`ANTHROPIC_MODEL`, Haiku 5.5 by default) so no new env var was needed; it is not
   tied to the content-language routes, so the Ukrainian-quality model is never paid
   for a one-word answer.
10. **Chat `create_deck`.** The model's `subject` is stored as `subjectSource 'ai'`;
    the topic branch ignores the generator's own `draft.subject` (the chat model
    already chose in the same call). `targetLanguage` is preferred over
    `wordsLanguage`; when only one of them is readable, that one is used.
11. **`POST /ai/classify-subject`** shares the AI routes' 30/min limit.
12. **Anki import** classifies before inserting (concurrency 4, 4 s timeout each,
    rules fallback), so latency grows by at most ~4 s and the import never fails on
    classification.
13. **Discover `lang`** is now validated with `langSchema` (aliases normalize,
    unknown → 400) and matches `targetLanguage` only.
14. **Bad library cursor** returns the existing `400 INVALID_CURSOR`, not
    `VALIDATION_ERROR`.
15. **Backfill script safety.** It is a dry run unless `--apply` is passed
    (`--dry-run` is accepted; both together is an error), it prints the DB host
    first, and every write is guarded (`subjectSource = 'pending'`, unchanged
    language values). The language pass needed a small provider capability
    (`detectLanguages`) the spec implied but did not list.
16. **Gates.** `test/billing-management.test.ts` fails before and after these
    changes: it requires a dedicated `mnemio_qa_sub` database. Everything else
    passes.
