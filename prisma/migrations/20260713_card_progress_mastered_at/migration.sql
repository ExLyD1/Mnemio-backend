-- item-3 "mastery curve": set-once timestamp of when a card first reached
-- mastery (repetitions >= 3, the canonical threshold). CardProgress is
-- upsert-only with no history, so we persist the first-crossing time here.
-- It is never overwritten and never cleared on lapse — the curve is
-- "cumulative cards ever mastered" (monotonic).

ALTER TABLE "card_progresses" ADD COLUMN "masteredAt" TIMESTAMP(3);

-- Backfill already-mastered rows with the best available timestamp. Historical
-- points are therefore approximate; masteries recorded from now on are exact.
UPDATE "card_progresses"
   SET "masteredAt" = COALESCE("lastReviewedAt", "updatedAt", "createdAt")
 WHERE "repetitions" >= 3 AND "masteredAt" IS NULL;
