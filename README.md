# Mnemio Backend

> REST API for **Mnemio** — the AI-powered vocabulary & flashcard learning
> platform. The Nuxt frontend (`mnemio-frontend`) communicates exclusively
> through this API; the database is never exposed directly.

Built with Fastify + TypeScript + Prisma + PostgreSQL. Implements every
endpoint specified in [`docs/api-contract.md`](./docs/api-contract.md) — see
that doc for the authoritative request/response shapes the frontend integrates
against.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Fastify v5 |
| Language | TypeScript |
| Validation | Zod |
| Auth | `@fastify/jwt` (HS256, 15 min access token) + HttpOnly refresh cookie (`@fastify/cookie`) |
| Password hashing | argon2id |
| OAuth (planned) | `arctic` — installed, no routes wired yet |
| ORM | Prisma 7 (with `@prisma/adapter-pg`) |
| Database | PostgreSQL 17 (local Docker for dev) |
| Email | Console provider for dev (Resend / SES swap-ready via `MAIL_PROVIDER`) |
| AI | Mock provider in this repo; Anthropic / OpenAI swap path — see [`docs/ai-integration-plan.md`](./docs/ai-integration-plan.md) |
| Media | Local FS + `@fastify/static` (S3 presigned-PUT swap path documented in `src/services/media.service.ts`) |
| Rate limiting | `@fastify/rate-limit` |
| CORS | `@fastify/cors` (`credentials: true`, origin allow-list) |
| Tests | Vitest |

---

## Architecture

```
mnemio-frontend (Nuxt 4)
     ↕  REST  /api/v1   (Bearer access token + mnemio_refresh HttpOnly cookie)
mnemio-backend (Fastify)          ← this repo
     ↕  Prisma (pg adapter)
PostgreSQL
```

The frontend never touches the database. All business logic, auth, ownership
checks, and data access live here.

### Project layout

```
src/
  app.ts                  Fastify factory (plugins, routes, error handler)
  server.ts               Process entrypoint (env, listen, graceful shutdown)
  config/env.ts           Zod-validated env loader
  db/prisma.ts            Prisma client wired with @prisma/adapter-pg
  plugins/
    cookies.ts            mnemio_refresh helpers + @fastify/cookie
    jwt.ts                @fastify/jwt + `authenticate` preHandler
    error-handler.ts      Normalizes AppError | ZodError | Prisma codes → envelope
  routes/<domain>.routes.ts
  controllers/<domain>.controller.ts
  services/<domain>.service.ts
  repositories/<domain>.repository.ts
  schemas/<domain>.schema.ts                Zod request/response
  shared/{errors,pagination,mappers*}.ts    cross-cutting
  services/sm2.ts                           pure SuperMemo-2 (no DB)
test/sm2.test.ts          16 SM-2 cases (matches FE useSpacedRepetition)
test/xp.test.ts            7 XP-formula cases
scripts/seed.ts           idempotent demo seed
prisma/                    8 migrations, model-per-file (user, deck, card, …)
```

### Conventions
- All routes under `/api/v1`; `/health` is the only un-prefixed route.
- Errors normalize to `{ code, message, details? }` (see `error-handler.ts`).
- Cursor pagination is opaque (base64url keyset). `GET /decks` also returns
  `total`; other lists don't (counting on every page is expensive).
- IDs are UUID strings. Dates are ISO-8601 UTC. Birthday is `YYYY-MM-DD`.
- **Refresh token** in `mnemio_refresh` HttpOnly cookie scoped to
  `/api/v1/auth`; `Secure` flag set only in production.
- **Ownership** enforced at the repo layer (`findFirst({where:{id,authorId:owner}})`,
  `updateMany/deleteMany` with the same filter) — controllers can't forget.
- **One active study session per user**, enforced atomically inside Prisma
  transactions (and a Postgres partial unique index as belt-and-braces).

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Docker (for the local Postgres container)

### Install

```bash
npm install
npx prisma generate
```

### Environment

```bash
cp .env.example .env
# Then fill in JWT_SECRET (≥ 32 chars) — the rest have safe defaults for dev.
```

Required:

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | ≥ 32 chars; HS256 access-token signing key |
| `WEB_URL` | CORS allow-list origin (default `http://localhost:3000`) |

Optional (with sensible defaults):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | Backend listens here (frontend is on 3000) |
| `HOST` | `0.0.0.0` | |
| `NODE_ENV` | `development` | `production` makes the refresh cookie `Secure` |
| `LOG_LEVEL` | `info` | Pino level |
| `JWT_ACCESS_TTL` | `15m` | |
| `JWT_REFRESH_TTL_DAYS` | `30` | |
| `MAIL_PROVIDER` | `console` | `console` prints OTPs to stdout in dev |
| `MAIL_FROM` | `Mnemio <noreply@mnemio.local>` | |
| `AI_PROVIDER` | `mock` | `mock` returns realistic placeholders — see ai-integration-plan.md to swap |
| `MEDIA_STORAGE` | `local` | `local` writes to `./uploads/`; swap to S3 later |

### Database

```bash
docker compose up -d db                   # Postgres on host port 5433
npx prisma migrate deploy
# If a prior failed migration blocks deploy:
# PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma migrate reset --force
```

### Seed (optional)

```bash
npm run seed
# → demo@mnemio.local / demo-password-123
#   (pre-verified, profile complete, 2 decks of 8–10 cards)
```

Idempotent — re-running is safe.

### Dev server

```bash
npm run dev           # tsx watch on http://localhost:3001
```

Health check: `curl http://localhost:3001/health` → `{"status":"ok"}`

### Tests + typecheck

```bash
npm test              # SM-2 + XP unit tests (23 cases)
npm run typecheck     # tsc --noEmit
```

### Production-style build

```bash
npm run build         # prisma generate && tsc → dist/
npm start             # node dist/src/server.js
```

### Frontend integration

```bash
# In mnemio-frontend
NUXT_PUBLIC_API_BASE=http://localhost:3001/api/v1 npm run dev
```

CORS allow-lists `WEB_URL` (default `http://localhost:3000`) with
`credentials: true`, so the refresh cookie rides automatically.

---

## API Overview

Base path: `/api/v1`. All protected routes require
`Authorization: Bearer <accessToken>`. The refresh token lives **exclusively**
in the `mnemio_refresh` HttpOnly cookie — the frontend never reads it.

Full request/response shapes, error codes, and pagination contracts are in
[`docs/api-contract.md`](./docs/api-contract.md). What follows is an index.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | public | Create account, trigger OTP email |
| POST | `/auth/verify-email` | public | Consume OTP → access token + refresh cookie |
| POST | `/auth/resend-otp` | public | Re-send OTP (60 s cooldown) |
| POST | `/auth/login` | public | Email + password → access token + refresh cookie |
| POST | `/auth/refresh` | cookie | Rotate refresh token → new access token |
| POST | `/auth/logout` | cookie | Revoke refresh token, clear cookie |
| GET | `/auth/me` | ✓ | Current user + `needsProfile` flag |

### Users & Preferences

| Method | Path | Auth | Description |
|---|---|---|---|
| PATCH | `/users/me` | ✓ | Update `fullName`, `username`, `birthday` |
| GET | `/users/me/preferences` | ✓ | Read prefs (auto-creates on first call) |
| PATCH | `/users/me/preferences` | ✓ | Update `interests`, `goal`, `nativeLanguage`, `learningLanguages`, `avatarHue`, `mimiPlacement`, `favorites` |

### Decks

Every `Deck` response includes embedded `stats { total, mastered, learning, new, due, masteredPct }`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/decks` | ✓ | Paginated deck list (`{ items, nextCursor, total }`), `?q=` search |
| POST | `/decks` | ✓ | Create deck (incl. `coverColor`, `glyph`, `subject`, `isPublic`) |
| GET | `/decks/:id` | ✓ | Deck + **full inline `cards: Card[]`** (cap 1000) |
| PATCH | `/decks/:id` | ✓ | Update any subset of deck fields |
| DELETE | `/decks/:id` | ✓ | Delete (cascades to cards, progress, sessions) |
| POST | `/decks/:id/copy` | ✓ | Clone a public deck; atomically bumps source `copyCount` |

### Cards

Rich Card model: `partOfSpeech`, `example`, `exampleTranslation`, `reading`, `tags[]`, `difficulty`, `type`, `audioUrl`, `imageUrl`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/decks/:id/cards` | ✓ | Add single card |
| POST | `/decks/:id/cards/bulk` | ✓ | Add up to 100 cards at once |
| PATCH | `/cards/:id` | ✓ | Update any subset of card fields |
| DELETE | `/cards/:id` | ✓ | Delete card (deck.cardCount recomputed) |

### Study Sessions

Sessions expose server-backed summary fields: `counts { again, hard, good, easy }`, `revisitCardIds`, `durationMs`.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/sessions` | ✓ | Start session (implicitly ends any active one) |
| PATCH | `/sessions/:id` | ✓ | Record progress (`cardIndex`, `correct`, `counts`, `durationMs`) |
| POST | `/sessions/:id/complete` | ✓ | Close; **server-computed XP** = `correct * 10 + 25` |
| POST | `/sessions/:id/exit` | ✓ | Exit without XP (marks `incomplete`) |
| POST | `/sessions/:id/resume` | ✓ | Resume an incomplete session |
| GET | `/sessions/active` | ✓ | Current active session or `null` |
| GET | `/sessions/incomplete` | ✓ | Most recent incomplete session or `null` |

### SRS (Spaced Repetition)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/srs/rate` | ✓ | `{ cardId, rating: 'again' \| 'hard' \| 'good' \| 'easy' }` — runs SM-2 + updates DailyActivity |
| GET | `/srs/due` | ✓ | Cards due for review (most-overdue first) |
| GET | `/srs/progress` | ✓ | Full progress map for the user (cap 2000) |

SM-2 mapping (matches the frontend composable): `again`→0 / `hard`→2 / `good`→3 / `easy`→5. EF floored at 1.3.

### Dashboard

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/dashboard` | ✓ | Stats, due count, recent decks (with stats), continue-studying session |

### Statistics

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/stats/overview?range=7\|30\|90\|all` | ✓ | reviewed / correct / retention / streak / dueCount + trends vs previous window |
| GET | `/stats/series?range=…` | ✓ | Daily review series (one point per day) |
| GET | `/stats/activity` | ✓ | 53-week year heatmap + current-month calendar |
| GET | `/stats/decks` | ✓ | Per-deck retention / mastery / review count |

### Achievements

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/achievements` | ✓ | Catalog (7 entries) with per-user `earned` / `earnedAt` / `progress` |

Catalog is code-defined ([`src/services/achievements.catalog.ts`](./src/services/achievements.catalog.ts)); auto-evaluated on session-complete / rate / card-create.

### Discover

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/discover/decks` | ✓ | Public catalog (`?q`, `?lang`, `?subject`, `?sort=popular\|recent`) |
| GET | `/discover/featured` | ✓ | Curator-flagged decks (≤12) |
| GET | `/discover/categories` | ✓ | Distinct subjects with deck counts |

### AI

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/ai/enrich-words` | ✓ | **Key feature.** User pastes a word list (≤100); AI returns one card per word (order preserved). FE persists via existing `/decks/:id/cards/bulk`. Streams via SSE when `Accept: text/event-stream`. |
| POST | `/ai/generate-deck` | ✓ | Returns an ephemeral deck draft from a topic. Streams via SSE when `Accept: text/event-stream`. |
| POST | `/ai/suggest` | ✓ | Mimi contextual nudge (`dashboard` / `deck_detail` / `review`) |

**Providers** (`AI_PROVIDER` env):
- `mock` (default) — deterministic placeholders; no LLM cost.
- `anthropic` — Claude Haiku 4.5 via `@anthropic-ai/sdk`. Requires
  `ANTHROPIC_API_KEY`.

Response shapes are identical across providers — FE never branches on
`provider`.

**Per-user daily caps** (configurable via env):
- `enrich`: 5/day  ·  `generate`: 20/day  ·  `suggest`: 60/day
- Max words per `enrich` call: 100

See [`docs/ai-integration-plan.md`](./docs/ai-integration-plan.md) for
provider design + cost forecast.

### Media

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/media/uploads?kind=avatar\|card_image\|card_audio` | ✓ | Multipart upload; avatar also sets `user.avatarUrl` |
| GET | `/media/<userId>/<file>` | public | Static-served upload |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | public | Uptime check (no `/api/v1` prefix) |

---

## Auth Flow

```
POST /auth/register
  → 201 { userId, email }
       → OTP sent (or printed to stdout when MAIL_PROVIDER=console)

POST /auth/verify-email  { userId, code }
  → 200 { accessToken, user, needsProfile }  +  Set-Cookie: mnemio_refresh=…
       → needsProfile === true  → PATCH /users/me  (complete profile)
       → needsProfile === false → /dashboard

POST /auth/login  { email, password }
  → 200 { accessToken, user, needsProfile }  +  Set-Cookie: mnemio_refresh=…
  → 401 EMAIL_NOT_VERIFIED (details.userId) → route to OTP step
```

Token lifecycle:
- **Access token**: JWT HS256, 15 min TTL, stored in `localStorage` by the frontend.
- **Refresh token**: opaque 32-byte token, 30-day TTL, rotates on every
  `/auth/refresh`. Lives only in the `mnemio_refresh` HttpOnly cookie.
- **Reuse detection**: presenting a previously-rotated refresh token revokes
  *all* tokens for that user — next `/auth/refresh` returns
  `AUTH_INVALID_REFRESH`; force a hard logout on the frontend.

---

## Error Format

Every error uses the same envelope:

```ts
type ApiError = {
  code: string;                       // e.g. AUTH_INVALID_CREDENTIALS
  message: string;                    // human-readable English (FE handles i18n)
  details?: Record<string, unknown>;  // Zod field errors, extra context
};
```

| Status | Meaning |
|---|---|
| 400 | Validation error |
| 401 | Unauthenticated |
| 403 | Forbidden (ownership check failed) |
| 404 | Not found |
| 409 | Conflict (duplicate email / username) |
| 422 | Business-rule violation |
| 429 | Rate limited |
| 500 | Internal error |

Full code → meaning table in [`docs/api-contract.md §1`](./docs/api-contract.md#1-conventions).

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| Global default | 120 req / min / IP |
| `POST /auth/register`, `POST /auth/login` | 10 req / min / IP |
| `POST /auth/verify-email`, `POST /auth/resend-otp` | 5 req / min / IP |
| `POST /auth/refresh` | 30 req / min / IP |
| `POST /ai/*` | 30 req / min / user |
| `POST /media/uploads` | 30 req / min / user |

---

## Smoke Test (curl)

After `npm run seed` + `npm run dev`:

```bash
BASE=http://localhost:3001/api/v1

# Sign in (writes the mnemio_refresh cookie to /tmp/cookies.txt)
LOGIN=$(curl -sX POST "$BASE/auth/login" -c /tmp/cookies.txt \
  -H 'content-type: application/json' \
  -d '{"email":"demo@mnemio.local","password":"demo-password-123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# Deck list — embedded stats, total, nextCursor
curl -s "$BASE/decks" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -20

# Deck detail — inline cards array
DECK=$(curl -s "$BASE/decks" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])")
curl -s "$BASE/decks/$DECK" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin); \
      print('cards:', len(d['cards']), 'isArray:', isinstance(d['cards'], list))"

# Dashboard
curl -s "$BASE/dashboard" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# Refresh (no body — cookie travels via -b)
curl -sX POST "$BASE/auth/refresh" -b /tmp/cookies.txt -c /tmp/cookies.txt
```

The full registration → verify-email → me flow (incl. OTP scraping for brand-new
users) is in [`docs/api-contract.md §5`](./docs/api-contract.md#5-local-development).

---

## Out of MVP scope

These will return 404 — not planned for v1:

- Password reset / forgot-password (manual support intervention at MVP).
- Folders, leagues / leaderboards.
- Account deletion.
- WebSockets / push notifications.

Other gaps documented in [`docs/api-contract.md §6`](./docs/api-contract.md#6-whats-not-in-this-contract):
admin surface for the `featured` flag (currently toggled via SQL); real LLM
provider for `/ai/*` (currently mocked); S3-backed media (currently local FS).
All of these have **contract-stable swap paths** — when they land, the
endpoint shapes don't change.

---

## Related Repositories

| Repo | Description |
|---|---|
| `mnemio-frontend` | Nuxt 4 frontend (separate repo) |

---

## License

Private — all rights reserved.
