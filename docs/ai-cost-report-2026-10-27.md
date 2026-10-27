# AI cost per operation and production models — measured 2026-10-27

Every number below is measured by running the real prompts and provider code
against the Anthropic API on 2026-10-27. Anything not measured is marked `~`, with
the reason. Prices were checked on the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
the same day. The whole eval, including the judge, cost **$3.53** of the $5 ceiling.

## Verdict

| Route | Model | Env to set (when you decide to flip) |
|---|---|---|
| EN card content | **Claude Haiku 5.5 @ low** | `ANTHROPIC_CONTENT_MODEL_EN=claude-haiku-5-5`, `ANTHROPIC_CONTENT_EFFORT_EN=low` |
| UK card content | **Claude Sonnet 5.5 @ low** | `ANTHROPIC_CONTENT_MODEL_UK=claude-sonnet-5-5`, `ANTHROPIC_CONTENT_EFFORT_UK=low` |
| Chat + tips | **Claude Haiku 5.5 @ low** | `ANTHROPIC_MODEL=claude-haiku-5-5`, `ANTHROPIC_CHAT_EFFORT=low` |

- **EN: −87% per operation.** Haiku 5.5 has higher judge scores than Haiku 4.5. It
  misses the strict pass bar on two points:
  - it reads the non-word *drastle* as a misspelling of *drastic*, which the enrich
    prompt arguably invites;
  - chat time-to-first-token rises from 0.7 s to 2.0 s, while total reply time stays
    the same (see Risks).
- **UK: we cannot drop Sonnet.** In the same blind comparisons, Haiku 5.5 scored
  below Sonnet 5 on native-sounding Ukrainian (medium 92.4% vs 92.8%; low 90.7% vs
  94.9%) and made 2 critical errors to Sonnet 5's 0–1. Sonnet 5.5 passes every bar:
  - Ukrainian 94.1% vs Sonnet 5's 91.6%;
  - 0 critical errors;
  - −20% cost on a 100-word list;
  - 2× faster.
- **Your hand review of `uk-review.csv` should decide the UK route,** not the judge.

Haiku 5.5 @ medium measured the same cost as @ low on EN content. A forced tool call
skips thinking, so effort barely matters there. Its EN quality was within noise of
low: 99.4% vs 98.7%.

## Cost per operation (USD, median · worst of 3, chosen models)

Cost is the sum of every API call an operation triggers, retries included, taken from
the `ai_call` records. `chat_messages` token counts are not used.

| Operation | EN | UK | Today EN (Haiku 4.5) | Today UK (Haiku 4.5 chat + Sonnet 5 content) |
|---|---:|---:|---:|---:|
| Chat msg, 1st turn | 0.0005 · 0.0005 | 0.0005 · 0.0005 | 0.0034 | 0.0045 |
| Chat msg, ~10th turn | 0.0007 · 0.0007 | 0.0008 · 0.0008 | 0.0054 | 0.0069 |
| Chat msg, ~30th turn | 0.0007 · 0.0007 | 0.0008 · 0.0008 | 0.0054 | 0.0072 |
| Chat: create 20-card deck (3 calls) | 0.0028 · 0.0028 | 0.033 · 0.034 | 0.019 | 0.041 (worst 0.067, a retry) |
| Chat: add 10 cards (3 calls) | 0.0018 · 0.0020 | 0.017 · 0.017 | 0.015 | 0.0037 ¹ |
| Word list → deck, 1 word | 0.0001 · 0.0003 | 0.0020 · 0.0020 | 0.0020 | 0.0024 |
| Word list, 10 words | 0.0006 · 0.0007 | 0.012 · 0.012 | 0.0072 | 0.016 |
| Word list, 50 words | 0.0029 · 0.0030 | 0.046 · 0.047 | 0.023 | 0.060 |
| Word list, 100 words | 0.0058 · 0.0058 | 0.078 · 0.079 | 0.043 | 0.097 |
| Topic → deck, 20 cards | 0.0015 · 0.0016 | 0.021 · 0.022 | 0.013 | 0.033 |
| Photo → deck (3 real textbook photos) | 0.0009 · 0.0011 | 0.020 · 0.022 | 0.0079 | 0.019 |
| Tip | 0.0002 · 0.0002 | 0.0002 · 0.0002 | 0.0014 | 0.0014 |

¹ Today's UK chat model (Haiku 4.5) never added the cards: in 3/3 runs it asked a
clarifying question instead of calling `add_cards`. This number is the price of a
question, so it is left out of every comparison below.

The "~10th" and "~30th" turns cost the same because the server sends at most
`AI_CHAT_CONTEXT_TURNS` (20) messages: turn 30 carries the same context as turn ~10.

**What the columns mean.**
- **EN:** English words with English definitions. Chat EN is an English speaker
  learning German.
- **UK:** the same English words with Ukrainian definitions and instructions. Chat UK
  is a Ukrainian speaker learning English.
- **Tip:** the prompt has no language, so one measurement fills both columns.

**Versus today.** EN is −87% and UK is −26%. Method: the sum of the per-operation
medians in the table, skipping UK "add 10 cards" (footnote ¹).
- EN: $0.0184 vs $0.1465.
- UK: $0.214 vs $0.288.

**Without prompt-cache hits.** Back-to-back eval runs can hit the 5-minute prompt
cache, but sparse real traffic mostly won't. So I re-priced every call with each
cached token billed as a cold cache write (1.25× input):
- UK content goes up by at most +5%, e.g. a 100-word list costs 0.082 vs 0.078;
- chat and EN are unchanged to 4 decimals.

Output tokens dominate the cost.

## Daily cost at current caps (chosen models)

The caps come from `src/config/env.ts`:

| Cap | Free | Premium (hidden) |
|---|---:|---:|
| Decks | 2 | 100 |
| Messages | 50 | 1000 |
| Actions | 5 | 200 |
| Tips | 100 | 100 |

A word list is metered as an **action** in code (`ai.service.ts:77`), even though the
`env.ts` comment lists it under decks. The figures below follow the code.

"Maxing every cap" prices each unit as follows:
- **Deck:** the most expensive measured deck operation.
- **Action:** the most expensive measured action, which is a 100-word list.
- **Message:** a late chat turn.
- **Tip:** the measured tip.

The deck and action chat turns are also counted as messages, which overstates the
total slightly.

| | EN | UK |
|---|---:|---:|
| Free | 2×0.0028 + 50×0.0007 + 5×0.0058 + 100×0.00016 = **$0.08/day** | 2×0.0326 + 50×0.0008 + 5×0.0782 + 100×0.00016 = **$0.51/day** |
| Premium | 100×0.0028 + 1000×0.0007 + 200×0.0058 + 100×0.00016 = **$2.11/day** | 100×0.0326 + 1000×0.0008 + 200×0.0782 + 100×0.00016 = **$19.67/day** |
| Same mix on today's models | free $0.66 · premium $16.13 | free $1.06 · premium $30.74 |

The Premium UK figure is driven by 200 actions × a 100-word Sonnet list ($15.64 of
the $19.67).

## Quality (per model)

Blind, pairwise judging: Claude Sonnet 5.5 @ medium compared each model against the
baseline on the same cards. The baseline was Haiku 4.5 for EN and Sonnet 5 for UK.
The judge graded run 1 of the 100-word list and run 1 of the 20-card topic deck
(≈118 cards per comparison). Critical errors are automatic plus judge-flagged. p95
latency is total wall time for content operations, plus time to first token for chat.

| Model | Lang | Schema-valid 1st try | Critical errors | Mean score | UK naturalness | p95 latency |
|---|---|---:|---:|---:|---:|---|
| Haiku 4.5 (today) | EN | 100% | 0 | 94.8–96.6% ² | — | content 63.8 s · chat TTFT 0.7 s |
| Sonnet 5 (today) | UK | 95.8% (1 retry) | 0–1 ² («поспівчувала» for *sympathetic*) | 94.6–95.1% ² | 91.6–94.9% ² | content 95.0 s |
| Haiku 5.5 @ low | EN | 100% | 2 (*drastle*) | 98.7% | — | content 44.2 s · chat TTFT 2.0 s |
| Haiku 5.5 @ low | UK | 100% | 4 ³ (*drastle* in 2 runs; «Собака почала», wrong gender agreement) | 93.2% | 90.7% | content 44.2 s · chat TTFT 2.1 s |
| Haiku 5.5 @ medium | EN | 100% | 1 (*drastle*) | 99.4% | — | content 44.3 s · chat TTFT 2.6 s |
| Haiku 5.5 @ medium | UK | 100% | 3 ³ (*drastle*; «тратить полярний лід», a russism and the wrong verb) | 95.9% | 92.4% | content 46.6 s · chat TTFT 5.6 s |
| **Sonnet 5.5 @ low** | UK | 100% | **0** | 92.3% | **94.1%** | content 44.4 s |

² The baseline was judged once against each candidate, so its figures are a range
across those comparisons. The pass bar always compares against the baseline's
verdicts from the same comparison.

³ Automatic and judge counts added together. The automatic check and the judge both
flag the same *drastle* card from run 1, so one error is counted twice.

**Pass bar.**
- **Sonnet 5.5 @ low (UK):** passes all five checks (schema validity, critical
  errors, mean score, Ukrainian score, latency).
- **Haiku 5.5 EN:**
  - Fails "critical ≤ baseline" on *drastle* alone; the judge itself flagged 0 vs 0.
  - Fails chat TTFT ≤ 1.5×.
  - Passes everything else.
- **Haiku 5.5 UK:** fails "UK ≥ Sonnet 5" and "critical ≤ baseline".

**How Sonnet 5.5 loses points.** It writes translation-style glosses (*magazine* →
«журнал»). The judge marks these down as "just a translation", but for НМТ learners a
translation is probably what they want. It also leaves the 4 typos empty, while Haiku
corrects them. Both are prompt-policy questions rather than model errors (Risks).

## Surprises and risks

- **Production truncates word lists today.**
  - On `main`, the word-list `max_tokens` is `min(8000, n × 200)`.
  - Measured output for 100 words: 9.2k tokens (Haiku 4.5 EN), 9.8k (Sonnet 5 UK),
    11.9k (Haiku 5.5, heavier tokenizer).
  - Any list over ~80–85 words is cut off in production. The tail comes back
    `ai-unfilled`, nothing checks `stop_reason`, and nothing is retried.
  - The per-word budget is fine (~92–98 tokens/word); the 8000 ceiling is the bug.
  - This branch raises the ceiling (16000 × the tokenizer factor), retries a
    truncation once with twice the tokens, and never accepts a cut-off deck.
- **Retries and refusals are rare.**
  - 1 retry in 231 runs: a Sonnet 5 UK deck failed validation once, which made its
    worst run 1.6× the median.
  - On the 5.5 models: 0 retries, 0 `max_tokens`, 0 refusals.
  - 0 refusals in all 310 calls.
- **Thinking overhead costs time, not money.**
  - Haiku 5.5 chat thinks before answering. Time to first token is 2.0 s at low and
    up to 5.6 s at medium (UK), vs 0.7 s on Haiku 4.5. Total reply time is about the
    same (p95 3.2–3.6 s vs 3.4–5.5 s).
  - Sonnet 5.5 content calls think before the tool call. Its first token arrived
    after ~15 s on a topic deck in the pilot, but it still finishes in half Sonnet
    5's time.
  - ~ An untested option to recover TTFT: `thinking: disabled` at low effort on chat.
    That would need a new env var, so it's not done here.
- **The tokenizer costs more tokens, at a much lower price.** Haiku 5.5 used ~27% more
  output tokens than Haiku 4.5 on the same 100-word list (11.6k vs 9.2k), and is still
  7.5× cheaper.
- **Today's chat model fails in Ukrainian.**
  - Haiku 4.5 never ran "Додай ще 10 слів до цієї колоди" (3/3 runs asked a question
    instead).
  - One reply opened with «Хорошо», a russism.
  - Haiku 5.5 did it in 6/6 runs.
- **Card counts drift on 5.5 models.** Topic decks came back with 19–22 cards instead
  of 20 in 7/12 Haiku 5.5 runs and 2/3 Sonnet 5.5 runs; Haiku 4.5 and Sonnet 5 were
  exact.
- **"Add 10 cards" can add fewer.**
  - The chat model can't see the deck, so it sometimes passes words the deck already
    has. Those are skipped, which left UK runs at 4, 6 and 5 cards.
  - Mimi reports the shortfall honestly.
  - The eval's stub left `skipped` out of the tool result, which production includes.
    That changes the reply wording, not the cost.
- **The enrich prompt's typo policy is ambiguous.** "If the user pasted a misspelling,
  still produce an entry" makes Haiku correct typos, and also "correct" non-words.
  Sonnet leaves both empty. Pick one policy in the prompt.
- **Definition vs translation.** For the НМТ list, Haiku writes dictionary
  definitions in Ukrainian («Періодичне видання з статтями», which should be «зі
  статтями»), and Sonnet 5.5 writes translations («журнал»). Decide which you want.
- **Prompt caching.**
  - Content prompts now cache on the 5.5 models (the minimum is 512 tokens); the cost
    sensitivity is above.
  - The chat prompt (~4.5–5k input tokens per late turn) has no `cache_control`, so
    every message pays full input.
  - ~ Adding it would cut a late Haiku 5.5 chat message from $0.0008 to about
    $0.0004. That's estimated from token counts and applies only when the same user
    writes again within 5 minutes. It wasn't measured, so it isn't implemented.
- **Merging `development` into `main` flips models.** `origin/development` already
  defaults `ANTHROPIC_MODEL` to Haiku 5.5. When it's promoted to `main`, chat, EN
  content, photo and tips all move to Haiku 5.5 unless Railway pins
  `ANTHROPIC_MODEL`.
- **A test made real, billed API calls.** `test/ai-reservations.test.ts` did so
  whenever `.env` had `AI_PROVIDER=anthropic`. It's fixed on this branch.

## The 2026-10-10 audit findings

| # | Finding | Status |
|---|---|---|
| 1 | A chat deck is 3 calls | Confirmed: every successful create/add run was round 1 + generation + round 2 |
| 2 | `chat_messages` leaves out generation and retries | Confirmed in code. Cost here comes from per-call `ai_call` logs |
| 3 | Up to 4 generation calls; `stop_reason` unchecked | Confirmed (worst case stays 4, now documented). `stop_reason` is now handled: `max_tokens` is retried once and never accepted short; `refusal` is never retried |
| 4 | 200 tokens/word too tight for UK | Per-word budget is fine (~98 tokens/word measured). The real problem is the 8000 ceiling — see Risks |
| 5 | Prompt caching is a no-op | True on Haiku 4.5 (prompts below the 4096-token minimum) and for chat (no `cache_control`). Content prompts do cache on Sonnet 5 and the 5.5 models |
| 6 | 100 words per call vs "20 cards" in the chat prompt | Confirmed. `create_deck.words` has no `maxItems`; the 100-word cap is enforced only in `fillCards` |

## Method and reproducibility

- **Code:** `scripts/ai-calibrate.ts` (runner) and `scripts/ai-eval-grade.ts`
  (grading and judge). Fixtures are in `scripts/fixtures/ai-eval/` (see its README).
- **Setups run** (3 runs per cell; photo = 3 real textbook photos, one run each):
  - `today`: Haiku 4.5 + Sonnet 5 UK;
  - `h55-low`;
  - `h55-med`;
  - `s55-uk`: UK content cells only; chat in this setup runs on Haiku 5.5 @ low.
- **Chat cells run end to end** with the real generation helpers; only persistence is
  stubbed. Chat history is 30 hand-written user turns per language, with replies
  frozen from one Haiku 5.5 @ low pass.
- **Raw data stays local and is git-ignored:**
  - `scripts/fixtures/ai-eval/out/*.jsonl` — every `ai_call` and every run's output;
  - `ledger.json` — spend;
  - `judge.jsonl`;
  - `grade.md`;
  - `uk-review.csv` — **your review sheet: 842 Ukrainian cards, blind model codes, key
    in `uk-review-key.csv`**.
- **References still need your review.** All reference translations in
  `quality-set.json` are drafts; check the 5 marked `unsure` first: *mean, take after,
  call off, complexion, replica*.
- **Eval spend:** $3.53 = $0.28 pilot and history + $2.23 runs + $1.02 judge.
  $0.32 of the judge cost went on topic decks across two passes. The first pass was
  discarded: the judge prompt hid each card's headword, so it couldn't check
  definitions against their words.
