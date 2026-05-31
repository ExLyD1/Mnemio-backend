# Mnemio-backend

> REST API backend for Mnemio — the AI-powered vocabulary & flashcard learning platform.

Built with Fastify, Node.js, and TypeScript. Handles all auth, deck management, study sessions, spaced repetition, and AI features. The Nuxt frontend (`mnemio-web`) communicates exclusively through this API — the database is never exposed directly.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Fastify |
| Language | TypeScript |
| Validation | Zod |
| Auth | @fastify/jwt (HS256, 15 min access token) + HttpOnly refresh cookie |
| Password hashing | argon2 |
| OAuth | Arctic (Google) |
| ORM | Prisma |
| Database | PostgreSQL (Supabase) |
| Cache | Upstash Redis |
| Email | Resend |
| AI | Vercel AI SDK |
| Rate limiting | @fastify/rate-limit |
| CORS | @fastify/cors |

---

## Architecture

```
mnemio-web (Nuxt 4)
     ↕  REST  /api/v1
mnemio-api (Fastify)          ← this repo
     ↕  Prisma ORM
PostgreSQL on Supabase

     ↕  ioredis
Upstash Redis                 (token cache, rate limit state)
```

The frontend never touches the database. All business logic, auth, and data access lives here.

**Deployment:** Railway / Render

---

## Project Structure

```
mnemio-api/
├── src/
│   ├── config/           # Env config, constants
│   ├── lib/              # Prisma client, Redis client, Resend client
│   ├── middleware/        # Auth guard, error handler
│   ├── routes/           # Fastify route handlers (auth, users, decks, cards, sessions, srs, dashboard)
│   ├── schemas/          # Zod request/response schemas
│   ├── services/         # Business logic (authService, deckService, srsService, …)
│   └── server.ts         # Fastify app bootstrap
├── prisma/
│   ├── schema.prisma     # 11-model schema
│   └── migrations/
├── .env.example
├── docker-compose.yml    # Local Postgres
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm (recommended)
- Docker (for local Postgres) **or** a Supabase project

### Install

```bash
git clone https://github.com/your-username/mnemio-api.git
cd mnemio-api
pnpm install
```

### Environment

```bash
cp .env.example .env
```

```env
# Server
PORT=3001
NODE_ENV=development

# Frontend origin (for CORS)
WEB_URL=http://localhost:3000

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemio

# Auth
JWT_SECRET=your-secret-here
REFRESH_TOKEN_SECRET=your-secret-here

# Redis (Upstash)
REDIS_URL=rediss://...
REDIS_TOKEN=...

# Email (Resend)
RESEND_API_KEY=re_...
MAIL_FROM=noreply@mnemio.app
# Set to 'console' in dev to print OTPs to stdout instead of sending email
MAIL_PROVIDER=console

# OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

### Local database

```bash
docker compose up -d db
npx prisma migrate deploy
```

### Dev server

```bash
pnpm dev    # http://localhost:3001
```

Health check: `GET http://localhost:3001/health` → `{ "status": "ok" }`

---

## API Overview

Base path: `/api/v1`

All protected routes require `Authorization: Bearer <accessToken>`. The refresh token lives exclusively in the `mnemio_refresh` HttpOnly cookie — the frontend never reads it.

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

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| PATCH | `/users/me` | ✓ | Update `fullName`, `username`, `birthday` |

### Decks

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/decks` | ✓ | Paginated deck list (cursor-based), supports `?q=` search |
| POST | `/decks` | ✓ | Create deck |
| GET | `/decks/:id` | ✓ | Deck + first page of cards |
| PATCH | `/decks/:id` | ✓ | Update deck metadata |
| DELETE | `/decks/:id` | ✓ | Delete deck (cascades to cards, progress, sessions) |

### Cards

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/decks/:id/cards` | ✓ | Add single card |
| POST | `/decks/:id/cards/bulk` | ✓ | Add up to 100 cards at once (AI deck creation) |
| PATCH | `/cards/:id` | ✓ | Update word, definition, phonetic, or position |
| DELETE | `/cards/:id` | ✓ | Delete card |

### Study Sessions

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/sessions` | ✓ | Start new session (implicitly ends any active one) |
| PATCH | `/sessions/:id` | ✓ | Record mid-session progress (`cardIndex`, `correct`) |
| POST | `/sessions/:id/complete` | ✓ | Close session, server computes XP |
| POST | `/sessions/:id/exit` | ✓ | Exit without XP (marks `incomplete`) |
| POST | `/sessions/:id/resume` | ✓ | Resume an incomplete session |
| GET | `/sessions/active` | ✓ | Current active session or `null` |
| GET | `/sessions/incomplete` | ✓ | Most recent incomplete session or `null` |

### SRS (Spaced Repetition)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/srs/rate` | ✓ | Rate a card (`again` / `hard` / `good` / `easy`), runs SM-2 |
| GET | `/srs/due` | ✓ | Cards due for review (most-overdue first) |
| GET | `/srs/progress` | ✓ | Full progress map for the user |

### Dashboard

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/dashboard` | ✓ | Stats, due count, recent decks, continue-studying session |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | public | Uptime check (no `/api/v1` prefix) |

---

## Auth Flow

```
POST /auth/register
  → 201 { userId, email }
       → OTP sent to email (or printed to stdout in dev)

POST /auth/verify-email  { userId, code }
  → 200 { accessToken, user, needsProfile }  +  Set-Cookie: mnemio_refresh=...
       → needsProfile true  → PATCH /users/me (complete profile)
       → needsProfile false → /dashboard

POST /auth/login  { email, password }
  → 200 { accessToken, user, needsProfile }  +  Set-Cookie: mnemio_refresh=...
  → 401 EMAIL_NOT_VERIFIED (details.userId) → route to OTP step
```

Token lifecycle:
- Access token: JWT HS256, 15 min TTL, stored in `localStorage` by the frontend
- Refresh token: opaque 32-byte token, 30-day TTL, rotates on every `/auth/refresh`
- Reuse detection: presenting a rotated token revokes **all** tokens for that user

---

## Error Format

Every error response uses a consistent envelope:

```ts
type ApiError = {
  code: string;                       // e.g. AUTH_INVALID_CREDENTIALS
  message: string;                    // human-readable (frontend handles i18n)
  details?: Record<string, unknown>;  // Zod field errors, extra context
}
```

| Status | Meaning |
|---|---|
| 400 | Validation error |
| 401 | Unauthenticated |
| 403 | Forbidden (ownership check) |
| 404 | Not found |
| 409 | Conflict (duplicate email / username) |
| 422 | Business rule violation |
| 429 | Rate limited |
| 500 | Internal error |

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| Global | 120 req / min / IP |
| `POST /auth/register`, `POST /auth/login` | 10 req / min / IP |
| `POST /auth/verify-email`, `POST /auth/resend-otp` | 5 req / min / IP |
| `POST /auth/refresh` | 30 req / min / IP |

---

## Smoke Test (curl)

```bash
BASE=http://localhost:3001/api/v1

# 1. Register
curl -sX POST "$BASE/auth/register" \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"hunter22!"}'

# 2. Verify OTP (grab code from backend stdout)
curl -sX POST "$BASE/auth/verify-email" -c cookies.txt \
  -H 'content-type: application/json' \
  -d '{"userId":"<id>","code":"123456"}'

# 3. Refresh
curl -sX POST "$BASE/auth/refresh" -b cookies.txt -c cookies.txt

# 4. Authenticated call
curl -s "$BASE/auth/me" -H "Authorization: Bearer <accessToken>"
```

---

## Out of MVP scope

The following are **not implemented** and will return 404:

- Password reset / forgot-password
- Avatar upload
- Public deck browsing / explore / clone
- Folders, achievements, leagues
- Account deletion
- WebSockets / push notifications

---

## Related Repositories

| Repo | Description |
|---|---|
| [`mnemio-web`](https://github.com/your-username/mnemio-web) | Nuxt 4 frontend |

---

## License

Private — all rights reserved.
