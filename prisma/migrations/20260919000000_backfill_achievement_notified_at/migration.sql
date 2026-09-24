-- 20260806093130_achievement_notified_at added "notifiedAt" as NULL on every
-- existing row, so achievements earned before the notification system existed
-- surfaced as "new" and fired a burst of toasts months after they were earned.
-- Treat anything earned before that migration as already seen.
UPDATE "user_achievements"
   SET "notifiedAt" = "earnedAt"
 WHERE "earnedAt" IS NOT NULL
   AND "notifiedAt" IS NULL
   AND "earnedAt" < TIMESTAMP '2026-08-06 09:31:30';
