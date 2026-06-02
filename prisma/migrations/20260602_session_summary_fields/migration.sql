-- Server-backed Session Summary (P1.2): per-grade counts, revisit list,
-- precise duration in ms.

ALTER TABLE "study_sessions"
    ADD COLUMN "countsAgain"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "countsHard"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "countsGood"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "countsEasy"     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "revisitCardIds" TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "durationMs"     INTEGER NOT NULL DEFAULT 0;
