# Mnemio Backend — API Contract for Frontend Integration

> Audience: the frontend (`mnemio-frontend`) developer / AI replacing the
> `localStorage`-backed mocks in `app/api/*.ts` with real HTTP calls.
> Read [`backend-plan.md`](./backend-plan.md) for the *why*; this file is the *what*.

---

## 1. Conventions

### Base URL
- All endpoints are prefixed `/api/v1`.
- Dev: `http://localhost:3000/api/v1`.
- CORS: server allows `WEB_URL` only (default `http://localhost:3001`) with credentials.

### Authentication
- Send `Authorization: Bearer <accessToken>` on every non-public endpoint.
- Public endpoints (no token required): everything under `/auth/*` **except** `/auth/me`,
  plus `/health`.

### Tokens
- **Access token** — JWT (HS256), 15 min TTL. Claims: `sub` (userId), `emailVerified`, `role`.
- **Refresh token** — opaque base64url string (32 bytes of entropy). 30-day TTL.
  Rotates on every `/auth/refresh`. **Reuse detection**: presenting a revoked refresh
  token revokes *all* of that user's refresh tokens — log the user out and force re-login.
- Frontend may store both in `localStorage` (this is what the FE plan currently calls for).
  Consider moving the refresh token to an HttpOnly cookie in a hardening pass (see
  backend-plan.md §8).

### Request / response format
- Bodies and responses are JSON. `Content-Type: application/json`.
- All dates are ISO 8601 UTC strings (`2026-05-25T17:42:00.000Z`).
- Birthday is `YYYY-MM-DD` (date-only, no time).
- IDs are UUID strings.

### Error envelope
Every error response follows the same shape:
```ts
type ApiError = {
  code: string;                       // machine-readable, screaming snake case
  message: string;                    // human-readable, English (i18n is FE's job)
  details?: Record<string, unknown>;  // optional, e.g. Zod tree of issues
};
```

Status code → meaning:
| Status | Meaning |
|---|---|
| 400 | Validation error (`VALIDATION_ERROR`, or domain-specific `code`) |
| 401 | Unauthenticated (bad / expired access token, bad credentials) |
| 403 | Authenticated but not allowed (e.g. ownership check failed) |
| 404 | Not found |
| 409 | Conflict (e.g. duplicate email / username) |
| 422 | Business-rule violation |
| 429 | Rate-limited |
| 500 | Internal — backend bug, retry later |

**Important error codes the FE should map specifically:**
| Code | Where | UX |
|---|---|---|
| `VALIDATION_ERROR` | any | Show field errors from `details` |
| `AUTH_EMAIL_TAKEN` | `POST /auth/register` | "An account already exists. Log in instead." |
| `AUTH_INVALID_CREDENTIALS` | `POST /auth/login` | "Email or password is incorrect." (do **not** distinguish "no such user" from "wrong password") |
| `AUTH_INVALID_CODE` | `POST /auth/verify-email` | "Invalid verification code." |
| `AUTH_OTP_EXHAUSTED` | `POST /auth/verify-email` | "Too many attempts. Request a new code." |
| `AUTH_OTP_COOLDOWN` | `POST /auth/resend-otp` | "Wait {N}s before requesting another code." (message includes remaining seconds) |
| `EMAIL_NOT_VERIFIED` | `POST /auth/login` | Route the user to the OTP step; `details.userId` is included |
| `AUTH_INVALID_TOKEN` | any auth-required endpoint | Try `/auth/refresh`; on failure, log out |
| `AUTH_INVALID_REFRESH` | `POST /auth/refresh` | Hard log-out — refresh token is revoked or stolen |
| `USER_USERNAME_TAKEN` | `PATCH /users/me` | Show inline field error on `username` |
| `DECK_NOT_FOUND` / `CARD_NOT_FOUND` / `SESSION_NOT_FOUND` | resource routes | 404 page or toast |
| `DECK_EMPTY` | `POST /sessions` | Disable the "Study" button when `cardCount === 0` |

### Rate limiting
- Global default: 120 req/min/IP.
- `/auth/register`, `/auth/login`: 10 req/min/IP.
- `/auth/verify-email`, `/auth/resend-otp`: 5 req/min/IP.
- `/auth/refresh`: 30 req/min/IP.
- On 429, response body is the standard envelope with `code: 'RATE_LIMITED'`.

### Pagination contract
- Cursor-based. Send `?cursor=<opaque>&limit=<n>`; receive `{ items, nextCursor }`.
- `nextCursor` is `null` when there are no more pages.
- Hard cap on `limit`: 100 (cards in deck-detail allow up to 200).
- The cursor is **opaque** — never parse it, never construct it; treat it as a black-box string.

```ts
type Page<T> = {
  items: T[];
  nextCursor: string | null;
};
```

---

## 2. Domain types (response shapes)

These match the frontend plan's data model with two differences noted inline.

```ts
type User = {
  id: string;                  // uuid
  email: string;
  displayName: string | null;  // null until profile completion
  username: string | null;     // null until profile completion
  birthday: string | null;     // 'YYYY-MM-DD' or null
  avatarUrl: string | null;
  emailVerified: boolean;
  role: 'user' | 'admin';
  xp: number;
  streak: number;
  createdAt: string;           // ISO
  updatedAt: string;           // ISO
};

type Deck = {
  id: string;
  ownerId: string;             // frontend may already call this 'authorId' — both refer to the same field
  title: string;
  description: string;
  sourceLanguage: string;      // ISO 639-1, e.g. 'en'
  targetLanguage: string;
  isPublic: boolean;           // always false at MVP
  cardCount: number;           // server-maintained
  createdAt: string;
  updatedAt: string;
};

type Card = {
  id: string;
  deckId: string;
  word: string;
  definition: string;
  phonetic: string | null;
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
  nextReviewAt: string;        // ISO
  lastReviewedAt: string | null;
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
  startedAt: string;
  endedAt: string | null;
  completedAt: string;
};
```

### `User` shape vs frontend's current shape
Frontend's `stores/profile.ts` currently uses `id: number` (hardcoded `1`). Backend
returns **`id: string` (UUID)**. Update the store before integration.

### `needsProfile` flag
Most auth responses include `needsProfile: boolean` alongside `user`. It's `true`
when `user.username` or `user.displayName` is `null`. Use this flag — not local
heuristics — to decide whether to send the user to the account-details step.

---

## 3. Endpoint reference

### Auth

#### `POST /auth/register`  *(public)*
Create an unverified user; trigger OTP email. **No tokens issued.**
```ts
// Request
{ email: string; password: string }   // password ≥ 8 chars

// 201 Response
{ userId: string; email: string }

// Errors
// 409 AUTH_EMAIL_TAKEN
// 400 VALIDATION_ERROR
```

#### `POST /auth/verify-email`  *(public)*
Consume an OTP code; on success, mark verified and issue tokens.
```ts
// Request
{ userId: string; code: string }      // code: 6 digits

// 200 Response
{
  accessToken: string;
  refreshToken: string;
  user: User;
  needsProfile: boolean;
}

// Errors
// 400 AUTH_INVALID_CODE
// 400 AUTH_OTP_EXHAUSTED
```

#### `POST /auth/resend-otp`  *(public)*
60-second cooldown per user.
```ts
// Request
{ userId: string }

// 200 Response
{ ok: true; cooldownSeconds: number } // cooldownSeconds = 60 (or 0 if already verified)

// Errors
// 429 AUTH_OTP_COOLDOWN  (message contains the remaining seconds)
```

#### `POST /auth/login`  *(public)*
```ts
// Request
{ email: string; password: string }

// 200 Response
{
  accessToken: string;
  refreshToken: string;
  user: User;
  needsProfile: boolean;
}

// Errors
// 401 AUTH_INVALID_CREDENTIALS  (used for both "no user" and "bad password")
// 401 EMAIL_NOT_VERIFIED        (details.userId — route the user to OTP step)
```

#### `POST /auth/refresh`  *(public)*
Rotates the refresh token. The old one is revoked; the new one is in the response.
```ts
// Request
{ refreshToken: string }

// 200 Response — same shape as login
{ accessToken, refreshToken, user, needsProfile }

// Errors
// 401 AUTH_INVALID_REFRESH  → hard log-out; if user previously had a valid refresh
//                             token, this means it was already rotated (possible theft)
```

#### `POST /auth/logout`  *(public — token in body, not Authorization)*
```ts
// Request
{ refreshToken: string }

// 204 No Content
```
Only revokes that single refresh token (single-session logout). Clear access token
client-side after this call.

#### `GET /auth/me`  *(auth)*
```ts
// 200 Response
{ user: User; needsProfile: boolean }

// Errors
// 401 AUTH_INVALID_TOKEN  → try /auth/refresh
```

### Users

#### `PATCH /users/me`  *(auth)*
Used for the "account-details" step after OTP verification. All fields optional;
at least one required.
```ts
// Request
{
  displayName?: string;   // trimmed, 1–64 chars
  username?: string;      // 3–24 chars, /^[a-zA-Z0-9_]+$/, lowercased server-side,
                          // reserved names rejected (admin, root, mnemio, …)
  birthday?: string;      // 'YYYY-MM-DD'; must be ≥ 13 years ago
}

// 200 Response
{ user: User; needsProfile: boolean }

// Errors
// 400 VALIDATION_ERROR     (e.g. age < 13, bad username format)
// 409 USER_USERNAME_TAKEN
```

### Decks

#### `GET /decks`  *(auth)*
```ts
// Query
?cursor?=string&limit?=number(<=100)&q?=string

// 200 Response
Page<Deck>
```
`q` does a case-insensitive `contains` over `title` and `description`.
Sort order is `updatedAt DESC, id DESC` (stable for keyset pagination).

#### `POST /decks`  *(auth)*
```ts
// Request
{
  title: string;              // 2–120 chars
  description?: string;       // ≤ 500 chars, default ''
  sourceLanguage: string;     // 2–10 chars
  targetLanguage: string;
}

// 201 Response: Deck
```

#### `GET /decks/:id`  *(auth)*
```ts
// Query
?cardsCursor?=string&cardsLimit?=number(<=200)   // cards paginate at 50 by default

// 200 Response
{
  deck: Deck;
  cards: Page<Card>;          // sorted by (position ASC, id ASC)
}

// Errors
// 404 DECK_NOT_FOUND
```

#### `PATCH /decks/:id`  *(auth)*
```ts
// Request: any subset of { title, description, sourceLanguage, targetLanguage }
// 200 Response: Deck
```

#### `DELETE /decks/:id`  *(auth)*
```ts
// 204 No Content
// Cascade: deletes the deck's cards, their progress, and any sessions on it.
```

### Cards

#### `POST /decks/:id/cards`  *(auth)*
```ts
// Request
{
  word: string;             // 1–120 chars
  definition: string;       // 1–1000 chars
  phonetic?: string;        // ≤ 120 chars
}
// 201 Response: Card (position is server-assigned: last + 1)
```

#### `POST /decks/:id/cards/bulk`  *(auth)*
```ts
// Request
{ cards: { word, definition, phonetic? }[] }   // 1–100 items

// 201 Response
{ created: number }
```

#### `PATCH /cards/:id`  *(auth)*
```ts
// Request: any subset of { word, definition, phonetic, position }
// 200 Response: Card

// Errors
// 404 CARD_NOT_FOUND
// 403 CARD_FORBIDDEN  (you don't own the deck the card lives in)
```

#### `DELETE /cards/:id`  *(auth)*
```ts
// 204 No Content
// Side effect: deck's cardCount is recomputed.
```

### Sessions

#### `POST /sessions`  *(auth)*
Start a new study session. **Side effect:** if the user has an `active` session
already, it is atomically marked `incomplete` before the new one is created.
This satisfies the frontend's "only one active session at a time" rule.

```ts
// Request
{ deckId: string; mode: 'flashcard' | 'multiple_choice' | 'srs' }

// 201 Response: StudySession
//   - status: 'active'
//   - cardIds: snapshot of the deck's cards in (position ASC, id ASC) order
//   - cardIndex: 0, correct: 0

// Errors
// 404 DECK_NOT_FOUND
// 400 DECK_EMPTY        (deck has zero cards — disable the Study CTA)
```

#### `PATCH /sessions/:id`  *(auth)*
Append progress mid-session.
```ts
// Request: at least one of { cardIndex: number, correct: number }
// 200 Response: StudySession

// Errors
// 404 SESSION_NOT_FOUND  (also returned if the session is no longer 'active')
```

#### `POST /sessions/:id/complete`  *(auth)*
Close the session. **XP is computed server-side**; do not send it. Formula:
`correct * 10 + 25`. The user's total XP is incremented atomically.

```ts
// Request: empty body
// 200 Response: StudySession  (status: 'complete', xpAwarded, endedAt set)

// Errors
// 400 SESSION_NOT_ACTIVE
// 404 SESSION_NOT_FOUND
```

#### `GET /sessions/incomplete`  *(auth)*
Most-recent incomplete session, or `null`. Powers the "Continue studying" CTA.
```ts
// 200 Response
{ session: StudySession | null }
```

### SRS

#### `POST /srs/rate`  *(auth)*
Rate a card; server runs SM-2 and upserts the user's `CardProgress`.
```ts
// Request
{ cardId: string; quality: 0 | 1 | 2 | 3 | 4 | 5 }
// Mapping for review UI: Again=0, Hard=2, Good=3, Easy=5

// 200 Response: CardProgress

// Errors
// 404 CARD_NOT_FOUND
// 403 CARD_FORBIDDEN
```
SM-2 details (mirrors `composables/useSpacedRepetition.ts`):
- Quality < 3 → repetitions reset to 0, interval = 1 day, easeFactor -= 0.2 (min 1.3).
- Quality ≥ 3 → repetitions++, interval = 1 / 6 / round(prev * EF), easeFactor adjusted.

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
Ordered by `nextReviewAt ASC` (most-overdue first). Only cards with an existing
`CardProgress` row appear (i.e. cards rated at least once and now due). Newly
created cards become due immediately the first time you rate them.

### Dashboard

#### `GET /dashboard`  *(auth)*
One round-trip for the dashboard page.
```ts
// 200 Response
{
  stats: {
    decks: number;
    cards: number;   // sum of cardCount across owned decks
    xp: number;
  };
  dueCount: number;
  recentDecks: Deck[];          // up to 5, by updatedAt DESC
  continueStudying: StudySession | null;  // same as GET /sessions/incomplete
}
```

### Health (ops)

#### `GET /health`  *(public, **no** /api/v1 prefix)*
```ts
// 200 Response
{ status: 'ok' }
```

---

## 4. Recommended frontend wiring

### Token storage / lifecycle
1. On `login` / `verify-email` / `refresh`: persist `accessToken` and `refreshToken`
   to `localStorage` (matches current FE plan).
2. Build a single `$fetch` wrapper in `app/api/_client.ts` that:
   - Adds `Authorization: Bearer <accessToken>` if present.
   - On 401 with `code: 'AUTH_INVALID_TOKEN'`, calls `/auth/refresh` once; on
     success, retries the original request. On failure, clears tokens and
     redirects to `/login`.
   - On 401 with `code: 'AUTH_INVALID_REFRESH'`, hard log-out — do **not** retry.
3. On `logout`: `POST /auth/logout { refreshToken }`, then clear both tokens.

### Auth-flow state machine
```
register(email, password)
  → 201 { userId, email }                  → go to OTP step (carry userId)
verify-email(userId, code)
  → 200 { ...tokens, user, needsProfile }
       if needsProfile → go to account-details step (PATCH /users/me)
       else → go to /dashboard
```
For login:
```
login(email, password)
  → 200 → if needsProfile, account-details step; else dashboard
  → 401 EMAIL_NOT_VERIFIED → go to OTP step with details.userId
```

### Session-flow contract
- Starting a new session implicitly ends any active one — the frontend's
  `sessions.incomplete[]` semantic is satisfied by polling `GET /sessions/incomplete`
  (or just reading `dashboard.continueStudying`).
- Don't send `xp` to `/sessions/:id/complete`; read it back from the response.

### Pagination wiring
Stash `nextCursor` per list view; "Load more" passes it as `?cursor`. Treat
`null` as "no more pages". Don't try to compute total counts — pagination is
forward-only.

---

## 5. Local development

1. **Start Postgres:** `docker compose up -d db` (port 5433 on host).
2. **Apply schema:** `npx prisma migrate reset` (init migration was squashed).
3. **Start backend:** `npm run dev` → `http://localhost:3000`.
4. **OTP in dev:** `MAIL_PROVIDER=console` (default) prints OTPs to the backend's
   stdout — grep the dev console after `POST /auth/register` to grab the code.
5. **Quick smoke (curl):**
   ```bash
   BASE=http://localhost:3000/api/v1
   curl -sX POST "$BASE/auth/register" -H 'content-type: application/json' \
        -d '{"email":"alice@example.com","password":"hunter22!"}'
   # → { "userId": "...", "email": "alice@example.com" }
   # (grab the OTP from the backend's console)
   curl -sX POST "$BASE/auth/verify-email" -H 'content-type: application/json' \
        -d '{"userId":"<id>","code":"123456"}'
   # → { accessToken, refreshToken, user, needsProfile: true }
   ```

---

## 6. Stuff that's intentionally *not* in MVP

The frontend should not call (and the backend will 404) any of these:
- Password reset / forgot-password.
- File uploads (avatar).
- Public deck browsing / explore / clone.
- Folders, achievements, leagues.
- Account deletion.
- WebSockets / push notifications.

If any of these is needed sooner, file it as an addition to `backend-plan.md` §10
(Phase 5) before wiring the frontend.
