-- READ-ONLY preview of the spec-002 subject migration
-- (prisma/migrations/20261029000000_fixed_subjects). Pure SELECTs — safe on a
-- prod snapshot or read replica BEFORE deploying. Shows what each distinct
-- subject value would become. The VALUES below mirror the migration's
-- subject_map; keep them in sync. Anything that isn't an exact or legacy-slug
-- match is 'pending' and goes to the AI script (no keyword guessing).
--
--   psql "$SNAPSHOT_URL" -f scripts/sql/preview-subject-mapping.sql

WITH subject_map(raw, slug) AS (
    VALUES
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
    ('trivia', 'other')
),
deck_s AS (
    SELECT d.id, d.subject AS raw, lower(btrim(d.subject)) AS s FROM decks d
),
plan AS (
    SELECT ds.id, ds.raw, m.slug AS legacy_slug
      FROM deck_s ds
      LEFT JOIN subject_map m ON m.raw = ds.s
)
-- Per distinct raw value: how many decks, which rule, and the result.
SELECT raw,
       count(*) AS decks,
       CASE
           WHEN legacy_slug IS NOT NULL AND raw = legacy_slug THEN 'unchanged'
           WHEN legacy_slug IS NOT NULL THEN 'legacy'
           ELSE 'pending → AI script'
       END AS method,
       COALESCE(legacy_slug, 'other') AS becomes
  FROM plan
 GROUP BY raw, legacy_slug
 ORDER BY method, decks DESC, raw NULLS FIRST;
