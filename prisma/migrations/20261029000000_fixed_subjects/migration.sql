-- Spec 002: every deck's subject becomes one of the 12 fixed slugs
-- (src/shared/subjects.ts). Free-text / legacy values are rewritten:
--   1. legacy  — a pre-002 FE slug (or a case/space variant of a slug) → its
--                mapped subject (LEGACY_SUBJECT_MAP)
--   2. keyword — old free text → the SQL port of KEYWORD_RULES (same order,
--                same substrings; first match wins)
--   3. pending — NULL / unmatched → 'other' + subjectSource 'pending';
--                scripts/backfill-subjects.ts classifies these with AI
-- Every changed deck is recorded in deck_subject_backfill with its raw value
-- (audit + revert + context for the AI script). Decks already holding a valid
-- slug are untouched (subjectSource stays 'user'). The data steps are
-- idempotent (ON CONFLICT DO NOTHING + IS DISTINCT FROM guards).

-- AlterTable
ALTER TABLE "decks" ADD COLUMN "subjectSource" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "deck_subject_backfill" (
    "deckId" TEXT NOT NULL,
    "rawSubject" TEXT,
    "subject" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deck_subject_backfill_pkey" PRIMARY KEY ("deckId")
);

-- AddForeignKey
ALTER TABLE "deck_subject_backfill" ADD CONSTRAINT "deck_subject_backfill_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "decks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1. legacy: the 12 slugs map to themselves (catches "Languages", " law "),
--    plus every pre-002 FE slug and 'tech'.
CREATE TEMP TABLE subject_map (raw TEXT PRIMARY KEY, slug TEXT NOT NULL);
INSERT INTO subject_map (raw, slug) VALUES
    ('languages', 'languages'),
    ('medicine', 'medicine'),
    ('science', 'science'),
    ('math', 'math'),
    ('technology', 'technology'),
    ('humanities', 'humanities'),
    ('social', 'social'),
    ('business', 'business'),
    ('law', 'law'),
    ('arts', 'arts'),
    ('test-prep', 'test-prep'),
    ('other', 'other'),
    ('vocabulary', 'languages'),
    ('nursing', 'medicine'),
    ('anatomy', 'medicine'),
    ('pharmacology', 'medicine'),
    ('biology', 'science'),
    ('chemistry', 'science'),
    ('physics', 'science'),
    ('computer-science', 'technology'),
    ('programming', 'technology'),
    ('engineering', 'technology'),
    ('tech', 'technology'),
    ('history', 'humanities'),
    ('geography', 'humanities'),
    ('philosophy', 'humanities'),
    ('literature', 'humanities'),
    ('religion', 'humanities'),
    ('psychology', 'social'),
    ('social-science', 'social'),
    ('finance', 'business'),
    ('art', 'arts'),
    ('music', 'arts'),
    ('culinary', 'other'),
    ('sports', 'other'),
    ('trivia', 'other');

INSERT INTO "deck_subject_backfill" ("deckId", "rawSubject", "subject", "method")
SELECT d.id, d.subject, m.slug, 'legacy'
  FROM "decks" d
  JOIN subject_map m ON m.raw = lower(btrim(d.subject))
 WHERE d.subject IS DISTINCT FROM m.slug
ON CONFLICT ("deckId") DO NOTHING;

-- 2. keyword: port of KEYWORD_RULES in src/shared/subjects.ts. Keep in sync
--    with scripts/sql/preview-subject-mapping.sql.
INSERT INTO "deck_subject_backfill" ("deckId", "rawSubject", "subject", "method")
SELECT id, subject, slug, 'keyword'
  FROM (
    SELECT d.id, d.subject,
        CASE
            WHEN s LIKE ANY (ARRAY['%lang%', '%мова%', '%english%', '%ukrainian%', '%spanish%', '%french%', '%german%', '%italian%', '%japanese%', '%chinese%', '%korean%', '%portuguese%']) THEN 'languages'
            WHEN s LIKE ANY (ARRAY['%vocab%', '%word%', '%term%']) THEN 'languages'
            WHEN s LIKE ANY (ARRAY['%medic%', '%health%', '%clinic%']) THEN 'medicine'
            WHEN s LIKE '%nurs%' THEN 'medicine'
            WHEN s LIKE ANY (ARRAY['%anatom%', '%physiol%']) THEN 'medicine'
            WHEN s LIKE ANY (ARRAY['%pharma%', '%drug%']) THEN 'medicine'
            WHEN s LIKE '%bio%' THEN 'science'
            WHEN s LIKE '%chem%' THEN 'science'
            WHEN s LIKE '%physic%' THEN 'science'
            WHEN s LIKE ANY (ARRAY['%math%', '%calcul%', '%algebra%']) THEN 'math'
            WHEN s LIKE '%computer%' OR s LIKE '%cs %' OR s = 'cs' THEN 'technology'
            WHEN s LIKE ANY (ARRAY['%program%', '%code%', '%coding%', '%software%', '%developer%']) THEN 'technology'
            WHEN s LIKE '%engineer%' THEN 'technology'
            WHEN s LIKE '%histor%' THEN 'humanities'
            WHEN s LIKE ANY (ARRAY['%geograph%', '%country%', '%capital%']) THEN 'humanities'
            WHEN s LIKE ANY (ARRAY['%law%', '%legal%', '%juris%']) THEN 'law'
            WHEN s LIKE ANY (ARRAY['%business%', '%econom%', '%market%']) THEN 'business'
            WHEN s LIKE ANY (ARRAY['%financ%', '%account%', '%invest%']) THEN 'business'
            WHEN s LIKE '%psych%' THEN 'social'
            WHEN s LIKE '%philos%' THEN 'humanities'
            WHEN s LIKE ANY (ARRAY['%liter%', '%book%', '%grammar%']) THEN 'humanities'
            WHEN s LIKE ANY (ARRAY['%art%', '%design%', '%draw%']) THEN 'arts'
            WHEN s LIKE ANY (ARRAY['%music%', '%piano%', '%guitar%']) THEN 'arts'
            WHEN s LIKE ANY (ARRAY['%social%', '%sociol%', '%anthrop%']) THEN 'social'
            WHEN s LIKE ANY (ARRAY['%test%', '%exam%', '%prep%', '%sat%', '%gre%']) THEN 'test-prep'
            WHEN s LIKE ANY (ARRAY['%religio%', '%theol%', '%bible%', '%quran%']) THEN 'humanities'
            WHEN s LIKE ANY (ARRAY['%culin%', '%cook%', '%food%', '%recipe%']) THEN 'other'
            WHEN s LIKE ANY (ARRAY['%sport%', '%fitness%', '%gym%']) THEN 'other'
            WHEN s LIKE ANY (ARRAY['%trivia%', '%general%', '%quiz%']) THEN 'other'
        END AS slug
      FROM "decks" d
      CROSS JOIN LATERAL (SELECT lower(btrim(d.subject)) AS s) x
     WHERE d.subject IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM subject_map m WHERE m.raw = x.s)
  ) k
 WHERE slug IS NOT NULL
ON CONFLICT ("deckId") DO NOTHING;

-- 3. pending: everything else that isn't already a valid slug.
INSERT INTO "deck_subject_backfill" ("deckId", "rawSubject", "subject", "method")
SELECT d.id, d.subject, 'other', 'pending'
  FROM "decks" d
 WHERE (d.subject IS NULL OR d.subject NOT IN (SELECT slug FROM subject_map WHERE raw = slug))
   AND NOT EXISTS (SELECT 1 FROM "deck_subject_backfill" b WHERE b."deckId" = d.id)
ON CONFLICT ("deckId") DO NOTHING;

-- Apply. "updatedAt" is deliberately left alone: a taxonomy rewrite isn't a
-- user edit and must not reorder anyone's deck list.
UPDATE "decks" d
   SET subject = b.subject,
       "subjectSource" = CASE b.method WHEN 'pending' THEN 'pending' ELSE 'rules' END
  FROM "deck_subject_backfill" b
 WHERE b."deckId" = d.id
   AND d.subject IS DISTINCT FROM b.subject;

DROP TABLE subject_map;

-- AlterTable
ALTER TABLE "decks" ALTER COLUMN "subject" SET NOT NULL,
ALTER COLUMN "subject" SET DEFAULT 'other';

-- DropIndex (superseded by the 3-column index below, which shares its prefix)
DROP INDEX "decks_isPublic_subject_idx";

-- CreateIndex
CREATE INDEX "decks_isPublic_subject_targetLanguage_idx" ON "decks"("isPublic", "subject", "targetLanguage");
