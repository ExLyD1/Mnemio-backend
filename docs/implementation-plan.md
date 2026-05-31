# Mnemio Frontend — MVP Implementation Plan (v2)

> Revised from v1 after architectural review. v1's scaffolding-first Phase 0A,
> stretch-goal sprawl, and over-engineered ancillaries have been cut. The plan
> is now four vertical phases, each delivering a usable workflow end-to-end.

---

## Context

Mnemio is a vocabulary learning platform. The frontend is **Nuxt 4 + Vue 3 + TypeScript**.
Current state: landing page, multi-step login UI (no real auth), basic UI primitives,
one stub `profile` store. Everything else is greenfield.

The goal is to ship the MVP frontend — auth, decks, study, spaced repetition,
dashboard — using only the existing design system and the libraries already in
`package.json`. **One new dev dependency**: Vitest (decided below).

---

## MVP Cut Line

**Must ship (Phases 1–4):**
- Email/password auth, session persistence, route guard.
- App shell (sidebar, header, user dropdown, logout).
- Deck CRUD + card CRUD.
- Flashcard mode + Multiple Choice mode (one engine, two renderers).
- SM-2 spaced repetition review queue.
- Dashboard (greeting, stats, due count, recent decks, continue-studying CTA).

**Post-MVP (do not plan in detail yet):**
Profile/settings → Written mode → Folders → AI mocks → Explore + clone →
Achievements/leagues → True/False + Matching → virtualization → theme picker → forgot-password.

**Cut from MVP entirely (was in v1, removed):**
- Forgot/reset password flow (no real email backend; not worth the surface area).
- Lazy i18n (English-only at MVP — eager load one file).
- 10% random API failure injection (replaced by an opt-in `?chaos=1` toggle if needed).
- Card-list virtualization (paginate at 50; flag only when a real user reports lag).
- `@vueuse/motion` for flashcard flip (pure CSS `transform` + `backface-visibility`).
- Per-mode results pages (one shared `results.vue`).
- Separate `DeleteDeckDialog` / `DeleteCardDialog` wrappers (one `UiConfirmDialog` with props).
- `ApiResponse<T>` wrapper (APIs return `T` or throw; `useAsync` catches).
- `useFuzzyMatch` (written mode is post-MVP and will use exact-match + self-grade).

**Locked decisions (do not relitigate):**
- **Theme:** dark-only at MVP. `@nuxtjs/color-mode` stays installed but unused until post-MVP.
- **Mock data persistence:** `localStorage`, keyed by `userId` + a `MOCK_SCHEMA_VERSION` constant. On version mismatch, reset and log.
- **Test runner:** Vitest, installed in Phase 1. Tests are written **only for pure logic**: SM-2, Zod schemas, `useStudySession` state machine. No component or integration tests at MVP.
- **XP formula:** `correct * 10 + (completed ? 25 : 0)`. Locked here; documented in `useStudySession`.
- **Concurrent sessions:** starting a new session **ends the current one** with `status: 'incomplete'`, pushed to `sessions.incomplete[]`. Only one `active` session at a time.
- **Forgot password:** out of MVP. `/forgot-password` and `/reset-password` routes do not exist.

---

## Design System Source of Truth

(Unchanged from v1 — reproduced because it's the contract for every component.)

### Colors (Tailwind tokens — do not deviate)
| Token | Hex | Use |
|-------|-----|-----|
| `bg-landing` | #2D1A28 | Landing bg |
| `bg-base` | #111111 | Main app bg |
| `bg-deep` | #202020 | Deeper surfaces |
| `bg-surface` | #272727 | Cards, panels |
| `bg-muted` | #454545 | Subtle elements |
| `brand-dark` | #482A41 | Hover, deep purple |
| `brand` | #572E54 | Primary brand |
| `brand-muted` | #8E7692 | Secondary text, borders |
| `brand-pale` | #CEB2BD | Light text |
| `brand-light` | #E2D2C8 | Lightest brand |
| `accent` | #1C73BB | Links, info |
| `accent-light` | #75B8E2 | Hover accent |
| `accent-pale` | #A9D3E7 | Pale accent |
| `neutral-400` | #9D9D9D | Disabled text |
| `neutral-0` | #FFFFFF | White text/icons |
| `error` | #EB3D3D | Error states |
| `#E84B8A` (inline) | — | Tab active indicator only |

### Typography
- Font: Nunito Sans (400/500/600/700)
- `text-h1` 32px/64px/700 · `text-h2` 24px/32px/700 · `text-h3` 18px/24px/600
- `text-body` 16px/24px/400 · `text-small` 12px/16px/400

### Patterns
- Buttons: `rounded-full px-5 py-2.5 text-body font-semibold`
- Inputs: `rounded-xl border border-brand-muted px-4 pb-3 pt-2 focus-within:border-brand-pale`
- Cards/panels: `rounded-xl` or `rounded-2xl` on `bg-surface` or `bg-deep`
- Transitions: Tailwind `transition-colors`, `transition-opacity`. CSS-only across all MVP phases.

### Layouts — exactly three; every route assigned to one
| Layout | File | Use |
|--------|------|-----|
| `landing` | `layouts/landing.vue` | `/` |
| `auth` | `layouts/auth.vue` | `/login` |
| `app` | `layouts/default.vue` | all authenticated routes |

---

## Accessibility Requirements (non-negotiable across all phases)

- Focus trap inside modals/overlays (`useFocusTrap` from VueUse — already installed).
- Escape-to-close on modals, dropdowns, overlays.
- Keyboard: OTP (arrow keys), flashcard (Space to flip), MC (1–4 to pick).
- Visible focus states: `focus-visible:ring-2 ring-brand-pale`.
- Form fields use real `<label>` elements, never `aria-label` alone.
- Error messages announce via `aria-live="polite"`.
- Icon-only buttons have `aria-label`.

---

## Performance Constraints

- Max cards per deck: **1000** → paginate card list at 50 per page (no virtualization).
- Max decks per user: **200** → paginate deck list at 20 per page.
- Search debounce: **300ms** on all search inputs.

---

## Architecture at a Glance

- **API layer** (`app/api/*.ts`): plain async functions returning `T`; throw on error. Backed by `localStorage` via a small `mockStore` helper.
- **Composables** wrap API calls in `useAsync` → `{ data, error, loading, execute }`. No mock data in pages or components.
- **Stores** (Pinia): five at end of MVP. Derived values (`isAuthenticated`, `currentDeck`, `dueCards`) are **getters**, never state.
- **Middleware**: one global `auth.global.ts` with a public-route allowlist. No per-page `definePageMeta({ middleware })` annotations.
- **Plugins**: `01.auth.ts` hydrates the auth store from localStorage before middleware runs.

---

## Phase 1 — Auth + App Shell

**Goal:** A user can register, log in, see the authenticated shell, log out, and refresh without losing their session.

### Pages
- Refactor `app/pages/login.vue` — vee-validate + Zod schemas, real flow into `auth` store.
- `app/pages/dashboard.vue` — placeholder: greeting + "Create your first deck" CTA. No stats yet (added in Phase 4).
- `app/error.vue` — Nuxt 4 error page with "Go home" button.
- `app/pages/[...slug].vue` — 404 catch-all.

### Core logic
- `app/schemas/auth.ts` — `loginSchema`, `registerSchema`.
- `app/middleware/auth.global.ts` — public allowlist (`/`, `/login`); else redirect to `/login`.
- `app/plugins/01.auth.ts` — hydrate auth store from localStorage on boot.
- `app/composables/useAsync.ts` — uniform `{ data, error, loading, execute }`.
- `app/composables/useAuth.ts` — extend: `logout()`, persist `accessToken` to localStorage.
- `app/services/mockStore.ts` — typed `localStorage` helper with `MOCK_SCHEMA_VERSION` reset.
- `app/services/mock.ts` — `mockUser()` factory only at this phase.
- `app/api/auth.ts` — refactor: `login`, `register`, `logout`. Return `User` or throw `ApiError`.

### Store changes
- **Delete** `app/stores/profile.ts`.
- **Create** `app/stores/auth.ts`:
  - State: `user: User | null`, `accessToken: string | null`.
  - Getters: `isAuthenticated`, `currentUser`.
  - Actions: `login`, `register`, `logout`, `hydrate`.
- **Create** `app/stores/ui.ts` only if sidebar collapse state needs to outlive route changes; otherwise skip.

### Components
- Move `app/components/login/*` → `app/components/auth/*` and integrate `useForm` + `loginSchema` / `registerSchema`.
- Build: `UiModal`, `UiSpinner`, `UiToast` + `useToast`, `UiAvatar`, `UiDropdown`.
- Update `Aside.vue` — full nav (Dashboard, My Decks, Review), active state via `useRoute`, logout entry.
- Update `Header.vue` — authenticated state with avatar + `UiDropdown` (Sign out).

### Tooling
- Install Vitest: `npm i -D vitest @vue/test-utils @pinia/testing`.
- Add `scripts.test`: `vitest run`. Add `scripts.test:watch`: `vitest`.
- `npm run validate` becomes `lint && format:check && test`.

### i18n
- One file `app/i18n/en.json`. Eager load. Add `common.*`, `auth.*`, `nav.*` keys this phase.

### Tests
- `schemas/auth.test.ts` — valid/invalid inputs for `loginSchema`, `registerSchema`.

### Routes
| Path | Layout | Auth |
|------|--------|------|
| `/` | landing | No |
| `/login` | auth | No |
| `/dashboard` | app | Yes |

### Definition of done
- Register → land on dashboard. Logout → redirect `/login`. Refresh on `/dashboard` → still logged in. Unauthenticated `/dashboard` access → redirect `/login`. Mobile renders at 375px. `npm run validate` passes.

---

## Phase 2 — Decks + Cards

**Goal:** A user can create a deck, add cards, edit them inline, and delete with confirmation. Deck list is searchable and paginated.

### Pages
- `pages/decks/index.vue` — grid/list with 300ms debounced search, paginated at 20.
- `pages/decks/create.vue` — `DeckForm`.
- `pages/decks/[id]/index.vue` — `DeckHeader` + paginated card list (50/page).
- `pages/decks/[id]/edit.vue` — same `DeckForm`, pre-filled.

### Core logic
- `app/schemas/deck.ts` — `deckSchema` (title min 2, sourceLanguage, targetLanguage).
- `app/schemas/card.ts` — `cardSchema` (word, definition; phonetic optional).
- `app/api/decks.ts`, `app/api/cards.ts` — localStorage-backed CRUD.
- `app/services/mock.ts` — add `mockDeck`, `mockCard` factories.
- `app/composables/useDecks.ts`, `app/composables/useCards.ts` — wrap stores via `useAsync`.

### Store changes
- **Create** `app/stores/decks.ts`:
  - State: `decks: Deck[]`, `loading`, `error`.
  - Cards live **inside the active deck** as `deck.cards: Card[]` (loaded on detail fetch). No parallel `cards` array.
  - Getters: `currentDeck` (route-derived from `useRoute().params.id`), `byId(id)`.
  - Actions: `fetchAll`, `fetchOne`, `create`, `update`, `delete`, `addCard`, `updateCard`, `deleteCard`.

### Components
- Build: `UiBadge`, `UiSelect`, `UiConfirmDialog`, `UiToggle`, `UiEmptyState`.
- Build: `DeckCard`, `DeckGrid`, `DeckHeader`, `DeckForm`, `CardList`, `CardListItem`, `CardForm`.
- Reuse `UiConfirmDialog` everywhere — pass `title` / `message` / `confirmLabel` props; no specialized wrappers.

### i18n
- Add `deck.*`, `card.*` keys.

### Tests
- `schemas/deck.test.ts`, `schemas/card.test.ts` — required fields, min lengths.

### Routes
| Path | Layout | Auth |
|------|--------|------|
| `/decks` | app | Yes |
| `/decks/create` | app | Yes |
| `/decks/:id` | app | Yes |
| `/decks/:id/edit` | app | Yes |

### Definition of done
- Create deck → appears in list. Add 10 cards → card count updates. Edit card inline → persists across refresh. Delete deck → confirmation modal → list updates. Loading / empty / error states present everywhere. Search debounce visibly working.

---

## Phase 3 — Study Engine (Flashcard + Multiple Choice + Results)

**Goal:** One session engine drives both modes. Results screen shows accuracy, XP, and a "Study again" CTA.

### Pages
- `pages/study/[deckId]/index.vue` — mode picker (StudyModeCard per mode).
- `pages/study/[deckId]/[mode].vue` — **single dynamic page**; mounts `FlashCard` or `MultipleChoiceCard` based on `mode` param. Cuts duplication.
- `pages/study/[deckId]/results.vue` — shared results (XP, accuracy %, breakdown).

### Core logic
- `app/composables/useStudySession.ts` — pure state machine:
  ```
  idle → loading → active → results
              ↘ paused (route leave / "Exit" click)
  ```
  - Tracks `cardIndex`, `correct`, `elapsed` (via `useIntervalFn`).
  - XP: `correct * 10 + (completed ? 25 : 0)`.
  - On route leave or "Exit": writes `ActiveSession` with `status: 'incomplete'` to `sessions.incomplete[]` and clears `sessions.active`.
  - Starting a new session ends the current one the same way (locked rule).
- `app/api/sessions.ts` — create/list sessions (localStorage-backed).
- Flashcard flip: pure CSS — `transform: rotateY(180deg)` on `.flipped`, `backface-visibility: hidden` on faces. No `@vueuse/motion`.

### Store changes
- **Create** `app/stores/sessions.ts`:
  - State: `active: ActiveSession | null`, `incomplete: ActiveSession[]`.
  - Getters: `latestIncomplete`.
  - Actions: `start`, `pause`, `resume`, `end`.
- (No changes to other stores this phase.)

### Components
- Build: `StudyModeCard`, `StudyProgress` (top bar: card X of N, elapsed, Exit), `FlashCard`, `FlashCardActions` (Known / Unknown), `MultipleChoiceCard` (question + 4 options + correct/incorrect feedback), `ResultsSummary`.

### i18n
- Add `study.*` keys.

### Tests
- `composables/useStudySession.test.ts` — state transitions, XP formula, "new session ends old one" behavior.
- `composables/multipleChoice.test.ts` (or inline) — correct answer always present in options, distractors are wrong.

### Routes
| Path | Layout | Auth |
|------|--------|------|
| `/study/:deckId` | app | Yes |
| `/study/:deckId/flashcard` | app | Yes |
| `/study/:deckId/multiple-choice` | app | Yes |
| `/study/:deckId/results` | app | Yes |

### Definition of done
- Start session from deck → flip through all cards → results show with correct XP. Exit mid-session → dashboard CTA (added next phase) will resume. Empty deck disables the study entry button. Starting a second session correctly marks the first as `incomplete`.

---

## Phase 4 — Spaced Repetition + Dashboard Stats

**Goal:** SM-2 review loop works end-to-end. Dashboard surfaces real numbers.

### Pages
- `pages/review/index.vue` — due count + "Start Review" CTA + next review date.
- Review session reuses `pages/study/[deckId]/[mode].vue` with `mode = 'srs'` rendering `ReviewCard` (Again / Hard / Good / Easy).
- Upgrade `pages/dashboard.vue` — real `StatsGrid`, `RecentDecks`, `ReviewCount`, `ContinueStudying` (visible only if `sessions.latestIncomplete`).

### Core logic
- `app/composables/useSpacedRepetition.ts` — **pure**, side-effect-free:
  ```ts
  updateCard(progress: CardProgress, quality: 0|1|2|3|4|5): CardProgress
  ```
  Returns updated `interval`, `easeFactor` (min 1.3), `repetitions`, `nextReviewAt`. No store access.
- `app/api/srs.ts` (or fold into `cards.ts`) — persist `CardProgress` records.

### Store changes
- **Create** `app/stores/srs.ts`:
  - State: `progress: Record<cardId, CardProgress>`.
  - Getters: `dueCards`, `dueCount` (filter by `nextReviewAt <= now`).
  - Actions: `rate(cardId, quality)` → calls `useSpacedRepetition.updateCard`, writes back.

### Components
- Build: `ReviewQueue`, `ReviewCard`.
- Build: `WelcomeGreeting`, `StatsGrid`, `RecentDecks`, `ContinueStudying`, `ReviewCount`.

### i18n
- Add `review.*`, `dashboard.*` keys.

### Tests
- `composables/useSpacedRepetition.test.ts` — quality 0 resets interval to 1; quality 5 extends correctly; easeFactor never below 1.3; `nextReviewAt` math is correct.

### Routes
| Path | Layout | Auth |
|------|--------|------|
| `/review` | app | Yes |

### Definition of done
- Rate card "Again" → reappears in queue. Rate "Easy" → `nextReviewAt` advances. Dashboard due count matches review page. Empty queue → "All caught up!" with next review date. **End-to-end smoke test passes:** register → create deck → add 5 cards → flashcard session → results → review queue → rate 3 cards → queue updates → log out → log in → state intact.

---

## Pinia Store Architecture (end of MVP — 5 stores)

| Store | State | Getters | Actions |
|-------|-------|---------|---------|
| `auth` | `user`, `accessToken` | `isAuthenticated`, `currentUser` | `login`, `register`, `logout`, `hydrate` |
| `decks` | `decks: Deck[]` (with nested `cards`), `loading`, `error` | `currentDeck` (route-derived), `byId(id)` | `fetchAll`, `fetchOne`, `create`, `update`, `delete`, `addCard`, `updateCard`, `deleteCard` |
| `sessions` | `active`, `incomplete: ActiveSession[]` | `latestIncomplete` | `start`, `pause`, `resume`, `end` |
| `srs` | `progress: Record<cardId, CardProgress>` | `dueCards`, `dueCount` | `rate` |
| `ui` | `sidebarOpen` | — | `toggleSidebar` |

Post-MVP additions (`folders`, `achievements`, `profile` settings) are created only when their pages are built.

---

## Data Model

```ts
User           { id, email, displayName, createdAt }
Deck           { id, ownerId, title, description, sourceLanguage,
                 targetLanguage, isPublic, cards: Card[], updatedAt }
Card           { id, deckId, word, definition, phonetic? }
CardProgress   { cardId, easeFactor, interval, repetitions,
                 nextReviewAt, lastReviewedAt }
ActiveSession  { id, deckId, mode, cardIds, index, correct,
                 startedAt, status: 'active' | 'incomplete' | 'complete' }
ApiError       { code: string, message: string }
```

No `ApiResponse<T>` wrapper. APIs return `T` or throw `ApiError`. `useAsync` catches and exposes `{ data, error, loading }`.

---

## Component Inventory (MVP)

| Component | Phase | Notes |
|-----------|-------|-------|
| `UiButton` | exists | — |
| `UiInputField` | exists | — |
| `UiInputOtp` | exists | — |
| `UiInputSearch` | exists | — |
| `UiTabs` | exists | — |
| `UiCheckButton` | exists | — |
| `UiModal` | 1 | focus trap, Esc to close |
| `UiSpinner` | 1 | — |
| `UiToast` + `useToast` | 1 | 4s auto-dismiss |
| `UiAvatar` | 1 | initials fallback |
| `UiDropdown` | 1 | Esc to close, focus trap |
| `UiBadge` | 2 | — |
| `UiSelect` | 2 | language picker |
| `UiConfirmDialog` | 2 | reused everywhere |
| `UiToggle` | 2 | — |
| `UiEmptyState` | 2 | icon + message + CTA |
| `DeckCard`, `DeckGrid`, `DeckHeader`, `DeckForm`, `CardList`, `CardListItem`, `CardForm` | 2 | — |
| `StudyModeCard`, `StudyProgress`, `FlashCard`, `FlashCardActions`, `MultipleChoiceCard`, `ResultsSummary` | 3 | — |
| `ReviewQueue`, `ReviewCard`, `WelcomeGreeting`, `StatsGrid`, `RecentDecks`, `ContinueStudying`, `ReviewCount` | 4 | — |

`UiProgressBar` is **not** built at MVP (no XP bar in shell until post-MVP gamification).

---

## Mock Data Strategy

- All API stubs in `app/api/*.ts` return `T` or throw `ApiError`.
- All factories in `app/services/mock.ts`.
- `app/services/mockStore.ts` — typed localStorage helper:
  - Keys: `mnemio:v{MOCK_SCHEMA_VERSION}:{userId}:{resource}`.
  - On schema mismatch → reset and `console.warn`.
- When the real backend connects: only `app/api/*.ts` files change; stores and composables unchanged.
- Chaos mode (optional, opt-in): if `localStorage.getItem('mnemio_chaos') === '1'`, API functions throw with 10% probability. Default off.

---

## Complete Route Map (MVP)

| Path | Layout | Auth | Phase |
|------|--------|------|-------|
| `/` | landing | No | (exists) |
| `/login` | auth | No | 1 |
| `/dashboard` | app | Yes | 1 (stub) → 4 (real) |
| `/decks` | app | Yes | 2 |
| `/decks/create` | app | Yes | 2 |
| `/decks/:id` | app | Yes | 2 |
| `/decks/:id/edit` | app | Yes | 2 |
| `/study/:deckId` | app | Yes | 3 |
| `/study/:deckId/:mode` | app | Yes | 3 |
| `/study/:deckId/results` | app | Yes | 3 |
| `/review` | app | Yes | 4 |

Post-MVP routes (`/profile`, `/settings`, `/folders`, `/ai/*`, `/achievements`, `/leagues`, `/explore`, written/true-false/matching study modes, `/forgot-password`, `/reset-password`) are added when their phases are scoped.

---

## Verification (per phase)

1. `npm run dev` — no TypeScript errors, no console errors.
2. Navigate every new route manually.
3. Walk the "Definition of done" checklist for that phase.
4. Check 375px and 768px viewports.
5. `npm run validate` — lint + format + test all pass.

**End-to-end smoke test (after Phase 4):**
Register → log in → create deck → add 5 cards → start flashcard session → complete →
results show XP → go to `/review` → rate 3 cards → queue updates →
log out → log in → all state intact.
