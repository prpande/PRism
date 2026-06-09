# Inbox rows: GitHub-parity leading status glyphs (CI indicator + PR-state icon)

- **Issue:** [#264](https://github.com/prpande/PRism/issues/264)
- **Date:** 2026-06-09
- **Status:** Design — scope expanded 2026-06-09 (PR-state leading icon moved in from #300); re-review pending
- **Type:** backend wire-enum widening + frontend render/layout; design-gated (B1 visual sign-off)

## Problem

Each inbox row carries CI state poorly, and PR state (open/merged/closed) is
shown only as a text badge — neither matches GitHub's at-a-glance row iconography.

**CI:**
- The backend enum `CiStatus = None | Pending | Failing`
  (`PRism.Core.Contracts/CiStatus.cs`) has **no positive state**. A PR whose
  checks have all passed is indistinguishable from a PR with no CI configured —
  both collapse to `None`.
- `InboxRow` renders a visible CI marker **only** for `failing` (filled red dot)
  and `pending` (hollow amber ring); `passing`/`none` render an invisible
  placeholder. A green PR shows **nothing** — no "all clear" signal.

**PR state:**
- Merged/closed PRs show a **text badge** ("Merged"/"Closed") on the meta line
  (`InboxRow.tsx`); open PRs show no state glyph at all. GitHub instead leads each
  row with a coloured state icon (green open / purple merged / red closed).

Target is GitHub's PR-list row: a **PR-state icon leading the title**, and a
**CI glyph** as a compact secondary signal — amber ● in progress, red ✗ failed,
green ✓ passed, nothing when no checks exist.

This builds on **#286** (merged, `470a8209`), which corrected the `None`
classification so an empty combined-status (`state="pending"`, `total_count=0`,
no registered legacy statuses) no longer reads as `Pending`. #264 assumes that
correctness and adds `Passing` on top.

## Goals

1. Add `CiStatus.Passing` to the wire enum and emit it from the detector when
   checks have completed successfully.
2. Add a **PR-state leading icon** (open / merged / closed) on every row,
   derived from the existing payload — replacing the meta-line text badge.
3. Define the **leading-column model**: how the PR-state icon and the CI glyph
   coexist without colliding or doubling up signal (the central design question
   this issue exists to answer). **Chosen:** PR-state icon **prefixes** the title
   (leading column); the CI glyph **suffixes** the title (right edge of the title
   line) — the two flank the headline (see Decision 1).
4. Render every CI state with GitHub-parity, shape-distinct octicon glyphs and
   accessible labels.

## Non-goals

- **Mergeability** ("can this PR merge / has conflicts"). A separate axis, not in
  the inbox payload today; folded into **#259**. Passing CI ≠ mergeable.
- **Sort / filter changes.** #262 already shipped the `ci-failing` filter axis;
  this slice only upgrades the per-row glyph that axis points at. The CI filter
  facet (`FilterBar.tsx` `CI_VALUES = ['failing', 'pending']`) stays as-is —
  `'passing'` is **not** added as a filter option. Widening the `CiStatus` union
  does not break that typed array (a subset is still valid), and because filters
  are opt-in (`applyInboxFilters` only filters when `f.ci.length > 0`), a PR that
  now classifies `passing` (formerly `none`) behaves identically under every
  existing filter — no regression. PR state is likewise not added as a filter axis.
- **Draft PRs.** GitHub distinguishes a grey "draft" state; the inbox payload has
  no draft flag, so this slice handles only open / merged / closed. Draft → open
  glyph. Adding draft is a separate payload+derivation change.
- **Backend for PR state.** The PR-state icon is derived entirely frontend-side
  from the existing `mergedAt` / `closedAt` fields on `PrInboxItem` — no new
  payload field, no backend change.

## Design

### Backend — `CiStatus.Passing`

**Enum** (`PRism.Core.Contracts/CiStatus.cs`): add a `Passing` member. The wire
serialization is the existing lower/kebab `JsonStringEnumConverter`, so it
serializes as `"passing"`. The frontend union (`frontend/src/api/types.ts`)
gains `'passing'`.

**Detector** (`PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`) — the substantive
work is distinguishing "all checks green" from "no checks at all", which today
both return `None`:

- **`FetchChecksAsync`:** today a fully-successful PR returns `None` (the method
  only emits `Failing`/`Pending`/`None`). Add a new flag (`anyRun`) set **inside
  the `foreach` over `check_runs` entries** — i.e. it tracks whether at least one
  check-run *object* was seen, NOT whether the `check_runs` array was present.
  This distinction is load-bearing: the existing `anyPage` flag is already set
  true for an **empty** `check_runs: []`, so reusing it would misclassify a
  no-CI PR (empty array) as `Passing`. The final return becomes
  `anyFailing ? Failing : anyPending ? Pending : anyRun ? Passing : None`. So:
  runs exist and none failing/pending → **`Passing`**; missing or empty
  `check_runs` (`anyRun` false) → `None` (unchanged — avoids a false green tick,
  the passing-side analogue of the #286 false-amber bug). The existing
  "completed + conclusion failure/timed_out/cancelled → failing" and
  "status != completed → pending" classification is unchanged.

- **`FetchCombinedStatusAsync`:** `state="success"` **with** registered
  statuses (reuse the #286 `HasRegisteredStatuses` helper) → **`Passing`**.
  `state="success"` with no registered statuses → `None` (unchanged — the #286
  "no legacy statuses registered" case). The `failure`/`error` → `Failing` and
  `pending` (gated on `HasRegisteredStatuses`) → `Pending` branches are
  unchanged.

- **`ProbeAsync` precedence:** widen `Failing > Pending > None` to
  **`Failing > Pending > Passing > None`**:
  - either source `Failing` → `Failing`
  - else either source `Pending` → `Pending`
  - else either source `Passing` → `Passing`
  - else `None`

  Worked cases: all-checks-green + no legacy statuses → (`Passing`, `None`) →
  `Passing`. Green checks + a failing legacy status → (`Passing`, `Failing`) →
  `Failing`. No check-runs + a successful legacy status → (`None`, `Passing`) →
  `Passing`.

- **Degraded handling:** `Passing` is treated like `Pending`/`None` — it is
  **degraded-flagged (not cached)** when a probe could not fully read its
  source. Rationale: a `Passing` observed from one source while the other
  source returned a non-2xx (fine-grained 403 / transient 5xx) could be masking
  a `Failing` hidden behind the unread source. Only a definitively-observed
  `Failing` stays non-degraded / cacheable. This preserves the existing
  conservative caching contract (#213): `if Passing return (Passing, degraded)`.

### Frontend — leading-column model (PR-state prefix + CI suffix)

The row's headline is flanked by two status glyphs:

```
[PR-state icon]  PR title text wrapping up to two lines…  [CI glyph]
                 meta line: repo · author · iter N · 2h
                                                            (metrics tail unchanged)
```

**PR-state icon — leading column, every row.** Derived from the row's
`mergedAt`/`closedAt` (the existing `doneState` computation):

| State | Octicon | Token |
|-------|---------|-------|
| open (neither `mergedAt` nor `closedAt`) | `git-pull-request` | `--success-fg` (green) |
| merged (`mergedAt` set) | `git-merge` | `--merged-fg` (existing purple token) |
| closed (`closedAt` set, not merged) | `git-pull-request-closed` | `--danger-fg` (red) |

- Occupies the existing 16px leading grid column (currently `.status`). The
  **column width stays 16px**; the icon **renders at 14px**, vertically centred
  (a 14px glyph in a 16px track keeps the #227 metrics alignment stable). Shown
  on **every** row (open included), so the icon language is consistent —
  answering the issue's "same language on all rows".
- **No new colour tokens.** All three PR-state colours reuse existing, shipped,
  AA-verified semantic tokens: `--success-fg` (green, open), `--merged-fg`
  (purple, merged — already defined in `tokens.css` light+dark and already used
  by today's `.badgeMerged`), and `--danger-fg` (red, closed — the same token
  today's `.badgeClosed` uses). The CI glyphs likewise reuse existing tokens, so
  this slice introduces **zero** new colours.

**CI glyph — title suffix, open rows only.** Pinned to the trailing edge of the
title line (inside the main column), so it reads as a status on the headline
without competing with the leading PR-state icon:

| State | Octicon | Token |
|-------|---------|-------|
| `passing` | `check-circle-fill-16` (✓) | `--success-fg` |
| `failing` | `x-circle-fill-16` (✗) | `--danger-fg` |
| `pending` | `dot-fill-16` (●, static) | `--warning-fg` |
| `none` / done row | nothing rendered | — |

- The `.title` becomes a flex `titleRow`: `[.title (flex:1, min-width:0, 2-line
  clamp)] [CI glyph (flex:none)]`, glyph at 14px. The titleRow uses
  `align-items: flex-start` and the glyph `align-self: flex-start` so the CI
  glyph pins to the **first** line of the title (optically centred on that line
  via a small top offset ≈ `(line-height − 14px) / 2`), **not** the vertical
  midpoint of a two-line block — so a one-line title and the first line of a
  two-line title place the glyph identically.
- Unlike the old leading slot, the CI suffix needs **no width placeholder** for
  `none`/done — it sits at the flexible end of the title, so absence simply lets
  the title use the full width. (The leading column's alignment is now guaranteed
  by the always-present PR-state icon.)
- CI shows on open rows only; merged/closed rows show no CI glyph (CI is
  irrelevant once a PR is terminal — same `!isDone` gate as before, just relocated).
- At the #227 `@container inbox-sections (max-width: 560px)` breakpoint the CI
  suffix is **retained** — that query only drops the diff bar and the AI chip
  (both in the tail / meta line), and the narrower tail actually gives the title
  row *more* width. The titleRow flex (`title` flex:1 min-width:0, glyph
  flex:none) absorbs any squeeze: the title truncates, the glyph stays pinned.
  Confirmed at B1's narrow-viewport shot.

**Removed markup.** The CI dot moves out of the leading slot, so the
`InboxRow.module.css` `.dot` / `.dotFailing` / `.dotPending` rules and their JSX
are **deleted** (module-scoped to `InboxRow`; the identically-named `.dot` in
`AccentSwatches` / `WindowControls` / `PrTabStrip` are separate scoped classes,
untouched). The meta-line **text badge** (`.stateBadge` / `.badgeMerged` /
`.badgeClosed` and the "Merged"/"Closed" `<span>`s) is also **deleted** — PR
state now lives in the leading icon + the aria-label (see Decision 2 + #300).

**Glyph construction (both icon families).** Inline SVG `<path>`s, same pattern
as the existing comment octicon in this row. Each glyph is a **non-interactive
`<span>`/`<svg>`** — no `role`, no `tabIndex`, never wrapped in a `<button>`/`<a>`
(the row itself is the `<button>`; a nested interactive element would break
keyboard nav / WCAG 4.1.2). Each glyph is `aria-hidden="true"` with a `<title>`
child for a sighted-only hover tooltip.

**Accessibility:**

- **CI** state rides the row `aria-label` via the existing `ciSuffix` mechanism,
  extended to the three visible states: `· CI passing` / `· CI failing` /
  `· CI pending`; `none` and done rows contribute nothing.
- **PR** state rides the row `aria-label`: the `doneState` branch appends
  `· merged` / `· closed`, and this slice **adds `· open`** for open rows so all
  three states are announced symmetrically. (Absence of a word is not a
  communicated state for screen-reader users — merged/closed announce
  explicitly, so open must too; this also matches GitHub's accessible labels.)
  Promoting state to an icon keeps it in the aria-label, satisfying the issue's
  "PR state must stay in the aria-label".
- Both glyph families stay shape-distinct: PR state uses three structurally
  different octicons (pull-request / merge / closed); CI uses ✓ / ✗ / ● whose
  interior mark distinguishes state beyond hue (see Decision 4 for the honest
  greyscale limit + the B1 backstop).

## Testing

- **Backend (TDD), extending `GitHubCiFailingDetectorTests`:**
  - all check-runs completed successfully → `Passing`
  - combined status `success` **with** registered statuses → `Passing`
  - combined status `success` with **no** registered statuses → `None`
    (regression guard reinforcing #286)
  - mixed sources: one `Passing`, other `Failing` → `Failing` (precedence)
  - `Passing` observed while the other probe is degraded → result not cached
  - existing Failing/Pending/None tests remain green.

- **Frontend (`InboxRow` unit tests):**
  - **PR-state icon:** open row renders the open glyph; merged row the merge
    glyph; closed row the closed glyph (assert via a `data-pr-state` attribute).
  - **CI suffix:** each open visible state (`passing`/`failing`/`pending`) renders
    its glyph in the title row (assert via `data-ci`); `none`/done renders no CI
    glyph; `aria-label` carries the `· CI <state>` suffix for the three open
    states only.
  - **Badge removal:** merged/closed rows no longer render the "Merged"/"Closed"
    text badge; the done-state still appears in the `aria-label`.
  - **Existing tests updated, not just added:** two current `InboxRow.test.tsx`
    tests break under this change and must be rewritten, not left as-is —
    `renders the Merged badge on the meta line for a merged PR` (asserts
    `getByText('Merged')`, which throws once the badge span is deleted → reassert
    the merged **icon** `data-pr-state="merged"` + the aria-label), and
    `shows no CI dot ... when ci is none` (asserts the `.status` slot has exactly
    one child → update for the new always-present leading PR-state icon and the
    relocated CI suffix).

- **B1 visual gate:** Playwright screenshots of the inbox showing the matrix —
  **open** rows across all four CI states (passing/failing/pending/none) **plus**
  one **merged** and one **closed** row — in **both** light and dark themes,
  posted to the PR for owner sign-off before merge. Produced by **mocking the
  `/api/inbox` payload** in the Playwright route (the #272/#273 approach;
  `FakePrDiscovery` only emits `CiStatus.None` and can't exercise the states).
  Three checks:
  - **Contrast:** all glyph colours reuse existing shipped tokens
    (`--success-fg` / `--danger-fg` / `--warning-fg` / `--merged-fg`) — already
    AA in both themes; this confirms the glyph *use* of them against the row
    surface, not fresh colour derivation. No new tokens to verify.
  - **Greyscale legibility:** desaturated, confirm `passing` (✓) vs `failing` (✗)
    remain tellable apart at 14px (Decision 4).
  - **Flanking read:** confirm the open-icon (green) + ✓ (green) on a passing open
    row reads as two distinct signals, not a doubled-up smear (Decision 1).

## Decisions

1. **Flanking model: PR-state prefixes the title, CI suffixes it.** Of the three
   coexistence models the issue names — (a) two glyphs side-by-side in the leading
   slot, (b) one combined glyph, (c) PR-state-leads-with-CI-secondary — we take a
   refinement of (c): the PR-state icon leads (prefix), the CI glyph trails the
   title (suffix), so they sit on opposite sides of the headline. Side-by-side (a)
   puts an open-green and a passing-green glyph adjacent — the exact "double up
   signal" the issue warns against — and widens the leading column against #227's
   alignment. A combined glyph (b) overloads one mark with two orthogonal axes
   (PR state + CI), the same "one tick for two things is misleading" trap the
   mergeability section calls out, and is poor for a11y. The flanking model keeps
   both axes legible, separable, and attached to the title users scan; it also
   leaves #227's metrics-tail budget completely untouched (CI never enters the
   tail). Accepted trade-off: an open+passing row shows green on both sides —
   mitigated by distinct positions, distinct glyphs, and distinct meaning;
   verified at B1 (the "flanking read" check). **Fallback if it fails B1:** mute
   the open-state icon to a neutral/secondary colour (a muted text/foreground
   token) instead of green — "open" is the default state and needs the least
   emphasis, so muting it
   breaks the green-on-green without weakening the CI signal. Decided at B1, not
   pre-committed.

   **Red-collision invariant:** a closed PR-state icon (red `--danger-fg`) and a
   failing CI glyph (red `--danger-fg`) are **mutually exclusive on a row by
   construction** — CI renders on open rows only (the `!isDone` gate) and a
   closed row is not open, so the two reds never co-appear. This gate is a design
   invariant; relaxing it would require revisiting the colour analysis.

2. **Drop the meta-line text badge; PR state lives in the leading icon.** With a
   universal PR-state icon, the "Merged"/"Closed" text pill is redundant (state
   is in the icon + aria-label). #300 owns the near-term pill treatment for inbox
   cohesion; this slice removes the InboxRow text badge in favour of the leading
   icon and **cross-links #300** (does not claim it). If #300 later wants a pill
   back for a different reason, it can reintroduce one; the leading icon is the
   row-state-glyph model #264 owns.

3. **PR state is frontend-derived; no backend.** `mergedAt`/`closedAt` already
   ride the inbox payload and already drive the `doneState` computation and the
   aria-label. The icon is a pure render of existing data — no new field, no
   detector/orchestrator change. (Contrast the CI half, which genuinely needs the
   new `Passing` enum + detector logic.)

4. **CI: octicons over an extended dot family.** A filled green dot for passing
   would make passing-green and failing-red both filled dots distinguished only by
   hue, breaking the greyscale/colour-blind distinguishability the #227 hollow
   ring protected. GitHub-style octicons (✓ / ✗ / ●) carry an interior mark that
   distinguishes state beyond hue and are house style.
   **Honest limit:** `check-circle-fill` and `x-circle-fill` share a circular
   silhouette — the only greyscale difference is the interior ✓-vs-✗ knockout,
   which can collapse at very small sizes (true of GitHub's own list icons too).
   Mitigations: (a) render at 14px so the interior mark stays readable; (b) the
   B1 greyscale-legibility check. If they collapse, fall back to keeping `pending`
   as the #227 hollow ring and/or bump size — decided at B1, not assumed here.

5. **Pending is static, not animated.** GitHub's PR *list* uses a static amber
   dot (the spinner is PR-page only). A spinner in a dense list competes with the
   unread accent bar and needs `prefers-reduced-motion` handling for no gain.

6. **`Passing` is not cacheable when degraded.** Only a definitively-observed
   `Failing` is cached; a `Passing` could mask a `Failing` on an unread source, so
   it re-probes next tick (#213 model).

## Coordination

- **#286** (merged): made `None` correct for empty combined-status; this slice
  depends on it and reuses its `HasRegisteredStatuses` helper.
- **#300** (open): owns inbox cohesion incl. the merged/closed **pill** text
  treatment. The leading PR-state-icon exploration was moved *out* of #300 *into*
  #264. This slice **removes** the InboxRow text badge in favour of the leading
  icon; cross-link #300 so it doesn't re-add a colliding badge. Not claimed.
- **#262** (merged): owns the `ci-failing` filter axis; unchanged. This slice
  makes the per-row CI glyph that axis points at more legible.
- **#227** (merged): owns the row layout. This slice **restructures** the leading
  column (CI dot → PR-state icon) and the title line (adds a CI suffix), and
  drops the meta-line badge — but keeps the #227 metrics-tail budget intact (CI
  never enters the tail). Coordinated, not a conflict.
- **#259**: owns mergeability + row-payload expansion; mergeability stays there.
- **#279**: broader top-of-screen bar/SSE-accuracy family; not touched here.
