-- Expanded Card model (P1.3): rich fields for Add Card / Study, replacing
-- the FE client-side enrichment in app/utils/studyCard.ts.

ALTER TABLE "cards"
    ADD COLUMN "reading"            TEXT,
    ADD COLUMN "partOfSpeech"       TEXT,
    ADD COLUMN "example"            TEXT,
    ADD COLUMN "exampleTranslation" TEXT,
    ADD COLUMN "tags"               TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "difficulty"         TEXT   NOT NULL DEFAULT 'medium',
    ADD COLUMN "type"               TEXT   NOT NULL DEFAULT 'basic',
    ADD COLUMN "audioUrl"           TEXT;
