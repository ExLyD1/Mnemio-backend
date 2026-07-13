-- Deck privacy enforcement: decks are public-by-default now that the Public/
-- Private toggle is honored server-side. Existing decks predate enforcement and
-- were effectively public, so backfill them all to public (spec: existing decks
-- stay is_public = true).

ALTER TABLE "decks" ALTER COLUMN "isPublic" SET DEFAULT true;

UPDATE "decks" SET "isPublic" = true WHERE "isPublic" = false;
