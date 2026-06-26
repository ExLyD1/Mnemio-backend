-- Backfill: make every pre-existing private deck public.
--
-- New decks already default to public at the application layer, but decks
-- created before that change are still isPublic = false in the DB, so their
-- share links 404 for non-owners. This one-time data migration flips them all
-- to public so existing shared links resolve. It changes data only, not schema.
--
-- Idempotent within the migration system (runs exactly once via _prisma_migrations);
-- the WHERE clause also makes the statement itself a no-op for already-public decks.
UPDATE "decks" SET "isPublic" = true WHERE "isPublic" = false;
