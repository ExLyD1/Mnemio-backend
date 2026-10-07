-- Store the Paddle product id alongside the price id.
--
-- Entitlement is a product-level question ("does this user own Premium?"),
-- whereas the price only records how they pay for it. Keeping both means a
-- monthly↔annual switch can be told apart from an actual plan change.
--
-- DEFAULT '' lets the column be added to existing rows without a rewrite; the
-- webhook populates it on the next event for every live subscription.
ALTER TABLE "subscriptions" ADD COLUMN "paddleProductId" TEXT NOT NULL DEFAULT '';
