# Mnemio Backend

API for the Mnemio vocabulary-learning app — the server the Nuxt 4 frontend
(`mnemio-frontend`) calls. Built to match
[`docs/api-contract.md`](./docs/api-contract.md) exactly, per the build plan in
[`docs/backend-plan.md`](./docs/backend-plan.md).

**Stack:** TypeScript · Fastify v5 · Prisma 7 (with `@prisma/adapter-pg`) ·
PostgreSQL · Zod · Argon2id · `@fastify/jwt` · `@fastify/cookie` ·
`@fastify/rate-limit` · Vitest.

---

## Quick start

```bash
# 1. Deps + Prisma client
npm install
npx prisma generate

# 2. Start Postgres (Docker Compose; binds host port 5433)
docker compose up -d db

# 3. Apply migrations
npx prisma migrate deploy
#    If a prior failed migration blocks deploy:
#    PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma migrate reset --force

# 4. (Optional) Seed a demo user + two decks of 8–10 cards
npm run seed
#   → email: demo@mnemio.local
#     password: demo-password-123

# 5. Run the API
npm run dev           # tsx watch on http://localhost:3001

# 6. Tests
npm test              # SM-2 + XP unit tests (23 cases)
npm run typecheck     # tsc --noEmit
```

The frontend (Nuxt dev server on `http://localhost:3000`) just needs:

```bash
# In mnemio-frontend
NUXT_PUBLIC_API_BASE=http://localhost:3001/api/v1 npm run dev
```

CORS is allow-listed to `WEB_URL` (default `http://localhost:3000`) with
`credentials: true`, so the refresh cookie rides automatically.

---

## What's implemented (P0)

Per `docs/api-contract.md`, under `/api/v1`:

| Domain | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `verify-email`, `resend-otp`, `login`, `refresh`, `logout`; `GET /auth/me` |
| Users | `PATCH /users/me` (profile completion: `fullName`, `username`, `birthday`) |
| Decks | `GET /decks`, `POST /decks`, `GET /decks/:id`, `PATCH /decks/:id`, `DELETE /decks/:id` |
| Cards | `POST /decks/:id/cards`, `POST /decks/:id/cards/bulk`, `PATCH /cards/:id`, `DELETE /cards/:id` |
| Sessions | `POST /sessions`, `PATCH /sessions/:id`, `POST /sessions/:id/complete`, `POST /sessions/:id/exit`, `POST /sessions/:id/resume`, `GET /sessions/active`, `GET /sessions/incomplete` |
| SRS | `POST /srs/rate`, `GET /srs/due`, `GET /srs/progress` |
| Dashboard | `GET /dashboard` |
| Ops | `GET /health` (no `/api/v1` prefix) |

### Reconciliations from `backend-plan.md §Reconciliations`

| # | Reconciliation | Status |
|---|---|---|
| 1 | `GET /decks` returns `total` alongside `{items, nextCursor}` | ✓ |
| 2 | `GET /decks/:id` returns the full `cards: Card[]` inline (cap **1000**) | ✓ |
| 3 | Sessions expose `cardIndex` (FE maps `index ↔ cardIndex`) | ✓ |
| 4 | `POST /srs/rate` takes `{cardId, rating}`; deckId derived server-side | ✓ |
| 5 | XP server-computed `correct*10 + 25`; client-sent XP ignored | ✓ |

---

## Architecture

Layered, no DI framework:

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
```

### Conventions
- All routes under `/api/v1`; `/health` is the only un-prefixed route.
- Errors normalize to `{ code, message, details? }` (see error-handler.ts).
- Cursor pagination is opaque (base64url keyset on `(updatedAt, id)` for decks).
- IDs are UUID strings. Dates are ISO-8601 UTC. Birthday is `YYYY-MM-DD`.
- Refresh token in `mnemio_refresh` HttpOnly cookie scoped to `/api/v1/auth`;
  Secure flag set only in production.
- Ownership is enforced at the repo layer (`findFirst({where:{id,authorId:owner}})`,
  `updateMany/deleteMany` with the same filter) — controllers can't forget.
- One active study session per user, enforced atomically inside Prisma
  transactions (and a Postgres partial unique index as belt-and-braces).

---

## Open-question decisions (per `backend-plan.md §Open questions`)

| # | Question | Decision |
|---|---|---|
| 1 | Scope now | **P0 only** in this pass — the brief locks scope to the FE-real loop. P1 (Preferences, embedded per-deck stats, Statistics, Achievements, expanded Card model) follows once the FE has swapped all 5 P0 domains and a green build is in. |
| 2 | Per-deck stats | **Embed in deck responses** (recommended) when implemented in P1. Avoids the SRS fan-out the FE does today via `useDeckStats`. |
| 3 | Favorites | **`Preference.favorites`** (recommended) — single PATCH endpoint, no extra routes. P1. |
| 4 | Card model | Add rich fields (`partOfSpeech`, `example`, `tags`, `difficulty`, `type`, etc.) in **one P1 migration** rather than enriching at study time. |
| 5 | Stack | **Confirmed**: Fastify + Prisma + Postgres (current setup). |

---

## Smoke check (curl)

After `npm run seed` + `npm run dev`:

```bash
BASE=http://localhost:3001/api/v1

# Sign in (sets mnemio_refresh cookie in /tmp/cookies.txt)
LOGIN=$(curl -sX POST "$BASE/auth/login" -c /tmp/cookies.txt \
  -H 'content-type: application/json' \
  -d '{"email":"demo@mnemio.local","password":"demo-password-123"}')
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

curl -s "$BASE/decks" -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool | head -10
# → { "items": [...], "nextCursor": null, "total": 2 }

DECK=$(curl -s "$BASE/decks" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])")

curl -s "$BASE/decks/$DECK" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json;d=json.load(sys.stdin); \
      print('cards:', len(d['cards']), 'isArray:', isinstance(d['cards'], list))"
# → cards: 10 isArray: True

curl -s "$BASE/dashboard" -H "Authorization: Bearer $TOKEN" \
  | python3 -m json.tool
```

The full registration → verify-email → me flow is in
[`docs/api-contract.md §5`](./docs/api-contract.md#5-local-development).

---

## Environment

Copy `.env.example` to `.env` and adjust. Required variables:

| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | ≥ 32 chars; HS256 access-token signing key |
| `WEB_URL` | CORS allow-list origin (default `http://localhost:3000`) |

Optional:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `NODE_ENV` | `development` | `production` makes the refresh cookie `Secure` |
| `LOG_LEVEL` | `info` | Pino level |
| `JWT_ACCESS_TTL` | `15m` | |
| `JWT_REFRESH_TTL_DAYS` | `30` | |
| `MAIL_PROVIDER` | `console` | `console` prints OTPs to stdout in dev |
| `MAIL_FROM` | `Mnemio <noreply@mnemio.local>` | |

OAuth (`OAUTH_GOOGLE_*`, `OAUTH_FACEBOOK_*`, `OAUTH_APPLE_*`) is reserved for
P2 — the `arctic` dependency is in place but no routes are wired.

---

## Out of scope here

Anything labeled P1/P2 in `backend-plan.md`: Preferences, Statistics,
Achievements, Discover, AI, Media. Add these after the FE has fully migrated
off the localStorage mocks.
