# Deployment

Operational guide for running **mnemio-backend** in production. The
authoritative product contract is [`api-contract.md`](./api-contract.md);
the day-to-day dev guide is [`../AGENTS.md`](../AGENTS.md). This file is
about *getting the bits onto a real server* and keeping them there.

> Status: target stack confirmed; not yet deployed. CI/CD and infra
> recommendations here are based on the MVP scope (single Node service,
> single Postgres, no media yet beyond local FS).

---

## 1. Hosting choice — Railway

For an MVP that's one Fastify service + Postgres + a local FS for media,
Railway is the best fit. Reasons:

- **One-shot Postgres add-on.** Provisioned in 30 seconds; `DATABASE_URL`
  injected automatically.
- **GitHub-based auto-deploy.** Push to `main` → build → deploy. Branch
  previews available on Pro.
- **Builds the existing Dockerfile.** No platform-specific buildpack
  weirdness. After the Dockerfile fix lands, `docker build` is the same
  locally and remotely.
- **Healthchecks built in.** Railway will probe `/ready` (we expose both
  `/health` for cheap liveness and `/ready` for DB-touching readiness).
- **Pricing.** Hobby plan: $5/mo flat + usage. For the MVP load (a few
  concurrent users, small DB), expect $10–25/mo end-to-end.

Alternatives considered:

| Option | Verdict |
|---|---|
| **Fly.io** | Comparable, more flexible for multi-region later. Steeper config (`fly.toml`). Fine choice if multi-region is on the roadmap. |
| **Render** | Similar to Railway, slower deploys, slightly more expensive Postgres. |
| **Vercel / Netlify** | Wrong shape — serverless model fights long-lived SSE connections (`/ai/*` streaming endpoints). |
| **AWS / GCP / Fly Machines bare** | Overkill for MVP. Revisit when you have paying customers and need cost or compliance control. |

---

## 2. Required environment variables on the host

Everything below must be set on Railway (or whatever host you pick).
`.env.example` in repo root mirrors this list — keep them in sync.

**Core:**
```
NODE_ENV=production
PORT=3001                          # Railway sets this; leave the var
HOST=0.0.0.0
LOG_LEVEL=info
WEB_URL=https://app.mnemio.<your-domain>
APP_URL=https://api.mnemio.<your-domain>
```

**Database (Railway injects automatically if you use the add-on):**
```
DATABASE_URL=postgresql://...
```

**Auth:**
```
JWT_SECRET=<random 32+ char secret — `openssl rand -base64 48`>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=30
```

**Mail (deferred — using console provider for now):**
```
MAIL_PROVIDER=console              # swap to `resend` when wired
MAIL_FROM="Mnemio <noreply@mnemio.app>"
# RESEND_API_KEY=<set when Resend is wired>
```

**AI:**
```
AI_PROVIDER=anthropic              # or `mock` for paid-down env
ANTHROPIC_API_KEY=<sk-ant-...>
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
AI_DAILY_ENRICH_CAP_PER_USER=5
AI_DAILY_GENERATE_CAP_PER_USER=20
AI_DAILY_SUGGEST_CAP_PER_USER=60
AI_MAX_WORDS_PER_ENRICH=100
```

**Observability (optional but recommended):**
```
# SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
```

**OAuth (when 3.1 ships):**
```
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URL=https://api.mnemio.<your-domain>/api/v1/auth/oauth/google/callback
```

---

## 3. Container build

After the Dockerfile fix, the build is a standard two-stage:

```bash
# Local sanity check before pushing
docker build -t mnemio-be .
docker run --rm -p 3001:3001 \
    --env-file .env.production.local \
    mnemio-be

# Verify the live checks
curl -s http://localhost:3001/health   # cheap liveness — always 200
curl -s http://localhost:3001/ready    # touches DB — 200 when ready, 503 when not
```

Railway picks up the same Dockerfile from the repo root automatically.

---

## 4. Database migrations

On Railway, migrations run as part of the release step. Add this to the
service's "Start Command" if you don't use a release phase:

```
npx prisma migrate deploy && node dist/src/server.js
```

`migrate deploy` is the production-safe variant: it applies committed
migrations only, never prompts, never resets. Never run
`prisma migrate dev` or `prisma migrate reset` against the prod DB.

---

## 5. Media storage

**Today (MVP):** `/uploads` directory in the container's filesystem, served
by `@fastify/static`. Fine for the current scope (no avatars wired through
the UI yet); does NOT survive a container restart on Railway because the
container FS is ephemeral.

**Swap path:** Cloudflare R2 (S3-compatible, zero egress fees). Touch
points to flip:

- `src/services/media.service.ts` — replace local-FS write with S3 SDK upload
- Add `S3_*` env vars (endpoint, bucket, access keys)
- Remove the `@fastify/static` registration once nothing reads from `/uploads`

Estimated effort: half a day, isolated to the media module. Tracked in
[`backlog.md`](./backlog.md).

---

## 6. Observability

**Sentry** (free tier: 5k events + 10k traces / month) is wired via the
plugin in `src/plugins/sentry.ts`. It no-ops when `SENTRY_DSN` is unset, so
local dev is unaffected.

**Logs.** Pino → stdout → Railway's log viewer. Adequate at MVP. Pipe to a
log aggregator (Logtail, Axiom) only when log volume gets unwieldy.

**Uptime monitoring.** BetterUptime free tier (10 monitors). Point one
monitor at `/health`. Don't point uptime monitors at `/ready` — a DB blip
shouldn't page you; alert separately on `/ready` failures via Sentry.

---

## 7. CI/CD

### 7.1 GitHub Actions on PR

`.github/workflows/ci.yml` (to be added) runs on every PR:

```yaml
name: ci
on:
    pull_request:
    push:
        branches: [main, development]
jobs:
    check:
        runs-on: ubuntu-latest
        services:
            postgres:
                image: postgres:17
                env:
                    POSTGRES_USER: postgres
                    POSTGRES_PASSWORD: postgres
                    POSTGRES_DB: mnemio_test
                ports: ['5432:5432']
                options: >-
                    --health-cmd pg_isready
                    --health-interval 10s
                    --health-timeout 5s
                    --health-retries 5
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: '22'
                  cache: 'npm'
            - run: npm ci
            - run: npx prisma generate
            - run: npx prisma migrate deploy
              env:
                  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mnemio_test
            - run: npm run typecheck
            - run: npx eslint .
            - run: npm test
              env:
                  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/mnemio_test
                  JWT_SECRET: ci-only-secret-not-real-12345678901234567890
                  AI_PROVIDER: mock
```

### 7.2 Deploy on merge to `main`

Railway's GitHub integration is sufficient. Set the service to "Auto Deploy
from `main`" — no extra workflow needed. PR previews are a paid Railway
feature; useful but not required at MVP.

### 7.3 Migrations as a release gate

If you want zero-downtime migrations (recommended once you have real users),
move `prisma migrate deploy` into a Railway "Pre-deploy command" instead of
the start command. That way a failing migration aborts the rollout instead
of crash-looping the new image.

---

## 8. Cost estimate (monthly, MVP load)

| Item | Plan | Cost |
|---|---|---|
| Railway service + Postgres | Hobby | ~$5–10 |
| Anthropic API (Claude Haiku 4.5) | Pay-as-you-go | ~$5–15 depending on usage |
| Cloudflare R2 (when wired) | Free tier covers <10 GB | $0 |
| Sentry | Free tier | $0 |
| BetterUptime | Free tier | $0 |
| Domain | Annual | ~$1/mo amortized |
| **Total** | | **~$10–25 / mo** |

---

## 9. First-deploy checklist

In order:

1. Provision Railway project + Postgres add-on
2. Copy all env vars from §2 into the service settings
3. Connect the GitHub repo, set auto-deploy on `main`
4. Set healthcheck path to `/ready`
5. First deploy: run `npx prisma migrate deploy` (Railway's "run command" UI)
   to apply migrations to the empty DB
6. Hit `/health` and `/ready` once each — both should 200
7. Run a smoke: register a user, create a deck, run a session, hit `/ai/suggest`
   to verify the AI provider works in prod
8. Point your domain at the Railway service (CNAME)
9. Add Sentry DSN once the synthetic test event arrives
10. Add `/health` to BetterUptime

That's the MVP path. Multi-region, blue/green deploys, and zero-downtime
schema changes are tracked in [`backlog.md`](./backlog.md).
