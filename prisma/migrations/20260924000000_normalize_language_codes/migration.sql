-- Language fields must hold a supported ISO 639-1 code (src/shared/lang.ts).
-- AI-created decks used to store full names ("Portuguese", "Ukrainian") or
-- country codes ("ua"), and region tags ("uk-UA") slipped into preferences.
-- Rewrite every value that maps cleanly to a code; anything unrecognized is
-- left untouched. Idempotent — a second run changes nothing.

CREATE TEMP TABLE lang_map (raw text PRIMARY KEY, code text NOT NULL);
INSERT INTO lang_map (raw, code) VALUES
    ('en', 'en'),
    ('uk', 'uk'),
    ('es', 'es'),
    ('fr', 'fr'),
    ('de', 'de'),
    ('pt', 'pt'),
    ('it', 'it'),
    ('ru', 'ru'),
    ('pl', 'pl'),
    ('ja', 'ja'),
    ('ko', 'ko'),
    ('zh', 'zh'),
    ('ar', 'ar'),
    ('nl', 'nl'),
    ('tr', 'tr'),
    ('vi', 'vi'),
    ('hi', 'hi'),
    ('sv', 'sv'),
    ('no', 'no'),
    ('da', 'da'),
    ('fi', 'fi'),
    ('el', 'el'),
    ('cs', 'cs'),
    ('ro', 'ro'),
    ('hu', 'hu'),
    ('he', 'he'),
    ('th', 'th'),
    ('id', 'id'),
    ('english', 'en'),
    ('ukrainian', 'uk'),
    ('spanish', 'es'),
    ('french', 'fr'),
    ('german', 'de'),
    ('portuguese', 'pt'),
    ('italian', 'it'),
    ('russian', 'ru'),
    ('polish', 'pl'),
    ('japanese', 'ja'),
    ('korean', 'ko'),
    ('chinese', 'zh'),
    ('mandarin', 'zh'),
    ('arabic', 'ar'),
    ('dutch', 'nl'),
    ('turkish', 'tr'),
    ('vietnamese', 'vi'),
    ('hindi', 'hi'),
    ('swedish', 'sv'),
    ('norwegian', 'no'),
    ('danish', 'da'),
    ('finnish', 'fi'),
    ('greek', 'el'),
    ('czech', 'cs'),
    ('romanian', 'ro'),
    ('hungarian', 'hu'),
    ('hebrew', 'he'),
    ('thai', 'th'),
    ('indonesian', 'id'),
    ('ua', 'uk'),
    ('jp', 'ja'),
    ('cn', 'zh'),
    ('kr', 'ko'),
    ('gr', 'el'),
    ('cz', 'cs'),
    ('dk', 'da'),
    ('se', 'sv'),
    ('eng', 'en'),
    ('ukr', 'uk'),
    ('spa', 'es'),
    ('fra', 'fr'),
    ('fre', 'fr'),
    ('deu', 'de'),
    ('ger', 'de'),
    ('ita', 'it'),
    ('por', 'pt'),
    ('pol', 'pl'),
    ('rus', 'ru'),
    ('jpn', 'ja'),
    ('kor', 'ko'),
    ('zho', 'zh'),
    ('chi', 'zh'),
    ('nld', 'nl'),
    ('dut', 'nl'),
    ('tur', 'tr')
;

-- "uk-UA" / "en_US" / " English " → lookup key ("uk" / "en" / "english").
CREATE FUNCTION pg_temp.lang_key(v text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT split_part(replace(lower(trim(v)), '_', '-'), '-', 1) $$;

UPDATE "decks" d
   SET "sourceLanguage" = m.code
  FROM lang_map m
 WHERE pg_temp.lang_key(d."sourceLanguage") = m.raw
   AND d."sourceLanguage" <> m.code;

UPDATE "decks" d
   SET "targetLanguage" = m.code
  FROM lang_map m
 WHERE pg_temp.lang_key(d."targetLanguage") = m.raw
   AND d."targetLanguage" <> m.code;

UPDATE "preferences" p
   SET "nativeLanguage" = m.code
  FROM lang_map m
 WHERE pg_temp.lang_key(p."nativeLanguage") = m.raw
   AND p."nativeLanguage" <> m.code;

-- Map each entry, keep first-occurrence order, drop duplicates created by the
-- mapping (e.g. ["uk", "ua"] → ["uk"]).
UPDATE "preferences" p
   SET "learningLanguages" = ARRAY(
           SELECT code
             FROM (
                 SELECT DISTINCT ON (code) code, ord
                   FROM (
                       SELECT coalesce(m.code, l) AS code, ord
                         FROM unnest(p."learningLanguages") WITH ORDINALITY AS u(l, ord)
                         LEFT JOIN lang_map m ON m.raw = pg_temp.lang_key(l)
                   ) mapped
                  ORDER BY code, ord
             ) deduped
            ORDER BY ord
       )
 WHERE EXISTS (
           SELECT 1
             FROM unnest(p."learningLanguages") AS l
             JOIN lang_map m ON m.raw = pg_temp.lang_key(l)
            WHERE l <> m.code
       );

DROP FUNCTION pg_temp.lang_key(text);
DROP TABLE lang_map;
