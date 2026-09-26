-- Decks whose stored language pair disagrees with what their cards actually contain.
--
-- Convention (docs/api-contract.md): targetLanguage = the language of card.word
-- (the front), sourceLanguage = the language of card.definition (the back).
--
-- Detection only works where the two languages differ in script (Cyrillic vs
-- Latin), which covers uk/ru against en/de/es/pt/etc. Same-script pairs
-- (es/pt, en/de) cannot be judged this way and are left out.
WITH lang_script AS (
    SELECT * FROM (VALUES
        ('uk','cyr'), ('ru','cyr'),
        ('en','lat'), ('de','lat'), ('es','lat'), ('pt','lat'), ('fr','lat'),
        ('it','lat'), ('pl','lat'), ('nl','lat'), ('tr','lat'), ('sv','lat'),
        ('no','lat'), ('da','lat'), ('fi','lat'), ('cs','lat'), ('ro','lat'),
        ('hu','lat'), ('id','lat'), ('vi','lat')
    ) AS t(code, script)
),
card_scripts AS (
    SELECT
        c."deckId",
        count(*) AS sampled,
        count(*) FILTER (WHERE c.word ~ '[А-Яа-яЁёІіЇїЄєҐґ]') AS word_cyr,
        count(*) FILTER (WHERE c.word ~ '[A-Za-z]'
                           AND c.word !~ '[А-Яа-яЁёІіЇїЄєҐґ]') AS word_lat,
        count(*) FILTER (WHERE c.definition ~ '[А-Яа-яЁёІіЇїЄєҐґ]') AS def_cyr,
        count(*) FILTER (WHERE c.definition ~ '[A-Za-z]'
                           AND c.definition !~ '[А-Яа-яЁёІіЇїЄєҐґ]') AS def_lat
    FROM cards c
    GROUP BY c."deckId"
),
observed AS (
    SELECT
        cs."deckId",
        cs.sampled,
        CASE WHEN cs.word_cyr > cs.word_lat THEN 'cyr'
             WHEN cs.word_lat > cs.word_cyr THEN 'lat' END AS word_script,
        CASE WHEN cs.def_cyr > cs.def_lat THEN 'cyr'
             WHEN cs.def_lat > cs.def_cyr THEN 'lat' END AS def_script
    FROM card_scripts cs
    WHERE cs.sampled >= 3
)
SELECT
    d.id,
    d.title,
    d."authorId",
    d."sourceLanguage" AS stored_definitions_lang,
    d."targetLanguage" AS stored_words_lang,
    o.word_script      AS actual_word_script,
    o.def_script       AS actual_definition_script,
    o.sampled          AS cards_checked,
    d."sourceDeckId" IS NOT NULL AS is_copy,
    d."isPublic",
    d."createdAt"
FROM decks d
JOIN observed o        ON o."deckId" = d.id
JOIN lang_script ls_t  ON ls_t.code = d."targetLanguage"
JOIN lang_script ls_s  ON ls_s.code = d."sourceLanguage"
WHERE o.word_script IS NOT NULL
  AND o.def_script IS NOT NULL
  AND o.word_script <> o.def_script          -- a real bilingual deck
  AND ls_t.script <> ls_s.script             -- stored pair differs in script too
  AND ls_t.script = o.def_script             -- ...but the two are swapped:
  AND ls_s.script = o.word_script            --    words are in the "definitions" language
ORDER BY d."createdAt";
