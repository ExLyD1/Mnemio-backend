# AI eval fixtures

Inputs for `scripts/ai-calibrate.ts` (cost matrix) and `scripts/ai-eval-grade.ts`
(quality + judge). Both use the real prompts from `src/services/ai.prompts.ts` and
`src/services/chat.prompt.ts`, unchanged.

| File | What |
|---|---|
| `quality-set.json` | 100 НМТ items: plain, polysemous, phrasal verbs, false friends, rare words, 3 non-words, 4 typos, 2 duplicates, 1 prompt injection. `lists` holds the 1 / 10 / 50 / 100-word lists the cost matrix uses — the 100-word list *is* the quality set. |
| `chat-scripts.json` | One EN and one UK conversation (30 hand-written user turns each), plus the create-deck and add-cards requests. |
| `chat-history.json` | Assistant replies for those turns, generated once (`--build-history`) and frozen, so every model sees the same prior context. |
| `scenarios.json` | Topic deck, tip and photo inputs. |
| `photos/` | Real textbook photos for photo → deck. Git-ignored: they are not ours to publish. |
| `out/` | Raw run JSONL, the spend ledger, `grade.md`, `uk-review.csv`. Git-ignored. |

**Columns.** EN = English words with English definitions; UK = the same English words
with Ukrainian definitions (the НМТ beachhead). Chat EN is an English speaker learning
German; chat UK is a Ukrainian speaker learning English.

**References need review.** Every `refUk` was written by Claude (`reviewStatus:
"needs-review"`); `unsure: true` marks the ones Claude was not confident about. The
automatic match is lenient (stem match); a miss goes to the review sheet, it is not an
error by itself. Critical errors come from non-words given a meaning, an obeyed
injection, a false-friend translation, or the judge.

**Spend.** Every paid call goes through `out/ledger.json`; a run stops before the
eval's cumulative spend could pass `--budget-usd` (default $5).
