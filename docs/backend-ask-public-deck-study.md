# Backend ask — let non-owners study shared public decks

## Context / goal

We've shipped a **share** button on the deck page that copies a link to
`/decks/{id}`. We want a recipient (a _different_ signed-in user) to open that link
and **study/practice the deck in place** — without first copying it — while the
owner keeps the full authoring UI.

The frontend is already built and gated by ownership:

- **Owner** (`deck.ownerId === me`): full UI — edit, add/delete cards, delete deck,
  AI append, personal SRS stats.
- **Non-owner, public deck**: read-only card list + **Study / Practice / Share** +
  **Copy to my library**. No editing.

The FE decides ownership client-side from `deck.ownerId` vs the current user id.

**What works today** (no backend change): the read-only view + "Copy to my library".
The FE reads the deck for a non-owner via the existing no-auth `GET /public/decks/:id`
fallback, and copy uses `POST /decks/:id/copy`.

**What's blocked on you**: _studying in place_. The endpoints below are ownership-scoped
(contract invariant #9), so a non-owner's study/rate calls currently `404`. Until these
ship, the FE's Study/Practice buttons for non-owners will fail.

---

## Required changes

### 1. Read a public deck as an authenticated non-owner

`GET /decks/:id` currently returns `404 DECK_NOT_FOUND` for non-owners. Two options:

- **Preferred — extend `GET /decks/:id`**: if the deck is `isPublic = true`, return it to
  any authenticated user (not just the owner), with:
    - a `role: 'owner' | 'viewer'` (or `isOwner: boolean`) field, and
    - `stats` computed for **the requesting viewer** (their SRS), not the owner.

    This gives one consistent authed path that carries the viewer's own progress.

- **Or** leave `GET /decks/:id` owner-only and rely on `GET /public/decks/:id` for the read
  (FE already does). Downside: it's no-auth, so it can't include the viewer's per-user
  stats/SRS — the read-only page just won't show personal progress.

Please tell us which you'll do.

### 2. Start a session on a public deck you don't own

`POST /sessions { deckId }` must succeed when the target deck is `isPublic = true`, even if
`ownerId !== requester`. The session belongs to the requester. (Today it `404`s on the
ownership check.)

### 3. Rate cards / SRS on a public deck you don't own ← the critical one

`POST /srs/rate { cardId, rating }` derives the deck from the card, and the card belongs to
the owner. A non-owner must be able to rate cards in a public deck, with the SRS row keyed by
**(requesterUserId, cardId)**.

> **Two users studying the same shared public deck must have completely independent SRS
> state. A viewer's ratings must never touch the owner's progress.**

### 4. Due / progress include the viewer's rows on public decks

`GET /srs/due` and `GET /srs/progress` should return the requester's own SRS state for cards
in public decks they've studied. If these are already keyed by `userId`, this should follow
automatically once #3 writes viewer-scoped rows.

### 5. Stats reflect the viewer

The `stats` in #1 (mastered / learning / new / due) should be the requester's own progress on
the deck, not the owner's.

---

## Guardrails (please keep)

- **Writes stay owner-only.** `PATCH /decks/:id`, `DELETE /decks/:id`, and all card
  create/update/delete must keep returning `404/403` for non-owners. Only **read + session +
  SRS for the requester** get unlocked.
- **Privacy toggle is the gate.** If a deck is flipped to `isPublic = false`, non-owner
  read/study must immediately stop (`404`). The viewer's previously-created SRS rows can stay
  but become unreachable.
- **No card leakage across users** — see #3.

---

## Two things to confirm

1. **Does `GET /public/decks/:id` return `{ deck: DeckWithAuthor, cards }` in production right
   now?** The FE's read-only fallback depends on it. (Contract says yes; we haven't seen it
   called in prod yet.)
2. **`isPublic` backfill.** The FE now defaults _new_ decks to `isPublic = true`, but decks
   created earlier may still be `isPublic = false` in the DB — their shared links will `404`.
   Do you want to backfill existing user decks to public, or leave them and let owners opt in?

---

## Not changing

- `POST /decks/:id/copy` already works — the FE keeps "Copy to my library" as an alternative
  to study-in-place. No change needed.
