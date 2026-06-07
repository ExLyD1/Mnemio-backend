-- Per-user daily AI usage rollup. One row per (userId, day, kind).
-- Powers ai.budget.service.ts caps.

CREATE TABLE "ai_usage" (
    "userId"    TEXT NOT NULL,
    "day"       DATE NOT NULL,
    "kind"      TEXT NOT NULL,
    "count"     INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("userId", "day", "kind")
);

CREATE INDEX "ai_usage_userId_day_idx" ON "ai_usage" ("userId", "day");

ALTER TABLE "ai_usage"
    ADD CONSTRAINT "ai_usage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
