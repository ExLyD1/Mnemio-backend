-- READ-ONLY preview of the spec-002 subject migration
-- (prisma/migrations/20261029000000_fixed_subjects). Pure SELECTs — safe on a
-- prod snapshot or read replica BEFORE deploying. Shows what each distinct
-- subject value would become. The VALUES and CASE below mirror the migration's;
-- keep them in sync.
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
    SELECT ds.id, ds.raw,
           m.slug AS legacy_slug,
           CASE
               WHEN ds.s LIKE ANY (ARRAY['%lang%', '%мова%', '%english%', '%ukrainian%', '%spanish%', '%french%', '%german%', '%italian%', '%japanese%', '%chinese%', '%korean%', '%portuguese%']) THEN 'languages'
               WHEN ds.s LIKE ANY (ARRAY['%vocab%', '%word%', '%term%']) THEN 'languages'
               WHEN ds.s LIKE ANY (ARRAY['%medic%', '%health%', '%clinic%']) THEN 'medicine'
               WHEN ds.s LIKE '%nurs%' THEN 'medicine'
               WHEN ds.s LIKE ANY (ARRAY['%anatom%', '%physiol%']) THEN 'medicine'
               WHEN ds.s LIKE ANY (ARRAY['%pharma%', '%drug%']) THEN 'medicine'
               WHEN ds.s LIKE '%bio%' THEN 'science'
               WHEN ds.s LIKE '%chem%' THEN 'science'
               WHEN ds.s LIKE '%physic%' THEN 'science'
               WHEN ds.s LIKE ANY (ARRAY['%math%', '%calcul%', '%algebra%']) THEN 'math'
               WHEN ds.s LIKE '%computer%' OR ds.s LIKE '%cs %' OR ds.s = 'cs' THEN 'technology'
               WHEN ds.s LIKE ANY (ARRAY['%program%', '%code%', '%coding%', '%software%', '%developer%']) THEN 'technology'
               WHEN ds.s LIKE '%engineer%' THEN 'technology'
               WHEN ds.s LIKE '%histor%' THEN 'humanities'
               WHEN ds.s LIKE ANY (ARRAY['%geograph%', '%country%', '%capital%']) THEN 'humanities'
               WHEN ds.s LIKE ANY (ARRAY['%law%', '%legal%', '%juris%']) THEN 'law'
               WHEN ds.s LIKE ANY (ARRAY['%business%', '%econom%', '%market%']) THEN 'business'
               WHEN ds.s LIKE ANY (ARRAY['%financ%', '%account%', '%invest%']) THEN 'business'
               WHEN ds.s LIKE '%psych%' THEN 'social'
               WHEN ds.s LIKE '%philos%' THEN 'humanities'
               WHEN ds.s LIKE ANY (ARRAY['%liter%', '%book%', '%grammar%']) THEN 'humanities'
               WHEN ds.s LIKE ANY (ARRAY['%art%', '%design%', '%draw%']) THEN 'arts'
               WHEN ds.s LIKE ANY (ARRAY['%music%', '%piano%', '%guitar%']) THEN 'arts'
               WHEN ds.s LIKE ANY (ARRAY['%social%', '%sociol%', '%anthrop%']) THEN 'social'
               WHEN ds.s LIKE ANY (ARRAY['%test%', '%exam%', '%prep%', '%sat%', '%gre%']) THEN 'test-prep'
               WHEN ds.s LIKE ANY (ARRAY['%religio%', '%theol%', '%bible%', '%quran%']) THEN 'humanities'
               WHEN ds.s LIKE ANY (ARRAY['%culin%', '%cook%', '%food%', '%recipe%']) THEN 'other'
               WHEN ds.s LIKE ANY (ARRAY['%sport%', '%fitness%', '%gym%']) THEN 'other'
               WHEN ds.s LIKE ANY (ARRAY['%trivia%', '%general%', '%quiz%']) THEN 'other'
           END AS keyword_slug
      FROM deck_s ds
      LEFT JOIN subject_map m ON m.raw = ds.s
)
-- Per distinct raw value: how many decks, which rule, and the result.
SELECT raw,
       count(*) AS decks,
       CASE
           WHEN legacy_slug IS NOT NULL AND raw = legacy_slug THEN 'unchanged'
           WHEN legacy_slug IS NOT NULL THEN 'legacy'
           WHEN raw IS NOT NULL AND keyword_slug IS NOT NULL THEN 'keyword'
           ELSE 'pending → AI script'
       END AS method,
       COALESCE(legacy_slug, keyword_slug, 'other') AS becomes
  FROM plan
 GROUP BY raw, legacy_slug, keyword_slug
 ORDER BY method, decks DESC, raw NULLS FIRST;
