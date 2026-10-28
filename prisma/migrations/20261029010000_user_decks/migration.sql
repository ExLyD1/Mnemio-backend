-- Spec 002: user_decks — which decks a user is learning (distinct cards
-- studied per deck, any mode). Backfilled from history so the library is right
-- on day one:
--   * card_progresses  — every rated card (own or public deck), timestamped by
--                        its last review
--   * study_sessions   — a completed session studied all its cardIds; an
--                        active/incomplete one the first `cardIndex` of them.
--                        This is what makes browse-mode (SRS off) study count.
-- Card ids are intersected with the deck's real cards. Read-only on existing
-- tables; idempotent (ON CONFLICT DO NOTHING).

-- CreateTable
CREATE TABLE "user_decks" (
    "userId" TEXT NOT NULL,
    "deckId" TEXT NOT NULL,
    "studiedCardIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "studiedCount" INTEGER NOT NULL DEFAULT 0,
    "lastStudiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_decks_pkey" PRIMARY KEY ("userId","deckId")
);

-- CreateIndex
CREATE INDEX "user_decks_userId_lastStudiedAt_idx" ON "user_decks"("userId", "lastStudiedAt");

-- AddForeignKey
ALTER TABLE "user_decks" ADD CONSTRAINT "user_decks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_decks" ADD CONSTRAINT "user_decks_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "decks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill
INSERT INTO "user_decks" ("userId", "deckId", "studiedCardIds", "studiedCount", "lastStudiedAt", "updatedAt")
SELECT "userId",
       "deckId",
       array_agg(DISTINCT card_id),
       count(DISTINCT card_id)::int,
       max(studied_at),
       now()
  FROM (
    SELECT cp."userId" AS "userId",
           c."deckId"  AS "deckId",
           c.id        AS card_id,
           COALESCE(cp."lastReviewedAt", cp."updatedAt") AS studied_at
      FROM "card_progresses" cp
      JOIN "cards" c ON c.id = cp."cardId"
    UNION ALL
    SELECT s."userId",
           s."deckId",
           c.id,
           COALESCE(s."endedAt", s."updatedAt")
      FROM "study_sessions" s
      CROSS JOIN LATERAL unnest(
          CASE WHEN s.status = 'complete'
               THEN s."cardIds"
               ELSE s."cardIds"[1:GREATEST(s."cardIndex", 0)]
          END
      ) AS sc(card_id)
      JOIN "cards" c ON c.id = sc.card_id AND c."deckId" = s."deckId"
  ) studied
 GROUP BY "userId", "deckId"
ON CONFLICT ("userId", "deckId") DO NOTHING;
