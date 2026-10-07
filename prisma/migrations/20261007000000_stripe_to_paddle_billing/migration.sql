-- Stripe → Paddle billing migration.
--
-- Uses RENAME throughout rather than DROP/ADD: renaming preserves every existing
-- row and its values, so no subscription, customer link or processed-event
-- record is lost if this runs against an environment that already has data.
-- Indexes and constraints follow their columns automatically.

-- subscriptions: provider-id columns
ALTER TABLE "subscriptions" RENAME COLUMN "stripeCustomerId" TO "paddleCustomerId";
ALTER TABLE "subscriptions" RENAME COLUMN "stripeSubId" TO "paddleSubId";
ALTER TABLE "subscriptions" RENAME COLUMN "stripePriceId" TO "paddlePriceId";

-- subscriptions: index + unique constraints carrying the old provider name
ALTER INDEX IF EXISTS "subscriptions_stripeCustomerId_idx"
    RENAME TO "subscriptions_paddleCustomerId_idx";
ALTER INDEX IF EXISTS "subscriptions_stripeCustomerId_key"
    RENAME TO "subscriptions_paddleCustomerId_key";
ALTER INDEX IF EXISTS "subscriptions_stripeSubId_key"
    RENAME TO "subscriptions_paddleSubId_key";

-- Idempotency ledger. The id format differs between providers (evt_… vs ntf_…),
-- but ids stay globally unique, so retaining old rows is harmless and keeps the
-- replay protection history intact.
ALTER TABLE "stripe_webhook_events" RENAME TO "paddle_webhook_events";
ALTER INDEX IF EXISTS "stripe_webhook_events_pkey" RENAME TO "paddle_webhook_events_pkey";
