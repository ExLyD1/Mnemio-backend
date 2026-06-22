# Paid Subscriptions — Architecture Document

**Mnemio backend** · Fastify v5 · Prisma 7 · PostgreSQL · Railway · June 2026

---

## Context

Mnemio currently has no monetisation layer. The AI budget system
(`ai.budget.service.ts` → `ai-usage.prisma`) already gates per-user daily
quotas via a simple `assertWithinBudget` call before each LLM operation. The
subscription feature mirrors that pattern: a thin `entitlement.service.ts`
becomes the one gate that all premium-only paths call. Everything else — billing
lifecycle, dunning, tax — is delegated to the payment provider.

---

## 1 · Provider Recommendation: Stripe

### Comparison

| Dimension                    | Stripe                                                     | Paddle / LemonSqueezy                               | UA rails (Mono, WFP, LiqPay, Fondy) |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| Recurring billing engine     | Best-in-class (Billing + Smart Retries dunning)            | Good (Paddle Billing), simpler (LS)                 | None — manual invoicing only        |
| Webhooks                     | Signed, idempotent, rich event set                         | Signed, adequate                                    | Varies; often polling or weak HMAC  |
| Customer self-service portal | Built-in, hosted                                           | Built-in (Paddle); basic (LS)                       | None                                |
| EU VAT / tax compliance      | Stripe Tax add-on (~0.5 %) handles collection + remittance | MoR: Paddle/LS own all tax — zero work on your side | None                                |
| UA payout support            | ✅ since 2022 (UA entity required)                         | Paddle Classic: limited; Paddle Billing: uncertain  | ✅ native                           |
| DX / TypeScript SDK          | Excellent (`stripe` npm, full types)                       | Good (Paddle), decent (LS)                          | Poor — often REST + raw HMAC        |
| Pricing (payment fee)        | 2.9 % + $0.30                                              | ~5 % + $0.50 (MoR premium)                          | ~1.5–2.5 % but no sub mgmt          |

### Decision: **Stripe**

Stripe's 2022 Ukraine support means payouts work. The remaining argument for
Paddle (MoR = zero VAT work) is now answered by **Stripe Tax** at 0.5 % extra —
saving ~2 % per transaction vs Paddle. Smart Retries replaces manual dunning.
The Billing portal means zero custom UI for plan management. The TypeScript SDK
is first-class.

UA rails are a non-starter for recurring SaaS: no subscription primitives, EU
cards routinely blocked, and every renewal requires manual work.

---

## 2 · Domain Model

### Subscription states

```
free (no row) ──→ trialing ──→ active ──→ canceled ──→ expired
                              ↑    ↓           ↑
                              └── past_due ───→ expired (dunning exhausted)
```

| State      | Meaning                                                      | Entitled?              |
| ---------- | ------------------------------------------------------------ | ---------------------- |
| _(no row)_ | Never subscribed — free tier                                 | No                     |
| `trialing` | Active trial, `trialEnd` in future                           | Yes                    |
| `active`   | Paid, within `currentPeriodEnd`                              | Yes                    |
| `past_due` | Invoice failed; Stripe is retrying (grace period)            | Yes (grace)            |
| `canceled` | User canceled; `cancelAtPeriodEnd=true`; period not yet over | Yes (until period end) |
| `expired`  | Period ended with no renewal, or dunning exhausted           | No                     |

**Entitlement rule:**

```
isPremium = subscription exists
  AND status IN ('trialing','active','past_due','canceled')
  AND currentPeriodEnd > now()
```

No `paused` state in v1 (Stripe supports it; add when needed).

### Full lifecycle events

| Trigger                         | State transition                                | DB action                                                                |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| User clicks "Subscribe"         | —                                               | Create Stripe Checkout session (no DB yet)                               |
| `customer.subscription.created` | → `trialing` or `active`                        | Upsert subscription row                                                  |
| `invoice.payment_succeeded`     | → `active`, period advances                     | Update period fields                                                     |
| `invoice.payment_failed`        | → `past_due`                                    | Update status                                                            |
| Smart Retry succeeds            | → `active`                                      | `invoice.payment_succeeded` fires                                        |
| Smart Retry exhausted           | → `expired`                                     | `customer.subscription.deleted` fires                                    |
| User cancels in portal          | `cancelAtPeriodEnd=true`, status stays `active` | `customer.subscription.updated` fires                                    |
| Period ends after cancel        | → `expired`                                     | `customer.subscription.deleted` fires                                    |
| User resubscribes               | → `trialing`/`active`                           | New `customer.subscription.created`                                      |
| Refund (full)                   | → `expired`                                     | Handle via `charge.refunded` + manual or `customer.subscription.deleted` |
| Plan change (upgrade/downgrade) | status unchanged, `stripePriceId` updates       | `customer.subscription.updated` fires                                    |

---

## 3 · Feature Gating

### Entitlement service (mirrors ai.budget.service.ts pattern)

New file: `src/services/entitlement.service.ts`

```ts
// Throws PremiumRequiredError (403) — same call site pattern as assertWithinBudget
export const assertPremium = async (userId: string): Promise<void> => { … }
export const getPlan = async (userId: string): Promise<'free' | 'premium'> => { … }
```

New error in `shared/errors.ts`:

```ts
export class PremiumRequiredError extends ForbiddenError {
    constructor() {
        super('PREMIUM_REQUIRED', 'This feature requires a premium subscription');
    }
}
```

### Tiered AI caps

Modify `capFor` in `ai.budget.service.ts` to accept the user's plan:

```ts
// assertWithinBudget gains a plan param (or fetches it internally)
const capFor = (kind: AiUsageKind, plan: 'free' | 'premium'): number => {
    if (plan === 'premium') {
        /* 10× caps from env */
    }
    /* free caps (existing env vars) */
};
```

Add env vars: `AI_DAILY_*_CAP_PREMIUM_PER_USER` (defaults = 10× free).

### Entitlement matrix (v1)

| Feature                                  | Free                | Premium                                 |
| ---------------------------------------- | ------------------- | --------------------------------------- |
| AI enrich/generate/suggest               | 5 / 20 / 60 per day | 50 / 200 / 600 per day (env-controlled) |
| AI chat turns/day                        | 50                  | 500                                     |
| Deck imports/day                         | 20                  | 200                                     |
| _(future)_ Private decks, advanced modes | —                   | ✓                                       |

The matrix lives in `entitlement.service.ts`; individual services call
`assertPremium` or check `getPlan`, never query `Subscription` directly.

---

## 4 · DB Schema

Three new Prisma models. All others (Stripe's invoices, payment methods,
charges) stay in Stripe — we do not mirror them.

**`prisma/subscription.prisma`**

```prisma
model Subscription {
  id                 String   @id @default(uuid())
  userId             String   @unique          // 1:1 — one active sub per user
  status             String                   // 'trialing'|'active'|'past_due'|'canceled'|'expired'
  plan               String                   // 'monthly'|'annual' — string, not enum, for extensibility

  stripeCustomerId   String   @unique
  stripeSubId        String   @unique
  stripePriceId      String

  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  cancelAtPeriodEnd  Boolean  @default(false)
  trialEnd           DateTime?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([stripeCustomerId])
  @@map("subscriptions")
}
```

**`prisma/subscription.prisma` continued — idempotency log**

```prisma
model StripeWebhookEvent {
  id          String   @id            // Stripe event ID (evt_xxx) — natural dedup key
  type        String
  processedAt DateTime @default(now())

  @@map("stripe_webhook_events")
}
```

**User model addition** (in `prisma/user.prisma`):

```prisma
  subscription Subscription?
```

**Justification / items NOT added:**

- `BillingCustomer` model: skipped — `stripeCustomerId` lives on `Subscription`; created lazily on first checkout
- `Payment` / `Invoice` models: skipped — Stripe is the source of truth; we only need current entitlement state
- `SubscriptionEvent` audit log: skipped in v1 — `StripeWebhookEvent` gives us replay protection; full audit can come later
- Status as Prisma `enum`: skipped in favour of string — avoids a migration on every state addition and follows the repo's existing pattern (User.role, StudySession.status are strings)

---

## 5 · API + Services

### New files

```
src/
  schemas/billing.schema.ts
  repositories/subscription.repository.ts
  services/entitlement.service.ts
  services/billing.service.ts
  controllers/billing.controller.ts
  routes/billing.routes.ts
```

### Endpoints

| Method | Path                    | Auth                 | Description                                       |
| ------ | ----------------------- | -------------------- | ------------------------------------------------- |
| `POST` | `/billing/checkout`     | JWT                  | Create Stripe Checkout session → `{ url }`        |
| `GET`  | `/billing/subscription` | JWT                  | Current subscription DTO                          |
| `POST` | `/billing/portal`       | JWT                  | Create Stripe Customer Portal session → `{ url }` |
| `POST` | `/billing/webhook`      | None (Stripe-signed) | Receive Stripe events                             |

`GET /auth/me` should include a `plan: 'free' | 'premium'` field (cheap
entitlement check added to the existing me-response mapper).

### Service responsibilities

**`billing.service.ts`**

- `createCheckoutSession(userId, plan: 'monthly'|'annual')` → finds or creates
  Stripe Customer by `stripeCustomerId` (lazy creation), creates Checkout Session
  with `success_url` / `cancel_url`, returns `{ url }`
- `getSubscription(userId)` → reads from `subscription.repository`, maps to DTO
- `createPortalSession(userId)` → looks up `stripeCustomerId`, creates portal session
- `handleWebhookEvent(rawBody: Buffer, signature: string)` → verifies signature,
  checks `StripeWebhookEvent` for duplicate, dispatches to sub-handlers, records event ID

**`subscription.repository.ts`**

- `findByUserId(userId)` → Subscription | null
- `findByStripeCustomerId(id)` → Subscription | null
- `upsertFromStripe(data)` → atomic upsert used by webhook handler
- `isEntitled(userId)` → boolean (SQL-level check against status + currentPeriodEnd)

**`entitlement.service.ts`**

- `assertPremium(userId)` → calls `subscriptionRepo.isEntitled`, throws `PremiumRequiredError`
- `getPlan(userId)` → 'free' | 'premium' (cached per-request if needed later)

---

## 6 · Webhooks + Security

### Raw body in Fastify

Stripe signature verification requires the raw `Buffer`, not the parsed JSON.
Register a scoped raw-body content-type parser for only the webhook route:

```ts
// billing.routes.ts — before the route declaration
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
);
// The route handler receives request.body as Buffer
```

This is scoped to the plugin scope wrapping the webhook route; it does not
affect other JSON routes.

### Signature verification

```ts
const event = stripe.webhooks.constructEvent(
    rawBody, // Buffer
    request.headers['stripe-signature'],
    env.STRIPE_WEBHOOK_SECRET,
);
// throws StripeSignatureVerificationError on bad sig → return 400
```

### Idempotency / replay protection

1. After verifying signature, check `StripeWebhookEvent` by `event.id`.
2. If found → return `200` immediately (Stripe considers 2xx a success).
3. If not found → process → insert `StripeWebhookEvent` row in same transaction as subscription upsert.

Stripe retries for 3 days with exponential backoff. The above makes all
handlers safe to call multiple times.

### Events to handle

| Stripe event                    | Handler action                                                  |
| ------------------------------- | --------------------------------------------------------------- |
| `customer.subscription.created` | Upsert subscription (status from event)                         |
| `customer.subscription.updated` | Upsert subscription (handles cancel_at_period_end, plan change) |
| `customer.subscription.deleted` | Set status → `expired`                                          |
| `invoice.payment_succeeded`     | Set status → `active`, update period dates                      |
| `invoice.payment_failed`        | Set status → `past_due`                                         |

Unhandled event types → log + return `200` (Stripe requires 2xx for all events).

### Env vars to add to `config/env.ts`

```
STRIPE_SECRET_KEY          sk_live_...
STRIPE_WEBHOOK_SECRET      whsec_...
STRIPE_PRICE_MONTHLY       price_xxx
STRIPE_PRICE_ANNUAL        price_xxx
```

---

## 7 · Frontend Integration

### Pages / flows

**Pricing page** (unauthenticated or free users):

- Monthly / Annual toggle (annual shows discount badge)
- CTA → calls `POST /api/v1/billing/checkout` → redirect to Stripe-hosted Checkout
- Stripe redirects back to `/billing/success?session_id=…` or `/billing/cancel`

**Success page** (`/billing/success`):

- Poll or listen for `GET /billing/subscription` until status is `active`/`trialing`
- Show confirmation, clear any "upgrade" banners

**Billing settings page** (authenticated):

- Show current plan, period, renewal date from `GET /billing/subscription`
- "Manage billing" button → calls `POST /billing/portal` → redirect to Stripe Customer Portal
  (cancel, change payment method, download invoices all handled there)

### Lifecycle UX

| Subscription state | FE behaviour                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| Free (no sub)      | "Upgrade to Premium" CTAs throughout; AI rate-limit 429 shows paywall modal |
| `trialing`         | "Trial ends on DATE" banner                                                 |
| `active`           | Normal experience                                                           |
| `past_due`         | "Payment failed — update card" banner with portal link; access intact       |
| `canceled`         | "Plan ends on DATE — resubscribe?" banner; access intact until period end   |
| `expired`          | Reverts to free-tier behaviour; premium features gate                       |

### How FE reads premium status

`GET /auth/me` response gains `plan: 'free' | 'premium'`. FE stores this in
auth state on login/refresh — no extra API call needed for gating UI elements.
For hard gates (server enforces), the FE doesn't need to know in advance;
it just handles `403 PREMIUM_REQUIRED` from the API.

---

## 8 · Future-Proofing

The design accommodates extensions without breaking changes:

| Future feature                   | How the model handles it                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Additional tiers ('pro', 'team') | `plan` is a `String` not an enum; just add Stripe Price IDs and env vars                                                                  |
| Teams                            | Add `organizationId` to `Subscription`; add `members` relation; entitlement checks org sub                                                |
| Coupons / promo codes            | Pass `allow_promotion_codes: true` in Checkout session; Stripe handles it                                                                 |
| Trials                           | `trialEnd` already in schema; set `trial_period_days` in Checkout                                                                         |
| Referrals                        | Create a Stripe coupon at signup referral; apply `discounts[]` at checkout                                                                |
| Lifetime deal                    | `plan='lifetime'`, `status='active'`, `stripeSubId=''`, `currentPeriodEnd=far future`; `isEntitled` already handles this                  |
| Usage-based billing              | `AiUsage` table already tracks usage; add Stripe metered items to the subscription                                                        |
| AI credit packs (top-ups)        | `POST /billing/credit-pack` → Stripe Payment Intent (one-time); on `payment_intent.succeeded` add credits to a `aiCredits` column on User |

The entitlement service is the single choke point — adding a tier means
updating `capFor` and the entitlement matrix, nothing else.

---

## 9 · Roadmap (ordered, shippable steps)

Each step is independently deployable and leaves the system in a valid state.

1. **Stripe account + keys** — create Stripe account, get test keys, configure
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, two Price IDs (monthly/annual),
   add all to `env.ts` + `.env.example`

2. **DB schema** — add `prisma/subscription.prisma` with `Subscription` +
   `StripeWebhookEvent`; extend `user.prisma` relation; run migration

3. **Entitlement layer** — `subscription.repository.ts` (`isEntitled`,
   `findByUserId`, `upsertFromStripe`); `entitlement.service.ts`
   (`assertPremium`, `getPlan`); add `PremiumRequiredError` to `shared/errors.ts`

4. **Wire entitlement into AI caps** — `ai.budget.service.ts` calls `getPlan`,
   `capFor` branches on plan; add premium cap env vars to `env.ts`

5. **Billing service (read path)** — `billing.service.ts#getSubscription` +
   `createPortalSession`; `GET /billing/subscription` + `POST /billing/portal`
   endpoints; add `plan` field to `GET /auth/me` response

6. **Checkout** — `billing.service.ts#createCheckoutSession`; `POST
/billing/checkout` endpoint; Stripe Checkout with success/cancel URLs

7. **Webhook handler** — raw-body parsing scope in `billing.routes.ts`;
   `handleWebhookEvent` with signature verify + idempotency check + event
   dispatch (`subscription.created/updated/deleted`, `invoice.payment_succeeded/failed`)

8. **Local testing** — `stripe listen --forward-to localhost:3001/api/v1/billing/webhook`
   (Stripe CLI); smoke-test full checkout → webhook → entitlement cycle

9. **FE integration** — pricing page, success page, billing settings page,
   lifecycle banners, `plan` field in auth state

10. **Go live** — swap to live Stripe keys in Railway env; enable Stripe Tax for EU;
    point Stripe webhook endpoint to production URL

---

## Verification

- Unit: `entitlement.service.ts#isEntitled` with stubbed repo (various status/date combos)
- Integration: Stripe CLI + `stripe listen` → POST to webhook endpoint → assert DB state
- Smoke: create Checkout session → complete test card (4242…) → webhook fires → `GET /billing/subscription` returns `active`
- Negative: free-tier user hits AI cap → `429 AI_BUDGET_EXCEEDED`; premium user does not until higher cap
- Idempotency: send same webhook event twice → second call returns `200` without duplicate DB write
