# AGENTS.md

Canonical agent guide for **mnemio-backend** — the REST API for Mnemio, an
AI-powered vocabulary / flashcard learning platform. The Nuxt frontend
(`mnemio-frontend`, separate repo) talks to this API exclusively; the DB is
never exposed directly. This file is the source of truth for agents; the
human-facing `README.md` and `docs/` carry the long-form detail.

## Stack

Fastify v5 · TypeScript (ESM, `nodenext`) · Prisma 7 (`@prisma/adapter-pg`) ·
PostgreSQL 17 · Zod 4 · argon2id · `@fastify/jwt` · Vitest.

## Commands

```bash
npm run dev          # tsx watch → http://localhost:3001 (.env.example PORT; code default 3000)
npm test             # vitest run — SM-2 + XP unit tests (23 cases, pure functions, no DB)
npm run typecheck    # tsc --noEmit
npm run build        # prisma generate && tsc → dist/
npm start            # node dist/src/server.js
npm run seed         # idempotent demo seed → demo@mnemio.local / demo-password-123
npx eslint .         # lint (configured in eslint.config.js; no npm script for it)

# Prisma
npm run prisma:generate      # regenerate client into generated/prisma (gitignored)
npm run prisma:migrate       # prisma migrate dev
npm run prisma:deploy        # prisma migrate deploy

# Local Postgres (host port 5433 → container 5432)
docker compose up -d db
```

After pulling schema changes or a fresh clone, run `npx prisma generate` — the
client lives in `generated/prisma/` and is **not** committed.

## Architecture

Strict one-way layering, one file per domain at each layer:

```
routes/<domain>.routes.ts        URL → controller; attaches preHandler auth
controllers/<domain>.controller.ts  parse req with Zod schema, call service, send
services/<domain>.service.ts      business logic, ownership decisions, mapping
repositories/<domain>.repository.ts all Prisma access lives here (and only here)
schemas/<domain>.schema.ts        Zod request/response shapes + inferred types
shared/{errors,pagination,mappers*}.ts  cross-cutting helpers
services/sm2.ts                   pure SuperMemo-2 (no DB) — unit tested
config/env.ts                     Zod-validated env (add every new env var here)
plugins/{jwt,cookies,error-handler}.ts
app.ts                            Fastify factory: plugins → routes (under /api/v1)
server.ts                         entrypoint: listen + graceful shutdown
```

Request flow: `route → controller (Zod parse) → service → repository (Prisma) →
mapper → DTO`. Controllers never touch Prisma; repositories never throw HTTP
errors. Services translate "not found / not owned" into `AppError` subclasses.

## Conventions & invariants (don't break these)

- **All routes under `/api/v1`**; `/health` is the only un-prefixed route. New
  route modules must be `await api.register(...)`'d in `app.ts`.
- **ESM with explicit `.js` extensions** in TS import paths (e.g.
  `import ... from './app.js'`). `verbatimModuleSyntax` is on, so use
  `import type` for type-only imports. `isolatedModules` is on.
- **tsconfig is strict**: `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
  Array access is `T | undefined`; optional props can't be set to `undefined`
  explicitly — build patch objects conditionally (see `decks.service.ts#update`).
- **Auth**: routes opt in with `fastify.addHook('preHandler', fastify.authenticate)`.
  The user id is `request.currentUser.sub`. `requireVerified` adds an
  email-verified gate.
- **Ownership is enforced at the repository layer**, never in controllers:
  `findFirst({ where: { id, authorId } })` for reads,
  `updateMany/deleteMany({ where: { id, authorId } })` for writes. Services check
  the returned `count === 0` and throw `NotFoundError` — controllers can't forget.
- **Error envelope** is always `{ code, message, details? }`. Throw `AppError`
  subclasses from `shared/errors.ts` (`BadRequestError`, `UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ConflictError`, `UnprocessableError`,
  `RateLimitedError`). `plugins/error-handler.ts` also maps `ZodError`→400,
  Prisma `P2002`→409, `P2025`→404. Codes are SCREAMING_SNAKE (e.g.
  `DECK_NOT_FOUND`, `AUTH_INVALID_TOKEN`).
- **Validation**: controllers call `schema.parse(request.body|query)` explicitly
  (schemas are not registered as Fastify JSON schemas).
- **Pagination** is opaque base64url keyset cursors (`shared/pagination.ts`).
  `GET /decks` also returns `total`; most other lists don't (per-page counts are
  expensive).
- **Mappers** (`shared/mappers*.ts`) convert Prisma rows → public DTOs. Never
  return raw Prisma models to the client.
- **One active study session per user** — enforced inside Prisma transactions
  plus a Postgres partial unique index. Don't bypass the transaction.
- IDs are UUID strings; dates ISO-8601 UTC; birthday `YYYY-MM-DD`.
- **Refresh token** lives only in the `mnemio_refresh` HttpOnly cookie (scoped to
  `/api/v1/auth`); rotates every `/auth/refresh`; reuse revokes all of a user's
  tokens. The access token is JWT HS256, 15 min.

## Adding an endpoint (checklist)

1. Add/extend the Zod schema in `schemas/<domain>.schema.ts`.
2. Add Prisma access in `repositories/<domain>.repository.ts` (with the
   `authorId` ownership filter).
3. Add business logic + mapping in `services/<domain>.service.ts`.
4. Add the controller handler (parse → service → `reply.send` / status code).
5. Wire the route in `routes/<domain>.routes.ts`.
6. If it's a new domain, `await api.register(<domain>Routes)` in `app.ts`.
7. If it adds an env var, add it to `config/env.ts` (Zod) **and** `.env.example`.

## Database / Prisma

- Schema is split model-per-file under `prisma/` (`user.prisma`, `deck.prisma`,
  `card.prisma`, `auth.prisma`, `activity.prisma`, `achievements.prisma`,
  `preference.prisma`, `folder.prisma`, `audit.prisma`; `schema.prisma` holds the
  generator + datasource). Tables use `@@map` snake_case names.
- Client is the new `prisma-client` generator output in `generated/prisma/`,
  wired through `@prisma/adapter-pg` in `src/db/prisma.ts`. Import Prisma types
  from `../../generated/prisma/client.js`.
- Migrations live in `prisma/migrations/`. If a failed migration blocks deploy:
  `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes" npx prisma migrate reset --force`
  (dev only — drops data).

## Swappable providers (env-driven, mocked for dev)

- `MAIL_PROVIDER=console|resend` — console prints OTPs to stdout.
- `AI_PROVIDER=mock` — `services/ai.provider.mock.ts` returns realistically
  shaped placeholders; real LLM swap path in `docs/ai-integration-plan.md`.
- `MEDIA_STORAGE=local` — writes to `./uploads/`, served via `@fastify/static`;
  S3 presigned-PUT swap path noted in `services/media.service.ts`.

## Analytics (Mixpanel, server-side)

Server-side Mixpanel is the analytics tool. The client (Nuxt FE) fires UI/funnel
events and calls `mixpanel.identify(user.id)`; the backend fires the events that
can only be trusted server-side (revenue, account creation, AI-cap hits,
activation milestones).

- **Module:** `services/analytics.service.ts` — lazy-init guard (sentry.ts
  pattern), **no-op when `MIXPANEL_TOKEN` is unset**. `track()` / `setUserProps()`
  are fire-and-forget (try/catch, never throw, never awaited in a hot path).
- **Golden rule:** every event uses `distinct_id = user.id` (same id as JWT `sub`
  / `/auth/me`) so server events merge onto the profile the client built. Never
  use email as the id.
- **Typed contract:** `analytics/events.ts` `AnalyticsEvent` union — a hand-kept
  mirror of the FE's `app/analytics/events.ts`. `track()` is typed against it, so
  names/props can't drift. Keep both in sync until a shared package exists.
- **Env:** `MIXPANEL_TOKEN` (project token; required to enable). `MIXPANEL_API_SECRET`
  optional (historical imports only). Both `.optional()` in `config/env.ts`. One var,
  **per-environment value**: local `.env` holds the dev project token; production
  (Railway) injects the prod token — keeps dev test events out of the prod project.
- **Events wired:** `account_created` (auth.service first-verify / new-OAuth only),
  `first_value_reached` (milestone.service: first deck/session/review),
  `ai_cap_reached` (ai.budget.service guard — enrich/generate/suggest only),
  and the Stripe revenue set in `billing.service.ts`
  (`subscription_started/renewed/canceled`, `trial_started/converted`).
- **Webhook rule:** the Stripe handler ACKs **first**, then fires analytics — a
  Mixpanel outage must never delay/fail the webhook ACK. Add new revenue events by
  returning more deferred emits from `handleWebhookEvent`, not inline.
- **Adding an event:** add it to `analytics/events.ts` (+ FE mirror), then call
  `analytics.track(userId, name, props)` at the action site. snake_case names,
  no PII, omit absent props (never send `null`).

## Testing

Vitest, `*.test.ts` under `test/`. Current suites are pure-function only
(`sm2.test.ts`, `xp.test.ts`) — no DB, no HTTP. Keep new pure logic (SRS, XP,
mappers) unit-testable without Prisma. SM-2 rating map must stay in sync with the
FE composable: `again→0 / hard→2 / good→3 / easy→5`, EF floored at 1.3.

## Reference docs

- `README.md` — full setup, endpoint index, auth flow, smoke tests.
- `docs/api-contract.md` — **authoritative** request/response shapes & error codes
  the frontend integrates against. Update it when you change a public shape.
- `docs/backend-plan.md` — design rationale & FE↔BE reconciliations.
- `docs/ai-integration-plan.md` — real-LLM swap plan for `/ai/*`.

## Out of MVP scope (return 404 by design)

Password reset, folders, leagues/leaderboards, account deletion, WebSockets/push.
Don't implement these without an explicit ask.
