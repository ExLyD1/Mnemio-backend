# Mnemio — Audit-driven Refactor Plan (19 Sep 2026)

Branch: `fix/audit-2026-09` off `development` in both repos.
Evidence: `audit-findings.md` (every HIGH claim personally verified against source; auth
classifier verified by execution).

Owner decisions applied:
1. Rotated refresh token → re-issue, never revoke-all. Keep revoke-all for logout-revoked/expired.
2. Delete verified-dead code (orphan components, dead FE SM-2, 142 unused i18n keys).
3. Fix fallout only — do NOT build `/stats/performance`. DO send durationMs/counts (existing
   intended behaviour, already plumbed both sides).

Milestones are ordered so foundational contract/auth fixes land before anything that depends
on them. Each milestone is committed separately and verified before the next starts.

---

## Milestone 1 — Authentication & session persistence
**Goal** A login lasts ~30 days across devices; no spontaneous logout.

**Findings** A-04 (OAuth cookie on wrong origin), A-02 (rotation treated as theft),
A-07 (any second 401 → hard logout).

**Root causes**
- `auth.controller.oauthExchangeCode` never sets the refresh cookie; it was set earlier on the
  *backend* origin during the redirect, so the same-origin proxy never sees it in prod.
- `classifyRefreshRecord` returns `reused` for any rotated token older than 60s → `refresh()`
  calls `revokeAllUserRefreshTokens`. Verified by execution: device B holding a token device A
  rotated 3h ago kills every session.
- `http.ts` retry path calls `onAuthFailure()` on any 401, not just `AUTH_INVALID_TOKEN`.

**Changes**
- BE `auth.controller.ts`: set refresh cookie in `oauthExchangeCode`; clear the stale comment.
- BE `auth.service.ts`: add `rotated_stale` state — `replacedById != null && expiresAt >= now`
  → re-issue without revoke-all. `reused` (revoke-all) now only for logout-revoked/expired replays.
- BE `auth.controller.refresh`: `clearRefreshCookie` on `AUTH_INVALID_REFRESH` so a dead cookie
  can't re-trigger every boot.
- FE `http.ts`: narrow the retry-401 logout to `AUTH_INVALID_TOKEN`.

**Tests** Extend `auth-refresh-grace.test.ts` for the new state matrix (concurrent tab, device-B
3h, 20h sleep, logout replay, expired). New `auth-refresh-side-effects.test.ts` with mocked
`auth.repository`: asserts revoke-all fires ONLY for genuine reuse and never for a rotated token.

**Risk** Weakens theft detection for a stolen token replayed inside its 30-day life (accepted).
Touches the hottest auth path — mitigated by pure-function tests + side-effect assertions.

**Verification** Backend suite; the 5-scenario matrix executed; manual trace of the OAuth cookie
path across both origins.

---

## Milestone 2 — Frontend ↔ backend contract correctness
**Goal** The wire contract matches on both sides for every flow that is currently broken.

**Findings** C-01 (card media 400s), C-02 (premium→free), C-03 (missing endpoint rejection),
C-04 (public deck page empty), C-05 (`isOwner` dropped), C-08 (can't clear a card field).

**Root causes** listed per item in `audit-findings.md`; all verified in source.

**Changes**
- BE `card.schema.ts`: accept absolute URL **or** app-relative `/media/...` for `audioUrl`/`imageUrl`;
  make the optional text fields `.nullable()` so "clear this field" has a wire representation.
- BE `auth.service.ts`: include `plan` in `AuthResult` (reuse existing `entitlement.getPlan`,
  in the existing `Promise.all`) so login/verify/oauth match `/auth/me`.
- FE `api/publicDiscover.ts`: unwrap `{deck, cards}` exactly as `api/decks.ts` already does.
- FE `api/decks.ts`: carry `role`/`isOwner` through instead of discarding them.
- FE `api/cards.ts`: stop stripping `null` on update (keep stripping `undefined`).
- FE `statistics.vue`: guard `loadPerformance` like the sibling `getDeckPerformance` call.
- BE `docs/api-contract.md`: fix invariant #14 and the inverted `isPublic` default.

**Tests** BE: card schema accepts relative media path + rejects junk; `updateCardSchema` accepts
null; a `buildStats` unit test (most-reused pure fn, currently untested). FE: verified by typecheck
+ the mocked-API browser run in M8.

**Risk** `plan` on more responses is additive. Nullable card fields widen validation — narrow,
covered by tests.

**Verification** Backend suite + typecheck; FE typecheck; public deck page rendered against a
mocked API (title/description/author/link non-empty).

---

## Milestone 3 — Study session data integrity
**Goal** A study session records what the user actually studied.

**Findings** L-02 (subset round records whole deck), L-11/C-06 (durationMs/counts never sent),
L-08 (accuracy can exceed 100%).

**Root causes**
- `createSessionSchema` has no `cardIds`; `start()` always stores every card in the deck, and
  `complete()` uses `cardIds.length` as `cardsStudied`. In browse mode that number is rolled
  straight into `DailyActivity` — corrupting the streak/stats data repaired last round.
- FE never sends `counts`/`durationMs`, so `resolveDurationMs` always falls back to wall-clock.
- Results screen divides grades-given by queue-length.

**Changes**
- BE: accept optional `cardIds` on session create, intersected with the deck's real card ids
  (ownership preserved); fall back to the whole deck when absent.
- FE: send `cardIds` from `startSession`/`startWithCards`; send `durationMs` (already measured by
  the existing timer) and `counts` on the existing `updateActive` calls.
- FE: derive `reviewed` from the same population as `correct`.

**Tests** BE `sessions-start-cardids.test.ts` (subset honoured, foreign ids rejected, absent →
whole deck) and a `complete()` test asserting the browse-mode `recordReview` payload and the
SRS-mode double-count guard.

**Risk** Touches session creation — the intersect keeps ownership guarantees. Existing sessions
unaffected (field is optional).

**Verification** Backend suite; a scripted subset-round flow against the mocked API confirming
`cardsStudied` equals the subset, not the deck.

---

## Milestone 4 — Review queue, caching and state races
**Goal** Every due card is reachable; the UI stops showing stale numbers.

**Findings** L-03 (decks 21+ invisible in /review), C-07 (`/srs/progress` lacks `deckId` → N+1),
L-04 (ack sends wrong argument), L-06 (rename zeroes deck stats), L-07 (stats stale after study),
L-05/L-09 (no sequence guards), L-10 (swallowed failure renders deck as unstudied).

**Changes**
- BE: add `deckId` to `PublicCardProgress` (data already joined for `/srs/due`).
- FE `stores/srs.ts`: build the queue from progress+deckId, deleting the 21-request fan-out;
  add a sequence guard; `Promise.allSettled` + a surfaced error instead of `.catch(() => {})`.
- FE `useAchievementNotifications.ts`: send `targets`, not `keys`.
- FE `stores/decks.ts`: don't let an update response clobber `stats`.
- FE: refetch deck summaries after session completion.
- FE `statistics.vue`: sequence token on the range watcher.

**Tests** BE: progress DTO includes `deckId`. FE: verified in M8 with a >20-deck mocked account
(due count from queue must equal the server's `dueCount`).

**Risk** Review-queue construction is core. Behaviour preserved: same cards, fewer requests.

**Verification** Mocked 25-deck account: decks 21-25 appear; request count drops from 21 to 2.

---

## Milestone 5 — i18n and user-facing text
**Goal** No English leaks to Ukrainian users; no hardcoded user-facing strings.

**Findings** B2 (raw backend `e.message` rendered), A1 (8 live hardcoded strings),
C(b) 142 unused keys. Catalogs are otherwise at perfect parity (1221 leaves each).

**Changes**
- FE `useStudySession.ts`: store `e.code` and route through `apiErrorText()` (the pattern
  `usePractice`/`review` already use) instead of raw `e.message`.
- Extract the 8 live strings; reuse the existing-but-unused `common.loading`.
- Remove the 142 unused keys from both catalogs (after the orphan-component deletion in M6, so
  the two sets are computed once, together).
- Optionally extend `.github/scripts/i18n-parity.mjs` to also fail on unused/missing keys.

**Risk** Deleting keys could remove one a dynamic lookup builds — mitigated by the dynamic-prefix
allowlist already identified (9 prefixes + `mimi.*` arrays + the `interestLabels` concat).

**Verification** Parity script; grep for every remaining `t(` key resolving; UK render of the
study-error path shows Ukrainian.

---

## Milestone 6 — Dead code, duplication and config consistency
**Goal** Remove traps for future contributors; one source of truth per rule.

**Changes**
- Delete `useSpacedRepetition.updateCardProgress` + FE `RATING_TO_QUALITY` (0 call sites,
  contradicts the server); keep `isDue`. Note SM-2 lives server-side.
- Delete 4 orphan components (0 importers each): `Legal`, `ActivityHeatmap`, `CardPreview`,
  `MiniCalendar`.
- BE `request-tz.ts`: trim/ignore an empty `X-Timezone` so `?tz=` isn't shadowed (this one
  silently reintroduces UTC bucketing — the bug we just fixed).
- BE `deck-export.service.ts`: escape `\r`.
- BE `stats.service.ts`: don't report a fabricated `+100%` trend for `range='all'`.
- FE `stores/auth.ts`: use the server's `needsProfile` instead of a diverging local computed.
- Retire the stale FE fork of `docs/api-contract.md`; point `CLAUDE.md` at the backend copy.
- `app/utils/grades.ts` interval labels: verify against server behaviour; correct or drop.

**Risk** Deletions are the main risk — each verified by grep; typecheck + build catch the rest.

**Verification** Typecheck, lint, build, full backend suite.

---

## Milestone 7 — Test hardening
**Goal** Regression cover for every fix above, plus the highest-value untested logic.

**Changes** (all DB-free; repository mocks only, matching the existing pattern)
- Regression tests per milestone (listed above).
- Fill the top gaps found: `shared/pagination.ts` (cursor round-trip/corruption — silent data
  loss on page 2+), `plugins/error-handler.ts` (the whole HTTP error contract the FE reads),
  `shared/mappers.deck.buildStats` (most-reused pure fn), `stats.service.overview` (div-by-zero,
  trend deltas), `chat.tools.resolveDefaults` (regression guard for the shipped uk→uk deck bug).
- Repair the weak tests identified: the `evaluate` mock that resolves to `undefined` instead of
  `[]`, and the tautological mastery assertions.

**Risk** None to production code.

**Verification** Full suite green; each new test demonstrated to fail against the pre-fix code
where practical.

---

## Milestone 8 — Final verification
- Backend: `vitest run`, `tsc --noEmit`, `npx eslint .`
- Frontend: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`,
  i18n parity script
- Browser pass against a mocked API at 375px + desktop: login/boot restore, onboarding,
  dashboard, statistics (all ranges), deck detail, study subset round, review with >20 decks,
  public deck page, language switch, theme toggle
- Re-check every contract touched; confirm no UI/visual change
- Write the final report; leave anything unproven as documented observations

## Explicitly NOT doing
- No `/stats/performance` endpoint (new feature).
- No UI redesign, no colour/layout/spacing/animation changes.
- No rewrite of working AI chat, billing, discover or import logic.
- No change to the `hard` = failed SM-2 rule (owner decision, 18 Sep).
- No speculative refactors — unproven items stay in the observations list.
