ALTER TABLE "card_progresses"
    ADD COLUMN "state" TEXT NOT NULL DEFAULT 'new',
    ADD COLUMN "remainingSteps" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lapses" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "leeched" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reps" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "learningStepSecs" INTEGER NOT NULL DEFAULT 0;

-- Preserve legacy review schedules, stats streaks and set-once mastery timestamps.
UPDATE "card_progresses"
SET "state" = 'review', "interval" = GREATEST("interval", 1), "reps" = "repetitions";

ALTER TABLE "preferences" ADD COLUMN "defaultStudyMode" TEXT;
ALTER TABLE "cards" ADD COLUMN "sourceData" JSONB;
ALTER TABLE "decks" ADD COLUMN "sourceData" JSONB;
