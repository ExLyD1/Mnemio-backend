# Mnemio — Deep Audit Findings (verified)

Baseline at audit start (both repos on `development`, 2 unpushed BE + 3 unpushed FE commits):
- Backend: 240 tests pass, `tsc --noEmit` clean.
- Frontend: `npm run typecheck` (vue-tsc) clean, `npm run lint` clean, `format:check` clean.

Method: 4 parallel read-only subagent audits (contracts, auth, i18n, tests+logic), then
**personal verification of every high-severity claim** against the source, plus one executed
test of the auth classifier. Claims I could not verify are listed as OBSERVATIONS, not bugs.

---

## Verified HIGH severity (fix)

### A-04 — OAuth users lose their session 15 min after signing in (CONFIRMED)
`src/controllers/auth.controller.ts:166` sets the refresh cookie during the **backend-origin**
redirect (the FE navigates to `oauthBase` = backend host in prod, per `nuxt.config.ts:161-168`).
All later refreshes go to the FE origin through the Nuxt `/api/**` proxy, where that cookie does
not exist. `oauthExchangeCode` (line ~176-192) explicitly does NOT set the cookie: comment says
"The cookie was already set at the callback step" — only true when OAuth start was same-origin (dev).
→ Every Google user: access token dies at 15 min, refresh has no cookie, `AUTH_INVALID_REFRESH`, logout.
Fix: `setRefreshCookie(reply, result.refreshToken)` in `oauthExchangeCode` (same-origin via proxy).

### A-02 — A token rotated >60s ago revokes EVERY session on EVERY device (CONFIRMED BY EXECUTION)
`classifyRefreshRecord` (`src/services/auth.service.ts:284-300`) returns `reused` for any rotated
token presented after the 60s grace, and `refresh()` then calls `revokeAllUserRefreshTokens`.
Executed against the real function:
  - lost-response / asleep 20h, replacedById set → `reused`  ← kills all sessions
  - **device B holding a token device A rotated 3h ago → `reused`** ← multi-device logout
  - concurrent tabs 3s → `rotated_grace` (correct)
  - logout-revoked replay → `reused` (correct, keep)
The 60s window only covers simultaneous tabs. A second device, or any client that slept, is
indistinguishable from theft under the current rule.
Fix: a token with `replacedById != null` and `expiresAt >= now` is a **rotation artifact**, not
theft — issue a fresh pair without revoke-all. Keep revoke-all for logout-revoked (`replacedById == null`)
and expired replays. Also `clearRefreshCookie` on the AUTH_INVALID_REFRESH response so a dead
cookie can't re-trigger on every boot.

### L-02 — "Study unknown" inflates daily activity by the whole deck (CONFIRMED)
`createSessionSchema` (`src/schemas/session.schema.ts:6-14`) has no `cardIds`; `sessions.service.start`
always sets `cardIds` = every card in the deck; `complete()` uses `session.cardIds.length` as
`cardsStudied`. FE `startSession` (`app/api/sessions.ts:65-78`) never sends card ids, and
`useStudySession.startWithCards` starts a subset round (e.g. 3 revisit cards).
→ 3 cards studied, 100 recorded. In browse mode (`srsEnabled:false`) `complete()` rolls
`recordReview({reviews: 100})` into DailyActivity → corrupts streaks, weekly goal, /stats/series,
dashboard — the exact data we repaired in the previous QA round.
Also: `start()` drops the FE's shuffled `cardIds`, so `resume()` rebuilds in natural order.

### L-03 — Review queue silently ignores every deck past the first 20 (CONFIRMED)
`app/stores/decks.ts:29` hardcodes `limit: 20`; `app/stores/srs.ts:62-88` builds the due queue only
from loaded deck summaries, dropping progress rows whose deck isn't in the map.
→ 25-deck user: cards in decks 21+ are unreachable in /review, and the header "N due"
(client queue) disagrees with /stats/overview `dueCount` (server-side, all decks) on the same screen.
Secondary: 21 HTTP requests per mount to rebuild a card→deck map the server already has.

### C-01 — Card image/audio attach is broken end to end (CONFIRMED)
`src/schemas/card.schema.ts:19-20` uses `z.string().url()` (absolute URL required), but
`media.service.ts:102` returns a **relative** path (`MEDIA_PUBLIC_BASE` default `/media`).
→ Upload succeeds (file written, orphaned), then card save 400s. Same on PATCH.

### C-02 — Premium users are treated as free until a hard reload (CONFIRMED)
`AuthResult` has no `plan`; only `/auth/me` returns it (`auth.service.ts:454-461`).
FE `AuthTokenResponse` expects `plan` on login/verify/oauth-exchange → `undefined` →
`setSession` default param makes it `'free'`. Premium user hits the paywall gate for the whole
SPA session; Mixpanel records `plan: 'free'`. BE doc invariant #14 claims the opposite (caused this).

### C-03 — `GET /stats/performance` does not exist (CONFIRMED)
No route/controller/service; FE `app/api/stats.ts:36` calls it and `statistics.vue` awaits it
un-caught inside `Promise.all` → unhandled rejection on every Statistics mount and range change.

### C-04 — Public deck SEO page renders empty (CONFIRMED)
BE returns `{deck, cards}` (`public.service.ts:99-102`); FE types it flat and does not unwrap
(`app/api/publicDiscover.ts:37-38`). Consumer reads `deck.title/description/id/author` → all
`undefined`. Empty `<h1>`, empty `<title>`, "Open deck" → `/decks/undefined`. These URLs are in
sitemap.xml. (`cards` resolves by luck, masking it.)

---

## Verified MEDIUM

- **L-04** `useAchievementNotifications.ts:86` — computes `targets` then sends `keys`; when called
  with no args the server acks its own (possibly larger) unseen set while the client filters only
  its own → an unlock gets marked seen without ever being shown. One-word fix.
- **L-06** `app/stores/decks.ts:82-84` — `update()` spreads a `DeckSummary` whose `stats` is always
  `zeroStats` (BE `update` never passes stats) over the loaded deck → renaming a deck instantly
  shows 0% mastered / all-grey bar until refetch.
- **L-07** deck stats never invalidated after a study session → /decks and dashboard keep urging
  review of a deck just cleared (page kept alive on back-nav).
- **L-08** `[mode].vue:97-106` — `reviewed` = queue length but `correct` = grades given; ArrowLeft
  re-grading can produce accuracy >100% and a "perfect" heading. /review computes this correctly.
- **L-09** `statistics.vue:200` `watch(range)` has no sequence token → fast 7d response can
  overwrite 90d data; caption and numbers disagree.
- **L-05** `srs.fetchAll()` has no concurrency guard (contrast `decks.fetchOne`, which has one).
- **L-10** `.catch(() => {})` on `srs.fetchAll()` hides failure; deck renders as fully unstudied.
- **L-11 / C-06** `counts`/`durationMs` plumbing exists on both sides but FE never sends it →
  `resolveDurationMs` always falls back to wall-clock, so study time includes lunch breaks.
- **C-08** card optional fields are `.optional()` not `.nullable()` → no wire representation for
  "clear this field"; FE `clean()` strips nulls so clearing an example silently doesn't persist.
- **C-07** `/srs/progress` omits `deckId` (which `/srs/due` returns) → the N+1 behind L-03.
- **B2 (i18n)** `useStudySession.ts:99/135/167` stores raw backend `e.message` and
  `[mode].vue:229` renders it → verbatim English to Ukrainian users. Only confirmed live leak.

## Verified LOW / cleanup
- **L-01/L-15** FE `RATING_TO_QUALITY` (hard:3, good:4) contradicts BE (hard:2, good:3); both it and
  `updateCardProgress` have **zero call sites** (verified). Dead, divergent, and the most
  authoritative-looking SRS doc in the FE. `app/utils/grades.ts` interval labels (10m/1d/3d/6d)
  also don't match server behaviour on first review.
- **L-16** `request-tz.ts:10` `??` lets an empty `X-Timezone` beat the `tz` query param → UTC bucketing.
- **L-12** CSV export doesn't escape `\r`.
- **L-13** `range='all'` always reports `+100%` trend (previous window is empty by construction).
- **L-14** `needsProfile` differs FE (username only) vs BE (username || fullName).
- **i18n A1** 8 live hardcoded EN strings (Spinner/Modal aria-labels are on every page;
  `common.loading` already exists and is unused).
- **i18n A2** 4 orphan components with hardcoded EN, **0 importers each** (verified) → delete.
- **i18n C(b)** 142 unused catalog keys (11.6%); catalogs are at perfect parity otherwise.
- **C-14** doc drift: invariant #14 false (caused C-02), `isPublic` default documented backwards
  (AI-created decks land private, UI-created public), FE keeps a stale fork of api-contract.md.

## OBSERVATIONS (not established as bugs — do not change blindly)
- `stats.service.decks` retention is `SUM(reps>0)/SUM(reps)` ≈ always 100%; code comment calls it
  a known proxy. Product decision, not a fix.
- `toastedThisSession` module-level; in-app account switch scenario unverified.
- FE/BE `normLang` maps differ in size; no live path proven to produce a mismatch.
- Cleanup job FK `Restrict` on `replacedById` may make deletes throw and silently no-op (swallowed
  by catch). Unverified without a DB.
- A-01/A-03 (subagent "critical" claims about absolute expiry and boot rotation): the sliding
  window works as designed; A-03's "burns a rotation each boot" only applies when localStorage is
  empty. Downgraded — not treated as root causes.
