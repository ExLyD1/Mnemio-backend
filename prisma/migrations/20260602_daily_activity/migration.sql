-- DailyActivity rollup (P1.6) for /stats/* heatmap/streak/series/retention.

CREATE TABLE "daily_activity" (
    "userId"     TEXT NOT NULL,
    "date"       DATE NOT NULL,
    "reviews"    INTEGER NOT NULL DEFAULT 0,
    "correct"    INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "daily_activity_pkey" PRIMARY KEY ("userId", "date")
);

CREATE INDEX "daily_activity_userId_date_idx"
    ON "daily_activity" ("userId", "date");

ALTER TABLE "daily_activity"
    ADD CONSTRAINT "daily_activity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
