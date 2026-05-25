# Mnemio Backend — MVP Discovery & Implementation Plan

> Reverse-engineered from the existing Nuxt 4 frontend at
> `/Users/oleksandr_yakhnii/Data/work-projects/mnemio-frontend`.
> Stack confirmed with the user: **Fastify + raw SQL (no ORM) + PostgreSQL**.
> AI deferred to post-MVP. Auth MVP includes email/password + OTP email
> verification + social OAuth (Apple/Facebook/Google) + refresh-token rotation.

---

## Context

The frontend is a partially-built vocabulary-learning app ("Mnemio"). Today it
ships only a landing page, a 3-step auth UI (no real backend), a stub `profile`
Pinia store, and a small set of UI primitives. The frontend implementation plan
([docs/implementation-plan.md](docs/implementation-plan.md)) lays out four
vertical phases (Auth → Decks/Cards → Study → SRS/Dashboard), all of which run
against a `localStorage`-backed mock API.

This document is the **backend-side** of that picture: what the API must look
like to drop into those mock seams without changing stores or components, how to
build it on Fastify + raw SQL on Postgres, and the order to do it in so that
each phase of the frontend can be cut over from mock to real one phase at a
time.

**Legend used throughout:**
- ✅ Confirmed — directly visible in the frontend code.
- 🔎 Inferred — implied by UI/UX or the implementation plan.
- 💭 Speculative — recommendation that needs sign-off.

---

## 1. Product Understanding

**Product idea (✅ from landing copy + planning doc):**
Mnemio is a free, ad-free, AI-first vocabulary learning platform built on
*active recall* + *spaced repetition*. Users create decks of word/definition
cards and study them via flashcard, multiple-choice, and (post-MVP) other modes.
Progress is tracked per card via an SM-2 spaced-repetition schedule.

**Primary business domains (inferred from plan + UI):**
1. **Identity** — accounts, sessions, OAuth, email verification.
2. **Content** — decks and cards (the user-owned learning material).
3. **Study** — sessions, attempts, results, XP.
4. **Spaced Repetition** — per-card scheduling state (SM-2).
5. **Dashboard / Stats** — aggregated read model over the above.
6. *(Post-MVP)* AI generation, folders, public/explore, achievements, leagues.

**User roles (✅/🔎):**
- A single role at MVP: **authenticated user**. No admin/moderator UI exists.
- All resources are owned by exactly one user (`ownerId` on `Deck`).
- 💭 Recommendation: model `role` as a single column `users.role` defaulting to
  `'user'` so an `'admin'` value can be added later without migration churn.

**Core workflows (🔎 from plan + UI):**
1. Register (email+password → OTP email verify → profile completion) → land on
   dashboard. *Or* social OAuth → first-time profile completion if missing.
2. Create deck → add cards → study (flashcard or multiple choice).
3. After study, results screen shows XP + accuracy → session persisted.
4. Daily: open `/review` → SM-2 due queue → rate cards (Again/Hard/Good/Easy).
5. Refresh anywhere → session restored from access token.

---

## 2. Current MVP Analysis (Frontend State Today)

### Finished features (✅)
- Landing page with marketing copy + 5 feature segments
  ([app/pages/index.vue](app/pages/index.vue)).
- UI primitives: `Button`, `InputField`, `InputOtp`, `InputSearch`, `Tabs`,
  `CheckButton` ([app/components/ui/](app/components/ui/)).
- Layout shell — `landing`, `auth`, `default` layouts; `Header`, `Aside`,
  `Footer` ([app/layouts/](app/layouts/), [app/components/layout/](app/components/layout/)).
- 3-step auth UI: email/password → OTP → account-details
  ([app/pages/login.vue](app/pages/login.vue),
  [app/components/login/](app/components/login/)).

### Partially implemented (🔎)
- **Auth store** — `app/stores/profile.ts` holds `{ id, email, accessToken,
  refreshToken, isAuthenticated }` but `id: 1` is hardcoded and tokens aren't
  persisted. The implementation plan calls for replacing this with
  `app/stores/auth.ts`.
- **Account-details step** has UI (`fullName`, `username`, `birthday`) but no
  submit handler — never POSTs anywhere.
- **Resend OTP** button exists but does nothing.

### Mocked / fake (✅ in code)
- `app/api/auth.ts` — `login` and `register` are async stubs returning canned
  objects. No HTTP. `register` returns `accessToken: 'mocked_token'`.
- `app/composables/useAuth.ts` — wraps the stubs; no error handling.
- Social buttons (Apple/Facebook/Google) — render only, no click handlers wired.

### Missing backend-dependent functionality (per plan, not yet in code)
- Deck/Card CRUD, study sessions, SRS progress, dashboard stats — all Phases
  2–4 of the frontend plan; none of them exist in `app/` yet.
- `app/middleware/` and `app/plugins/` are **empty directories** — no route
  guard, no token hydration on boot.
- No Zod schemas exist yet (`app/schemas/` doesn't exist). Inline regex
  validation only in `AuthForm.vue`.

### Technical debt & risky assumptions
- `RegisterEmail.vue` emits `email: 'qwe', password: 'qwe'` hardcoded — the
  password the user typed in step 1 is lost across steps. State machine across
  the auth steps is fragile.
- `useAuth.login` takes `(email, password, accessToken)` — `accessToken` as a
  *login input* makes no sense; likely a leftover. Frontend will need to clean
  this up before integration.
- Type of `User.id` is `number` in the store but the implementation plan's data
  model says `id: string`. **Need to lock id type before backend ships** (see
  Missing Decisions §9).

---

## 3. Frontend Architecture Findings

- **Framework:** Nuxt 4 (Vue 3, TypeScript). Pinia, VueUse, vee-validate, Zod,
  `@nuxtjs/i18n` (only `en-US` configured), `@nuxtjs/color-mode` (dark only at
  MVP), `lucide-vue-next`. No HTTP client installed yet — `useFetch`/`$fetch`
  from Nuxt is the natural choice.
- **API seam:** the plan locks all real network calls into `app/api/*.ts`. When
  the backend is ready, **only those files change** — stores and components
  stay untouched. This is the integration contract the backend must honor.
- **Session-persistence model (planned):** `localStorage` for `accessToken`;
  `app/plugins/01.auth.ts` hydrates the auth store before middleware runs;
  `app/middleware/auth.global.ts` enforces a public-route allowlist (`/`,
  `/login`). This implies a **stateless JWT-style access token** the frontend
  can stash, plus a refresh mechanism (see §5).
- **Mock schema versioning:** the plan uses a `MOCK_SCHEMA_VERSION` constant
  with localStorage key prefix `mnemio:v{version}:{userId}:{resource}`. Useful
  context: the backend should pick a **stable identifier for each user early**
  (UUID v7 recommended) because frontend mock keys are scoped by it.
- **No i18n message files exist yet** — copy is hardcoded in components today.
  Backend error messages should be **codes**, not localized strings, so the
  frontend can map them through i18n later.

---

## 4. Backend Requirements

### 4.1 Modules
| Module | Responsibilities |
|---|---|
| `auth` | Register, login (password & OAuth), OTP issue/verify, refresh, logout, "me". |
| `users` | Profile CRUD (displayName, username, birthday, avatar URL). |
| `decks` | CRUD + listing/search/pagination. Scoped by `ownerId`. |
| `cards` | CRUD within a deck. Bulk create (for paste import later). |
| `sessions` | Create study session, append attempts, close session (active/incomplete/complete). |
| `srs` | Read due queue, write rating outcome (delegates math to a pure function). |
| `dashboard` | Aggregated read endpoint (stats, recent decks, due count, latest incomplete session). |
| `mail` | Outbound transactional email (OTP, welcome). One thin adapter. |

### 4.2 Entities & relationships (see §6 for SQL)
- `User 1—* Deck 1—* Card` (cards always live inside a deck; cascade delete).
- `User 1—* StudySession *—1 Deck`; `StudySession 1—* StudySessionAttempt *—1 Card`.
- `User 1—* CardProgress *—1 Card` (one row per user×card; SRS state).
- `User 1—* RefreshToken` (rotating; hashed at rest).
- `User 1—* EmailVerification` (short-lived OTP; consumed on success).
- `User 1—* OAuthIdentity` (provider, providerUserId).

### 4.3 Auth / Authz
- **Access token:** short-lived JWT (15 min), signed HS256 from a single
  shared secret (or RS256 with a key pair if multiple services are planned —
  not needed at MVP). Claims: `sub` (userId), `iat`, `exp`, `email_verified`.
- **Refresh token:** opaque random 256-bit string, **hashed at rest**
  (`sha256`). 30-day TTL with rotation: every refresh issues a new token and
  invalidates the old one. Stored in `refresh_tokens` with `user_id`,
  `token_hash`, `user_agent`, `ip`, `created_at`, `expires_at`,
  `revoked_at`, `replaced_by_id`. Frontend stores both in localStorage; the
  implementation plan already locks this.
- **OTP email verification:** 6-digit code (matches `UiInputOtp` length=6),
  10-minute TTL, max 5 attempts, rate-limited per email. On success, set
  `users.email_verified_at`.
- **OAuth:** Apple, Facebook, Google. Use
  [`@fastify/oauth2`](https://github.com/fastify/fastify-oauth2). On callback:
  upsert into `oauth_identities`, find-or-create `users` row, return our own
  JWT + refresh token (do **not** propagate the provider's token to the
  client). If user has no `display_name`/`username` yet, frontend routes them
  to the account-details step.
- **Route auth:** Fastify `preHandler` hook that verifies the JWT and attaches
  `request.user = { id, role, emailVerified }`. All non-public routes require it.
- **Ownership checks:** every deck/card/session/progress query must filter by
  `owner_id = request.user.id`. No exceptions; centralize in repository
  functions, not controllers.

### 4.4 Realtime / WebSockets
- **Not needed at MVP.** Nothing in the UI is collaborative or push-driven.
  Defer to post-MVP if leagues/leaderboards arrive.

### 4.5 File uploads
- Avatars (planned, not in current UI) — defer until post-MVP `/profile` page
  is built. When needed, presigned PUT to S3-compatible storage; backend stores
  only the URL.

### 4.6 Notifications
- Transactional email only at MVP: OTP, welcome. One provider (Resend or
  Postmark — see §9). No push, no in-app feed.

### 4.7 Background jobs
- **None required at MVP.** Email send is fire-and-forget from the request
  handler (acceptable for OTPs given low volume). When AI generation lands or
  if email volume grows, add BullMQ + Redis.
- Optional cron: nightly cleanup of expired `email_verifications` and
  `refresh_tokens` rows (a daily `DELETE WHERE expires_at < now() - interval
  '7 days'` — could also be a Postgres `pg_cron` extension if available).

### 4.8 Caching
- **Not at MVP.** Postgres + a small dataset (200 decks, 1000 cards each per
  user — limits set in the frontend plan) is far below where caching pays off.
- Add HTTP `Cache-Control: no-store` on all authenticated endpoints to prevent
  CDN/browser caching of personal data.

### 4.9 Rate limiting
- Use [`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit).
- Tight limits on `/auth/*` endpoints: e.g. 10 req/min per IP on login,
  5 req/min per email on `request-otp`, 5 attempts per code on `verify-otp`.
- Generous default elsewhere: 120 req/min per user.

### 4.10 Validation
- [TypeBox](https://github.com/sinclairzx81/typebox) for request/response
  schemas — native to Fastify, generates JSON Schema for auto-docs and gives
  TypeScript types for free. Fastify validates with Ajv under the hood.
- Mirror the frontend's Zod schemas where the shape is identical (no shared
  package needed at MVP — duplication of ~10 schemas is cheaper than a
  monorepo setup; revisit post-MVP).

### 4.11 Pagination / filtering / search
- Cursor-based pagination (`?cursor=<opaque>&limit=20`) for deck list and card
  list. Frontend paginates decks at 20/page and cards at 50/page; the backend
  should accept `limit` up to a hard cap of 100.
- Deck search: `?q=<term>` → `ILIKE '%term%'` on `title` + `description`.
  Frontend already debounces at 300ms; no server-side debounce needed. Add a
  trigram GIN index (`pg_trgm`) once decks grow.

### 4.12 Error handling
- Single error envelope: `{ code: string, message: string, details?: object }`.
- Matches the implementation plan's `ApiError { code, message }` (see plan
  §"Data Model"). Frontend `useAsync` is documented to "catch and expose
  `{ data, error, loading }`" — backend just needs to throw the right shape.
- HTTP status mapping: 400 validation, 401 unauthenticated, 403 forbidden,
  404 not found, 409 conflict (e.g. duplicate email), 422 business rule, 429
  rate-limited, 500 internal.
- Centralize via a Fastify `setErrorHandler` that maps custom error classes →
  envelope. Never leak stack traces in non-dev `NODE_ENV`.

### 4.13 Audit logging
- 💭 Recommend a thin `audit_log` table for security-relevant events only:
  login success/failure, password change, OAuth link, OTP request/verify,
  refresh-token revoke. Keep it append-only; no business-event firehose.

### 4.14 Analytics / event tracking
- **Not at MVP.** Frontend has no analytics SDK installed. Defer.

---

## 5. Suggested Architecture (Fastify, raw SQL, PostgreSQL)

> **Note:** The original prompt mentioned NestJS; user explicitly chose
> **Fastify + raw SQL + PostgreSQL**. All recommendations below reflect that.

### 5.1 Folder structure
```
src/
  app.ts                    # Fastify factory (testable)
  server.ts                 # binds to port; loads env
  config/
    env.ts                  # zod-validated env loader
  plugins/                  # Fastify plugins (auto-loaded via @fastify/autoload)
    db.ts                   # pg Pool, request.db decorator
    jwt.ts                  # @fastify/jwt setup
    auth.ts                 # authenticate preHandler
    rate-limit.ts
    cors.ts
    helmet.ts
    oauth.ts                # @fastify/oauth2 for Apple/Google/Facebook
    error-handler.ts
  modules/
    auth/
      auth.routes.ts
      auth.service.ts
      auth.repo.ts          # raw SQL
      auth.schemas.ts       # TypeBox
      otp.service.ts
      oauth.service.ts
    users/
      users.routes.ts
      users.service.ts
      users.repo.ts
      users.schemas.ts
    decks/
    cards/
    sessions/
    srs/
      srs.routes.ts
      srs.service.ts
      sm2.ts                # PURE function, mirrors frontend useSpacedRepetition
      srs.repo.ts
    dashboard/
    mail/
      mail.service.ts
      templates/
  shared/
    errors.ts               # AppError + subclasses (NotFound, Forbidden, …)
    pagination.ts           # cursor encode/decode
    sql.ts                  # tagged template helper (see §5.4)
  db/
    migrations/             # node-pg-migrate or dbmate .sql files
    seeds/
test/
  unit/
  integration/              # spin up real Postgres via testcontainers
```

### 5.2 Key libraries
- **Server:** `fastify` v5.
- **Plugins:** `@fastify/autoload`, `@fastify/jwt`, `@fastify/cors`,
  `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/oauth2`,
  `@fastify/sensible`, `@fastify/swagger` + `@fastify/swagger-ui`
  (auto-docs from TypeBox schemas).
- **DB driver:** [`pg`](https://node-postgres.com/) (the canonical raw driver).
  Use a `Pool` per process.
- **Migrations:** [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
  (.sql or .js migrations, plays well with raw-SQL ethos) **or**
  [`dbmate`](https://github.com/amacneil/dbmate) (pure .sql, language-agnostic
  — recommended if you might rewrite the backend in another language later).
  💭 **Recommendation: dbmate** — keeps migrations as plain `.sql` files,
  matches the no-ORM philosophy.
- **Validation:** `@sinclair/typebox` + Ajv (Fastify uses Ajv natively).
- **Auth:** `@fastify/jwt`, `argon2` (password hashing — better than bcrypt for
  new projects), `@fastify/oauth2`.
- **Mail:** Resend SDK (simplest DX) or `nodemailer` against Postmark/SES.
- **Logging:** Pino (Fastify's default). Structured JSON; redact `authorization`
  + `password` fields.
- **Testing:** `node:test` or `vitest`, `supertest` or Fastify's `inject`,
  `testcontainers` for ephemeral Postgres.

### 5.3 Configuration management
- `.env` files per environment, never committed. `.env.example` checked in.
- One `config/env.ts` that runs Zod over `process.env` at boot and **fails fast**
  if a required var is missing. Export a typed `env` object; never read
  `process.env` directly elsewhere.
- Required vars: `DATABASE_URL`, `JWT_SECRET`, `JWT_ACCESS_TTL`,
  `JWT_REFRESH_TTL`, `MAIL_PROVIDER_API_KEY`, `MAIL_FROM`,
  `OAUTH_GOOGLE_CLIENT_ID/SECRET`, `OAUTH_FACEBOOK_*`, `OAUTH_APPLE_*`,
  `APP_URL`, `WEB_URL`, `NODE_ENV`, `LOG_LEVEL`.

### 5.4 Raw SQL ergonomics (do this on day 1)
Without an ORM, the two real risks are (a) SQL injection from concatenation
and (b) row → object mapping boilerplate. Mitigate both with a tiny helper:

```ts
// src/shared/sql.ts
export const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  text: strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), ''),
  values,
});
// usage:
//   const { rows } = await db.query(sql`SELECT * FROM decks WHERE owner_id = ${userId}`);
```

This forces every interpolation to become a parameterized query. Pair with a
convention that **every repo function returns a domain type**, mapped explicitly
from the row (so a renamed column doesn't silently break callers). Example:

```ts
// src/modules/decks/decks.repo.ts
export const findDeckById = async (db: PoolClient, id: string, ownerId: string) => {
  const { rows } = await db.query(
    sql`SELECT id, owner_id, title, description, source_language, target_language,
               is_public, created_at, updated_at
        FROM decks WHERE id = ${id} AND owner_id = ${ownerId}`
  );
  return rows[0] ? toDeck(rows[0]) : null;
};
```

💭 If raw SQL ergonomics start to hurt, [`slonik`](https://github.com/gajus/slonik)
is a drop-in upgrade that keeps SQL strings but adds runtime validation and
type-safety without becoming an ORM. **Don't add it until it hurts.**

### 5.5 API style
- **REST + JSON.** GraphQL/tRPC bring no benefit at this scope. REST integrates
  cleanly with `$fetch` / `useFetch` in Nuxt, and with `@fastify/swagger` you
  get an OpenAPI doc for free.
- All endpoints under `/api/v1`. URI versioning is the cheapest forward-compat.

### 5.6 DTO strategy
- Inputs: TypeBox `Type.Object({...})` in `*.schemas.ts`; route handler types
  are inferred via `Static<typeof schema>`.
- Outputs: also TypeBox schemas; declare them in route options to enable
  Fastify's response serialization (faster than `JSON.stringify`, and acts as a
  guard against leaking columns like `password_hash`).
- **Never** return a raw DB row. Always go through an explicit mapper.

### 5.7 Testing
- **Unit:** pure functions only — `sm2.ts`, OTP code generation, cursor
  encode/decode, mappers. Fast, no DB.
- **Integration:** Fastify `inject()` + testcontainers Postgres. Run the real
  migrations against an ephemeral DB per suite. Cover: auth happy path, OTP
  flow, ownership enforcement (user A cannot read user B's deck), SRS rating
  end-to-end.
- **No e2e** at MVP — the frontend's manual smoke-test covers the cross-system
  story (see frontend plan §"End-to-end smoke test").

### 5.8 Scalability considerations
- Stateless HTTP layer (JWT) → horizontal scale is trivial.
- Single Postgres instance is plenty for MVP. Plan upgrade path: read replicas
  when dashboard/stats queries get heavy.
- `pg.Pool` defaults are fine; set `max` to ~`2 * cpuCount` per process.
- Pre-MVP perf budget: p95 < 200 ms on every endpoint with a representative
  dataset (200 decks × 1000 cards). Easy.

### 5.9 Security considerations
- Argon2id for passwords (`memoryCost: 19 MiB`, `timeCost: 2`, `parallelism: 1`).
- JWT secret ≥ 32 bytes, rotated yearly (refresh tokens survive rotation by
  design — they don't carry the secret).
- All cookies (if used) — `httpOnly`, `Secure`, `SameSite=Lax`.
- 💭 Strongly consider **refresh-token-in-HttpOnly-cookie + access-token-in-memory**
  instead of "both in localStorage." LocalStorage tokens are XSS-stealable. The
  frontend plan currently writes the access token to localStorage; this is a
  decision worth challenging — see §9.
- CORS allowlist exactly `WEB_URL`. No wildcard.
- Helmet defaults + a CSP that only allows the frontend's own origin (the
  frontend has no third-party script tags today, so a strict CSP is feasible).
- `@fastify/rate-limit` on `/auth/*` (§4.9).
- Argon2 + parameterized SQL = no SQLi, no password leak. Audit log (§4.13)
  catches the rest.

### 5.10 Deployment
- Single Docker image, multi-stage build (builder → distroless or
  `node:22-slim`).
- **Hosting:** Fly.io, Render, or Railway for MVP (managed Postgres + simple
  deploys). AWS ECS/Fargate when scale warrants the ops cost.
- Database backups: daily snapshots from the managed provider; weekly restore
  drill in staging (manual at MVP).
- One staging environment that mirrors prod (same env vars, smaller DB).
- CI: GitHub Actions runs `lint + typecheck + unit + integration` on every PR;
  a tagged release triggers deploy.

---

## 6. Database Design

### 6.1 Conventions
- All ids are **UUID v7** (time-ordered → good index locality). Generate
  client-side (in the service layer) using `uuid` package — don't depend on
  Postgres `uuid_generate_v7` extension (not in core yet).
- Snake_case columns; plural table names.
- Every table: `created_at timestamptz NOT NULL DEFAULT now()`,
  `updated_at timestamptz NOT NULL DEFAULT now()` (kept current via trigger).
- Soft-delete: **not at MVP.** Hard delete with cascades. If the product later
  needs "restore deck," add `deleted_at` to specific tables only.

### 6.2 Tables (MVP)

```sql
-- USERS
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           citext UNIQUE NOT NULL,         -- citext for case-insensitive
  password_hash   text,                            -- nullable: OAuth-only users
  display_name    text,
  username        citext UNIQUE,                   -- may be null until profile completion
  birthday        date,
  role            text NOT NULL DEFAULT 'user',
  email_verified_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- OAUTH IDENTITIES (Apple / Google / Facebook)
CREATE TABLE oauth_identities (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,                   -- 'google' | 'apple' | 'facebook'
  provider_user_id text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX ON oauth_identities (user_id);

-- EMAIL VERIFICATION (OTP codes)
CREATE TABLE email_verifications (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       text NOT NULL,                   -- sha256 of 6-digit code
  attempts        smallint NOT NULL DEFAULT 0,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_verifications (user_id, consumed_at);

-- REFRESH TOKENS (rotating)
CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,            -- sha256 of opaque token
  user_agent      text,
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  replaced_by_id  uuid REFERENCES refresh_tokens(id)
);
CREATE INDEX ON refresh_tokens (user_id, revoked_at);

-- DECKS
CREATE TABLE decks (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  source_language text NOT NULL,                   -- ISO 639-1, e.g. 'en'
  target_language text NOT NULL,
  is_public       boolean NOT NULL DEFAULT false,
  card_count      integer NOT NULL DEFAULT 0,      -- denormalized; trigger-maintained
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON decks (owner_id, updated_at DESC);
CREATE INDEX ON decks USING gin (title gin_trgm_ops);  -- for ?q= search

-- CARDS
CREATE TABLE cards (
  id              uuid PRIMARY KEY,
  deck_id         uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  word            text NOT NULL,
  definition      text NOT NULL,
  phonetic        text,
  position        integer NOT NULL DEFAULT 0,      -- for user-defined ordering
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cards (deck_id, position);

-- CARD PROGRESS (SM-2 state per user × card)
CREATE TABLE card_progress (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id         uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ease_factor     real NOT NULL DEFAULT 2.5,        -- min 1.3
  interval_days   integer NOT NULL DEFAULT 0,
  repetitions     integer NOT NULL DEFAULT 0,
  next_review_at  timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz,
  PRIMARY KEY (user_id, card_id)
);
CREATE INDEX ON card_progress (user_id, next_review_at);    -- the due-queue index

-- STUDY SESSIONS
CREATE TABLE study_sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id         uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  mode            text NOT NULL,                    -- 'flashcard' | 'multiple_choice' | 'srs'
  status          text NOT NULL,                    -- 'active' | 'incomplete' | 'complete'
  card_ids        uuid[] NOT NULL,                  -- snapshot of session queue
  index           integer NOT NULL DEFAULT 0,
  correct         integer NOT NULL DEFAULT 0,
  xp_awarded      integer NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE UNIQUE INDEX one_active_session_per_user
  ON study_sessions (user_id) WHERE status = 'active';
-- ^^ Enforces frontend plan's "only one active session at a time" rule.

-- AUDIT LOG (security events)
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  event           text NOT NULL,                    -- 'login.success', 'otp.verify.fail', ...
  ip              inet,
  user_agent      text,
  details         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (user_id, created_at DESC);
```

**Extensions needed:** `citext`, `pg_trgm`. Both ship with Postgres core.

### 6.3 Notes on `card_progress`
- Partial unique index on `(user_id, next_review_at)` is the **hot path** for
  the daily review queue (`SELECT … WHERE user_id = $1 AND next_review_at <=
  now() ORDER BY next_review_at LIMIT 50`).
- A row is created **lazily** the first time a user rates a card (not when the
  card itself is created). Decks shared with millions of users won't bloat
  this table.

### 6.4 Notes on `study_sessions.card_ids`
- Storing a snapshot array means the session is stable even if cards are added
  or deleted mid-session. Tradeoff: can't `JOIN` to it. Fine — sessions are
  read individually.

---

## 7. API Design (endpoints)

All paths prefixed `/api/v1`. All non-public routes require
`Authorization: Bearer <accessToken>`. Errors return `{ code, message, details? }`.

### Auth
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Email+password. Creates user (unverified), sends OTP, returns `{ userId, email }`. **No token issued yet.** |
| `POST` | `/auth/verify-email` | Body: `{ userId, code }`. On success, marks verified + issues `{ accessToken, refreshToken, user }`. |
| `POST` | `/auth/resend-otp` | Body: `{ userId }`. Throttled. |
| `POST` | `/auth/login` | Body: `{ email, password }`. Returns `{ accessToken, refreshToken, user }`. |
| `POST` | `/auth/refresh` | Body: `{ refreshToken }`. Rotates + returns new pair. |
| `POST` | `/auth/logout` | Body: `{ refreshToken }`. Revokes that token only (not all sessions). |
| `GET`  | `/auth/me` | Returns `User`. |
| `GET`  | `/auth/oauth/:provider` | Redirects to provider. `:provider` ∈ `google|facebook|apple`. |
| `GET`  | `/auth/oauth/:provider/callback` | Provider callback. Redirects to frontend with a short-lived `code` the frontend exchanges. |
| `POST` | `/auth/oauth/exchange` | Body: `{ code }`. Returns `{ accessToken, refreshToken, user, needsProfile: boolean }`. |

### Users
| Method | Path | Purpose |
|---|---|---|
| `PATCH` | `/users/me` | Update `displayName`, `username`, `birthday`. Validates uniqueness on `username`. Used by step 3 of the auth flow. |

### Decks
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/decks?cursor=&limit=20&q=` | List user's decks; search + paginate. |
| `POST` | `/decks` | Create. |
| `GET` | `/decks/:id` | Get one with nested cards (matches frontend store shape `deck.cards`). Paginate cards: `?cardsCursor=&cardsLimit=50`. |
| `PATCH` | `/decks/:id` | Update. |
| `DELETE` | `/decks/:id` | Delete (cascades to cards + progress + sessions). |

### Cards
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/decks/:id/cards` | Create one. |
| `POST` | `/decks/:id/cards/bulk` | Create many (≤100). Future-proof for paste-import. |
| `PATCH` | `/cards/:id` | Update. |
| `DELETE` | `/cards/:id` | Delete. |

### Sessions
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | Start. Body: `{ deckId, mode }`. **Side effect:** marks any current `active` session `incomplete` (matches frontend locked rule). Returns the session with snapshotted `cardIds`. |
| `PATCH` | `/sessions/:id` | Append progress. Body: `{ index, correct }`. |
| `POST` | `/sessions/:id/complete` | Close + compute final XP. |
| `GET` | `/sessions/incomplete` | Latest incomplete (for "Continue studying" CTA). |

### SRS
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/srs/due?limit=50` | Cards due now, oldest-due first. |
| `POST` | `/srs/rate` | Body: `{ cardId, quality: 0..5 }`. Runs SM-2; returns updated `CardProgress`. |

### Dashboard
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dashboard` | One round-trip: `{ stats: { decks, cards, xp }, dueCount, recentDecks: Deck[5], continueStudying: ActiveSession | null }`. |

---

## 8. Security Concerns (consolidated)

1. **Password storage** — argon2id only; never reversible.
2. **Token storage** — current frontend plan puts both tokens in localStorage,
   which is XSS-vulnerable. **Strongly recommend** switching to httpOnly cookie
   for refresh + memory-only access token. Worth raising before backend ships.
3. **Brute force on OTP** — 5 attempts then invalidate the code; rate-limit
   `request-otp` per email to prevent enumeration.
4. **Account enumeration** — `/auth/register` and `/auth/login` should return
   the *same* generic error for "user not found" vs "wrong password"
   (`AUTH_INVALID_CREDENTIALS`). Frontend just shows "Email or password is
   incorrect."
5. **SQL injection** — fully mitigated by parameterized queries (see §5.4).
   Lint rule or PR-time grep to forbid string concatenation in `*.repo.ts`.
6. **Ownership leaks** — every `WHERE` on user-scoped tables must filter by
   `owner_id`. Centralize in repos so no controller can forget.
7. **OAuth callback CSRF** — `@fastify/oauth2` handles `state` param if
   configured; verify the config in code review.
8. **JWT vulnerabilities** — pin `alg: HS256`, reject `alg: none`. Use
   `@fastify/jwt` defaults; don't roll your own verify.
9. **Secrets in logs** — Pino redact list: `req.headers.authorization`,
   `req.body.password`, `req.body.refreshToken`, `req.body.code`.
10. **Rate-limit bypass behind proxy** — set `trustProxy` correctly in Fastify
    so client IP comes from `X-Forwarded-For`.

---

## 9. Missing Decisions / Risks

Each item: what's unclear, why it's risky, and what the team should answer
before the backend phase that depends on it.

| # | Open question | Why risky | Suggested decision point |
|---|---|---|---|
| 1 | **User id type** — frontend store uses `id: number` (hardcoded `1`); plan's data model uses `id: string`. | Wire shape mismatch will break the first real `/auth/me` call. | Lock to **UUID v7 (string)** before Backend Phase 1. Update frontend store + login mock. |
| 2 | **Token storage location** — localStorage (per plan) vs httpOnly cookie for refresh. | XSS-stolen refresh token = total account takeover. | Decide before issuing real tokens. Recommendation: httpOnly cookie for refresh, in-memory for access. |
| 3 | **Username uniqueness & rules** — frontend has a field but no validation rules. | Sign-up will fail unpredictably; username is sometimes used as a public handle. | Define: min/max length, allowed chars, case-insensitivity, reserved-name list. |
| 4 | **Birthday — required and minimum age?** | COPPA/GDPR-K means under-13 accounts have legal obligations. | Decide: optional vs required; minimum age; what to do if user lies. At minimum: require age ≥ 13. |
| 5 | **Profile-completion enforcement** — what happens if a user closes the browser between OTP-verify and account-details? | They have a valid token but no `username`. Every subsequent request needs to know to re-prompt. | Decide: server returns `needsProfile: true` on `/auth/me` until `username` is set; route guard sends them to step 3. |
| 6 | **OAuth users that don't share an email with their existing account** — link or duplicate? | Without policy, a user with `me@x.com` + Google `me@x.com` could end up with two accounts. | Decide: auto-link if emails match and existing email is verified; otherwise create new. |
| 7 | **XP formula authority** — frontend plan locks `correct * 10 + (completed ? 25 : 0)`; backend will need to validate. | If client sends `xp`, it's trivially cheatable. | Backend computes XP server-side from `correct` and `status`. Don't trust client. |
| 8 | **SM-2 source of truth** — frontend plan has a pure `useSpacedRepetition` composable. | Two implementations diverging = inconsistent schedules. | Backend's `sm2.ts` must be the authority; frontend can preview locally but server result wins. **Port the test cases.** |
| 9 | **"Public" decks** — schema has `is_public` boolean; no UI exposes it; no `/explore` route at MVP. | If shipped without thinking, public decks could leak PII (deck titles, user-generated content). | Defer the entire public-deck surface. Keep the column for forward-compat but force `false` server-side at MVP. |
| 10 | **Email provider** — Resend vs Postmark vs SES. | Cost, deliverability, DKIM setup all differ. | Pick before Phase 1. Recommendation: **Resend** for fastest setup; switch to Postmark if deliverability issues arise. |
| 11 | **Hosting** — Fly.io vs Render vs Railway vs AWS. | Affects CI shape, env-var management, secrets storage. | Pick before Phase 1. Recommendation: **Fly.io** (good Postgres pricing, simple deploys). |
| 12 | **Data retention** — when a user deletes their account, what's the policy? | GDPR right-to-erasure obligation. | Define: cascade-delete all user rows; retain audit log with `user_id` set NULL. Add `DELETE /users/me` in Phase 4. |
| 13 | **Frontend `accessToken` parameter on `login()`** — the existing `useAuth.login(email, password, accessToken)` has a vestigial `accessToken` arg. | Confuses anyone integrating; not a backend concern but coordinate. | Drop the arg before Backend Phase 1 ships. |
| 14 | **Resend-OTP cooldown** — UI has the button, no copy about cooldown. | Without server-enforced cooldown, users will hammer it. | 60-second cooldown per `userId`; UI counts down. |

---

## 10. MVP Backend Roadmap

Phases mirror the frontend's four-phase plan **1:1** so each phase ends with a
cut-over: `app/api/*.ts` swaps from `localStorage` to real `$fetch` calls and
nothing else in the frontend needs to change.

### Phase 1 — Foundation + Auth (matches Frontend Phase 1)

**Goals:** A user can register, verify email, log in (password + OAuth),
refresh tokens, fetch `/me`, and complete their profile.

**Deliverables**
- Fastify app skeleton with autoload, env config, error handler, request logging.
- Postgres + dbmate migrations for: `users`, `oauth_identities`,
  `email_verifications`, `refresh_tokens`, `audit_log`.
- Modules: `auth`, `users`, `mail`.
- Endpoints: all `/auth/*` from §7 + `PATCH /users/me`.
- `@fastify/jwt` + `authenticate` preHandler.
- `@fastify/oauth2` for Google (Facebook + Apple can land within phase if dev
  accounts are ready — otherwise defer to phase 1.5).
- Resend (or chosen provider) integration for OTP email.
- `@fastify/rate-limit` configured for `/auth/*`.
- CI green: lint, typecheck, unit, integration (testcontainers Postgres).
- Staging deploy.

**Dependencies:** OAuth provider apps registered; mail-provider account; chosen
hosting set up.

**Complexity:** Medium-high. The auth pieces (OTP + OAuth + refresh rotation)
are where most projects bleed time.

**Risks:** OAuth provider config (especially Apple — requires Apple Developer
account + key file). Mail deliverability (set up SPF + DKIM + DMARC up front).

**Order:** env+server skeleton → DB+migrations → register/login/refresh →
OTP → OAuth → audit log.

---

### Phase 2 — Decks + Cards (matches Frontend Phase 2)

**Goals:** Authenticated CRUD for decks and cards, with search and pagination.

**Deliverables**
- Migrations: `decks`, `cards` + the `card_count` trigger.
- Modules: `decks`, `cards`.
- Endpoints: all `/decks` and `/cards` from §7.
- Cursor-pagination helper in `shared/pagination.ts`.
- Repo-level ownership enforcement + integration test that proves user A cannot
  read user B's deck.
- Updated OpenAPI doc.

**Dependencies:** Phase 1.

**Complexity:** Low. This is the easiest phase.

**Risks:** Wrong-shape pagination (offset vs cursor) is annoying to retrofit —
go cursor from day 1.

---

### Phase 3 — Sessions + (passive) SRS write path (matches Frontend Phase 3)

**Goals:** Frontend can persist study sessions; the SRS endpoint exists but the
review queue (Phase 4) is not yet exercised.

**Deliverables**
- Migration: `study_sessions` with the partial unique index.
- Migration: `card_progress`.
- Modules: `sessions`, `srs` (rate path only).
- Endpoints: `/sessions/*`, `POST /srs/rate`.
- Server-side XP computation (decision §9.7).
- Port `sm2.ts` from the frontend composable with **the same test cases**.

**Dependencies:** Phase 2.

**Complexity:** Medium. The "one active session per user" rule needs a
transaction: mark old `active` → `incomplete`, insert new `active`, all in
one tx.

**Risks:** Off-by-one on the SM-2 algorithm. Mitigate by porting the frontend
test suite verbatim.

---

### Phase 4 — Review Queue + Dashboard (matches Frontend Phase 4)

**Goals:** Daily-driver loop works; dashboard shows real numbers.

**Deliverables**
- Endpoints: `GET /srs/due`, `GET /dashboard`, `GET /sessions/incomplete`.
- Performance check: dashboard query under 100 ms with 200 decks × 1000 cards.
- Migration: any indexes uncovered by the perf check.
- End-to-end smoke test (mirrors the one in the frontend plan).

**Dependencies:** Phase 3.

**Complexity:** Low-medium. The dashboard endpoint is the one place we want a
careful query — it's 4 sub-queries today, easy to footgun into N+1.

**Risks:** The "incomplete session" semantics need to match the frontend
state-machine. Test the cross-tab case: open session in tab A, start another in
tab B → tab A's session should be `incomplete` on next ping.

---

### Phase 5 (post-MVP) — Production hardening

- Soft-delete + account-erasure endpoint.
- Nightly cleanup cron for `email_verifications` + `refresh_tokens`.
- Backup-restore drill in staging.
- p95/p99 latency budgets enforced in CI via k6 smoke load.
- Sentry (or equivalent) error tracking.
- Audit-log retention policy.

---

## 11. Recommended Next Steps

1. **Resolve §9 open questions** — especially items 1 (id type), 2 (token
   storage), 5 (profile-completion gate), and 10/11 (provider picks). These
   block Phase 1.
2. **Pick a repo layout** — decide whether the backend lives in this repo (as
   `apps/api/`, with frontend becoming `apps/web/`) or as a separate repo.
   Recommendation: **separate repo** at MVP — the frontend doesn't need to
   block on backend deploys, and there's no shared code worth a monorepo yet.
3. **Author the OpenAPI contract first** — TypeBox schemas for every endpoint
   in §7, generated to a single `openapi.json`. Hand it to the frontend before
   Phase 1 implementation so the two streams can run partly in parallel.
4. **Stand up the empty backend skeleton in a day** — Fastify, dbmate, Pino,
   Zod env loader, one trivial `/health` endpoint, CI, staging deploy. Don't
   start Phase 1 until this works end-to-end.
5. **Coordinate with the frontend team on the cut-over plan** — for each
   backend phase, the corresponding `app/api/*.ts` file flips from
   `localStorage` to `$fetch`. Define a feature flag (or env var) so the flip
   can be done per-resource (not all-or-nothing).

---

## Suggested commit message
```
docs(plan): add backend discovery + Fastify/raw-SQL MVP roadmap
```
