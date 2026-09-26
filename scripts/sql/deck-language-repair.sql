-- Swap the stored language pair on decks confirmed inverted by
-- deck-language-audit.sql.
--
-- DO NOT run this blind. The audit query is a heuristic: it only compares
-- scripts (Cyrillic vs Latin), and a deck for learning Ukrainian FROM English
-- looks the same to it as an English deck stored backwards. Read the audit's
-- rows first, open a few of the decks it names, and paste only the ids you
-- have actually confirmed into the list below.
--
-- Convention (docs/api-contract.md): targetLanguage = the language of
-- card.word, sourceLanguage = the language of card.definition.

BEGIN;

-- 1. Paste the confirmed deck ids here.
-- decks.id is a text column (Prisma String), not a uuid type.
CREATE TEMP TABLE decks_to_fix (id text PRIMARY KEY);
INSERT INTO decks_to_fix (id) VALUES
    -- ('00000000-0000-0000-0000-000000000000'),
    ('00000000-0000-0000-0000-000000000000');  -- placeholder: replace or remove

-- 2. Look at exactly what is about to change, with a sample card for context.
SELECT d.id,
       d.title,
       d."targetLanguage" AS words_lang_now,
       d."sourceLanguage" AS definitions_lang_now,
       d."sourceLanguage" AS words_lang_after,
       d."targetLanguage" AS definitions_lang_after,
       (SELECT c.word FROM cards c WHERE c."deckId" = d.id ORDER BY c.position LIMIT 1) AS sample_word,
       (SELECT c.definition FROM cards c WHERE c."deckId" = d.id ORDER BY c.position LIMIT 1) AS sample_definition
  FROM decks d
  JOIN decks_to_fix f ON f.id = d.id;

-- 3. The swap itself.
UPDATE decks d
   SET "sourceLanguage" = d."targetLanguage",
       "targetLanguage" = d."sourceLanguage",
       "updatedAt"      = now()
  FROM decks_to_fix f
 WHERE f.id = d.id;

-- 4. Confirm, then COMMIT. ROLLBACK if anything above looks wrong.
SELECT d.id, d.title, d."targetLanguage" AS words_lang, d."sourceLanguage" AS definitions_lang
  FROM decks d
  JOIN decks_to_fix f ON f.id = d.id;

ROLLBACK;  -- change to COMMIT once the output above is correct
