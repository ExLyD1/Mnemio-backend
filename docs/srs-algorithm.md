# Mnemio SRS algorithm

Behaviour specification for `src/services/srs-engine.ts`.

## Provenance

The engine is Mnemio's own implementation of the classic SM-2 family of
spaced-repetition rules. It was written from this document, not translated
from any other code base. The rules come from public sources:

- SM-2 (P. Wozniak, 1987): ease factor, interval × ease, ease floor 1.3.
- The publicly documented behaviour of Anki's deck options (learning steps,
  graduating/easy interval, starting ease, easy bonus, hard interval,
  interval modifier, lapse "new interval", minimum interval, leech threshold,
  day rollover at 04:00).
- Interval fuzz ranges as published by the open-spaced-repetition project
  (MIT): 15 % between 2.5 and 7 days, 10 % between 7 and 20, 5 % above 20.

Behaviour is checked against 1 500 reference transitions recorded from Anki
(`test/fixtures/anki/anki-golden.json`, input → output data only): 5 999 of
6 000 answers match. The one difference comes from number format: Anki
multiplies in single precision, where 1.3 is 1.2999999523, so `95 × 1.3` gives
123.4999 and rounds to 123. Mnemio keeps ease as a plain decimal (four places),
so it gives 123.5 and rounds to 124.

The fuzz factor comes from Mnemio's own source (SHA-256 of card id and answer
count), so live intervals stay inside the same ranges but are not Anki's
exact picks.

## Card memory

| Field             | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `phase`           | `new`, `learning`, `review` or `relearning`                  |
| `stepsLeft`       | learning steps still ahead, the current one included         |
| `stepSecs`        | delay of the current learning step                           |
| `intervalDays`    | review interval; while relearning, the interval to return to |
| `daysSinceReview` | whole study days since the last answer                       |
| `ease`            | interval growth factor, never below 1.3                      |
| `lapses`          | times the card was forgotten in review                       |
| `leeched`         | the last lapse hit the leech threshold                       |

## Settings (defaults)

Learning steps 1m 10m · relearning steps 10m · graduating interval 1d ·
easy interval 4d · starting ease 2.5 · easy bonus 1.3 · hard interval 1.2 ·
interval modifier 1.0 · lapse interval 0 · minimum lapse interval 1d ·
maximum interval 36500d · leech threshold 8.

A study day starts at 04:00 in the learner's time zone.

## Learning steps

Steps are minutes, stored as whole seconds (fractions truncated). For a list
of `n` steps, the current position is `n − stepsLeft`, clamped to the list.

- **Again**: back to the first step, `stepsLeft = n`.
- **Hard**: on the first step, the average of the first two steps, or 1.5 × the
  only step but at most one day more than it. On a later step, repeat that step.
  `stepsLeft` is unchanged. A delay longer than a day is rounded to whole days.
- **Good**: the next step, `stepsLeft − 1`; after the last step the card graduates.
- **Easy**: graduates at once.

A new card behaves as a card on the first learning step. With no steps every
answer graduates.

Graduating: Good gives the graduating interval, Easy the easy interval, both
fuzzed and capped by the maximum interval. Ease starts at the starting ease.

Learning delays under a day get a random extra of up to a quarter of the
delay, at most five minutes. The stored step delay stays unjittered.

## Review answers

`I` = current interval, `E` = days since the last review, `ease` = current ease.
Intervals below are computed from `B = max(I, 1)`.

On time or late (`E ≥ I`), with `late = E − I`:

- Hard: `B × hard interval`; at least `I + 1` when hard interval > 1.
- Good: `(B + late / 2) × ease`; at least Hard + 1 (or `I + 1` when hard interval ≤ 1).
- Easy: `(B + late) × ease × easy bonus`; at least Good + 1.

Early (`E < I`), no minimums beyond one day:

- Hard: the larger of `E × hard interval` and `B × hard interval / 2`.
- Good: the larger of `E × ease` and `B`.
- Easy: Good's base × (easy bonus − (easy bonus − 1) / 2).

Every result is multiplied by the interval modifier, then capped by the
maximum interval (the "at least" rules give way to the cap). On-time and late
results are fuzzed; early results are not.

Ease: Hard −0.15, Good unchanged, Easy +0.15, never below 1.3.

**Again (lapse)**: `lapses + 1`, ease −0.2 (floor 1.3). The interval to return
to is `I × lapse interval` (no interval modifier), at least the minimum lapse
interval, capped and fuzzed. With relearning steps the card enters relearning
at the first step; without, it stays in review with that interval.

Leech: at the threshold and then every half threshold (rounded up) after it.
Any passing review answer clears the leech flag.

## Relearning answers

The learning-step rules above apply to the relearning steps; ease and lapses
are kept.

- Again: back to the first step; the saved interval is lapsed once more
  (`× lapse interval`, same limits and fuzz). No extra lapse is counted.
- Good after the last step (or Again/Hard/Good with no steps): back to review
  with the saved interval as it is.
- Easy: back to review with the saved interval + 1 day.

## Fuzz

Intervals below 2.5 days are not fuzzed. Otherwise the spread is
`1 + 15 % of the part in 2.5–7 + 10 % of the part in 7–20 + 5 % above 20`
days around the interval; the range is rounded, then narrowed by the
minimum and maximum. A uniform random factor in `[0, 1)` picks a whole day in
that range. The factor is derived from the card id and its answer count, so
previews and the real answer agree.
