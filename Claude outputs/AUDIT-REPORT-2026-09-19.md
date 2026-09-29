# Mnemio — Full Project Audit & Refactor: Final Report
**19 Sep 2026 · branch `fix/audit-2026-09` (both repos, 13 commits)**

Baseline: BE 240 tests / FE clean. Now: **BE 322 tests**, both repos typecheck,
lint, format and build clean; i18n parity holds at 1224 leaves.

---

## The logout bug — two root causes, both verified

**A-04 — every Google user lost their session 15 minutes after signing in.**
The refresh cookie was set during the OAuth callback, which runs on the
*backend* origin. Every later `/auth/refresh` goes to the *frontend* origin
through the Nuxt `/api` proxy, where that cookie does not exist. The exchange
step explicitly discarded it ("the cookie was already set at the callback step"
— true only in dev, where both origins are the same). So: access token expires
at 15 min → refresh has no cookie → `AUTH_INVALID_REFRESH` → logout.
Now set in `oauthExchangeCode`, the only same-origin step.

**A-02 — one rotated token revoked every session on every device.**
Not inferred — proven by executing the real classifier:

| scenario | before | after |
|---|---|---|
| two tabs, 3 s apart | `rotated_grace` ✅ | `rotated_grace` ✅ |
| phone holding a token the laptop rotated 3 h ago | `reused` → **revoke-all** | `rotated_stale` ✅ |
| laptop asleep 20 h | `reused` → **revoke-all** | `rotated_stale` ✅ |
| genuine logout replay | `reused` ✅ | `reused` ✅ |
| replay past expiry | `reused` ✅ | `reused` ✅ |

The 60-second grace only ever covered simultaneous tabs. A rotated token still
inside its 30-day life is now treated as a rotation artifact and re-issued
(audited), per your decision. Revoke-all is kept for the two cases that really
are replays.

**Accepted trade-off:** a stolen refresh token replayed inside its lifetime is
no longer detected. That is the cost of the re-issue policy you chose.

Also: `/auth/refresh` now clears a cookie it rejects, and the client only logs
out on a 401 that names the token — it used to do so on *any* 401 from a
retried request, wiping a session it had just refreshed.

---

## Verified at runtime, not just in tests

**Public deck SEO pages (C-04).** Built both versions and rendered the same
page against the same stub backend:

| | pre-fix | post-fix |
|---|---|---|
| `<title>` | `" — flashcards & study set · Mnemio"` | `"Deutsch B1 Wortschatz — …"` |
| links to `/decks/undefined` | 1 | 0 |
| title / description / author / cards | absent | all present |

The backend returns `{deck, cards}`; the client typed it flat and never
unwrapped it. `cards` resolved by coincidence, which masked it. These URLs are
in your sitemap.

---

## Also fixed

- **C-01 — card image/audio attach was broken end to end.** The schema demanded
  an absolute URL; the media service returns the app-relative `/media/...`.
  Upload wrote the file, then the save 400'd and orphaned it.
- **L-02 — a 3-card round recorded the whole deck as studied.** In browse mode
  that went straight into `DailyActivity`, corrupting the streak and stats data
  repaired last round. Sessions now carry their real card list (intersected
  server-side, so a client can't widen a session).
- **L-03 — decks 21+ were unreachable in /review.** The queue was built from
  the paginated deck list while the header's count came from the server, so the
  two disagreed on screen. Also removed a 21-request fan-out.
- **C-02 — premium users were treated as free** for the whole SPA session, and
  recorded as free in Mixpanel. `plan` now rides on every auth response,
  including refresh.
- **C-03 — Statistics threw an unhandled rejection on every mount** calling an
  endpoint that doesn't exist. Degrades into the empty state that already
  existed. No new endpoint, per your decision.
- **L-16 — an empty `X-Timezone` header silently reverted to UTC bucketing**,
  quietly undoing the local-day work.
- Plus: >100% accuracy on results, the achievements ack sending the wrong
  argument, deck rename showing 0% mastered, stats races, CSV `\r`, a
  fabricated `+100%` trend, and `needsProfile` disagreeing with the server.

---

## Things I did NOT change

- **`deltaPct` for range 'all'** now returns `null` instead of a fake `+100%`.
  Nothing renders it yet, so this only changes what the API claims.
- **Grade interval labels ("10m / 1d / 3d / 6d")** were removed, not corrected.
  I ran the server's SM-2: on a first review *every* grade schedules 1 day, and
  after that it depends on the card's own history. Three of four labels were
  false and no fixed label can be right. This is a visible change, made because
  the text was factually wrong.
- **The ~165 unused i18n keys were left in place.** `mimi.*` alone is 25 of
  them and is read straight off the catalog object at runtime, so grep cannot
  see it — deleting them would have silenced the mascot. The rest are spread
  thinly across live namespaces. This needs a reference-aware tool, not a text
  search.
- **L-07 ("deck stats stale after a session") is not a bug.** No page uses
  keepalive, so all three surfaces refetch on mount. Checked rather than
  assumed.
- **A-01 / A-03**, which a subagent called "critical", did not survive
  verification. The sliding window works as designed. Not treated as causes.
- No UI redesign, no new features, no rewrite of working AI chat, billing,
  discover or import logic, no change to `hard` = failed.

---

## Still open (unchanged from before)

- **Nothing is pushed.** `git push` has no credentials from here. The branch is
  in both of your repos as `fix/audit-2026-09`, plus the earlier `development`
  commits still waiting to go out.
- Worth checking on Railway: `JWT_REFRESH_TTL_DAYS` is not set below 30 — the
  auth fixes assume the intended 30-day window.
- Unverified without a database: a cleanup-job FK (`Restrict` on
  `replacedById`) may make deletes throw into a swallowing catch.

---

## To ship

```bash
cd ~/Data/work-projects/mnemio-backend
git checkout fix/audit-2026-09 && npm test        # 322 passing
git checkout development && git merge fix/audit-2026-09
git push origin development

cd ~/Data/work-projects/mnemio-frontend
git checkout fix/audit-2026-09
npm run typecheck && npm run lint && npm run build
git checkout development && git merge fix/audit-2026-09
git push origin development
```

Review Milestone 1 (auth) and Milestone 3 (session creation) most closely —
they touch the hottest paths. Both have tests that fail against the old code.
