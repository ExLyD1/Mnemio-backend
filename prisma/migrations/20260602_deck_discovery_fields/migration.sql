-- Deck enhancements for Discover (P2.1): cosmetic + clone-lineage + featured.

ALTER TABLE "decks"
    ADD COLUMN "coverColor"   TEXT,
    ADD COLUMN "glyph"        TEXT,
    ADD COLUMN "subject"      TEXT,
    ADD COLUMN "featured"     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "copyCount"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "sourceDeckId" TEXT;

ALTER TABLE "decks"
    ADD CONSTRAINT "decks_sourceDeckId_fkey"
    FOREIGN KEY ("sourceDeckId") REFERENCES "decks"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "decks_isPublic_updatedAt_idx" ON "decks" ("isPublic", "updatedAt");
CREATE INDEX "decks_isPublic_subject_idx"   ON "decks" ("isPublic", "subject");
CREATE INDEX "decks_isPublic_featured_idx"  ON "decks" ("isPublic", "featured");
