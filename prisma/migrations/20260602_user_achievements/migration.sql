-- UserAchievement (P1.5): per-user catalog unlocks. Catalog is code-defined.

CREATE TABLE "user_achievements" (
    "userId"    TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "earnedAt"  TIMESTAMP(3),
    "progress"  INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("userId", "key")
);

CREATE INDEX "user_achievements_userId_earnedAt_idx"
    ON "user_achievements" ("userId", "earnedAt");

ALTER TABLE "user_achievements"
    ADD CONSTRAINT "user_achievements_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
