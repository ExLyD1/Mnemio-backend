-- READ-ONLY post-migration / post-backfill check for spec 002.
-- Expect: invalid_subject = 0 always; pending = 0 after
-- scripts/backfill-subjects.ts has run; the last query lists decks whose
-- language is outside the 28 supported codes (src/shared/lang.ts) — review by hand.
--
--   psql "$DATABASE_URL" -f scripts/sql/check-subjects.sql

SELECT
    count(*) FILTER (WHERE subject NOT IN ('languages', 'medicine', 'science', 'math',
        'technology', 'humanities', 'social', 'business', 'law', 'arts', 'test-prep',
        'other'))                                       AS invalid_subject,
    count(*) FILTER (WHERE "subjectSource" = 'pending') AS pending,
    count(*)                                            AS total_decks
  FROM decks;

SELECT subject, "subjectSource", count(*) AS decks
  FROM decks
 GROUP BY subject, "subjectSource"
 ORDER BY subject, "subjectSource";

SELECT method, subject, count(*) AS decks
  FROM deck_subject_backfill
 GROUP BY method, subject
 ORDER BY method, decks DESC;

SELECT id, title, "sourceLanguage", "targetLanguage"
  FROM decks
 WHERE "sourceLanguage" NOT IN ('en','uk','es','fr','de','pt','it','ru','pl','ja','ko','zh',
        'ar','nl','tr','vi','hi','sv','no','da','fi','el','cs','ro','hu','he','th','id')
    OR "targetLanguage" NOT IN ('en','uk','es','fr','de','pt','it','ru','pl','ja','ko','zh',
        'ar','nl','tr','vi','hi','sv','no','da','fi','el','cs','ro','hu','he','th','id')
 ORDER BY title;
