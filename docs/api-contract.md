# Mnemio Backend — API Contract for Frontend Integration

> Audience: the frontend (`mnemio-frontend`) developer / AI replacing the
> `localStorage`-backed mocks in `app/api/*.ts` with real HTTP calls.
> Read [`backend-plan.md`](./backend-plan.md) for the *why*; this file is the *what*.

## 0. What's new since the last sync

**P2 is shipped.** Discover (public catalog + clone), AI (mock provider for now)
and Media uploads (local FS for now) are all live. P0+P1 are unchanged.

### P2 deltas
| Area | Change |
|---|---|
| **Deck** | New fields on every `Deck` response: `coverColor`, `glyph`, `subject` (all nullable), `featured: boolean`, `copyCount: number`, `sourceDeckId: string \| null`. `POST /decks` and `PATCH /decks/:id` accept the cosmetic fields + `isPublic`. |
| **Discover** ✨ | New endpoints: `GET /discover/decks`, `GET /discover/featured`, `GET /discover/categories`. |
| **Clone** ✨ | `POST /decks/:id/copy` — clones a public deck (cards + cosmetics) into the viewer's account, sets `sourceDeckId`, atomically bumps the source's `copyCount`. |
| **AI** ✨ | `POST /ai/generate-deck` (returns a deck draft, FE persists if user accepts) and `POST /ai/suggest` (Mimi suggestions). Backed by a `mock` provider for MVP; provider swap is env-driven and contract-stable. |
| **Media** ✨ | `POST /media/uploads?kind=avatar\|card_image\|card_audio` (multipart). Avatar uploads also set `user.avatarUrl`. Files served from `/media/<userId>/<file>`. |
| **User.avatarUrl** | No longer always `null` — populated after a successful `kind=avatar` upload. |

### Recap of earlier deltas (all still in §3)
- **P1**: embedded per-deck `stats`, server-backed session summary
  (`counts`/`revisitCardIds`/`durationMs`), rich `Card` fields, Preferences,
  Achievements, Statistics + DailyActivity.
- **P0**: `total` on `GET /decks`, inline `cards: Card[]` on `GET /decks/:id`,
  cookie refresh, error envelope, etc.

Shipped contract invariants (mentioned here so you can spot anything your
client still expects in the old form):
- Refresh token is an **HttpOnly cookie** `mnemio_refresh` on path
  `/api/v1/auth`; never in any body.
- `POST /srs/rate` body is `{ cardId, rating: 'again'|'hard'|'good'|'easy' }`
  (server derives `deckId` from the card).
- Session XP is **server-computed** `correct*10 + 25`; don't send `xp`.
- `User.displayName` was renamed to `User.fullName`.
- Username-taken error code is `AUTH_USERNAME_TAKEN` (not `USER_*`).

### Demo data
The backend ships a seed: `npm run seed` creates `demo@mnemio.local` /
`demo-password-123` (pre-verified, profile complete, 2 decks of 8–10 cards).
Use it to skip the OTP scrape during FE integration testing.

---

## 1. Conventions

### Base URL
- All endpoints are prefixed `/api/v1`.
- Dev: `http://localhost:3001/api/v1` (backend on **3001**; Nuxt frontend on **3000**).
- CORS: server allows `WEB_URL` only (default `http://localhost:3000`) with
  **`credentials: true`** (required so the browser sends the refresh cookie).
- Frontend `fetch` must use `credentials: 'include'` on every call.

### Authentication
- **Access token** — JWT (HS256), 15 min TTL. Claims: `sub` (userId),
  `emailVerified`, `role`. **Lives in `localStorage`**, sent as
  `Authorization: Bearer <accessToken>` on every non-public request.
- **Refresh token** — opaque base64url string (32 bytes of entropy), 30-day TTL,
  rotates on every `/auth/refresh`. **Lives in an HttpOnly cookie named
  `mnemio_refresh`**, scoped to path `/api/v1/auth`. The frontend never reads,
  writes, or sees this token — the browser handles it automatically because
  CORS uses `credentials: true`.
- **Cookie attributes:** `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`.
  `Secure` is set only when `NODE_ENV === 'production'` (so it works on
  `http://localhost` in dev).
- **Reuse detection:** presenting a previously-rotated refresh token revokes
  *all* of that user's refresh tokens. The next `/auth/refresh` will return
  `AUTH_INVALID_REFRESH` — force a full logout.

Public endpoints (no access token required): everything under `/auth/*`
except `/auth/me`, plus `/health`.

### Request / response format
- Bodies and responses are JSON. `Content-Type: application/json`.
- All dates are ISO 8601 UTC strings (`2026-05-25T17:42:00.000Z`).
- Birthday is `YYYY-MM-DD` (date-only).
- IDs are UUID strings.
- The refresh token is **never** present in any request body or response body —
  it's only ever in the `mnemio_refresh` cookie.

### Error envelope
Every error response follows the same shape:
```ts
type ApiError = {
  code: string;                       // machine-readable, SCREAMING_SNAKE_CASE
  message: string;                    // human-readable English (FE handles i18n)
  details?: Record<string, unknown>;  // optional, e.g. Zod tree of issues
};
```

| Status | Meaning |
|---|---|
| 400 | Validation error (`VALIDATION_ERROR` or domain code) |
| 401 | Unauthenticated (bad / expired access token, bad credentials) |
| 403 | Authenticated but not allowed (ownership check failed) |
| 404 | Not found |
| 409 | Conflict (e.g. duplicate email / username) |
| 422 | Business-rule violation |
| 429 | Rate-limited |
| 500 | Internal — backend bug |

**Codes the FE should map specifically:**
| Code | Where | UX |
|---|---|---|
| `VALIDATION_ERROR` | any | Field errors from `details` |
| `AUTH_EMAIL_TAKEN` | `POST /auth/register` | "An account already exists. Log in instead." |
| `AUTH_INVALID_CREDENTIALS` | `POST /auth/login` | "Email or password is incorrect." (do **not** distinguish "no such user" from "wrong password") |
| `AUTH_INVALID_CODE` | `POST /auth/verify-email` | "Invalid verification code." |
| `AUTH_OTP_EXHAUSTED` | `POST /auth/verify-email` | "Too many attempts. Request a new code." |
| `AUTH_OTP_COOLDOWN` | `POST /auth/resend-otp` | "Wait {N}s before requesting another code." |
| `EMAIL_NOT_VERIFIED` | `POST /auth/login` | Route the user to OTP step; `details.userId` included |
| `AUTH_INVALID_TOKEN` | any auth-required endpoint | Try `/auth/refresh`; on failure → logout |
| `AUTH_INVALID_REFRESH` | `POST /auth/refresh` | Hard logout — token is revoked or stolen |
| `AUTH_USERNAME_TAKEN` | `PATCH /users/me` | Inline field error on `username` |
| `DECK_NOT_FOUND` / `CARD_NOT_FOUND` / `SESSION_NOT_FOUND` | resource routes | 404 page or toast |
| `DECK_EMPTY` | `POST /sessions` | Disable "Study" CTA when `cardCount === 0` |
| `SESSION_NOT_ACTIVE` | `POST /sessions/:id/complete` | Refetch session, sync FE state |

> Note: `@fastify/rate-limit` 429 responses currently use the plugin's default
> shape (`{ statusCode, error, message }`), not our envelope. Treat **HTTP 429**
> itself as the signal. Can be normalized on request.

### Rate limiting
- Global default: 120 req/min/IP.
- `/auth/register`, `/auth/login`: 10 req/min/IP.
- `/auth/verify-email`, `/auth/resend-otp`: 5 req/min/IP.
- `/auth/refresh`: 30 req/min/IP.

### Pagination contract
- Cursor-based. Send `?cursor=<opaque>&limit=<n>`; receive `{ items, nextCursor }`.
- `nextCursor === null` → no more pages.
- Hard cap on `limit`: **100** for general lists.
- A few endpoints expose `total` alongside the page (currently `GET /decks`) for
  list-header counters; most omit it because counting on every page is expensive.
- The cursor is **opaque** — never parse or construct it; pass it through verbatim.

```ts
type Page<T> = {
  items: T[];
  nextCursor: string | null;
};
type PageWithTotal<T> = Page<T> & { total: number };
```

---

## 2. Domain types

```ts
type User = {
  id: string;                  // uuid
  email: string;
  fullName: string | null;     // null until profile completion
  username: string | null;     // null until profile completion
  birthday: string | null;     // 'YYYY-MM-DD' or null
  avatarUrl: string | null;    // populated by POST /media/uploads?kind=avatar
  emailVerified: boolean;
  role: 'user' | 'admin';
  xp: number;                  // updated atomically on session complete
  streak: number;              // EXPOSED, ALWAYS 0 — `/stats/overview.streak`
                               // is the authoritative streak value (live, from
                               // the DailyActivity rollup)
  createdAt: string;
  updatedAt: string;
};

type DeckStats = {
  total: number;          // = cardCount
  mastered: number;       // cards with interval ≥ 21 days
  learning: number;       // has progress but interval < 21
  new: number;            // cards without a CardProgress row
  due: number;            // cards due now (nextReviewAt ≤ now)
  masteredPct: number;    // 0..100, rounded
};

type Deck = {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  sourceLanguage: string;      // ISO 639-1, e.g. 'en'
  targetLanguage: string;
  isPublic: boolean;
  cardCount: number;
  coverColor: string | null;   // P2: '#RRGGBB' hex
  glyph: string | null;        // P2: short symbol/emoji, ≤ 8 chars
  subject: string | null;      // P2: e.g. 'languages', 'science'
  featured: boolean;           // P2: curator-flagged for Discover home
  copyCount: number;           // P2: # of times this deck has been cloned
  sourceDeckId: string | null; // P2: id of the public deck this was copied from
  stats: DeckStats;            // P1: embedded per-deck stats
  createdAt: string;
  updatedAt: string;
};

// Discover responses use a variant that bundles an author summary so the FE
// doesn't need a second roundtrip to render a username.
type DeckWithAuthor = Deck & {
  author: {
    id: string;
    username: string | null;
    fullName: string | null;
  };
};

type Card = {
  id: string;
  deckId: string;
  word: string;
  definition: string;
  phonetic: string | null;
  reading: string | null;                // P1
  partOfSpeech: string | null;           // P1
  example: string | null;                // P1
  exampleTranslation: string | null;     // P1
  tags: string[];                        // P1
  difficulty: 'easy' | 'medium' | 'hard'; // P1; default 'medium'
  type: 'basic' | 'cloze' | 'image';     // P1; default 'basic'
  audioUrl: string | null;               // P1
  imageUrl: string | null;
  position: number;            // 0-indexed, server-assigned on create
  createdAt: string;
  updatedAt: string;
};

type CardProgress = {
  cardId: string;
  repetitions: number;
  interval: number;            // in days
  easeFactor: number;          // SM-2, min 1.3
  nextReviewAt: string;
  lastReviewedAt: string | null;
};

type SessionCounts = {
  again: number;
  hard: number;
  good: number;
  easy: number;
};

type StudySession = {
  id: string;
  userId: string;
  deckId: string;
  mode: 'flashcard' | 'multiple_choice' | 'srs';
  status: 'active' | 'incomplete' | 'complete';
  cardIds: string[];           // snapshot of the queue at session start
  cardIndex: number;
  correct: number;
  xpAwarded: number;
  cardsStudied: number;
  correctAnswers: number;
  counts: SessionCounts;       // P1: per-grade tally
  revisitCardIds: string[];    // P1: cards the user flagged to revisit
  durationMs: number;          // P1: ms spent in this session
  startedAt: string;
  endedAt: string | null;
  completedAt: string;
};

type Rating = 'again' | 'hard' | 'good' | 'easy';

type Achievement = {
  id: string;                  // = key
  key: string;
  name: string;
  description: string;
  iconKey: string;             // FE maps to the actual asset
  earned: boolean;
  earnedAt: string | null;
  progress: number;            // 0..100
};

type Preference = {
  interests: string[];
  goal: string | null;
  nativeLanguage: string | null;
  learningLanguages: string[];
  avatarHue: number | null;    // 0..360
  mimiPlacement: 'left' | 'right' | null;
  favorites: string[];         // deckIds
  updatedAt: string;
};
```

### `needsProfile` flag
Most auth responses include `needsProfile: boolean` alongside `user`. It's
`true` when `user.username` or `user.fullName` is `null`. **Use this flag — not
local heuristics — to decide whether to send the user to the account-details
step.**

---

## 3. Endpoint reference

### Auth

All auth responses that issue tokens set the `mnemio_refresh` HttpOnly cookie
as a side effect; the JSON body contains **only** `accessToken`, `user`,
`needsProfile`. Frontend stashes `accessToken` in `localStorage` and forgets
the cookie exists.

#### `POST /auth/register`  *(public)*
Create an unverified user; trigger OTP email. **No tokens issued.**
```ts
// Request
{ email: string; password: string }   // password ≥ 8 chars

// 201 Response
{ userId: string; email: string }

// Errors: 409 AUTH_EMAIL_TAKEN · 400 VALIDATION_ERROR
```

#### `POST /auth/verify-email`  *(public)*
Consume an OTP; on success, mark verified, set refresh cookie, return access token.
```ts
// Request
{ userId: string; code: string }      // 6-digit code

// 200 Response  +  Set-Cookie: mnemio_refresh=...
{ accessToken: string; user: User; needsProfile: boolean }

// Errors: 400 AUTH_INVALID_CODE · 400 AUTH_OTP_EXHAUSTED
```

#### `POST /auth/resend-otp`  *(public)*
60-second cooldown per user.
```ts
// Request: { userId: string }
// 200 Response: { ok: true; cooldownSeconds: number }
// Errors: 429 AUTH_OTP_COOLDOWN (message includes remaining seconds)
```

#### `POST /auth/login`  *(public)*
```ts
// Request: { email: string; password: string }

// 200 Response  +  Set-Cookie: mnemio_refresh=...
{ accessToken: string; user: User; needsProfile: boolean }

// Errors:
// 401 AUTH_INVALID_CREDENTIALS
// 401 EMAIL_NOT_VERIFIED  (details.userId — route the user to OTP step)
```

#### `POST /auth/refresh`  *(public — uses cookie, **no body**)*
Reads `mnemio_refresh` cookie, rotates the token (old one revoked, new one
sent via `Set-Cookie`), returns a fresh access token.
```ts
// Request: (no body)
// 200 Response  +  Set-Cookie: mnemio_refresh=... (rotated)
{ accessToken: string; user: User; needsProfile: boolean }

// Errors: 401 AUTH_INVALID_REFRESH  → hard logout (cookie was rotated/stolen)
```

#### `POST /auth/logout`  *(public — uses cookie, **no body**)*
Revokes the current refresh token and clears the cookie. Idempotent.
```ts
// 204 No Content  +  Set-Cookie: mnemio_refresh=; Max-Age=0
```
FE should also delete `accessToken` from `localStorage` after this call.

#### `GET /auth/me`  *(auth)*
```ts
// 200 Response: { user: User; needsProfile: boolean }
// Errors: 401 AUTH_INVALID_TOKEN → try /auth/refresh
```

### Users

#### `PATCH /users/me`  *(auth)*
Profile completion. All fields optional; at least one required.
```ts
// Request
{
  fullName?: string;      // trimmed, 1–64 chars
  username?: string;      // 3–24 chars, /^[a-zA-Z0-9_]+$/, lowercased server-side,
                          // reserved names rejected (admin, root, mnemio, …)
  birthday?: string;      // 'YYYY-MM-DD'; must be ≥ 13 years ago
}

// 200 Response: { user: User; needsProfile: boolean }

// Errors: 400 VALIDATION_ERROR · 409 AUTH_USERNAME_TAKEN
```

### Decks

#### `GET /decks`  *(auth)*
```ts
// Query: ?cursor?=string&limit?=number(<=100)&q?=string  default limit 20
// 200 Response: PageWithTotal<Deck>
//   = { items: Deck[]; nextCursor: string | null; total: number }
```
`q` does case-insensitive `contains` over `title` + `description`. Sort:
`updatedAt DESC, id DESC` (stable keyset). `total` is the full match count for
the filter, independent of the current page.

Example (after `npm run seed`):
```json
{
  "items": [
    { "id": "…", "title": "Japanese: Hiragana Starter", "cardCount": 10, "…": "…" },
    { "id": "…", "title": "Spanish: Greetings & Basics", "cardCount": 8,  "…": "…" }
  ],
  "nextCursor": null,
  "total": 2
}
```

#### `POST /decks`  *(auth)*
```ts
// Request
{
  title: string;              // 2–120 chars
  description?: string;       // ≤ 500 chars, default ''
  sourceLanguage: string;     // 2–10 chars
  targetLanguage: string;
  isPublic?: boolean;         // P2; default false
  coverColor?: string | null; // P2: '#RRGGBB' hex
  glyph?: string | null;      // P2: 1–8 chars (emoji ok)
  subject?: string | null;    // P2: 1–40 chars
}
// 201 Response: Deck
```

#### `GET /decks/:id`  *(auth)*
The FE's Deck Detail page, study queue, and Add Card flow all assume the entire
card list is present, so the deck detail returns cards **inline** rather than
paged. Hard cap is 1000 (matches the FE per-deck limit).
```ts
// Query: ?cardsLimit?=number(<=1000)  default 1000

// 200 Response
{
  deck: Deck;
  cards: Card[];              // sorted by (position ASC, id ASC), up to cap
}
// Errors: 404 DECK_NOT_FOUND
```
Example:
```json
{
  "deck": { "id": "…", "title": "Japanese: Hiragana Starter", "cardCount": 10, "…": "…" },
  "cards": [
    { "id": "…", "deckId": "…", "word": "あ", "definition": "a (vowel)", "phonetic": "/a/", "position": 0, "…": "…" },
    { "id": "…", "deckId": "…", "word": "い", "definition": "i (vowel)", "phonetic": "/i/", "position": 1, "…": "…" }
  ]
}
```

#### `PATCH /decks/:id`  *(auth)*
```ts
// Request: any subset of the POST /decks body, including isPublic /
//          coverColor / glyph / subject. null clears the optional fields.
// 200 Response: Deck
```

#### `DELETE /decks/:id`  *(auth)*
```ts
// 204 No Content   (cascades to cards, progress, sessions)
```

### Cards

#### `POST /decks/:id/cards`  *(auth)*
```ts
// Request — all fields beyond word/definition optional (P1 rich fields)
{
  word: string;                          // 1–120 chars
  definition: string;                    // 1–1000 chars
  phonetic?: string;                     // ≤ 120 chars
  reading?: string;                      // ≤ 120 chars
  partOfSpeech?: string;                 // ≤ 40 chars
  example?: string;                      // ≤ 500 chars
  exampleTranslation?: string;           // ≤ 500 chars
  tags?: string[];                       // ≤ 20 tags, each ≤ 40 chars
  difficulty?: 'easy' | 'medium' | 'hard';  // default 'medium'
  type?: 'basic' | 'cloze' | 'image';    // default 'basic'
  audioUrl?: string;                     // URL
  imageUrl?: string;                     // URL
}
// 201 Response: Card  (position is server-assigned: last + 1)
```

#### `POST /decks/:id/cards/bulk`  *(auth)*
```ts
// Request: { cards: <same field set as POST /decks/:id/cards>[] }   // 1–100 items
// 201 Response: { created: number }
```

#### `PATCH /cards/:id`  *(auth)*
```ts
// Request: any subset of the create body + { position? }
// 200 Response: Card
// Errors: 404 CARD_NOT_FOUND · 403 CARD_FORBIDDEN
```

#### `DELETE /cards/:id`  *(auth)*
```ts
// 204 No Content  (deck.cardCount recomputed)
```

### Sessions

**Invariant:** at most one `active` session per user. Both `POST /sessions` and
`POST /sessions/:id/resume` enforce this atomically — any pre-existing active
session is flipped to `incomplete` before the new one becomes `active`.

#### `POST /sessions`  *(auth)*
```ts
// Request: { deckId: string; mode: 'flashcard' | 'multiple_choice' | 'srs' }

// 201 Response: StudySession  (status: 'active', cardIds: deck snapshot,
//                              cardIndex: 0, correct: 0)
// Errors: 404 DECK_NOT_FOUND · 400 DECK_EMPTY
```

#### `PATCH /sessions/:id`  *(auth)*
Append progress and Session Summary state mid-session. **At least one** field
required; FE patches incrementally.
```ts
// Request
{
  cardIndex?: number;
  correct?: number;
  counts?: { again, hard, good, easy };     // P1: per-grade tally
  revisitCardIds?: string[];                // P1: ≤ 1000 ids
  durationMs?: number;                      // P1: ms spent so far
}
// 200 Response: StudySession
// Errors: 404 SESSION_NOT_FOUND  (also if no longer 'active')
```

#### `POST /sessions/:id/complete`  *(auth)*
Close session. **XP is server-computed**: `correct * 10 + 25`. User's total XP
incremented atomically.
```ts
// Request: (empty body)
// 200 Response: StudySession  (status: 'complete', xpAwarded set)
// Errors: 400 SESSION_NOT_ACTIVE · 404 SESSION_NOT_FOUND
```
> **Side effect:** `user.xp` increases by `xpAwarded`. The response contains the
> session, not the user — refresh user state via `GET /auth/me` (or
> `GET /dashboard.stats.xp`) if the UI shows it.

#### `POST /sessions/:id/exit`  *(auth)*
Explicit user-triggered exit. Marks an active session as `incomplete` (no XP
awarded). Use this for the "Exit" button in study mode.
```ts
// Request: (empty body)
// 200 Response: StudySession  (status: 'incomplete', endedAt set)
// Errors: 404 SESSION_NOT_FOUND  (no active session with that id)
```

#### `POST /sessions/:id/resume`  *(auth)*
Flip an incomplete session back to `active`. Atomically marks any *other*
currently-active session as `incomplete` first.
```ts
// Request: (empty body)
// 200 Response: StudySession  (status: 'active')
// Errors: 404 SESSION_NOT_FOUND  (no incomplete session with that id)
```

#### `GET /sessions/active`  *(auth)*
Current active session (or `null`).
```ts
// 200 Response: { session: StudySession | null }
```

#### `GET /sessions/incomplete`  *(auth)*
Most-recent incomplete session (or `null`). Powers "Continue studying" CTA.
```ts
// 200 Response: { session: StudySession | null }
```

### SRS

#### `POST /srs/rate`  *(auth)*
Rate a card. Server runs SM-2 and upserts the user's `CardProgress`.
```ts
// Request: { cardId: string; rating: 'again' | 'hard' | 'good' | 'easy' }
// 200 Response: CardProgress
// Errors: 404 CARD_NOT_FOUND · 403 CARD_FORBIDDEN
```
Rating → SM-2 quality mapping (matches the frontend composable). EF delta uses
the standard SuperMemo-2 formula `ΔEF = 0.1 − (5−q)(0.08 + (5−q)·0.02)`, with EF
floored at 1.3.
| Rating | Quality | Effect |
|---|---|---|
| `again` | 0 | Failure path: repetitions=0, interval=1d, **EF −0.2** |
| `hard`  | 2 | Treated as failure (q<3): same reset path, **EF −0.32** |
| `good`  | 3 | Advance: repetitions++, interval = 1 / 6 / round(prev × prevEF), **EF −0.14** |
| `easy`  | 5 | Advance same way, **EF +0.10** |

#### `GET /srs/due`  *(auth)*
```ts
// Query: ?limit?=number(<=200)  default 50

// 200 Response
{
  items: {
    cardId: string;
    deckId: string;
    word: string;
    definition: string;
    phonetic: string | null;
    nextReviewAt: string;
    interval: number;
    easeFactor: number;
    repetitions: number;
  }[];
}
```
`nextReviewAt ASC` (most-overdue first). Only cards with an existing
`CardProgress` row appear (i.e. rated at least once and now due).

#### `GET /srs/progress`  *(auth)*
Full progress map for the user. Powers the FE's `srs.progress` store. Capped
at 2000 entries (well above the MVP perf budget of 200 decks × 1000 cards =
200k cards, but only studied cards have rows).
```ts
// Query: ?limit?=number(<=2000)  default 2000

// 200 Response: { items: CardProgress[] }   // sorted by nextReviewAt ASC
```

### Dashboard

#### `GET /dashboard`  *(auth)*
One round-trip for the dashboard page.
```ts
// 200 Response
{
  stats: { decks: number; cards: number; xp: number };
  dueCount: number;
  recentDecks: Deck[];          // up to 5, by updatedAt DESC
  continueStudying: StudySession | null;
}
```

### Preferences  *(P1)*

User preferences live on a separate endpoint from `/users/me` so the FE can
PATCH them independently (avatar hue picker, favorite toggle, onboarding goals,
etc.).

#### `GET /users/me/preferences`  *(auth)*
Lazy-creates an empty row on first access; never returns 404.
```ts
// 200 Response: Preference
```

#### `PATCH /users/me/preferences`  *(auth)*
All fields optional; **at least one** required. `null` clears the field; arrays
replace.
```ts
// Request
{
  interests?: string[];            // ≤ 40 items, each ≤ 40 chars
  goal?: string | null;            // 1–120 chars, or null to clear
  nativeLanguage?: string | null;  // 2–10 chars (ISO 639-1)
  learningLanguages?: string[];    // ≤ 10 entries
  avatarHue?: number | null;       // 0..360
  mimiPlacement?: 'left' | 'right' | null;
  favorites?: string[];            // deckIds, ≤ 500
}
// 200 Response: Preference
// Errors: 400 VALIDATION_ERROR
```

### Achievements  *(P1)*

Catalog is server-defined (currently 7 entries: `first_steps`, `quick_learner`,
`marathoner`, `accuracy_ace`, `reviewer_100`, `builder_50`, `polyglot`).
Evaluated automatically on `/sessions/:id/complete`, `/srs/rate`, and card
create.

#### `GET /achievements`  *(auth)*
```ts
// 200 Response: { items: Achievement[] }
```
Each entry includes `earned: boolean`, `earnedAt: string|null`, and
`progress: 0..100` so the FE can show progress bars even before unlock.

### Statistics  *(P1)*

Backed by a `DailyActivity` rollup table that updates on every `/srs/rate`.
All endpoints scoped to the authenticated user.

#### `GET /stats/overview?range=7|30|90|all`  *(auth)*  — default `30`
```ts
// 200 Response
{
  range: '7' | '30' | '90' | 'all';
  reviewed: number;        // total reviews in the range
  correct: number;         // total correct (rating 'good' | 'easy') in the range
  retention: number;       // 0..100, rounded
  streak: number;          // consecutive-day streak ending today (UTC)
  dueCount: number;        // cards due now (same as /srs counter)
  trends: {
    reviewed:  { current: number; previous: number; deltaPct: number };
    retention: { current: number; previous: number; deltaPct: number };
  };
}
```
`trends.*.previous` is the same-length window immediately before the current
one (e.g. `range=30` compares last 30 days vs the 30 days before that).
`deltaPct` is rounded.

#### `GET /stats/series?range=7|30|90|all`  *(auth)*  — default `30`
Per-day review counts. Always one point per day in the range, including zeros.
```ts
// 200 Response
{
  range: '7' | '30' | '90' | 'all';
  points: { label: string; value: number }[];  // label = 'YYYY-MM-DD' UTC
}
```

#### `GET /stats/activity`  *(auth)*
Year heatmap (53 weeks × 7 days, Sun..Sat) and current-month calendar.
```ts
// 200 Response
{
  yearHeat: number[][];                    // 53 columns × 7 rows; values = reviews
  monthCalendar: {
    month: string;                         // 'YYYY-MM' (current UTC month)
    days: ({ date: string; reviews: number } | null)[];
    //   ^ leading nulls pad to start of week; each entry is one day of the month
  };
}
```

#### `GET /stats/decks`  *(auth)*
Per-deck performance for the Statistics screen.
```ts
// 200 Response
{
  items: {
    deckId: string;
    title: string;
    cardCount: number;
    masteryPct: number;       // 0..100
    retention: number;        // 0..100 — proxy from CardProgress repetitions
    reviewed: number;         // all-time review count over the deck's cards
  }[];
}
```
> Note: until a per-rating event log lands (post-P1), `retention` and
> `reviewed` come from `CardProgress.repetitions` as a proxy. Matches the FE's
> current `useDeckStats` heuristic — same numbers either way.

### Discover  *(P2)*

Browse, search, and clone public decks.

#### `GET /discover/decks`  *(auth)*
Paginated public-deck catalog. Same opaque cursor model as `GET /decks`.
```ts
// Query
?cursor?=string
&limit?=number(<=50)             // default 20
&q?=string                       // case-insensitive search on title/description
&lang?=string                    // ISO 639-1; matches sourceLanguage OR targetLanguage
&subject?=string                 // e.g. 'languages', 'science'
&sort?='popular' | 'recent'      // default 'recent'

// 200 Response: PageWithTotal<DeckWithAuthor>
//   = { items: DeckWithAuthor[]; nextCursor: string | null; total: number }
```
Sort keys:
- `recent` → `updatedAt DESC, id DESC`
- `popular` → `copyCount DESC, id DESC`

#### `GET /discover/featured`  *(auth)*
Curator-flagged decks (`featured = true`), max 12. Sorted by `updatedAt DESC`.
```ts
// 200 Response: { items: DeckWithAuthor[] }
```

#### `GET /discover/categories`  *(auth)*
Distinct `subject` values across the public catalog, with deck counts. Top 50
by count.
```ts
// 200 Response: { items: { subject: string; count: number }[] }
```

#### `POST /decks/:id/copy`  *(auth)*
Clone a public deck (cards + cosmetics) into the viewer's account. Atomic:
the source's `copyCount` is incremented in the same transaction. The clone
starts **private** (`isPublic: false`) and carries `sourceDeckId = <original>`.
```ts
// Request: (empty body)
// 201 Response: Deck                          // the freshly-created copy
// Errors:
// 404 DECK_NOT_FOUND  (no such public deck)
```

### AI  *(P2)*

Mimi-powered helpers. The MVP backend ships a **mock provider** so the FE can
wire these surfaces without a real LLM key — response shapes are stable across
the provider swap (set via `AI_PROVIDER` env var).

#### `POST /ai/generate-deck`  *(auth)*
Generates a deck draft based on a topic. **Server does not persist** — the FE
shows the draft to the user, then calls `POST /decks` + bulk card create if
the user accepts.
```ts
// Request
{
  topic: string;                 // 2–160 chars
  sourceLanguage?: string;       // default 'en'
  targetLanguage: string;        // ISO 639-1
  count?: number;                // 1–20, default 8
}

// 200 Response
{
  provider: string;              // 'mock' for MVP
  draft: {
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    subject?: string;
    glyph?: string;
    cards: {
      word: string;
      definition: string;
      phonetic?: string;
      partOfSpeech?: string;
      example?: string;
      exampleTranslation?: string;
      tags?: string[];
      difficulty?: 'easy' | 'medium' | 'hard';
    }[];
  };
}
```

#### `POST /ai/suggest`  *(auth)*
Contextual Mimi nudge for the dashboard / deck detail / review screens.
```ts
// Request
{
  context: 'dashboard' | 'deck_detail' | 'review';  // default 'dashboard'
  deckId?: string;                                   // for context='deck_detail'
}

// 200 Response
{
  suggestion: string;
  kind: 'tip' | 'deck' | 'review';
  actions: { label: string; href: string }[];
}
```

Both endpoints are rate-limited to 30 req/min per user.

### Media  *(P2)*

Single multipart upload endpoint for avatars / card images / card audio. The
MVP backend stores files on local disk and serves them via static handler;
production swaps in S3 presigned PUT URLs without changing the contract shape.

#### `POST /media/uploads?kind=avatar|card_image|card_audio`  *(auth)*
Multipart form: one field named `file`.

| Kind | MIME allowlist | Max size |
|---|---|---|
| `avatar` | `image/png\|jpeg\|webp` | 2 MB |
| `card_image` | `image/png\|jpeg\|webp\|gif` | 5 MB |
| `card_audio` | `audio/mpeg\|mp3\|wav\|ogg\|webm` | 10 MB |

```ts
// Request: multipart/form-data with `file` field
// Query:   ?kind=avatar | card_image | card_audio

// 201 Response (card_image / card_audio)
{
  url: string;          // public URL — store this in card.imageUrl/audioUrl
  kind: 'card_image' | 'card_audio';
  size: number;
  mimeType: string;
}

// 201 Response (avatar) — side-effect: also sets user.avatarUrl
{
  url: string;
  kind: 'avatar';
  size: number;
  mimeType: string;
  user: User;           // the updated user row
}

// Errors:
// 400 MEDIA_NO_FILE      (no `file` field in the multipart)
// 400 MEDIA_BAD_MIME     (MIME outside the allowlist for the kind)
// 422 MEDIA_TOO_LARGE    (exceeds the per-kind size cap)
```

After upload, the URL is served at `GET <url>` (no auth needed; treat as a
public link). For card uploads, `PATCH /cards/:id { audioUrl | imageUrl }` to
attach. For avatars, the response already updated the user row.

### Health (ops)

#### `GET /health`  *(public, **no** `/api/v1` prefix)*
```ts
// 200 Response: { status: 'ok' }
```

---

## 4. Recommended frontend wiring

### `$fetch` / `useFetch` wrapper
Single client in `app/api/_client.ts`:
1. **Base URL**: `http://localhost:3001/api/v1` (read from runtime config).
2. **`credentials: 'include'`** on every call — required so the browser sends
   the `mnemio_refresh` cookie on `/auth/refresh` and `/auth/logout`.
3. **Auth header**: if `accessToken` in `localStorage` → `Authorization: Bearer …`.
4. **401 → auto-refresh**: on response `{ code: 'AUTH_INVALID_TOKEN' }`, call
   `POST /auth/refresh` (no body, cookie travels automatically). On success,
   store the new `accessToken`, retry the original request **once**. On failure
   (`AUTH_INVALID_REFRESH`), hard logout: delete `accessToken`, redirect to
   `/login`.
5. **401 with `AUTH_INVALID_REFRESH`**: hard logout immediately; **never retry**.

### Auth-flow state machine
```
register(email, password)
  → 201 { userId, email }                  → OTP step (carry userId)
verifyEmail(userId, code)
  → 200 { accessToken, user, needsProfile } + cookie set
       needsProfile === true → account-details step (PATCH /users/me)
       needsProfile === false → /dashboard
```
For login:
```
login(email, password)
  → 200 → if needsProfile: account-details step; else /dashboard
  → 401 EMAIL_NOT_VERIFIED → OTP step with details.userId
```

### Session flow
- Starting a new session implicitly ends the active one. Don't fight it from FE.
- Exit button → `POST /sessions/:id/exit`.
- "Continue studying" → `POST /sessions/:id/resume` then route into the study page.
- Don't send `xp` to `/complete`; read it back from the response.

### Pagination wiring
Stash `nextCursor` per list view. "Load more" passes `?cursor=<nextCursor>`.
`null` means "no more pages". Only `GET /decks` exposes `total` (for the
Library header counter); other lists don't, by design.

---

## 5. Local development

```bash
# 1. Start Postgres (Docker Compose)
docker compose up -d db

# 2. Apply migrations
npx prisma migrate deploy
# (If it complains about a prior failed migration:
#   PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma migrate reset --force )

# 3. Seed demo data (skip the OTP scrape during FE integration)
npm run seed
#   → demo@mnemio.local / demo-password-123  (verified, profile complete,
#                                              2 decks of 8–10 cards)

# 4. Run the backend
npm run dev                   # http://localhost:3001
```

For brand-new users in dev, `MAIL_PROVIDER=console` prints OTPs to the backend's
stdout — grep the dev console after `POST /auth/register` for the 6-digit code.

### Quick smoke against the seed (curl)
```bash
BASE=http://localhost:3001/api/v1

# 1. Login (sets mnemio_refresh cookie in cookies.txt)
curl -sX POST "$BASE/auth/login" -c cookies.txt \
     -H 'content-type: application/json' \
     -d '{"email":"demo@mnemio.local","password":"demo-password-123"}'
# → { "accessToken": "...", "user": { ... }, "needsProfile": false }

ACCESS=...      # paste the accessToken from above

# 2. List decks
curl -s "$BASE/decks" -H "Authorization: Bearer $ACCESS"
# → { items: Deck[2], nextCursor: null, total: 2 }

# 3. Deck detail (note: cards is inline, not paginated)
curl -s "$BASE/decks/<deckId>" -H "Authorization: Bearer $ACCESS"
# → { deck: Deck, cards: Card[] }

# 4. Refresh (no body; cookie travels via -b)
curl -sX POST "$BASE/auth/refresh" -b cookies.txt -c cookies.txt
# → { accessToken (new), user, needsProfile }
```

### Full sign-up flow (manual OTP)
```bash
# 1. Register
curl -sX POST "$BASE/auth/register" -H 'content-type: application/json' \
     -d '{"email":"alice@example.com","password":"hunter22!"}'
# → { "userId": "...", "email": "..." }

# 2. Grab the OTP from the backend stdout, then verify
curl -sX POST "$BASE/auth/verify-email" -c cookies.txt \
     -H 'content-type: application/json' \
     -d '{"userId":"<id>","code":"123456"}'
# → { accessToken, user, needsProfile: true } + cookie set
```

---

## 6. What's NOT in this contract

### Coming later
- **Admin surface for `featured`**: today, the `featured` flag is set directly
  in the DB. A `POST /admin/decks/:id/feature` (gated on `user.role='admin'`)
  is a small post-MVP addition when curation moves out of SQL.
- **Real LLM provider for `/ai/*`**: the contract is stable; swap the `mock`
  provider for an Anthropic/OpenAI adapter via `AI_PROVIDER` env.
- **S3-backed media**: the `/media/uploads` shape stays; the storage backend
  swaps from local FS to S3 presigned PUTs (see `src/services/media.service.ts`
  comment header for the migration steps).

### Out of MVP entirely (no plans to ship)
- Password reset / forgot-password (manual support intervention at MVP).
- Folders, leagues.
- Account deletion endpoint.
- WebSockets / push notifications.

If anything in this list becomes urgent, raise it in `backend-plan.md §Open
questions` before wiring the FE.
