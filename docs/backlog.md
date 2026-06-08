# Backlog — intentionally deferred items

Things we **chose not to build** at MVP. Each entry exists so future-you (or
a teammate) can see the reasoning without re-deriving it, and knows roughly
when to revisit.

Anything not listed here that isn't already shipped is genuinely missing,
not deferred — open an issue and design it.

---

## Auth & accounts

### Apple / Facebook / Microsoft OAuth
- **Why deferred:** Google covers ~80% of expected sign-in volume. Apple
  requires a $99/yr developer account + Sign-in-with-Apple compliance.
  Facebook OAuth is in long-term decline.
- **Revisit when:** iOS app launches (Apple is mandatory if you ship native
  iOS auth alongside Google).

### Logout-all-devices
- **Why deferred:** Refresh-token rotation + reuse-detection already revoke
  the family on a stolen-token presentation. A user-initiated
  "log out everywhere" is nice-to-have, not load-bearing for security.
- **Revisit when:** First support ticket about a lost device.
- **Effort estimate:** ½ day — already have the refresh-token table and the
  per-user revocation query.

### Email-change flow
- **Why deferred:** Users can delete and re-register (now that
  `DELETE /users/me` exists). Proper email-change needs re-verification of
  the new address; touches the verification infrastructure we already have
  but is cosmetic for MVP.
- **Revisit when:** ≥5 support requests, or when retention is high enough
  that the friction matters.
- **Effort estimate:** 1 day — reuses `email_verification` infra.

### Password change (signed-in flow)
- **Why deferred:** Forgot-password covers the security-critical path.
  In-app change is a UX nicety.
- **Revisit when:** Same trigger as email-change.

---

## Decks & content

### Folders / DeckCollection
- **Why deferred:** Users with <20 decks don't need folders. Tags + search
  cover discovery. Folders add real UI complexity (drag-drop, nesting
  rules, breadcrumbs).
- **Revisit when:** Median power user has >25 decks, or analytics show
  users scrolling through the deck list >5×/day.

### Public-deck moderation / report flow
- **Why deferred:** Public catalog is a placeholder; clone count is low.
  No reports yet, so the cost of moderation tooling exceeds the cost of a
  handful of manual deletes.
- **Revisit when:** First abuse report, or when public-deck submissions
  exceed ~10/week.

### Deck collaboration (multi-author decks)
- **Why deferred:** Schema (`DeckCollaborator`) exists but no endpoints.
  Real-time co-editing needs CRDTs or operational transforms — heavy.
- **Revisit when:** Customer interview surfaces it as a top-3 ask.

### Card review history table
- **Why deferred:** Current `CardProgress` stores aggregate stats per
  card+user. Per-review history (every rating, timestamp, response time)
  would unlock fancy analytics + ML personalization but doubles write
  volume on the hot session path.
- **Revisit when:** Building "card-level analytics" UI or doing SRS
  parameter tuning.

---

## Gamification

### Streak freezes / shields
- **Why deferred:** Streak tracking exists; freezes add a meta-system
  (purchasable? earnable? gifted?) that's a product decision, not just an
  engineering one.
- **Revisit when:** Engagement metrics suggest streak-loss → churn.

### Leaderboards (global / friends)
- **Why deferred:** Requires a social graph (friends/follows), which we
  don't have. Adds privacy/abuse surface area.
- **Revisit when:** Social features ship.

### Achievement push on session-complete
- **Why deferred:** Currently achievement state is computed at
  `/users/me/achievements`. Pushing on session-complete needs a job runner
  or inline computation; low ROI until we have notifications.
- **Revisit when:** Notifications (web push or email) ship.

---

## Operational

### S3 / R2 media storage
- **Why deferred:** Local FS works for MVP; no public avatar gallery yet.
  Swap path is documented in [`deployment.md`](./deployment.md) §5.
- **Revisit when:** First time the Railway container restarts and a user
  notices their avatar is gone, OR before the marketing site launches with
  user-visible images.
- **Effort estimate:** ½ day.

### Resend email integration
- **Why deferred:** Console mail provider is fine for dev. User explicitly
  chose to wire later.
- **Revisit when:** Production launch — verification + password-reset
  emails must work for real users.
- **Effort estimate:** 2 hours — `MailProvider` interface is already
  abstracted; swap `console.ts` for `resend.ts`.

### Zero-downtime deploys
- **Why deferred:** MVP load tolerates 5–10s of 502s during deploy.
- **Revisit when:** First customer complains, or analytics show
  deploy-time errors hurting metrics.
- **Approach:** Railway "pre-deploy" command runs `prisma migrate deploy`;
  service uses graceful shutdown (Fastify already has `closeGracefullyOnSignal`).

### Multi-region deploy
- **Why deferred:** Single-region (US-East or EU) is sufficient until you
  have global paying users. Adds DB-replication complexity.
- **Revisit when:** Real users in two continents complain about latency.

### OpenAPI spec generation
- **Why deferred:** `docs/api-contract.md` is hand-maintained and is the
  source of truth. Generating an OpenAPI spec from Zod schemas
  (`zod-openapi`, `fastify-swagger`) duplicates that contract and tends to
  drift. Worth the cost only when you have third-party API consumers.
- **Revisit when:** External integrators or a public SDK.

---

## Real-time / push

### WebSockets
- **Why deferred:** SSE covers AI streaming. No other use case (live deck
  collab, push presence) is in scope.
- **Revisit when:** Collaboration or real-time multiplayer features
  approved.

### Web push / mobile push notifications
- **Why deferred:** No notification UX yet — what would we push? Reminders
  need a settings + opt-in UX first.
- **Revisit when:** Reminder/notification UX designed.

---

## AI

### AI-based URL extraction (any-site importer)
- **Why deferred:** Quizlet HTML parser covers the headline use case.
  Generic AI extraction costs $0.01–0.03 per import and is overkill until
  users ask for non-Quizlet imports.
- **Revisit when:** First "can I import from <X>?" request.

### Real LLM for tutor / chat
- **Why deferred:** Out of scope for vocab/flashcard MVP.
- **Revisit when:** Conversational tutor becomes a product direction.

### Server-side AI cache (re-enrich same words)
- **Why deferred:** Per-user caps make duplicate calls cheap; FE retries
  hit the same words infrequently.
- **Revisit when:** Anthropic bill > $50/mo and a cache hit rate analysis
  justifies it.
