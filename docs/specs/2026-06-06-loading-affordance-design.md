# Loading affordance: high-fidelity skeletons + global top progress bar

- **Status:** Design — awaiting human review
- **Issues:** #181 (PR-detail: no clear loading affordance on open), #147 (PrHeader empty title/author on cold-load — folded in), #244 (inbox cold-load shows a generic spinner — sibling, PR2)
- **Worktree / branch:** `feature/181-loading-affordance`
- **Date:** 2026-06-06

## 1. Problem

Two surfaces give weak, "is-it-stuck?" feedback while their first data fetch is in flight:

- **PR-detail (#181 / #147).** Clicking an inbox row navigates to `/pr/...`. `PrTabHost` mounts `PrDetailView` synchronously (no `lazy`/`Suspense`), so `usePrDetail` runs immediately with `isLoading = true` and `data === null`. During that window:
  - `PrHeader` renders with `title=''`, `author=''`, and undefined branch/CI/mergeability props → an **empty header shell** (this is #147 verbatim).
  - The body gate is `!data && showSkeleton ? <PrDetailSkeleton/> : data ? <tabs/> : null`. `showSkeleton` comes from `useDelayedLoading(isLoading)`, which has a **100 ms `WAIT_MS` anti-flash delay**. So for the first 100 ms `showSkeleton` is `false` and `data` is `null` → the body renders `null`. Net: empty header + nothing below = reads as frozen. After 100 ms a faint three-grey-bar skeleton appears beneath the still-empty header.
- **Inbox (sibling issue).** `InboxPage` renders a single centered `<Spinner size="lg" />` on cold load (`isLoading && !data`). A spinner on a blank page gives no sense of what is arriving.

The root cause for PR-detail is that `useDelayedLoading` conflates two cases that want opposite behavior:

- **Cold open** (`data === null`): there is nothing on screen to "flash," so the anti-flash delay only buys an empty shell. The skeleton should appear immediately.
- **Background reload** (`data` present, e.g. re-activation freshness or the Reload button): content is already on screen; the delay correctly avoids flashing a skeleton over good data, and the `!data` gate correctly keeps content mounted (this is the #180 fix — do not regress it).

## 2. Goals / Non-goals

**Goals**
- Cold opens of PR-detail and Inbox show an **immediate, content-shaped** loading state that mirrors the real screen closely enough to read as polished, not generic.
- A **global top progress bar** gives a single, app-level "something is happening" signal across navigations and background reloads.
- Fix #181 and #147; set up the inbox skeleton as a sibling.

**Non-goals**
- No change to fetch logic, caching, SSE, or keep-alive semantics. This is presentation only.
- No real determinate progress percentage (we have no byte/step signal) — the top bar is indeterminate.
- No skeletons for the Files or Drafts sub-tabs in this effort (cold open always lands on Overview; those tabs already have their own load UX). Out of scope, not a regression.

## 3. Real-state grounding

Skeletons are specified against **actual screenshots of the running app** (real PAT, `prpande/Pensieve#3` and the live inbox), not code inference. Reference captures taken 2026-06-06:

- `real-inbox-loaded.png` — paste-URL bar; sections (caret + label + count) with rows; Activity/Watching rail on the right (AI-ranking gate on).
- `real-prdetail-overview-loaded.png` — breadcrumb `owner/repo · #n`; title; subtitle (avatar + author + branch + chips); action buttons; tab strip + collapse chevron; Overview body = AI **Summary** card → markdown description → 4 **StatsTiles** (Files/Drafts/Threads/Viewed) → conversation → **Review files** CTA.

These are reproduced at the B1 visual-proof gate (before/after) on each PR.

## 4. Design

### 4.1 Shared `<Skeleton>` primitive — `frontend/src/components/Skeleton/`

A single shimmer primitive both surfaces compose. It **replaces** the existing ad-hoc `PrDetailSkeleton` markup — which today emits bare `.pr-detail-skeleton` / `.skeleton-row` divs that have **no CSS rule anywhere** in the frontend tree (they render unstyled; the only real skeleton animation, `skeleton-pulse`, is a scoped CSS-module class inside `FilesTab.module.css`). The same unstyled `.skeleton-row` class is also used by `DraftsTabSkeleton`; migrating that is **out of scope** here (left as-is — its latent unstyled-block bug is a separate follow-up, see §8 Deferred).

```
<Skeleton width? height? radius? circle? className? />     // one shimmer block
<SkeletonText lines={n} widths?={string[]} />              // n stacked line blocks
```

- Shimmer via a CSS `::after` sweep on a token-driven base (`--surface-2`/`--surface-3`), so light/dark both work.
- `aria-hidden` on individual blocks; the **container** carries `aria-busy="true"` and a polite live region label (see §4.7).
- Respects `prefers-reduced-motion`: no sweep animation, static block instead.

### 4.2 Cold-load timing fix — `frontend/src/components/PrDetail/PrDetailView.tsx`

**Do not touch `useDelayedLoading`.** The minimal correct fix lives entirely in `PrDetailView`'s body gate. Today the gate is `!data && showSkeleton`, where `showSkeleton = useDelayedLoading(isLoading)` carries the 100 ms `WAIT_MS`. Because the `!data` half of the gate already flips to `false` the instant `data` arrives, the `HOLD_MS` minimum can never actually hold the skeleton over present data — so the delayed-loading machinery contributes nothing here except the harmful 100 ms `WAIT` on cold open. Replace the gate with:

```
{!data && isLoading ? <PrDetailSkeleton/> : data ? <tabs/> : null}
```

- **Cold open** (`data === null`, `isLoading === true`): skeleton at t=0, replaced by content the moment `data` resolves. No `WAIT`, no empty-shell window.
- **Background reload** (`data` present): `!data` is false → content stays mounted, no skeleton (#180 non-regression preserved — unchanged from today).
- **Error** (`isLoading === false`, `data === null`): gate yields `null` body; the `ErrorModal` (already rendered on `error`) takes over.

`PrDetailView` destructures `isLoading` from `usePrDetail` (already on `UsePrDetailResult`; currently only `data`/`showSkeleton`/`error`/`reload` are pulled out). `showSkeleton` is no longer consumed by this view — and `PrDetailView` was its **only** consumer, so `usePrDetail` itself is edited to stop computing/returning it (drop `showSkeleton` from `UsePrDetailResult` and the `useDelayedLoading(isLoading)` call at `usePrDetail.ts:92`). Otherwise `usePrDetail` would keep running delayed-loading machinery on every render with zero consumers — dead complexity the keyed-boolean simplification is meant to avoid.

**Accepted tradeoff:** dropping `WAIT` means an ultra-fast (<~100 ms) cold load shows the skeleton briefly before content. This is fine — the transition is skeleton→content (never skeleton→**empty**, which was the bug), and real cold opens against GitHub are multi-hundred-ms (per #181). No anti-flash delay is warranted on the cold path.

> `useDelayedLoading` itself keeps its current single-arg signature. It has **three** production callers today — `useFileDiff.ts`, `useUnionDiff.ts`, and `usePrDetail.ts:92`. This change removes only `usePrDetail`'s now-orphaned call; `useFileDiff`/`useUnionDiff` are untouched (both call `useDelayedLoading(isLoading)` with no opts). Removing `showSkeleton` from `UsePrDetailResult` is a typed change — update every `usePrDetail` mock that includes it (see §7).

### 4.3 PR-detail skeleton — `frontend/src/components/PrDetail/`

Render a skeleton that is the **same DOM shape** as the loaded view. Two parts:

**Header (fixes #147).** While the PR-detail is loading (`!data && isLoading` — the *same* predicate as the body gate, see below), `PrHeader` shows:

| Element | Loaded | Cold-load skeleton |
|---|---|---|
| Breadcrumb `owner/repo · #n` | real | **real** (from `prRef`) |
| Title (h1) | real | `<Skeleton>` bar ~60% width, h1 height |
| Subtitle author | avatar + login | circle `<Skeleton>` (avatar) + ~120px bar |
| Subtitle branch/CI/mergeability chips | chips | two chip-shaped `<Skeleton>`s |
| Tab strip (Overview/Files/Drafts) | real | **real** static chrome |
| Collapse toggle | real | **real** |
| Action buttons (Verdict/Submit/Ask AI/Open-in-GitHub) | real | **kept real** — already safe on cold load: `VerdictPicker`/`SubmitButton` are `disabled={!session}` (session is null until the draft session loads), `AskAiButton` only toggles a drawer (no PR data), `OpenInGitHubButton` renders nothing without `htmlUrl`. So no data-dependent action can fire against null data. |

Implementation: `PrHeader` already receives `title`/`author`/etc. as props that are empty on cold load. Add a `loading?: boolean` prop **derived by `PrDetailView` as `!data && isLoading`** — the identical predicate to the body gate. This matters on the **error** path (`data === null`, `isLoading === false`): deriving header `loading` from `data === null` alone would leave the header shimmering behind the `ErrorModal` (and briefly after the user dismisses it, before `navigate('/')` lands) — a header skeleton with no body. Sharing the body's `!data && isLoading` predicate clears the header skeleton exactly when the body stops showing one. The prop swaps the title/author/chip slots for `<Skeleton>`s; no structural divergence — same elements, same grid. **Existing `PrHeader` tests** run with `loading` omitted/false and must stay green; any test asserting on the `h1` title or author element presence is reviewed for selector assumptions that the `loading=true` swap would break (see §7).

**Body (Overview shape).** Replace the three-grey-bar `PrDetailSkeleton` with one that mirrors `OverviewTab`:

| Overview element | Skeleton |
|---|---|
| AI **Summary** card | rounded card `<Skeleton>` block (~3 text lines) |
| `PrDescription` (markdown) | `<SkeletonText lines={6}>` with varied widths |
| `StatsTiles` (4 tiles) | row of 4 tile-shaped `<Skeleton>`s |
| `PrRootConversation` | one avatar-circle + 2 text lines |
| `ReviewFilesCta` | button-shaped `<Skeleton>` |

**Selector continuity (#180 guard):** the new body skeleton's root keeps `data-testid="pr-detail-skeleton"`, and `PrDetailView.freshness.test.tsx` (which today asserts `document.querySelector('.pr-detail-skeleton')` is null on background reload) is updated to query that `data-testid`. Without this, renaming the skeleton would make the #180 regression test pass *vacuously* — it would find null because the element no longer exists under the old selector, even if a skeleton were wrongly showing.

### 4.4 Inbox skeleton — `frontend/src/components/Inbox/InboxSkeleton.tsx`

Replaces the centered spinner branch in `InboxPage` (`isLoading && !data`). Mirrors the real inbox:

| Inbox element | Skeleton |
|---|---|
| Paste-URL toolbar (`InboxToolbar` → `PasteUrlInput`) | full-width input-shaped `<Skeleton>` |
| Section header (caret + label + count) | small caret block + ~140px label bar + count pill, ×2–3 sections |
| `InboxRow` (×2–4 per section) | status-dot slot + title bar + meta line (avatar circle + author bar + iter + age) + right tail (diff-bar block + `+/−` count blocks) |
| Activity rail (`ActivityRail`) | rail-width column of placeholder cards — shown when a **`showRail?: boolean` prop** is true |

`InboxSkeleton` stays presentational: it takes `showRail` as a prop, and `InboxPage` passes `showRail={showActivityRail}` (the page already computes `useAiGate('inboxRanking')` at line 21). The skeleton itself imports no feature-flag hook, so it renders in isolation and its unit test asserts on the prop, not a mocked gate. `useAiGate` is a synchronous boolean derived from the (already-loaded) preferences/capabilities context, so `showRail` holds the **same value** at skeleton-mount and at content-mount — no rail-appears-on-resolve horizontal shift.

Static counts (how many section/row placeholders) are fixed constants — a plausible-looking shape, not data-driven. **On resolution** the skeleton is replaced wholesale by the real sections, or by `EmptyAllSections` when the inbox has no PRs; a one-time layout shift as fixed placeholders give way to real content is accepted (this is a local PoC, not a CLS-budgeted public page).

### 4.5 Global top progress bar (the "Y" decision)

**Component** — `frontend/src/components/TopProgressBar/TopProgressBar.tsx`, mounted once at the app root (in `App.tsx`, above `<Routes>`). Fixed to the viewport top, full width, ~3px, high `z-index` (below modal/toast layers, above page content). **Accent color** uses the existing accent token (the same one `PrTabStrip` uses for the active-tab border — verified at plan time; no new token), so light/dark are both covered by the established surface ladder. Indeterminate sliding animation while active; on the active→idle transition it sweeps to 100% then fades out (~200 ms). This bar finish is **independent** of the skeleton lifecycle — the bar may still be fading while content is already on screen, which is the normal NProgress-style idiom, not a coordination bug. Honors `prefers-reduced-motion`: while active the bar sits at a fixed ~80% fill (no slide); on idle it **disappears directly from that fill** — no jump-to-100%, no fade, a single instant hide. This applies to both the success and the error completion paths. `aria-hidden` (the per-surface skeletons/spinners carry the AT-facing busy state; a global indeterminate bar would be screen-reader noise).

**Store** — `frontend/src/contexts/LoadingBarContext.tsx`: a **keyed-boolean** signal map (not a ref-counted counter). The bar is `active` when **any** key is `true`. A boolean-per-source map is simpler than a counter and StrictMode-safe by construction.

```ts
interface LoadingBarStore {
  setLoading(key: string, active: boolean): void;
  active: boolean;   // true when ANY key is true
}
useTopProgress(key: string, active: boolean): void   // sets key on every `active` change; clears key on unmount
```

- `useTopProgress` runs an effect keyed on `[key, active]` that calls `setLoading(key, active)` on **every change of `active`** (not only in cleanup), and `setLoading(key, false)` in its effect cleanup. The on-change path — not unmount — is the load-bearing clear mechanism under keep-alive (see PR-detail feeder below).
- **StrictMode-safe:** the setup→cleanup→setup double-invoke runs `set(key,true)`→`set(key,false)`→`set(key,true)`, netting to `true` — no drift, because it's an idempotent boolean assignment, not a counter. A stuck-`true` would require a key whose feeder neither re-renders with `active=false` nor unmounts; React guarantees the re-render on a prop/state change and the cleanup on unmount, so no watchdog timer is needed.

**Feeders:**
- Inbox: `useTopProgress('inbox', isLoading)` in `InboxPage` (covers cold load **and** background reload — the bar is the non-intrusive signal during a reload where no skeleton shows; it also animates during `useInbox`'s 503 retry-backoff cold-start window, which is accepted — a moving bar during backend warmup reads as "working," see §8).
- PR-detail: `useTopProgress('pr-detail:' + prRefKey, active && isLoading)` in `PrDetailView` — a **per-instance key** (not a single shared `'pr-detail'`). Under keep-alive, `PrTabHost` keeps every open PR view **mounted** and toggles the `active` prop; switching tabs does **not** unmount the outgoing view, so the clear comes from that view re-rendering with `active=false` (its effect re-runs `setLoading(key, false)`), never from unmount. A single shared key would conflate two mounted views' loading into one boolean and make correctness depend on the commit-order of the deactivating view's `set(false)` vs the activating view's `set(true)`. Per-instance keys make that ordering irrelevant: each view owns its own key, the store ORs across them, so an inactive-but-still-loading view and the newly-active view never stomp each other.

### 4.6 Loading-state matrix

| State | Skeleton | Top bar |
|---|---|---|
| Cold open (`data === null`, `isLoading`) | yes — instant, content-shaped | yes |
| Background reload (`data` present) | no (content stays mounted, #180) | yes (subtle) |
| Switch to already-loaded tab (no fetch) | no | no |
| Error on cold load (`data === null`, `isLoading` false, `error` set) | no — header **and** body skeleton both clear (`!data && isLoading` is false); `ErrorModal` shown | yes, then completes (feeder flips false → sweep-to-100% + fade, same as success) |
| Error on background reload (`data` present) | no (content stays) | completes as above; `ErrorModal` over content |

Header and body share the `!data && isLoading` predicate, so on error both stop showing skeletons in the same render. `usePrDetail` sets `error` and `isLoading=false` in the **same synchronous `.catch` callback** (`usePrDetail.ts:81-85`), so React batches them into one flush — there is no intermediate frame where the body is `null`, no skeleton, and no `ErrorModal`.

**Skeleton→content transition:** an **instant replace**, not an animated cross-fade — the standard, expected behavior for content-shaped skeletons. Placeholder dimensions approximate the real elements (h1-height title bar, 4-tile stats row, etc.) to minimize layout shift, but a small residual shift on swap is accepted (PoC, not CLS-budgeted). The top bar's completion animation runs independently and may overlap the content render (§4.5).

### 4.7 Accessibility

- Skeleton containers: `aria-busy="true"` + a visually-hidden polite label ("Loading PR…" / "Loading inbox…"). Individual shimmer blocks `aria-hidden`.
- The loaded view replacing the skeleton ends the busy state, which announces normally.
- Top bar is decorative (`aria-hidden`) to avoid double-announcing alongside the skeleton's busy region.
- `prefers-reduced-motion` removes the shimmer sweep and the bar's slide.

## 5. File-by-file changes

**PR1 — closes #181 + #147** (PR-detail + shared infrastructure):
- `components/Skeleton/Skeleton.tsx` (+`.module.css`) — new primitive.
- `contexts/LoadingBarContext.tsx` — new provider/hook.
- `components/TopProgressBar/TopProgressBar.tsx` (+`.module.css`) — new bar.
- `App.tsx` — mount `LoadingBarProvider` + `<TopProgressBar/>` at root.
- `hooks/usePrDetail.ts` — drop `showSkeleton` from `UsePrDetailResult` and the `useDelayedLoading(isLoading)` call (its only consumer, `PrDetailView`, now reads `isLoading`). `useDelayedLoading` and its other callers (`useFileDiff`, `useUnionDiff`) untouched.
- `components/PrDetail/PrHeader.tsx` — `loading` prop swaps title/author/chip slots for skeletons.
- `components/PrDetail/PrDetailView.tsx` — destructure `isLoading`; change body gate to `!data && isLoading`; derive `loading={!data && isLoading}` for `PrHeader`; replace `PrDetailSkeleton` body with the Overview-shaped skeleton (root keeps `data-testid="pr-detail-skeleton"`); feed `useTopProgress('pr-detail:' + prRefKey, active && isLoading)`. (No `useDelayedLoading` change — see §4.2.)
- `components/PrDetail/PrDetailView.freshness.test.tsx` + `PrDetailView.test.tsx` + `PrTabHost.test.tsx` — reshape the `usePrDetail` mock: drop `showSkeleton`, add `isLoading`. Update the freshness test's #180 assertion to query `data-testid="pr-detail-skeleton"` and its background-reload injection (`showSkeleton: true` → `isLoading: true`). Without the `isLoading` field the new `!data && isLoading` gate reads `undefined` and a cold-load skeleton assertion would pass *vacuously*.

**PR2 — closes sibling inbox issue** (reuses PR1 primitives):
- `components/Inbox/InboxSkeleton.tsx` — new; takes `showRail?: boolean`.
- `pages/InboxPage.tsx` — swap spinner branch for `<InboxSkeleton showRail={showActivityRail} />`; feed `useTopProgress('inbox', isLoading)`.

## 6. Scope / issues / PR split

- **#181** — PR-detail loading affordance (PR1).
- **#147** — empty header title/author on cold-load: a strict subset of PR1's `PrHeader` skeleton; **closed by PR1**, no separate diff.
- **#244** — inbox content-shaped skeleton (PR2).
- The **global top bar is app-level infrastructure broader than #181's title implies.** It is introduced under PR1 because PR-detail is its first feeder; this scope expansion is documented here deliberately rather than smuggled in. PR2 adds the inbox feeder.

Two PRs (not one) for reviewability: PR1 establishes the primitives + closes #181/#147; PR2 reuses them for the inbox.

## 7. Testing

- **Unit (vitest):**
  - `LoadingBarContext` — `setLoading(key,true/false)` drives `active`; `active` is the OR across keys; unmount cleanup clears a key; **StrictMode double-mount** of `useTopProgress` nets to the expected boolean with no leaked source.
  - `Skeleton` / `SkeletonText` — render, `aria-hidden`, reduced-motion class.
  - `PrHeader` (loading) — renders skeletons for title/author, real breadcrumb + tab strip, action buttons present; **existing `PrHeader` tests stay green with `loading` omitted** (selector-assumption review per §4.3).
  - `InboxSkeleton` — section/row counts; rail shown iff `showRail` prop true (no gate-hook mock needed).
- **`usePrDetail` mock reshape (prerequisite):** every component test that mocks `usePrDetail` (`PrDetailView.test.tsx`, `PrDetailView.freshness.test.tsx`, `PrTabHost.test.tsx`) must return `isLoading` (not `showSkeleton`) so the `!data && isLoading` gate is exercised, not read as `undefined`. The freshness test's mutable `prDetailResult` holder is reshaped accordingly.
- **Component render:** `PrDetailView` cold (`data===null`, `isLoading` true) shows the Overview-shaped skeleton immediately + header skeletons; background reload (`data` present, `isLoading` true) keeps content (no skeleton, header real) — guards the #180 regression via the `data-testid="pr-detail-skeleton"` selector. Error (`data===null`, `isLoading` false) renders no header/body skeleton and surfaces `ErrorModal`.
- **B1 visual proof (gated UI issue):** before/after screenshots of the cold-open window for both surfaces, captured via Playwright with network throttled to force the loading state, embedded on each PR.

## 8. Open decisions (resolved)

- **Treatment:** C+Y — content-shaped skeletons on both surfaces **and** a global top bar. (User-selected with the footgun disclosed.)
- **Header action buttons during load:** kept real (already `disabled={!session}` where data-dependent).
- **Bar store:** keyed-boolean signal map, **not** a ref-counted counter (StrictMode-safe by construction; no watchdog timer needed). PR-detail uses a **per-instance key** (`'pr-detail:'+prRefKey`) so two mounted keep-alive views never collide on one key. — revised from the first draft's ref-count (round 1) and single-key (round 2) after ce-doc-review.
- **Timing fix:** gate `PrDetailView` body on `!data && isLoading`; derive `PrHeader loading` from the *same* predicate; trim `usePrDetail`'s now-orphaned `showSkeleton`. Leave `useDelayedLoading` itself untouched. — revised from the first draft's `immediate` option (round 1) and the header/body predicate split (round 2).
- **PR split:** two PRs.
- **#147:** folded into PR1.

### Deferred / out of scope (from ce-doc-review)

- **`DraftsTabSkeleton` unstyled `.skeleton-row`:** a pre-existing latent bug (the class has no CSS animation) surfaced while auditing §4.1. Not introduced by this work — a separate follow-up issue, not folded in.
- **Top-bar maintenance surface (product-lens advisory):** acknowledged; the keyed-boolean simplification cuts the standing cost the concern named, and C+Y was chosen with the tradeoff on the table. No change.
- **Inbox bar during 503 retry-backoff (adversarial advisory):** accepted — an animated bar during backend cold-start warmup reads as "working," appropriate for a local PoC.
- **Goal framing "polished" vs "perceived-performance" (product-lens advisory):** wording kept; the anti-frozen driver is already explicit in §1–§2.

## 9. Self-review

(Completed inline before requesting review — see §10 below for the checklist pass.)

## 10. Spec self-review checklist

- **Placeholders:** none — all sections concrete.
- **Consistency:** the loading-state matrix (§4.6), the timing fix (§4.2), and the #180 non-regression all agree (`!data && isLoading` gate; cold path shows the skeleton, background reload keeps content, error yields `null` body).
- **Scope:** focused; Files/Drafts skeletons and a determinate bar explicitly excluded (§2). The top-bar scope expansion is called out (§6).
- **Ambiguity:** skeleton fidelity is pinned to real screenshots + per-element mapping tables (§4.3–4.4) so "mirror the real screen" can't be read two ways.
