# Mnemio Backend — API Contract for Frontend Integration

> Audience: the frontend (`mnemio-frontend`) developer / AI replacing the
> `localStorage`-backed mocks in `app/api/*.ts` with real HTTP calls.
> Read [`backend-plan.md`](./backend-plan.md) for the *why*; this file is the *what*.

## 0. Status

**Contract is complete.** P0 + P1 + P2 from `backend-plan.md` are all shipped,
plus the post-MVP additions (Google OAuth, account deletion, welcome flags,
Quizlet/text imports, deck import/export, real-time AI chat, and paid
subscriptions via Stripe). **65 endpoints under `/api/v1`** + `GET /health` +
`GET /ready` + static `/media/*`. Nothing in this document is "coming later"
unless it says so explicitly.

### Endpoint inventory (65 under `/api/v1`)

| Domain | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `verify-email`, `resend-otp`, `login`, `refresh`, `logout` · `GET /auth/me` · `GET /auth/oauth/google`, `/auth/oauth/google/callback` · `POST /auth/oauth/exchange` |
| Users | `PATCH /users/me` · `DELETE /users/me` · `GET /users/me/preferences` · `PATCH /users/me/preferences` |
| Decks | `GET /decks` · `POST /decks` · `GET /decks/:id` · `PATCH /decks/:id` · `DELETE /decks/:id` · `GET /decks/:id/export` · `POST /decks/:id/cards/import` |
| Cards | `POST /decks/:id/cards` · `POST /decks/:id/cards/bulk` · `PATCH /cards/:id` · `DELETE /cards/:id` |
| Sessions | `POST /sessions` · `PATCH /sessions/:id` · `POST /sessions/:id/complete` · `POST /sessions/:id/exit` · `POST /sessions/:id/resume` · `GET /sessions/active` · `GET /sessions/incomplete` |
| SRS | `POST /srs/rate` · `GET /srs/due` · `GET /srs/progress` |
| Dashboard | `GET /dashboard` |
| Achievements | `GET /achievements` |
| Stats | `GET /stats/overview` · `GET /stats/series` · `GET /stats/activity` · `GET /stats/decks` |
| Discover | `GET /discover/decks` · `GET /discover/featured` · `GET /discover/categories` · `POST /decks/:id/copy` |
| AI | `POST /ai/enrich-words` · `POST /ai/generate-deck` · `POST /ai/suggest` |
| Imports | `POST /imports/quizlet` · `POST /imports/text` |
| Chat | `GET /chat/conversations` · `POST /chat/conversations` · `GET /chat/conversations/:id` · `PATCH /chat/conversations/:id` · `DELETE /chat/conversations/:id` · `POST /chat/conversations/:id/messages` |
| Public (SEO) | `GET /public/discover/decks` · `GET /public/discover/categories` · `GET /public/decks/:id` · `GET /public/sitemap/decks` |
| Media | `POST /media/uploads` (+ static serve at `GET /media/<userId>/<file>`) |
| Billing | `POST /billing/checkout` · `GET /billing/subscription` · `POST /billing/portal` · `POST /billing/webhook` |
| Ops | `GET /health` · `GET /ready` (both un-prefixed) |

### Invariants the FE must respect

| # | Rule |
|---|---|
| 1 | Refresh token is an **HttpOnly cookie** `mnemio_refresh` on path `/api/v1/auth`. **Never in any body.** Send `credentials: 'include'` on every call. |
| 2 | Access token in `localStorage`, sent as `Authorization: Bearer …`. |
| 3 | On `{ code: 'AUTH_INVALID_TOKEN' }` → `POST /auth/refresh` (no body), retry once; on `{ code: 'AUTH_INVALID_REFRESH' }` → hard logout, never retry. |
| 4 | `POST /srs/rate` body is `{ cardId, rating }` — `'again'\|'hard'\|'good'\|'easy'`. Server derives `deckId`. |
| 5 | Session XP is **server-computed** `correct*10 + 25`. Never send `xp`. The user's total `xp` changes server-side — refresh via `/auth/me` or `/dashboard.stats.xp`. |
| 6 | `User.fullName` (was `displayName`); `User.streak` is exposed but always `0` — use `/stats/overview.streak` instead. |
| 7 | Username-taken error code is `AUTH_USERNAME_TAKEN`. |
| 8 | Every list response is `{ items, nextCursor }`; one variant (`GET /decks`) adds `total`. Cursor is opaque. |
| 9 | Ownership is checked at the repo layer — listing/**modifying** someone else's deck/card/session always returns `404 *_NOT_FOUND` or `403 *_FORBIDDEN`. **Exception (public decks):** an authenticated non-owner may **read, study, and rate** a deck with `isPublic = true` — `GET /decks/:id`, `POST /sessions`, and `POST /srs/rate` succeed. SRS is keyed by `(requesterId, cardId)`, so each studier has fully independent progress and a viewer never touches the owner's. **Writes stay owner-only** (`PATCH`/`DELETE` deck, all card create/update/delete). Flipping `isPublic = false` re-locks read/study/rate immediately (back to `404`); previously-written viewer SRS rows persist but become unreachable. |
| 10 | Only one `active` session per user. Both `POST /sessions` and `POST /sessions/:id/resume` flip a pre-existing active session to `incomplete` atomically. |
| 11 | Every auth response (`login`, `verify-email`, `refresh`, `me`) now carries `welcome: { hasDeck, hasSession, hasReviewed }` — use it for dashboard variant selection instead of fanning out three count probes from the FE. |
| 12 | `/imports/*` and `/ai/*` share a per-user daily-cap rollup in `ai_usage`. A user can hit the import cap without affecting AI calls and vice versa — distinct error codes (`IMPORT_BUDGET_EXCEEDED` vs `AI_BUDGET_EXCEEDED`). |
| 13 | `/chat/conversations/:id/messages` is the only endpoint where partial-success matters: a streamed assistant reply that gets cut mid-flight is persisted with `status: 'partial'` and the user is NOT charged a daily-cap unit. The FE can render the half-reply and offer "retry." |
| 14 | `GET /auth/me` (and every token-issuing auth response) now returns `plan: 'free' \| 'premium'` at the top level. Store it in auth state alongside `user` — the FE uses it to show/hide premium UI and to optimistically gate features before the server enforces them. On `403 PREMIUM_REQUIRED` from any endpoint, show the paywall modal (the server enforces even if the FE shows the feature). |

### Demo data
`npm run seed` creates `demo@mnemio.local` / `demo-password-123` (pre-verified,
profile complete, 2 decks of 8–10 cards). Skips the OTP scrape during FE
integration testing.

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
| `AI_TOO_MANY_WORDS` | `POST /ai/enrich-words` | "Max {max} words per batch — got {got}." `details.{max,got}` |
| `AI_BUDGET_EXCEEDED` | any `/ai/*` | "Daily AI quota reached." `details.kind`, `details.capPerDay` |
| `AI_PROVIDER_ERROR` | any `/ai/*` | Generic "AI is having a moment — try again." `details.providerStatus` for logs |
| `AI_VALIDATION_FAILED` | any `/ai/*` | Same UX as provider error; LLM returned garbage |
| `IMPORT_BAD_URL` | `POST /imports/quizlet` | "URL must be a `quizlet.com` set link." |
| `IMPORT_NOT_FOUND` | `POST /imports/quizlet` | "Set is private, removed, or doesn't exist." |
| `IMPORT_PARSE_FAILED` | `POST /imports/*` · `POST /decks/:id/cards/import` | "Couldn't parse this content." Suggest pasting text instead for Quizlet. |
| `IMPORT_UPSTREAM_ERROR` | `POST /imports/quizlet` | "Quizlet didn't respond — try again." `details.providerStatus` |
| `IMPORT_BUDGET_EXCEEDED` | `POST /imports/*` | "Daily import quota reached." `details.capPerDay` |
| `OAUTH_NOT_CONFIGURED` | `/auth/oauth/*` | "Google sign-in isn't enabled on this deployment." Hide the button. |
| `OAUTH_BAD_EXCHANGE_CODE` | `POST /auth/oauth/exchange` | "Sign-in code missing — start over." |
| `OAUTH_EXCHANGE_EXPIRED` | `POST /auth/oauth/exchange` | "Sign-in took too long — start over." |
| `OAUTH_EMAIL_UNVERIFIED` | `/auth/oauth/google/callback` | Surface via the `/auth/oauth/error?reason=` redirect. |
| `AUTH_EMAIL_UNVERIFIED_LINK` | `/auth/oauth/google/callback` | The user already has an unverified password account with that email; tell them to verify it first or use a different Google account. |
| `NOT_READY` | `GET /ready` | 503 — DB ping failed. Ops-only; FE doesn't call `/ready`. |
| `CHAT_NOT_FOUND` | any `/chat/conversations/:id*` | 404 — conversation missing or owned by someone else. |
| `PREMIUM_REQUIRED` | any gated endpoint | 403 — feature requires an active subscription. Show paywall/upgrade modal. |
| `BILLING_NOT_CONFIGURED` | any `/billing/*` | 400 — Stripe keys absent on this deployment. Hide billing UI entirely. |
| `BILLING_NO_SUBSCRIPTION` | `GET /billing/subscription` · `POST /billing/portal` | 404 — user has no subscription row. Treat the same as `plan: 'free'`. |
| `BILLING_PRICE_NOT_CONFIGURED` | `POST /billing/checkout` | 400 — specific plan price ID missing in env. Fall back to the other plan or show "unavailable". |

**429 envelope:** `@fastify/rate-limit` is now configured with our standard
envelope, so a rate-limited request returns
`{ code: 'RATE_LIMITED', message, details: { retryAfter, max } }`.

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
  streak: number;              // ALWAYS 0 — use /stats/overview.streak instead
  createdAt: string;
  updatedAt: string;
};

// Returned at the top level of GET /auth/me and every token-issuing response
// alongside `user`. Distinct from User so auth state can hold both without nesting.
type Plan = 'free' | 'premium';

// Current subscription details. Returned by GET /billing/subscription.
// Null / 404 means no subscription row exists — treat as plan: 'free'.
type Subscription = {
  id: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
  plan: 'monthly' | 'annual';
  currentPeriodStart: string;   // ISO 8601 UTC
  currentPeriodEnd: string;     // ISO 8601 UTC — access until this date on 'canceled'
  cancelAtPeriodEnd: boolean;   // true when user canceled but period hasn't ended
  trialEnd: string | null;      // ISO 8601 UTC, non-null only during 'trialing'
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

// Returned on every token-issuing auth response + GET /auth/me.
type WelcomeState = {
  hasDeck: boolean;
  hasSession: boolean;
  hasReviewed: boolean;
};

// Ephemeral card draft — used as both the AI-enrichment / generate-deck
// output and the /imports/* output, so the FE renders one review/preview
// UI for all three sources.
type AiCardDraft = {
  word: string;
  definition: string;
  phonetic?: string;
  partOfSpeech?: string;
  example?: string;
  exampleTranslation?: string;
  tags?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
};

// Real-time chat (POST /chat/*). Conversations are server-persisted so the
// user can resume across devices. Messages are append-only — re-sending the
// same prompt creates a new ChatMessage row, never edits an existing one.
type Conversation = {
  id: string;
  title: string;           // auto-set from the first user message; user can rename
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;   // drives sidebar order
};

type ChatMessageRole = 'user' | 'assistant' | 'system';
type ChatMessageStatus = 'complete' | 'partial';   // 'partial' when a stream got cut

type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;                 // plain text or markdown — no HTML
  status: ChatMessageStatus;
  tokensInput: number | null;      // assistant rows only
  tokensOutput: number | null;     // assistant rows only
  attachments?: ChatAttachment[];  // present when the assistant ran a tool
  createdAt: string;
};

// Structured side-effect produced when the chat model called a tool. Today
// the only kind is 'deck' (the create_deck / add_cards tools). Future tools
// (audio, image, study session…) extend this discriminated union without
// breaking the FE contract.
type ChatAttachment = {
  type: 'deck';
  deckId: string;
  title: string;
  cardCount: number;                  // the deck's CURRENT total after the tool ran
  action?: 'created' | 'appended';    // 'created' = create_deck, 'appended' = add_cards
  addedCount?: number;                // cards just appended (only on action: 'appended')
};
```

### `needsProfile` flag
Most auth responses include `needsProfile: boolean` alongside `user`. It's
`true` when `user.username` or `user.fullName` is `null`. **Use this flag — not
local heuristics — to decide whether to send the user to the account-details
step.**

### `welcome` flags
Auth responses also carry a `welcome` block — three booleans the FE can use to
pick between the empty-state dashboard and "Continue studying":
```ts
welcome: {
  hasDeck:     boolean,  // user has authored at least one deck
  hasSession:  boolean,  // user has at least one completed study session
  hasReviewed: boolean,  // user has at least one CardProgress row
}
```
Computed via three `count > 0` probes in parallel (~3ms). Refreshed on every
`/auth/me`, `/auth/login`, `/auth/refresh`, `/auth/verify-email` — so once a
user creates their first deck, the next response flips `hasDeck`.

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
{ accessToken: string; user: User; needsProfile: boolean; welcome: WelcomeState }

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
{ accessToken: string; user: User; needsProfile: boolean; welcome: WelcomeState }

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
{ accessToken: string; user: User; needsProfile: boolean; welcome: WelcomeState }

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
// 200 Response: { user: User; needsProfile: boolean; welcome: WelcomeState; plan: Plan }
// Errors: 401 AUTH_INVALID_TOKEN → try /auth/refresh
```
`plan` is the fast entitlement check — `'premium'` when the user has an active
subscription (`status ∈ {trialing, active, past_due, canceled}` and
`currentPeriodEnd > now`). Use it to show/hide UI. The server enforces gating
independently; the FE never fully trusts it for hard access control.

#### Google OAuth flow (3 endpoints)

End-to-end:
1. FE redirects the user to `GET /auth/oauth/google` (backend sets state
   + PKCE cookies, redirects to Google).
2. Google sends the user to `/auth/oauth/google/callback?code=...&state=...`.
   Backend validates state, exchanges the code, looks up or creates the
   user, **sets the `mnemio_refresh` cookie**, generates a short-lived
   exchange code, and 302-redirects to
   `${WEB_URL}/auth/oauth/callback?code=<short_lived>`.
3. FE swaps the short code via `POST /auth/oauth/exchange { code }` and
   gets `{ accessToken, user, needsProfile, welcome }`.

Identity-linking policy:
- Existing OAuth identity for `(provider, providerUserId)` → sign in that user.
- Existing **verified** password user with the same email → link OAuth
  identity, sign in.
- Existing **unverified** password user with the same email → error
  `AUTH_EMAIL_UNVERIFIED_LINK` (would let an attacker hijack a half-finished
  registration).
- Else → create a new user with `emailVerifiedAt = now()`, link identity, sign in.

```ts
GET /auth/oauth/google      → 302 to https://accounts.google.com/...
GET /auth/oauth/google/callback?code=&state=
  → on success: 302 to ${WEB_URL}/auth/oauth/callback?code=<short>
  → on failure: 302 to ${WEB_URL}/auth/oauth/error?reason=<...>
                 (reasons: missing_state | bad_state | missing_code |
                  exchange_failed | OAUTH_EMAIL_UNVERIFIED | etc.)

POST /auth/oauth/exchange
  Body: { code: string }
  200:  { accessToken, user, needsProfile, welcome }   // refresh cookie already set
  Errors:
    400 OAUTH_BAD_EXCHANGE_CODE
    400 OAUTH_EXCHANGE_EXPIRED      — older than 60s or already redeemed
    400 OAUTH_NOT_CONFIGURED        — server is missing Google creds
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

#### `DELETE /users/me`  *(auth)*
Permanently delete the signed-in account. Cascades wipe decks, cards,
sessions, progress, achievements, preferences, AI usage, refresh tokens,
email verifications, and OAuth identities. `audit_log` rows survive with
`userId = NULL` (security trail). Idempotent — re-issuing returns 204.
```ts
// Request: (no body)
// 204 No Content  +  Set-Cookie: mnemio_refresh=; Max-Age=0
```
FE should also delete `accessToken` from `localStorage` and hard-redirect
to the marketing landing page.

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

Returns to the **owner** OR any authenticated user when the deck is
`isPublic = true` (see invariant #9). `role`/`isOwner` tell the FE which UI to
render; `stats` always reflect **the requester's** SRS, never the owner's. A
private deck 404s for non-owners.
```ts
// Query: ?cardsLimit?=number(<=1000)  default 1000

// 200 Response
{
  deck: Deck;                // deck.stats = the REQUESTER's progress
  cards: Card[];             // sorted by (position ASC, id ASC), up to cap
  role: 'owner' | 'viewer';
  isOwner: boolean;
}
// Errors: 404 DECK_NOT_FOUND   (also when a non-owner requests a private deck)
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

#### `GET /decks/:id/export?format=csv|json`  *(auth)*
File download of every card in the deck (in `position` order).
- `csv` (default): columns `word,definition,phonetic,reading,partOfSpeech,
  example,exampleTranslation,tags,difficulty,type`. `tags` are joined with
  `;`. Quoting follows RFC 4180 for embedded commas, quotes, and newlines.
- `json`: `{ deck: { title, description, sourceLanguage, targetLanguage },
  cards: Card[] }` — drop IDs, timestamps, and media URLs (those don't
  re-import).

```ts
// 200 Response:
//   Content-Type: text/csv | application/json
//   Content-Disposition: attachment; filename="<deck-slug>.<ext>"
//   Body: file payload
// Errors: 404 DECK_NOT_FOUND
```

#### `POST /decks/:id/cards/import`  *(auth)*
Bulk-add cards to an existing deck from a CSV or JSON payload (typically
produced by `GET /decks/:id/export` from this app or another). Pasted text
is fine — multipart isn't required.
```ts
// Request
{
  format: 'csv' | 'json';
  text: string;       // ≤ 1 000 000 chars
}

// 201 Response: { created: number }

// Errors:
// 400 VALIDATION_ERROR        — empty body or unknown format
// 404 DECK_NOT_FOUND          — caller doesn't own the deck
// 422 IMPORT_PARSE_FAILED     — couldn't extract any cards from the input
```

CSV must include a header row with at least `word` and `definition`.
Unknown columns are ignored. Invalid `difficulty`/`type` values are
dropped (the import doesn't fail). JSON accepts either a bare card array
or `{ deck?, cards: [...] }` — `deck` metadata is ignored, only `cards`
are imported.

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

Mnemio's AI surface. The backend supports two providers via `AI_PROVIDER` env:
- `mock` (default) — deterministic placeholders; FE-safe, no LLM cost.
- `anthropic` — Claude Haiku 4.5 via `@anthropic-ai/sdk`. Requires
  `ANTHROPIC_API_KEY`.

**Response shapes are identical across providers.** The FE never branches on
provider.

#### `POST /ai/enrich-words`  *(auth)* ⭐ key feature
Takes a user-supplied list of words and returns one `AiCardDraft` per word
with definition + optional metadata. **Server does not persist** — the FE
shows the result, lets the user review, then commits via the existing
`POST /decks/:id/cards/bulk` (works for both "add to open deck" and
"create new deck then bulk-add" flows).

```ts
// Request
{
  words: string[];               // 1–100 (server-enforced cap), each 1–80 chars
  sourceLanguage: string;        // language for the definition (e.g. 'en')
  targetLanguage: string;        // language of the input words (e.g. 'es')
  context?: string;              // optional disambiguation hint, ≤ 200 chars
  fields?: ('phonetic' | 'partOfSpeech' | 'example' | 'exampleTranslation'
            | 'tags' | 'difficulty')[];   // which optional fields to fill;
                                          // default: all
}

// 200 Response (non-streaming — no Accept: text/event-stream)
{
  provider: 'mock' | 'anthropic';
  cards: AiCardDraft[];          // SAME order/length as request `words`
                                 // (after server-side trim + de-dup)
  meta: {
    requested: number;           // = words.length after de-dup
    enriched: number;            // = cards where definition !== ''
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
  };
}
```

**Invariants:**
- **Order preserved.** `cards[i].word` matches `words[i]` (post-trim/dedup).
- **Partial success.** Words the LLM can't define come back with
  `definition: ''` and `tags: ['ai-unfilled']`. Blocked content returns
  `tags: ['ai-blocked']`. Never fails the whole batch on a single bad word.
- **Server-side dedup.** Duplicates in the paste are collapsed before the
  LLM call (case-insensitive). FE re-expands if it needs the user's paste
  order verbatim.

**Errors:**
- `400 AI_TOO_MANY_WORDS` — input exceeds `AI_MAX_WORDS_PER_ENRICH` (default 100).
- `429 AI_BUDGET_EXCEEDED` — daily per-user cap hit.
- `502 AI_PROVIDER_ERROR` — upstream LLM failure; retry with backoff.
- `502 AI_VALIDATION_FAILED` — provider output failed schema validation
  after one retry.

##### Streaming variant — same endpoint, `Accept: text/event-stream`

For 50-word batches that take 5–8s, the FE can stream cards as they arrive
instead of staring at a spinner. Send `Accept: text/event-stream` on the same
POST (or `?stream=1`) and the backend writes Server-Sent Events:

```
event: start
data: { "provider": "anthropic" }

event: card
data: { "type": "card", "position": 0,
        "card": { "word": "agua", "definition": "water", "..." } }

event: card
data: { "type": "card", "position": 1,
        "card": { "word": "pan", "definition": "bread", "..." } }

...

event: done
data: { "type": "done", "meta": { "requested": 8, "enriched": 8, "..." } }
```

If a mid-stream error occurs, the backend emits one `event: error` frame with
the standard envelope (`{ code, message, details? }`) before closing.

FE pattern: read with `fetch().then(r => r.body.getReader())` and parse the
SSE frames; map each `card` event into the table by `position`.

#### `POST /ai/generate-deck`  *(auth)*
Generates a deck draft from a topic (no input word list). Useful when the
user has no list yet ("just give me 8 Italian café terms"). **Server does
not persist** — the FE shows the draft and the user accepts via
`POST /decks` + `POST /decks/:id/cards/bulk`.

```ts
// Request
{
  topic: string;                 // 2–160 chars
  sourceLanguage?: string;       // default 'en'
  targetLanguage: string;        // ISO 639-1
  count?: number;                // 1–20, default 8
}

// 200 Response (non-streaming)
{
  provider: 'mock' | 'anthropic';
  draft: {
    title: string;
    description: string;
    sourceLanguage: string;
    targetLanguage: string;
    subject?: string;
    glyph?: string;
    cards: AiCardDraft[];
  };
}
```

##### Streaming variant — `Accept: text/event-stream`

Same SSE protocol as enrich-words, but with one additional event type:
`header` fires first (with `title/description/subject/glyph/…`) so the FE can
render the deck shell before any cards arrive. Then `card` events for each
generated card, then `done`.

#### `POST /ai/suggest`  *(auth)*
Contextual Mimi nudge for the dashboard / deck detail / review screens.
Always single-response (small payload, no streaming needed).
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

#### Common — rate limits + budget

| Limit | Free tier | Premium tier | Throws |
|---|---|---|---|
| Request rate | 30/min/user | 30/min/user | `429 RATE_LIMITED` |
| Daily `enrich` cap | 5/day | 50/day (env) | `429 AI_BUDGET_EXCEEDED` |
| Daily `generate` cap | 20/day | 200/day (env) | `429 AI_BUDGET_EXCEEDED` |
| Daily `suggest` cap | 60/day | 600/day (env) | `429 AI_BUDGET_EXCEEDED` |
| Daily `chat` cap | 50/day | 500/day (env) | `429 AI_BUDGET_EXCEEDED` |
| Daily `import` cap | 20/day | 200/day (env) | `429 IMPORT_BUDGET_EXCEEDED` |
| Max words per `enrich` call | 100 | 100 | `400 AI_TOO_MANY_WORDS` |

Free and premium caps are independently configurable via env
(`AI_DAILY_*_CAP_PER_USER` for free, `AI_DAILY_*_CAP_PREMIUM_PER_USER` for
premium). The cap used is determined server-side from the caller's active
subscription — the FE never sends plan information in the request body.

### Imports  *(Quizlet + paste-text)*

Stateless: nothing is persisted by these endpoints. They return
`AiCardDraft[]` in the same shape as `/ai/enrich-words` so the FE reuses
the existing review/preview UI, then commits with `POST /decks` and
`POST /decks/:id/cards/bulk`.

#### `POST /imports/quizlet`  *(auth)*
Fetches a Quizlet public-set URL, extracts term/definition pairs from the
embedded `__NEXT_DATA__` JSON, returns the cards.
```ts
// Request
{ url: string }   // https://quizlet.com/<setId>/<slug>/

// 200 Response
{
  source: { kind: 'quizlet'; setId: string; title: string };
  cards: AiCardDraft[];     // same shape as /ai/enrich-words result
}

// Errors:
// 400 IMPORT_BAD_URL          — url isn't a quizlet.com set URL
// 404 IMPORT_NOT_FOUND        — set is private, removed, or 404
// 422 IMPORT_PARSE_FAILED     — fetched OK but couldn't extract cards
//                               (Quizlet may have changed their HTML)
// 429 IMPORT_BUDGET_EXCEEDED  — daily per-user cap reached (details.capPerDay)
// 502 IMPORT_UPSTREAM_ERROR   — Quizlet returned non-200 or timed out
```

Counts against a shared `import` daily cap (`IMPORT_DAILY_CAP_PER_USER`,
default 20) regardless of which import endpoint is used.

> **ToS note for the FE:** add a one-line confirmation in the FE flow —
> "By importing, you confirm you have the right to use this content."
> Quizlet's ToS prohibits automated scraping; this is the same pattern
> Anki-style importers use, but the legal responsibility ultimately
> belongs to the importing user.

#### `POST /imports/text`  *(auth)*
Paste-fallback for users who can't or won't share a Quizlet URL. Parses
TSV (`word<TAB>definition`), CSV (`word,definition`), or newline-paired
(`word\ndefinition\nword\n…`).
```ts
// Request
{
  text: string;
  format?: 'tsv'|'csv'|'newline'|'auto'   // default 'auto' (detect by first-line punctuation)
}

// 200 Response
{
  source: { kind: 'text'; format: 'tsv'|'csv'|'newline' };
  cards: AiCardDraft[];
}

// Errors:
// 400 VALIDATION_ERROR       — empty text or > 100 000 chars
// 422 IMPORT_PARSE_FAILED    — no card pairs could be extracted
// 429 IMPORT_BUDGET_EXCEEDED — shared cap with /imports/quizlet
```

### Chat  *(real-time AI)*

Server-persisted multi-turn chat against Claude Haiku 4.5. Conversations
live in their own tables so users can resume on any device; the sidebar
orders by `lastMessageAt DESC`. Each user-message turn counts against the
`chat` daily cap (`AI_DAILY_CHAT_CAP_PER_USER`, default 50).

The send-message endpoint streams tokens via SSE; all other endpoints are
plain JSON. SSE-or-JSON negotiation is the same `Accept: text/event-stream`
+ `?stream=1` switch the other AI endpoints use.

#### `GET /chat/conversations`  *(auth)*
Sidebar list. Cursor-paginated by `lastMessageAt DESC, id DESC`.
```ts
// Query: ?cursor?=string&limit?=number(<=100)   default limit 20
// 200 Response: Page<Conversation>
```

#### `POST /chat/conversations`  *(auth)*
Create a new conversation. Empty body is fine — the FE typically creates
first and sends the user's first message in a follow-up call.
```ts
// Request
{ title?: string }                  // 1..120 chars; defaults to 'New chat'

// 201 Response: Conversation
```

#### `GET /chat/conversations/:id`  *(auth)*
Fetch the conversation header plus its most recent 50 messages
(`createdAt ASC, id ASC`).
```ts
// 200 Response: { conversation: Conversation; messages: ChatMessage[] }
// Errors: 404 CHAT_NOT_FOUND
```

#### `PATCH /chat/conversations/:id`  *(auth)*
Rename. Replaces the auto-generated title.
```ts
// Request: { title: string }       // 1..120 chars
// 200 Response: Conversation
// Errors: 404 CHAT_NOT_FOUND
```

#### `DELETE /chat/conversations/:id`  *(auth)*
Hard delete. Cascades to all messages.
```ts
// 204 No Content
// Errors: 404 CHAT_NOT_FOUND
```

#### `POST /chat/conversations/:id/messages`  *(auth)*
Append a user message and stream the assistant reply.
```ts
// Request
{
  content: string;                  // 1..4000 chars (trimmed)
  deckId?: string;                  // uuid — the deck the user currently has OPEN.
                                    // When present (and owned), unlocks the
                                    // add_cards tool so "add these words to this
                                    // deck" appends instead of creating a new deck.
  locale?: string;                  // the chat/UI language, e.g. "uk", "en-US".
                                    // Normalized to an ISO 639-1 code server-side.
                                    // Drives the reply language and the default
                                    // create_deck/add_cards language pair when the
                                    // user doesn't ask for a specific one.
}
```

**SSE response** (when `Accept: text/event-stream` or `?stream=1`):
```
event: start
data: {
  userMessage: ChatMessage,
  assistantMessageId: string        // the still-empty placeholder we'll fill via tokens
}

event: token
data: { delta: string }             // one event per provider chunk

# Optional pair — emitted only when the model calls a tool.
# Tools: create_deck (always) and add_cards (only when the request carried a
# deckId the user owns).
event: tool_use
data: { name: 'create_deck' | 'add_cards', input: { topic?, words?, ... } }

event: tool_result
data: {
  name: 'create_deck' | 'add_cards',
  ok: boolean,                       // true on success
  data: ChatAttachment | { reason: string }  // attachment on ok:true, reason on ok:false
}

# IMPORTANT (BUG-2506-12): any tokens streamed BEFORE `tool_use` are a neutral
# pre-tool preamble, NOT a result — the FE should clear them on `tool_use` and
# render the post-`tool_result` tokens. The persisted `assistantMessage.content`
# is the post-tool text only, so a "added it" confirmation can never appear
# without a matching successful `tool_result`. More `event: token` frames follow
# after the tool runs.

event: done
data: {
  assistantMessage: ChatMessage,    // status: 'complete', tokens populated, attachments populated when a tool fired
  conversationTitle: string,        // may have been auto-set on the first turn
  tokensInput: number,              // sum of round-1 + round-2 when a tool fired
  tokensOutput: number
}

event: error                         // mid-stream failure
data: { code: string, message: string, details?: object }
```

**Tool semantics:** two deck tools, chosen by the model:
- **`create_deck`** — when the user wants a NEW deck (explicit words, topic
  request, "make me a deck"…). Persists a fresh `Deck` + `Card[]`; attachment
  `action: 'created'`.
- **`add_cards`** — appends to the deck the user is viewing. Offered **only**
  when the request carried a `deckId` the caller owns; the target deckId comes
  from that context (never from the model), and the new cards use the deck's
  own languages. Persists `Card[]` onto the existing deck via the same
  bulk-create path; attachment `action: 'appended'`, `addedCount: N`, and
  `cardCount` = the deck's new total.

Both run via the existing `enrich-words` / `generate-deck` pipeline. The final
`assistantMessage.attachments` carries the affected deck so the FE can render a
link card and refresh the open deck.

**Content matching the chat text:** the model is instructed to pass `words` —
the exact items it names in its reply — for any enumerable request ("10 names
of X", a specific list/category); `topic` is reserved for genuinely open-ended
requests. This keeps the persisted cards in sync with what Mimi told the user.
The `tool_result` JSON the model sees (not the FE-facing attachment) also
includes the first ~10 persisted `words`, so the model's post-tool reply is
grounded in what was actually saved rather than re-deriving it from memory.
The `topic` branch (`generateDeck`) additionally gets one deterministic retry
if the draft comes back empty or well short of the requested `count`.

**Language:** `create_deck`/`add_cards` resolve source/target languages with
this precedence: an explicit pair the model passes (honoring a custom request
like "words in Spanish, definitions in Portuguese") wins; otherwise the
request's `locale` is the default; otherwise the user's saved preferences;
otherwise a hardcoded fallback. Every language value (`locale`, model output,
and `Deck.sourceLanguage`/`targetLanguage`/`Preference` fields) is normalized
to an ISO 639-1 code (`src/shared/lang.ts`) before persisting — full names like
"English" are mapped to `en` — so the FE's code-keyed language `<select>`
always has a match.

If the tool fails (`ok: false`), no attachment is persisted, the model writes a
text apology (post-tool), and `assistantMessage.attachments` is omitted. The
user is still charged one `chat` budget unit. The error code lives in
`tool_result.data.reason` (`AI_BUDGET_EXCEEDED`, `DECK_NOT_FOUND`,
`NEEDS_WORDS_OR_TOPIC`, `AI_PROVIDER_ERROR`, `INTERNAL`, …).

After an `event: error` the assistant message stays in the database with
`status: 'partial'` and whatever text we got before the failure. The user
is NOT charged a daily-cap unit. The FE should render the partial reply
and offer the user a "retry" affordance.

**Non-SSE response** (default JSON):
```ts
// 200 Response
{
  userMessage: ChatMessage,
  assistantMessage: ChatMessage,
  conversationTitle: string,
  tokensInput: number,
  tokensOutput: number
}

// Errors:
// 404 CHAT_NOT_FOUND        — caller doesn't own this conversation
// 429 AI_BUDGET_EXCEEDED    — details.kind === 'chat', details.capPerDay
// 429 RATE_LIMITED          — per-route 30 req/min/user throttle
// 502 AI_PROVIDER_ERROR     — Anthropic returned non-200
// 502 AI_VALIDATION_FAILED  — provider returned nothing usable
```

**Context window:** the backend sends only the most recent
`AI_CHAT_CONTEXT_TURNS` (default 20) `user`+`assistant` messages to the
LLM, oldest first. Older messages remain in the DB and are returned by
`GET /chat/conversations/:id` for display but don't ride along to Claude.

**Auto-title rule:** on the user's first message in a conversation, the
title flips from `"New chat"` to the trimmed message (up to 60 chars, ellipsis
suffix when truncated). Subsequent turns leave the title alone.

### Public (SEO)

Unauthenticated, read-only mirror of the discover surface for marketing
pages, server-rendered deck previews, and `sitemap.xml` generation. All
filters match the authed `/discover/*` endpoints — when a deck flips
`isPublic` to false, it disappears from both sides in lock-step.

Per-route throttle: 60 req/min/IP on the browsing endpoints, 10 req/min/IP
on the sitemap.

#### `GET /public/discover/decks`  *(public)*
```ts
// Same query string as authed GET /discover/decks:
//   ?cursor?=string&limit?=number(<=50)&q?=string&lang?=string
//   &subject?=string&sort?=popular|recent   (default 'recent')
// 200 Response: PageWithTotal<DeckWithAuthor>
```

Per-user mastery is omitted (no viewer concept). `stats.mastered`,
`stats.learning`, `stats.due` are all `0` — `stats.total`, `stats.new`,
`stats.masteredPct` still come from the deck's own `cardCount`.

#### `GET /public/discover/categories`  *(public)*
```ts
// 200 Response: { items: { subject: string; count: number }[] }
```
Identical body to the authed variant.

#### `GET /public/decks/:id`  *(public)*
```ts
// 200 Response: { deck: DeckWithAuthor; cards: Card[] }
// Errors: 404 DECK_NOT_FOUND   (deck is private, missing, or has isPublic=false)
```
Cards inlined the same way as the authed `GET /decks/:id`. SEO renderer
can build the page without a second request.

#### `GET /public/sitemap/decks`  *(public)*
Minimal projection — id + ISO `updatedAt` — for the FE's `sitemap.xml`
generator. Hard cap of 50 000 rows per the sitemap protocol; split into
shards before then.
```ts
// 200 Response: { items: { id: string; updatedAt: string }[] }
```

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

### Billing

Stripe-powered subscription management. Requires `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, and `STRIPE_PRICE_ANNUAL` to
be set in the backend env. When any of these are absent, every `/billing/*`
call returns `400 BILLING_NOT_CONFIGURED` — the FE should hide billing UI
entirely in that case (useful for local dev without a Stripe account).

#### `POST /billing/checkout`  *(auth)*
Create a Stripe Checkout session and return the hosted-page URL. The FE
redirects the user to that URL; Stripe handles card collection, then redirects
back.
```ts
// Request
{ plan: 'monthly' | 'annual' }

// 201 Response
{ url: string }   // redirect the user here (window.location = url)

// Errors:
// 400 BILLING_NOT_CONFIGURED     — Stripe keys missing
// 400 BILLING_PRICE_NOT_CONFIGURED — env missing STRIPE_PRICE_MONTHLY/ANNUAL
```
Stripe redirects back to:
- Success: `${WEB_URL}/billing/success?session_id=<id>`
- Cancel: `${WEB_URL}/billing/cancel`

On the success page, poll `GET /billing/subscription` until `status` becomes
`active` or `trialing` (webhook fires within ~1 s in practice; 3 s poll is
fine).

#### `GET /billing/subscription`  *(auth)*
Current subscription details.
```ts
// 200 Response: Subscription
// 404 BILLING_NO_SUBSCRIPTION — user has no subscription row (plan: 'free')
```

#### `POST /billing/portal`  *(auth)*
Create a Stripe Customer Portal session and return the URL. The portal lets
the user cancel, change payment method, or download invoices — all without
any custom UI.
```ts
// Request: (empty body)

// 201 Response
{ url: string }   // redirect the user here

// Errors:
// 400 BILLING_NOT_CONFIGURED
// 404 BILLING_NO_SUBSCRIPTION — user has never subscribed
```

#### `POST /billing/webhook`  *(public — Stripe-signed, **no** JWT)*
Stripe event receiver. The FE **never calls this directly** — it is only for
Stripe's servers. Listed here for completeness.

The backend processes:
| Stripe event | Effect |
|---|---|
| `customer.subscription.created` | Upsert subscription row (→ `trialing`/`active`) |
| `customer.subscription.updated` | Update status, plan, period, `cancelAtPeriodEnd` |
| `customer.subscription.deleted` | Set status → `expired` |
| `invoice.payment_succeeded` | Set status → `active`, advance period dates |
| `invoice.payment_failed` | Set status → `past_due` |

All events are idempotent (duplicate delivery is a no-op). Unhandled event
types return 200 silently.

#### Subscription lifecycle UX
| `status` from `GET /billing/subscription` | What the FE should show |
|---|---|
| No subscription (404) | "Upgrade to Premium" CTAs; AI quota 429 → paywall modal |
| `trialing` | "Trial ends on {trialEnd}" banner |
| `active` | Normal premium experience |
| `past_due` | "Payment failed — update card" banner (link to `POST /billing/portal`) |
| `canceled` | "Plan ends on {currentPeriodEnd}" banner + resubscribe CTA; access intact |
| `expired` | Reverts to free-tier; premium features gate with paywall |

### Health (ops)

Both endpoints are unauthenticated and live **outside** the `/api/v1`
prefix. Hit them at the server root.

#### `GET /health`  *(public, **no** `/api/v1` prefix)*
Cheap liveness — no I/O. Point uptime monitors (BetterUptime, etc.) here.
```ts
// 200 Response: { status: 'ok' }
```

#### `GET /ready`  *(public, **no** `/api/v1` prefix)*
Readiness — runs `SELECT 1` against Postgres. Use this as the container
orchestrator's healthcheck path (Railway, k8s, Docker `HEALTHCHECK`).
A 503 here means "don't route traffic yet."
```ts
// 200 Response: { status: 'ready' }
// 503 Response: { code: 'NOT_READY', message: 'Database is not reachable.' }
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
  → 200 { accessToken, user, needsProfile, welcome } + cookie set
       needsProfile === true → account-details step (PATCH /users/me)
       needsProfile === false → /dashboard
```
For login:
```
login(email, password)
  → 200 → if needsProfile: account-details step; else /dashboard
  → 401 EMAIL_NOT_VERIFIED → OTP step with details.userId
```
For Google sign-in (when `OAUTH_GOOGLE_CLIENT_ID` is set on the server):
```
click "Continue with Google"
  → window.location = `${API}/auth/oauth/google`     // backend redirects to Google
                                                     // → user picks an account
                                                     // → Google → /auth/oauth/google/callback
                                                     // → backend sets refresh cookie
                                                     // → 302 to ${WEB_URL}/auth/oauth/callback?code=<short>
on FE /auth/oauth/callback?code=<short>:
  POST /auth/oauth/exchange { code }
  → 200 { accessToken, user, needsProfile, welcome }
  → route by needsProfile, same as login
on FE /auth/oauth/error?reason=<...>:
  show a friendly error; common reasons: missing_state, bad_state,
  exchange_failed, AUTH_EMAIL_UNVERIFIED_LINK, OAUTH_EMAIL_UNVERIFIED.
```

### Welcome-state wiring
Every token-issuing auth response carries `welcome: { hasDeck, hasSession,
hasReviewed }`. Use those to pick the dashboard variant:
- `hasDeck === false` → empty-state CTA "Create your first deck"
- `hasDeck && !hasReviewed` → "Pick a card to start reviewing"
- `hasReviewed && hasSession` → "Continue studying" card

These flip naturally on the next `/auth/refresh`, so the dashboard stays in
sync without extra count calls.

### Import + commit pattern
Both `/imports/quizlet` and `/imports/text` are **stateless** — they return
`AiCardDraft[]` without writing anything. The FE reuses the AI-enrichment
preview UI, then commits with the existing endpoints:
```
POST /imports/quizlet { url } | /imports/text { text }
  → { source, cards: AiCardDraft[] }
   → preview UI (same as /ai/enrich-words)
       → "Create new deck":  POST /decks → POST /decks/:id/cards/bulk
       → "Add to <deck>":    POST /decks/:id/cards/bulk
```

For deck round-trips between users, `GET /decks/:id/export?format=csv|json`
produces a file the recipient can re-import via
`POST /decks/:id/cards/import { format, text }`.

### Account deletion
`DELETE /users/me` cascades everything the user owns and clears the refresh
cookie. After the 204:
1. Delete `accessToken` from `localStorage`.
2. Hard-redirect to the marketing page (don't try to refresh — the cookie is
   gone and the user no longer exists).

### Chat / SSE consumption
The send-message endpoint is the only place in the API where a single
response can fail *after* it has already started writing data. The FE
must treat the stream as authoritative for the live message rendering,
but fall back to refetching `GET /chat/conversations/:id` for the final
persisted state.

Outline of a Nuxt-side consumer:
```ts
// 1. Open the stream
const res = await fetch(`${API}/chat/conversations/${id}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: {
        'authorization': `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
    },
    body: JSON.stringify({ content }),
});

// 2. Parse SSE frames (one event: line + one data: line per frame, blank line terminator).
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = '';
let assistantId: string | null = null;
let assistantContent = '';

for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Frames are separated by a blank line ("\n\n").
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1] ?? 'message';
        const data = JSON.parse(/^data:\s*(.+)$/m.exec(frame)?.[1] ?? '{}');
        switch (event) {
            case 'start':
                assistantId = data.assistantMessageId;
                // optimistic-insert userMessage into the FE store
                break;
            case 'token':
                assistantContent += data.delta;
                // append delta to the placeholder in the FE store
                break;
            case 'tool_use':
                // OPTIONAL: render a "Creating deck…" indicator next to
                // the assistant placeholder. data = { name, input }.
                break;
            case 'tool_result':
                // OPTIONAL: swap the indicator for a preview chip. The
                // canonical attachment also arrives on `done` so the
                // simplest FE just waits for that.
                break;
            case 'done':
                // replace the placeholder with data.assistantMessage;
                // attachments[] is on the assistantMessage when a tool
                // fired. update conversation title.
                break;
            case 'error':
                // surface a toast; the partial reply is preserved server-side
                // so a refetch of GET /chat/conversations/:id will show it.
                break;
        }
    }
}
```

Important edge cases:
- **User navigates away mid-stream:** the FE just stops reading. The
  server keeps the partial assistant row (`status: 'partial'`); the next
  `GET /chat/conversations/:id` returns it with whatever content the
  server saw. No charge against the daily cap.
- **Multiple tabs:** each opens its own stream. The server doesn't
  multiplex — two concurrent sends to the same conversation produce two
  independent assistant rows, both of which the next fetch returns.
- **JSON fallback:** if SSE is awkward (proxy, library, test rig), omit
  the `Accept: text/event-stream` header and the endpoint returns the
  same final payload as a single JSON body.

### Billing / subscription flow

```
// Subscribe (pricing page CTA)
POST /billing/checkout { plan: 'monthly' | 'annual' }
  → { url }
  → window.location = url                // Stripe-hosted Checkout
     └─ success → ${WEB_URL}/billing/success?session_id=...
          // poll GET /billing/subscription every ~3s until status ∈ {active, trialing}
          // then refresh auth state (GET /auth/me) so plan flips to 'premium'
     └─ cancel → ${WEB_URL}/billing/cancel
          // no subscription was created; user stays free

// Manage / cancel (billing settings page)
POST /billing/portal
  → { url }
  → window.location = url                // Stripe Customer Portal (cancel, card, invoices)

// Read current state (billing settings page)
GET /billing/subscription
  → Subscription or 404 (= free)

// Hard gate: server returns 403 PREMIUM_REQUIRED
// → show paywall / upgrade modal regardless of FE plan state
```

**Auth state:** store `plan` from every auth response alongside `user`. Update
it on every `GET /auth/me` call. The FE uses `plan === 'premium'` to show or
hide UI elements, but always handles `403 PREMIUM_REQUIRED` from the server as
the authoritative gate.

**`BILLING_NOT_CONFIGURED`:** when the backend is running without Stripe keys
(local dev, staging without billing), every `/billing/*` call returns this
code. Guard: before rendering any billing UI, check that a prior call didn't
return this error; if it did, hide all upgrade/subscription UI silently.

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
# → { "accessToken": "...", "user": { ... }, "needsProfile": false, "welcome": { ... } }

ACCESS=...      # paste the accessToken from above

# 2. List decks
curl -s "$BASE/decks" -H "Authorization: Bearer $ACCESS"
# → { items: Deck[2], nextCursor: null, total: 2 }

# 3. Deck detail (note: cards is inline, not paginated)
curl -s "$BASE/decks/<deckId>" -H "Authorization: Bearer $ACCESS"
# → { deck: Deck, cards: Card[] }

# 4. Refresh (no body; cookie travels via -b)
curl -sX POST "$BASE/auth/refresh" -b cookies.txt -c cookies.txt
# → { accessToken (new), user, needsProfile, welcome }
```

### Chat smoke (mock provider — no Anthropic credits burned)
```bash
# Make sure AI_PROVIDER=mock in .env to avoid hitting Claude.

# 1. Create a new conversation
CONV=$(curl -sX POST "$BASE/chat/conversations" \
     -H "authorization: Bearer $ACCESS" \
     -H 'content-type: application/json' \
     -d '{}' | jq -r .id)

# 2. Stream a reply via SSE (-N disables buffering)
curl -N -X POST "$BASE/chat/conversations/$CONV/messages" \
     -H "authorization: Bearer $ACCESS" \
     -H 'accept: text/event-stream' \
     -H 'content-type: application/json' \
     -d '{"content":"Teach me three Spanish words for fruit."}'
# Expect:  event: start   event: token (xN)   event: done

# 3. Or get the whole reply at once (JSON, no streaming)
curl -sX POST "$BASE/chat/conversations/$CONV/messages" \
     -H "authorization: Bearer $ACCESS" \
     -H 'content-type: application/json' \
     -d '{"content":"Another question"}' | jq
# → { userMessage, assistantMessage, conversationTitle, tokensInput, tokensOutput }

# 4. Read the conversation back
curl -s "$BASE/chat/conversations/$CONV" \
     -H "authorization: Bearer $ACCESS" | jq '.messages | map({role, content, status})'
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
# → { accessToken, user, needsProfile: true, welcome } + cookie set
```

---

## 6. What's NOT in this contract

Full deferral list with rationale is in [`backlog.md`](./backlog.md); this
section captures only the items that interact with this contract directly.

### Operational gaps (contract stays the same when these land)
- **Admin surface for `featured`**: today, the `featured` flag is set directly
  in the DB. A `POST /admin/decks/:id/feature` (gated on `user.role='admin'`)
  is a small post-MVP addition when curation moves out of SQL.
- **S3-backed media**: `/media/uploads` shape stays; storage backend swaps
  from local FS to S3 presigned PUTs (see `src/services/media.service.ts`
  comment header for the migration steps).

### Chat — designed-around but deferred
The `/chat/*` endpoints intentionally ship without:
- **Grounding** (auto-injecting the user's recent decks, due count, last
  mistakes into the system prompt). Hook lives at
  `src/services/chat.prompt.ts`.
- **Tool use** (`createDeck`, `addCardsToDeck`, etc.). The Anthropic SDK
  supports `tools` blocks; the provider interface accepts them when we add
  them.
- **Image / audio attachments**. `ChatMessage.content` is text-only at MVP.
- **AI-generated titles**. First-user-message truncation is the auto-title
  rule for now.

### Optional sub-stats deferred from P1
Tagged "Optional P2" in `backend-plan.md §7`; not built but can be added later
without breaking existing `/stats/*` shapes:
- `/stats/forecast` (14-day due projection)
- `/stats/study-patterns` (hour × day-of-week heatmap)
- `/stats/xp` and league/leaderboard

### Out of MVP entirely (see [`backlog.md`](./backlog.md) for full reasoning)
- Password reset / forgot-password (manual support intervention at MVP).
- Folders, leagues (leaderboard).
- WebSockets / push notifications.
- Apple / Facebook / Microsoft OAuth (only Google ships at MVP).
