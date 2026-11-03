# 001 — Deck-scoped Review

> Status: **Implemented (rev 3)** · Date: 2026-10-28
> Repos: `mnemio-backend` (API) + `mnemio-frontend` (UI)
>
> **Rev 3** (replaces rev 2's per-segment sessions): no session is open during a
> review. The client tracks per-deck results locally. When the run ends, or the
> user leaves, it writes **exactly one completed session per deck touched**. The
> +25 bonus is paid **once per run** through `runId`. Achievements, stats and
> "most practiced" need no changes.

## Goal

Let a learner review **all due cards**, **a chosen set of decks** (mixed together
or deck by deck), or **a single deck**, from one `/review` hub, without changing
how spaced repetition schedules anything. The common path stays one tap.
Multi-deck review appears only when the user opts in. A review over N decks earns
exactly `10 × Σcorrect + 25` XP, the same as those cards completed in one session.

## Non-goals

- **No SRS change.** Same engine, same `POST /srs/rate`, same daily limits
  (`newPerDay 20`, `reviewsPerDay 200`, learn-ahead 20 min), same queue ordering
  within a scope.
- **No new cards in review.** Every `/review` scope is due-only. New cards stay in
  `/study/:deckId` (SRS mode).
- Filtered or tag-based review (by tag, difficulty, leeches, custom query).
- Review ahead or cram (cards not yet due).
- Saved deck presets, named groups, folders.
- Per-deck due badges anywhere except the `/review` hub and the deck-page shortcut.
- Remembering the last selection.
- Premium gating. Review stays free on every plan.
- Changing `GET /srs/queue?deckId=` behaviour (incl. its existing `403 CARD_FORBIDDEN`).
- Resuming a review. Rated cards leave the due queue live, so re-entering just
  shows what is still due.
- Any change to `/study/:deckId` deck study. It keeps its live session, resume and
  per-rating `PATCH`, with no `runId`.
- Any change to achievements, `/stats/*`, or dashboard session queries.
- A multi-deck `StudySession`, or a batch "record sessions" endpoint.
- Retro-correcting XP and session counts that today's bug already inflated.

## Current state

- `GET /srs/queue` has two scopes: one `deckId` (due + that deck's new cards) or
  none (due across every accessible deck, no new cards)
  (`src/services/srs.service.ts:130-193`, `src/schemas/srs.schema.ts:32-36`).
  Filtering lives in `accessibleCardScope` (`src/repositories/srs.repository.ts:4-7`).
- `POST /srs/rate` has no deck context. It updates `CardProgress`, `DailyActivity`
  (`srs.service.ts:70`) and achievements live, per card.
- `POST /sessions` (`src/services/sessions.service.ts:28-62`) runs in a
  transaction that flips any `active` session to `incomplete`, then creates the
  new one as `active` (`src/repositories/sessions.repository.ts:13-35`).
  `complete` (`sessions.service.ts:102-165`) awards `computeXp(correct, true)` =
  `correct*10 + 25` **unconditionally**. It sets `cardsStudied = cardIds.length`
  and, when `srsEnabled = false`, adds it to `DailyActivity`.
- Session stats read **completed** rows by `completedAt`
  (`sessions.repository.ts:138-163`). "Last practiced deck" takes the newest
  `startedAt` (`src/repositories/dashboard.repository.ts:33-44`).
- FE `/review` = `StudyModePicker` → `/review?mode=srs|know` → `StudySession`
  with no deck (`app/pages/review/index.vue`).
- **Existing bug.** `useQueuePractice.ensureRecord`
  (`app/composables/useQueuePractice.ts:126-151`) completes the current session at
  every deck switch. Global review is interleaved by due time, so one review over
  3 decks can produce ~20 completed sessions. Each gets +25 XP and counts toward
  session achievements and `mostPracticedDecks`. Each segment also declares
  `cardIds` = all of that deck's queued cards, which inflates `cardsStudied` and,
  in Know mode, `DailyActivity`.
- `useSrsStore.fetchAll` loads the unscoped queue. Its length is the `dueCount`
  badge. Rail, bottom tab bar, dashboard and `ReviewCount` link to bare `/review`.
- The analytics catalog has an unused `practice_decks_selected`
  (`app/analytics/events.ts:111-118`), left over from an earlier client-side deck
  picker (added `67aacf1`, removed `f8ae5dd`).

## User stories + acceptance criteria

**US1 — Review everything due (one tap).**
- Every Review entry point (rail, bottom tab, dashboard "Review now", due badge)
  opens `/review`, which shows the **hub**.
- "Review all · N" starts an all-decks review immediately. N = Σ `byDeck[].due`.
  The order is the same as today's global review (mixed).

**US2 — Review one deck (one tap).**
- The hub shows a grid of decks that have due cards (cover, glyph, title, due
  count), sorted by most due first. Tapping a tile starts that deck's due review
  immediately.
- The deck page shows a secondary **"Review due (N)"** button when `stats.due > 0`.
  It goes to `/review?decks=<id>`. "Study" is unchanged.

**US3 — Review several decks (opt-in multi-select).**
- Each tile has a corner checkbox. On hover-capable devices it shows on hover or
  focus. On touch devices (`@media (hover: none)`) it's always visible.
- Ticking a checkbox enters multi-select. Tile taps toggle selection. The top
  button becomes **"Review N decks"** with a **Mixed / Deck by deck** toggle
  (default Mixed; hidden when N = 1). On mobile this bar is sticky at the bottom.
- Unticking everything, or pressing Esc, exits multi-select. The cap is 50 decks.
- **Mixed:** one queue in the server's due order.
- **Deck by deck:** the decks run back-to-back in hub order with no interstitial.
  The header title switches to the current deck.

**US4 — Mode choice without an extra step.**
- The hub header has a `[SRS | Know]` toggle, preset to
  `preferences.defaultStudyMode ?? 'srs'`. Changing it does **not** save the
  preference. `/review` no longer renders `StudyModePicker`.

**US5 — Results.**
- The SRS results screen keeps today's combined summary. When the review touched
  ≥ 2 decks it adds per-deck rows (title · reviewed · recalled %).

**US6 — Session recording (rev 3).**
- A review is one **run** with a client-generated `runId` (UUID), created per
  `StudySession` mount and shared across Know-mode rounds.
- **No session is opened while reviewing.** The client keeps a per-deck tally:
  `{ deckId, cardIds (distinct, in order shown), counts, correct, revisitCardIds, activeMs }`.
  A deck is "touched" once ≥ 1 card from it has been answered.
- **Flush** happens once, when the run ends (all done / "Finish") or the user leaves
  (End session, route leave, a mode switch). For each touched deck, in order of
  first touch, with the deck the user was on **last**:
  `POST /sessions { deckId, mode, srsEnabled, runId, cardIds }` →
  `POST /sessions/:id/complete { correct, counts, revisitCardIds, durationMs }`.
  The flush is sequential and runs once (decks already written are skipped on retry).
- Leaving with nothing answered writes nothing.
- After a flush, the review leaves **no** `active` or `incomplete` session behind.
  "Continue studying" is never affected by a review.
- `cardsStudied` for a deck = the distinct cards shown from it, so `/stats/*` and
  Know-mode `DailyActivity` add up to exactly what was reviewed.

**US7 — XP is fair.**
- Session XP = `correct*10 + bonus`. `bonus = 25` unless the user already has a
  **completed** session with the same `runId`, in which case it's 0. Sessions
  without `runId` are unchanged.
- ⇒ A run touching N decks earns exactly `10 × Σcorrect + 25`. This holds in
  mixed and deck-by-deck order, and when a review is left early: whatever was
  answered gets written as completed sessions.
- Achievements and "most practiced" count one session per deck touched, which is
  the same as studying those decks separately. No special casing.

**States.**
- Loading: skeleton grid.
- Error: `UiEmptyState` + Retry.
- Nothing due: "All caught up" + next due time + "Browse my decks". If the user
  has no progress, show `review.noProgressYet`.
- A scoped link with nothing due: "all caught up" + "Back to review".
- Flush in progress on finish: the results screen shows XP/achievement toasts as
  the completions return. On failure: toast "Couldn't save your session stats —
  your card ratings are saved" + Retry.

## Data model + migration

**Migration** `prisma/migrations/20261028120000_study_session_run_id` (additive):

```sql
ALTER TABLE "study_sessions" ADD COLUMN "runId" TEXT NULL;
CREATE INDEX "study_sessions_userId_runId_idx" ON "study_sessions" ("userId", "runId");
```

Prisma `model StudySession` (`prisma/user.prisma`): `runId String?` plus
`@@index([userId, runId])`. Use the same column type as the existing id columns.
**No backfill.** Existing rows keep `NULL` and behave as today. Rollback = drop the
column.

## API contract diff (`docs/api-contract.md`)

### 1. `GET /srs/queue` — additive

```diff
-// Query: ?deckId?=uuid &extraNew?=0..100 &limit?=number(<=2000, due reviews; default 200)
+// Query: ?deckId?=uuid
+//        &deckIds?=uuid,uuid,…   // 1–50, comma-separated, deduped; NOT with deckId
+//        &extraNew?=0..100       // only meaningful with deckId; ignored otherwise
+//        &limit?=number(<=2000, due reviews; default 200)
 // 200 Response
 {
   …
   limits: { newPerDay: number; newIntroducedToday: number };
+  byDeck: {
+    deckId: string;
+    deckTitle: string;
+    coverColor: string | null;
+    glyph: string | null;
+    due: number;               // ≥ 1
+  }[];
 }
-// Errors: 404 DECK_NOT_FOUND · 403 CARD_FORBIDDEN · 400 VALIDATION_ERROR
+// Errors: 404 DECK_NOT_FOUND · 403 CARD_FORBIDDEN (deckId only) · 400 VALIDATION_ERROR
```

- **`deckIds`** narrows the **due** queue (due learning, due reviews, learn-ahead,
  **no new cards**) to those decks. `limit` caps reviews across the selection.
- If **any** id is missing or private-not-owned → `404 DECK_NOT_FOUND`. This is
  deliberately not 403, so private decks can't be enumerated (invariant #9).
- `deckId` + `deckIds`, more than 50 ids, an empty list, or a non-UUID → `400 VALIDATION_ERROR`.
- **`byDeck`** is always present (may be `[]`). It is computed over the request's
  scope and counts, per deck, the due cards the query would return **ignoring
  `limit`**: `nextReviewAt ≤ now`, plus intraday learning/relearning within the
  learn-ahead window. New cards are never counted. Only `due ≥ 1`. Order:
  `due DESC, deckTitle ASC, deckId ASC`.

### 2. `POST /sessions` — additive

```diff
 // Request: {
 //   deckId: string;
 //   mode: 'flashcard' | 'multiple_choice' | 'srs';
 //   srsEnabled?: boolean;
+//   cardIds?: string[];   // (already implemented, now documented) 1–1000,
+//                         // intersected with the deck's cards; none left → 400 SESSION_NO_CARDS
+//   runId?: string;       // uuid; groups the sessions of one review run
 // }
-// Errors: 404 DECK_NOT_FOUND · 400 DECK_EMPTY
+// Errors: 404 DECK_NOT_FOUND · 400 DECK_EMPTY · 400 SESSION_NO_CARDS
```

### 3. `POST /sessions/:id/complete` — optional final snapshot (additive)

```diff
-// Request: (empty body)
+// Request: optional; an empty body behaves exactly as before.
+// { correct?: number; counts?: SessionCounts; revisitCardIds?: string[]; durationMs?: number }
+// Same field rules as PATCH /sessions/:id. Applied and completed in a single write,
+// so XP uses the snapshot's `correct`.
```

### 4. XP rule, `StudySession`, error table

```diff
 type StudySession = {
   …
+  runId: string | null;
 };
```

- Invariant #5 → *"Session XP is server-computed: `correct*10 + 25`. The +25 is
  awarded **at most once per `runId`**, to the first session of the run that
  completes. Sessions without `runId` always get it."*
- Error table: add `SESSION_NO_CARDS` (`POST /sessions`): "None of the cards
  belong to this deck". This is a client bug, so surface a generic error.

## FE changes

Flow order: page → components → composable → store → `app/api` → `http.ts`.

**URL contract**

| URL | Meaning |
|---|---|
| `/review` (also legacy `?pick=1`) | Hub |
| `/review?decks=all&mode=srs\|know` | All due (mixed) |
| `/review?decks=<id>&mode=…` | Single deck |
| `/review?decks=<id>,<id>…&order=mixed\|by_deck&mode=…` | Multi-deck (`order` default `mixed`) |
| legacy `/review?mode=srs\|know` (no `decks`) | `navigateTo(…, { replace: true })` to `decks=all` |

A missing `mode` resolves to `defaultStudyMode ?? 'srs'`.

**Pages**
- `app/pages/review/index.vue`: no `decks` → `<ReviewHub>`. Otherwise →
  `<StudySession :deck-ids :order :mode format="flashcard">` keyed by
  `route.fullPath`. Layout: `default` for the hub, `study` for a session
  (`setPageLayout`).
- `app/pages/decks/[id]/index.vue`: "Review due (N)" when `deckStat.due > 0` →
  `/review?decks=<id>`.

**Components** (`app/components/review/` → `Review*`)
- `Hub.vue` — header with the `[SRS|Know]` `UiSegmentedControl`, "Review all · N",
  tile grid, multi-select (`Set<string>`, cap 50, Esc to clear), selection bar
  (sticky on mobile), loading/error/empty states. Data: `useSrsStore().byDeck`
  via `fetchAll()`.
- `DeckTile.vue` — swatch via `app/utils/coverSwatches.ts`
  (`:style="{ background }"`), glyph, title, due count. The tile and the checkbox
  are separate focus targets. `aria-pressed` while selecting. `text-on-color` on
  swatches.
- `DeckBreakdown.vue` — per-deck rows on the results screen.
- `app/components/study/Session.vue`: `deckIds?`, `order?` props. Header title is
  the current deck in `by_deck` and single-deck review. Results get
  `<ReviewDeckBreakdown>` (≥ 2 decks) and "Back to review". "End session" awaits
  the flush (bounded, never blocks leaving).

**Composables**
- `app/utils/reviewScope.ts` (new, pure): `parseReviewScope(query)`,
  `reviewScopeQuery(scope)`, `orderByDeck(items, deckIds)`,
  `tallyAnswer(tally, card, rating, activeMs)`, `flushPlan(tallies, lastDeckId)`.
- `useSrsQueue.load(opts: { deckId?; deckIds?; extraNew?; order? })`. In
  `by_deck`, `advance()` serves the current deck's main and learning piles
  (learning within learn-ahead), moves on when both are empty, then falls back to
  today's global `advance()` for leftover learning cards.
- `useQueuePractice` — when there is no `options.deckId` (review scope):
  - Remove `ensureRecord`, `syncRecord` and `closeRecord` from the review path.
    `submit` only rates (SRS) and tallies.
  - `flush()` follows `flushPlan`: `sessions.start({ …, runId, cardIds })` then
    `sessions.complete(snapshot)` per deck, sequentially. A deck is marked written
    after its complete succeeds, so a retry skips it. One retry of a `429` after
    `details.retryAfter`.
  - `finishSession()` → `flush()` and then results. `exit()` → `flush()`. A
    Know-mode `roundDone` does **not** flush. The next round keeps tallying into
    the same run.
  - The deck-study path (`options.deckId`) is unchanged.

**Store / API**
- `app/stores/srs.ts`: keep `byDeck` from `fetchAll`. `fetchQueue(opts)`.
- `app/stores/sessions.ts`: `start` passes `runId`. `complete(snapshot?)`.
- `app/api/srs.ts`: `getQueue(opts)` sends `deckIds` comma-joined.
  `app/api/sessions.ts`: `startSession({ …, runId })`,
  `completeSession(id, snapshot?)`.
  `app/types/srs.ts`: `SrsQueue.byDeck: SrsDeckDue[]`. `app/types/session.ts`:
  `runId: string | null`.

**i18n (en + uk)** — `review.*`: `reviewAll`, `reviewDecks` (plural), `orderMixed`,
`orderByDeck`, `selectDeck` (aria), `selectionCap`, `clearSelection`, `dueCount`,
`reviewDueShortcut`, `backToReview`, `perDeckTitle`, `modeSrs`, `modeKnow`,
`saveFailed` ("Couldn't save your session stats — your card ratings are saved").

**Analytics** (`app/analytics/events.ts`)
- `practice_decks_selected` on every hub start: `selection_mode`
  `all|single|multi`, `deck_count`, `card_count` (Σ due), plus a new optional
  `order?: 'mixed'|'by_deck'`.
- `review_due_cleared` gains optional `scope: 'all'|'single'|'multi'` and `deck_count`.
- `study_session_started` fires once per run, client-side at run start (the first
  card's `deck_id`). It no longer depends on a server session.

## Edge cases

1. **Deck deleted or made private between hub load and start** → `404 DECK_NOT_FOUND`
   → error state + "Back to review".
2. **Deck deleted or made private during the run** → its flush `POST /sessions`
   returns 404 → skip that deck and continue. The bonus goes to the first session
   that does complete. Ratings were already saved, or 403'd at rating time.
3. **Selected decks caught up meanwhile** → empty queue → "All caught up".
4. **More than 200 due in the selection** → the queue holds the 200 most overdue
   (the existing default). `by_deck` groups those. The hub shows the remainder
   afterwards.
5. **Intraday learning in `by_deck`** → served with its deck. Leftovers come after
   the last deck and tally into that deck's existing entry (still one session per
   deck).
6. **Leave with nothing answered** → no writes.
7. **Tab closed, reload, or crash mid-run** → no flush. SRS ratings,
   `DailyActivity` and the streak are safe (written live by `/srs/rate`). That
   run's XP, session rows and, **in Know mode only**, its `DailyActivity` are lost.
   Accepted, see Risks.
8. **Flush partially fails** → decks already written stay. Retry writes only the
   rest. The bonus can't double: whichever first completes in the run takes it,
   the others get 0.
9. **Lost `complete` response** (the server did complete) → a retry starts a
   *new* session for that deck: an extra row and `10×correct` again, never a
   second bonus. Rare. Accepted.
10. **A session active in another tab** (e.g. deck study) → flipped to
    `incomplete` by our flush's `POST /sessions`. Today the same happens at review
    start. It can be resumed from "Continue studying" as usual.
11. **Know-mode rounds** → same run, same tallies. `cardIds` are distinct cards,
    `counts`/`correct` cover every answer.
12. **A review crossing local midnight** → stats bucket it by `completedAt`, so on
    the end day. `DailyActivity` for SRS is still per rating.
13. **One deck ticked** → "Review 1 deck", order toggle hidden, analytics `multi`.
14. **Duplicate ids in the URL** → deduped server-side. URL order drives `by_deck`.
15. **Hub count vs badge** → the hub uses Σ `byDeck.due` (exact). The rail badge
    stays `dueCards.length` (capped, includes learn-ahead).

## Risks + failure modes

- **Lost run on crash (Know mode).** Know mode feeds `DailyActivity` only through
  session completion. A crash loses the whole run's Know activity, where today it
  loses only the current segment. SRS mode, the main use of review, loses no
  activity or streak. Accepted. A `pagehide` keepalive flush is a possible
  follow-up.
- **Flush burst.** 2 requests per touched deck at the end, against 120 req/min/IP.
  A typical run touches < 10 decks (≤ 20 requests). Reaching the limit needs ~50+
  touched decks. One `429` retry honours `retryAfter`, and any decks still
  unwritten get the Retry toast.
- **XP is now client-reported through the snapshot's `correct`.** Same trust level
  as today's `PATCH /sessions/:id { correct }`. No new exposure.
- **Bonus race.** Flushes are sequential, and `complete` requires an `active`
  session, which only one can be. The "already completed in run" check and the
  completion still share one transaction.
- **`byDeck` query cost.** One grouped `COUNT` per `/srs/queue`, on
  `card_progresses(userId, nextReviewAt)`. `EXPLAIN` with about 10k rows.
- **Layout switch** between hub and session could flash. Keep `:key="route.fullPath"`.
- **No FE test runner.** Keep the tally and flush-plan logic pure in
  `app/utils/reviewScope.ts`. The rest is covered by manual click-paths.

## Test plan

**Backend Vitest** (mocked repositories, in the style of
`test/srs-progress-deckid.test.ts` and `test/sessions-start-cardids.test.ts`)

- `srs-queue-schema.test.ts`
  - `deckIds` is deduped and trimmed.
  - 51 ids, empty, non-UUID, and `deckId` + `deckIds` each → ZodError.
- `srs-queue-deckids.test.ts`
  - Accessible ids → `queueData` gets `deckIds` and no new cards. `extraNew` is ignored.
  - A missing id → `DECK_NOT_FOUND`. A private-not-owned id → `DECK_NOT_FOUND`.
    Someone else's public deck is allowed.
  - `byDeck` mapping and sort. Unscoped vs `deckId` vs `deckIds`.
- **`sessions-run-xp.test.ts`**. `sessions.repository` is replaced by an
  **in-memory fake** (`startSession` with the active→incomplete flip,
  `findSessionOwned`, `completeSession`, `incrementUserXp`, `hasCompletedInRun`),
  so the bonus check reads real run state. Achievements, activity and milestone
  are mocked.
  - **Run over N decks earns exactly `10 × Σcorrect + 25`**, parameterised
    `it.each` over N ∈ {1, 2, 3, 5, 50} with mixed `correct` values (including 0).
    Each deck goes start(runId) → complete(snapshot). Assert Σ `incrementUserXp`
    = Σ `xpAwarded` = `10 × Σcorrect + 25`.
  - Exactly one session in the run has `xpAwarded = 10×correct + 25`. All others
    have `10×correct`.
  - A run over N decks earns the same as one session with `correct = Σcorrect`
    (equivalence assertion).
  - Two different `runId`s → +25 each.
  - No `runId` → +25 on every complete (regression, deck study).
  - The first deck's complete fails (`SESSION_NOT_ACTIVE`) → the remaining decks
    still total `10 × Σcorrect(remaining) + 25`.
  - An empty-body complete with `runId` uses the session's stored `correct`.
- `sessions-complete-snapshot.test.ts`
  - An empty body behaves as before.
  - Snapshot `correct/counts/revisitCardIds/durationMs` are persisted in the
    completing write. XP uses the snapshot's `correct`.
  - Browse mode: `DailyActivity.reviews` = `cardIds.length`, `correct` = snapshot.
  - Invalid fields → ZodError (same rules as PATCH).
- `sessions-start-cardids.test.ts`: add that `runId` is stored and returned. A
  non-UUID `runId` → ZodError.
- Existing suites unchanged: `srs-engine.test.ts`, the Anki golden fixtures,
  `sessions-complete-activity.test.ts`, `achievements-service.test.ts`. Run
  `npm run typecheck` and `npx eslint .`.

**Frontend**: `npm run validate` + `npx nuxi typecheck`.

**Manual click-path** (seed user + decks A=5, B=3, C=2 due + one public deck from
another user with 1 due; note XP first)

1. Rail "Review" → hub: 4 tiles, "Review all · 11", mode toggle preset.
2. "Review all" → during the run, `GET /sessions/active` → `null`. Finish →
   4 completed sessions sharing one `runId`, exactly one bonus, XP delta =
   10×correct + 25. Per-deck rows on results.
3. Tile B → 1 session, XP = 10×correct + 25.
4. A + C **Deck by deck** → A's cards, then C's. 2 sessions, one bonus.
5. A + C **Mixed** → interleaved. Still 2 sessions, one bonus.
6. Mixed over A + B, "End session" after 2 A and 1 B answers → 2 completed
   sessions (A: 2 cards, B: 1 card), no `incomplete` rows, "Continue studying"
   unchanged. Re-enter → only the still-due cards.
7. Leave immediately without answering → no sessions written.
8. Know mode, all due, 2 rounds → `DailyActivity.reviews` += distinct cards shown.
   One session per deck, one bonus.
9. Deck page A → "Review due (5)" → single-deck review.
10. Turn off the network before finishing → "Couldn't save…" toast → back online →
    Retry → no duplicate decks written.
11. `/review?mode=srs` → redirected to `decks=all`. `/review?decks=<private deck of
    other user>` → error + "Back to review".
12. Mobile 375 px, dark and light themes, uk locale: checkboxes visible, sticky
    bar, no horizontal scroll, strings translated.
13. Mixpanel debug: `practice_decks_selected` (`selection_mode`, `deck_count`,
    `order`). `study_session_started` fires once per run.

## Implementation plan

Each task can be committed on its own and leaves both apps working.

1. **BE: `deckIds` query param.** Schema + tests.
   *(`feat(srs): accept deckIds on /srs/queue`)*
2. **BE: scoped queue.** `decksRepo.findReadableDeckIds`. Extend
   `accessibleCardScope`, `queueData`, `newIntroducedToday` and `nextFutureDue`.
   404 access check. Tests.
3. **BE: `byDeck` aggregate.** Raw SQL in `srs.repository.ts`, a mapper in
   `shared/mappers.srs.ts`, added to the response. Tests.
4. **BE: `runId` column.** Prisma field + index + migration, `runId` on
   `POST /sessions` and in `toPublicSession`. Tests.
   *(`feat(sessions): runId groups a review run`)*
5. **BE: complete snapshot body.** `completeSessionSchema`; apply and complete in
   one write. Tests.
6. **BE: bonus once per run.** `computeXp(correct, completed, bonusEligible)`,
   `sessionsRepo.hasCompletedInRun(userId, runId, excludeId)` in the completion
   transaction. `sessions-run-xp.test.ts` (the N-deck XP tests).
7. **BE: contract.** Update `docs/api-contract.md` (the four diffs above,
   invariant #5, `SESSION_NO_CARDS`).
8. **FE: API + store plumbing.** `getQueue(opts)`, `byDeck`, `runId`,
   `completeSession(id, snapshot?)`, types.
9. **FE: run recording.** Pure tally and flush plan in `app/utils/reviewScope.ts`.
   `useQueuePractice` review path: no live session, flush on finish/exit with
   retry. This fixes today's inflation.
   *(`fix(review): one session per deck, one bonus per run`)*
10. **FE: scope routing + queue order.** `parseReviewScope`/`orderByDeck`,
    `useSrsQueue.load(opts)` with `by_deck` advance, `deckIds`/`order` props,
    `review/index.vue` URL handling, legacy redirect and layout switch. Bare
    `/review` still shows the old picker here.
11. **FE: hub UI.** `ReviewHub`, `ReviewDeckTile`, selection bar, mode toggle,
    states, en + uk strings.
12. **FE: results + header.** `ReviewDeckBreakdown`, per-deck header title,
    "Back to review", the save-failed toast + Retry.
13. **FE: deck-page shortcut.** "Review due (N)" on `/decks/:id`.
14. **FE: analytics.** `practice_decks_selected` (+`order`), the
    `review_due_cleared` props, `study_session_started` once per run.
15. **Docs.** Note the hub, the URL contract and the run/flush model in the
    frontend `CLAUDE.md`.

Tasks 1–7 (BE) ship first. Every BE change is additive, so the current FE keeps
working. Task 9 needs tasks 4–6.

## Decisions made during build

**Process**
1. **Test gate.** `npm test` has one suite that already fails before this work:
   `test/billing-management.test.ts` throws unless `DATABASE_URL` is the dedicated
   `mnemio_qa_sub` database. The backend gate was run as
   `vitest run --exclude test/billing-management.test.ts`. All other suites pass.
2. **Contract commits.** The build rules ask for the contract change in the same
   commit as the API change, so tasks 2–6 each carry their part of
   `docs/api-contract.md`. There is no separate task-7 commit. Task 1 only parses
   `deckIds` and changes no behaviour, so its contract text lands with task 2.
3. **Migration.** The SQL was generated with `prisma migrate dev --create-only`
   against a throwaway, fully migrated scratch database, then renamed to the
   spec's timestamp. The local dev database (`localhost:5433/mnemio`) is several
   migrations behind: it has no `card_progresses.state` from `20261018220000_anki_srs`.
   Nothing was applied to it. The scratch database was dropped afterwards.

**Backend**
4. `accessibleCardScope(userId, scope)` takes `DeckScope = string | string[] | undefined`
   (one deck / a set / everything). It is exported so the unit tests can check
   the `where` shape directly.
5. `byDeck` is sorted in SQL (`due DESC, title ASC, id ASC`, using the database
   collation). The service keeps that order.
6. The once-per-run bonus check (`hasCompletedInRun`) runs just before the
   status-guarded completion, not inside one database transaction. Only the
   single active session can complete, and a run's sessions are written one after
   another. The worst case is concurrent misuse of the API, which costs one extra +25.

**Frontend: run recording**
7. A deck's `cardIds` / `cardsStudied` = the distinct cards **answered** from it.
   A card on screen but unanswered when the user leaves doesn't count.
8. A deck's `activeMs` = the time since the previous answer (or since the run or
   round started), credited to the deck of the card just answered.
9. Flush resilience:
   - A session that was started but not completed is completed on retry, rather
     than opening a second one. A second one would leave the first `incomplete`,
     visible in "Continue studying".
   - `SESSION_NOT_ACTIVE` on complete counts as written (a lost response).
   - `DECK_NOT_FOUND`, `DECK_EMPTY` and `SESSION_NO_CARDS` skip that deck.
10. The 429 retry reads @fastify/rate-limit's human `retryAfter` ("38 seconds",
    "1 minute"), capped at 60 s, with a 2 s fallback.
11. Leaving waits at most 3 s for the flush. The writes carry on in the background.
    Finishing shows results at once and flushes behind them, without awaiting.
12. Toasts have no actions, so Retry is an inline notice on the session screen.
    If the user has already left, only the toast shows.
13. A re-`initialize()` (the error-state Retry) first flushes the previous tallies,
    then starts a new `runId`.

**Frontend: UI and routing**
14. In review, "End session" (and the Know-mode end) returns to the hub. The
    review results show primary "Back to review" and ghost "Back to dashboard".
    "+20 new" and "Browse my decks" were dropped there, since review is due-only.
15. The layout switches via an inline route middleware (`setPageLayout`). It runs
    before render and on query-only navigations, so nothing flashes.
16. When a scoped URL has no `mode`, the page resolves it (hydrating preferences
    if needed) and `replace`s the URL with an explicit `mode`. The deck-page
    shortcut relies on this.
17. Starting a multi-select review uses hub order (most due first), not tick
    order, so deck-by-deck order is predictable.
18. `StudyModePicker` is no longer used on `/review`. Deck study still uses it.
19. Extra i18n keys beyond the spec's list: `hubHint`, `orderLabel`, `modeLabel`,
    `loadFailed`, `perDeckRow`, `retrySave`, `reviewDueHint`. The uk
    `review.dueCount` is count-invariant ("До повторення: {n}").

**Analytics**
20. `practice_decks_selected.order` is sent only for `multi`.
    `review_due_cleared.deck_count` = decks touched. Its `scope` comes from the
    URL, so one ticked deck reports `single` there, while
    `practice_decks_selected` reports `multi`.
