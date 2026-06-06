# Loading affordance: high-fidelity skeletons + global top progress bar

- **Status:** Design — awaiting human review
- **Issues:** #181 (PR-detail: no clear loading affordance on open), #147 (PrHeader empty title/author on cold-load — folded in), plus a sibling inbox issue to be filed (inbox cold-load shows a generic spinner)
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

A single shimmer primitive both surfaces compose. Absorbs the existing ad-hoc `.pr-detail-skeleton` / `.skeleton-row` CSS.

```
<Skeleton width? height? radius? circle? className? />     // one shimmer block
<SkeletonText lines={n} widths?={string[]} />              // n stacked line blocks
```

- Shimmer via a CSS `::after` sweep on a token-driven base (`--surface-2`/`--surface-3`), so light/dark both work.
- `aria-hidden` on individual blocks; the **container** carries `aria-busy="true"` and a polite live region label (see §4.7).
- Respects `prefers-reduced-motion`: no sweep animation, static block instead.

### 4.2 Cold-load timing fix — `frontend/src/hooks/useDelayedLoading.ts`

Add an `immediate` option:

```ts
useDelayedLoading(isLoading: boolean, opts?: { immediate?: boolean }): boolean
```

- `immediate === true`: skip `WAIT_MS` (show at t=0) but **keep `HOLD_MS`** (once shown, hold ≥300 ms so a fast resolve doesn't flash the skeleton off).
- `immediate` falsy: unchanged behavior.

`usePrDetail` calls `useDelayedLoading(isLoading, { immediate: data === null })`. The `PrDetailView` body gate is unchanged in shape (`!data && showSkeleton`); the only behavioral delta is that on a cold open `showSkeleton` is now true immediately. Background-reload behavior is untouched (data present → gate already keeps content; `immediate` is false anyway).

> Verify `useDelayedLoading` has no other callers before changing the signature; if it does, they pass no opts and are unaffected. (Confirmed at plan time.)

### 4.3 PR-detail skeleton — `frontend/src/components/PrDetail/`

Render a skeleton that is the **same DOM shape** as the loaded view. Two parts:

**Header (fixes #147).** While `data === null`, `PrHeader` shows:

| Element | Loaded | Cold-load skeleton |
|---|---|---|
| Breadcrumb `owner/repo · #n` | real | **real** (from `prRef`) |
| Title (h1) | real | `<Skeleton>` bar ~60% width, h1 height |
| Subtitle author | avatar + login | circle `<Skeleton>` (avatar) + ~120px bar |
| Subtitle branch/CI/mergeability chips | chips | two chip-shaped `<Skeleton>`s |
| Tab strip (Overview/Files/Drafts) | real | **real** static chrome |
| Collapse toggle | real | **real** |
| Action buttons (Verdict/Submit/Ask AI/Open-in-GitHub) | real (disabled while `session` null) | **kept real** (interactive chrome, not data — per design decision) |

Implementation: `PrHeader` already receives `title`/`author`/etc. as props that are empty on cold load. Add a `loading?: boolean` prop (derived by `PrDetailView` as `data === null`) that swaps the title/author/chip slots for `<Skeleton>`s. No structural divergence — same elements, same grid.

**Body (Overview shape).** Replace the three-grey-bar `PrDetailSkeleton` with one that mirrors `OverviewTab`:

| Overview element | Skeleton |
|---|---|
| AI **Summary** card | rounded card `<Skeleton>` block (~3 text lines) |
| `PrDescription` (markdown) | `<SkeletonText lines={6}>` with varied widths |
| `StatsTiles` (4 tiles) | row of 4 tile-shaped `<Skeleton>`s |
| `PrRootConversation` | one avatar-circle + 2 text lines |
| `ReviewFilesCta` | button-shaped `<Skeleton>` |

### 4.4 Inbox skeleton — `frontend/src/components/Inbox/InboxSkeleton.tsx`

Replaces the centered spinner branch in `InboxPage` (`isLoading && !data`). Mirrors the real inbox:

| Inbox element | Skeleton |
|---|---|
| Paste-URL toolbar (`InboxToolbar` → `PasteUrlInput`) | full-width input-shaped `<Skeleton>` |
| Section header (caret + label + count) | small caret block + ~140px label bar + count pill, ×2–3 sections |
| `InboxRow` (×2–4 per section) | status-dot slot + title bar + meta line (avatar circle + author bar + iter + age) + right tail (diff-bar block + `+/−` count blocks) |
| Activity rail (`ActivityRail`) | rail-width column of placeholder cards — **only when the AI-ranking gate is on** (mirror `useAiGate('inboxRanking')`) |

Static counts (how many section/row placeholders) are fixed constants — a plausible-looking shape, not data-driven.

### 4.5 Global top progress bar (the "Y" decision)

**Component** — `frontend/src/components/TopProgressBar/TopProgressBar.tsx`, mounted once at the app root (in `App.tsx`, above `<Routes>`). Fixed to the viewport top, full width, ~3px, high `z-index` (below modal/toast layers, above page content), theme accent color. Indeterminate sliding animation while active; on the active→idle transition it sweeps to 100% then fades out (~200 ms), so even a sub-100 ms load reads as a clean finish rather than an abrupt blink. Honors `prefers-reduced-motion` (static fill + fade, no slide). `aria-hidden` (the per-surface skeletons/spinners carry the AT-facing busy state; a global indeterminate bar would be noise to a screen reader).

**Store** — `frontend/src/contexts/LoadingBarContext.tsx`: a ref-counted provider.

```ts
interface LoadingBarStore {
  begin(): () => void;   // returns an idempotent end() token
  active: boolean;       // count > 0
}
useTopProgress(active: boolean): void   // begins on active→true, ends on false/unmount
```

- `useTopProgress` increments on `active` becoming true and decrements via the returned token in its effect **cleanup** (so an unmount mid-load cannot leak a permanent increment).
- The counter **clamps at 0** (a double-end can't drive it negative).
- **Safety auto-release:** each `begin()` schedules a 20 s timeout that force-releases that token and `console.warn`s. Trades a theoretical stuck bar for a bar that may vanish under a genuine >20 s load — acceptable, and the warning makes a real leak diagnosable rather than silent. (Mirrors the codebase convention of making silent-failure modes visible.)

**Feeders:**
- Inbox: `useTopProgress(isLoading)` in `InboxPage` (covers cold load **and** background reload — the bar is the non-intrusive signal during a reload where no skeleton shows).
- PR-detail: `useTopProgress(active && isLoading)` in `PrDetailView` — only the **active** (route-matched) tab feeds the bar; hidden keep-alive tabs do not.

### 4.6 Loading-state matrix

| State | Skeleton | Top bar |
|---|---|---|
| Cold open (`data === null`) | yes — instant, content-shaped | yes |
| Background reload (`data` present) | no (content stays mounted, #180) | yes (subtle) |
| Switch to already-loaded tab (no fetch) | no | no |

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
- `hooks/useDelayedLoading.ts` — `immediate` option.
- `hooks/usePrDetail.ts` — pass `{ immediate: data === null }`.
- `components/PrDetail/PrHeader.tsx` — `loading` prop swaps title/author/chip slots for skeletons.
- `components/PrDetail/PrDetailView.tsx` — pass `loading`; replace `PrDetailSkeleton` body with Overview-shaped skeleton; feed `useTopProgress(active && isLoading)`.

**PR2 — closes sibling inbox issue** (reuses PR1 primitives):
- `components/Inbox/InboxSkeleton.tsx` — new.
- `pages/InboxPage.tsx` — swap spinner branch for `<InboxSkeleton/>`; feed `useTopProgress(isLoading)`.

## 6. Scope / issues / PR split

- **#181** — PR-detail loading affordance (PR1).
- **#147** — empty header title/author on cold-load: a strict subset of PR1's `PrHeader` skeleton; **closed by PR1**, no separate diff.
- **New sibling issue** — inbox content-shaped skeleton (PR2).
- The **global top bar is app-level infrastructure broader than #181's title implies.** It is introduced under PR1 because PR-detail is its first feeder; this scope expansion is documented here deliberately rather than smuggled in. PR2 adds the inbox feeder.

Two PRs (not one) for reviewability: PR1 establishes the primitives + closes #181/#147; PR2 reuses them for the inbox.

## 7. Testing

- **Unit (vitest):**
  - `useDelayedLoading` — `immediate` shows at t=0, still honors `HOLD_MS`; non-immediate unchanged.
  - `LoadingBarContext` — ref-count begin/end, clamp-at-0, cleanup-on-unmount release, 20 s safety release.
  - `useTopProgress` — active toggle drives count; unmount-mid-active releases.
  - `Skeleton` / `SkeletonText` — render, `aria-hidden`, reduced-motion class.
  - `PrHeader` (loading) — renders skeletons for title/author, real breadcrumb + tab strip, action buttons present.
  - `InboxSkeleton` — section/row counts; rail only when ranking gate on.
- **Component render:** `PrDetailView` cold (`data===null`) shows Overview-shaped skeleton immediately; background reload keeps content (no skeleton) — guards the #180 regression.
- **B1 visual proof (gated UI issue):** before/after screenshots of the cold-open window for both surfaces, captured via Playwright with network throttled to force the loading state, embedded on each PR.

## 8. Open decisions (resolved)

- **Treatment:** C+Y — content-shaped skeletons on both surfaces **and** a global top bar. (User-selected with the footgun disclosed.)
- **Header action buttons during load:** kept real (interactive chrome), not skeleton pills.
- **Bar safety timeout:** 20 s auto-release + warning.
- **PR split:** two PRs.
- **#147:** folded into PR1.

## 9. Self-review

(Completed inline before requesting review — see §10 below for the checklist pass.)

## 10. Spec self-review checklist

- **Placeholders:** none — all sections concrete.
- **Consistency:** the loading-state matrix (§4.6), the timing fix (§4.2), and the #180 non-regression all agree (`!data` gate + `immediate` only affects the cold path).
- **Scope:** focused; Files/Drafts skeletons and a determinate bar explicitly excluded (§2). The top-bar scope expansion is called out (§6).
- **Ambiguity:** skeleton fidelity is pinned to real screenshots + per-element mapping tables (§4.3–4.4) so "mirror the real screen" can't be read two ways.
