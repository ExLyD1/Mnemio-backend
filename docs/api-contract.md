# Mnemio Backend — API Contract for Frontend Integration

> Audience: the frontend (`mnemio-frontend`) developer / AI replacing the
> `localStorage`-backed mocks in `app/api/*.ts` with real HTTP calls.
> Read [`backend-plan.md`](./backend-plan.md) for the *why*; this file is the *what*.

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
  avatarUrl: string | null;
  emailVerified: boolean;
  role: 'user' | 'admin';
  xp: number;
  streak: number;
  createdAt: string;
  updatedAt: string;
};

type Deck = {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  sourceLanguage: string;      // ISO 639-1, e.g. 'en'
  targetLanguage: string;
  isPublic: boolean;           // always false at MVP
  cardCount: number;
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
  nextReviewAt: string;
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

type Rating = 'again' | 'hard' | 'good' | 'easy';
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

#### `PATCH /decks/:id`  *(auth)*
```ts
// Request: any subset of { title, description, sourceLanguage, targetLanguage }
// 200 Response: Deck
```

#### `DELETE /decks/:id`  *(auth)*
```ts
// 204 No Content   (cascades to cards, progress, sessions)
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
// 201 Response: Card  (position is server-assigned: last + 1)
```

#### `POST /decks/:id/cards/bulk`  *(auth)*
```ts
// Request: { cards: { word, definition, phonetic? }[] }   // 1–100 items
// 201 Response: { created: number }
```

#### `PATCH /cards/:id`  *(auth)*
```ts
// Request: any subset of { word, definition, phonetic, position }
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
Append progress mid-session.
```ts
// Request: at least one of { cardIndex: number, correct: number }
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
Rating → SM-2 quality mapping (matches the frontend composable):
| Rating | Quality | Effect |
|---|---|---|
| `again` | 0 | Full reset: repetitions = 0, interval = 1 day, easeFactor -= 0.2 (min 1.3) |
| `hard`  | 2 | Treated as recall failure → same reset path (interval = 1 day) |
| `good`  | 3 | Advance: repetitions++, interval = 1 / 6 / round(prev × EF), EF unchanged |
| `easy`  | 5 | Advance with EF boost (~+0.1) |

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
`null` means "no more pages". No total counts available.

---

## 5. Local development

```bash
# 1. Start Postgres (Docker Compose)
docker compose up -d db

# 2. Apply migrations
npx prisma migrate deploy
# (If it complains about a prior failed migration, run:
#   PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma migrate reset --force )

# 3. Run the backend
npm run dev                   # http://localhost:3001
```

In dev, `MAIL_PROVIDER=console` prints OTPs to the backend's stdout — grep the
dev console after `POST /auth/register` for the 6-digit code.

### Quick smoke (curl)
```bash
BASE=http://localhost:3001/api/v1

# 1. Register
curl -sX POST "$BASE/auth/register" -H 'content-type: application/json' \
     -d '{"email":"alice@example.com","password":"hunter22!"}'
# → { "userId": "...", "email": "alice@example.com" }

# (grab the OTP from the backend's console)

# 2. Verify OTP — note -c saves cookies to ./cookies.txt
curl -sX POST "$BASE/auth/verify-email" -c cookies.txt \
     -H 'content-type: application/json' \
     -d '{"userId":"<id>","code":"123456"}'
# → { accessToken, user, needsProfile: true }
# (cookies.txt now has mnemio_refresh)

# 3. Refresh (no body, cookie travels via -b)
curl -sX POST "$BASE/auth/refresh" -b cookies.txt -c cookies.txt
# → { accessToken (new), user, needsProfile }

# 4. Authenticated call
curl -s "$BASE/auth/me" -H "Authorization: Bearer <accessToken>"
```

---

## 6. Out of MVP

The frontend should not call (backend will 404) any of these:
- Password reset / forgot-password
- File uploads (avatar)
- Public deck browsing / explore / clone
- Folders, achievements, leagues
- Account deletion
- WebSockets / push notifications

If anything here becomes urgent, add it to `backend-plan.md` §10 before wiring
the frontend.
