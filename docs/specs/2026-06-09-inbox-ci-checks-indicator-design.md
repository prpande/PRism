# Inbox rows: GitHub-parity CI checks indicator

- **Issue:** [#264](https://github.com/prpande/PRism/issues/264)
- **Date:** 2026-06-09
- **Status:** Design — approved, pending implementation plan
- **Type:** backend wire-enum widening + frontend render; design-gated (B1 visual sign-off)

## Problem

Each inbox row has a CI-status slot, but the model and the rendering are both
impoverished:

- The backend enum `CiStatus = None | Pending | Failing`
  (`PRism.Core.Contracts/CiStatus.cs`) has **no positive state**. A PR whose
  checks have all passed is indistinguishable from a PR with no CI configured —
  both collapse to `None`.
- `InboxRow` (`frontend/src/components/Inbox/InboxRow.tsx`) renders a visible
  marker **only** for `failing` (filled red dot) and `pending` (hollow amber
  ring). `passing` and `none` both render an invisible, width-reserving
  placeholder. So a PR with all checks green shows **nothing** — there is no
  "all clear" signal at all.

Target is GitHub's PR-list iconography: amber ● in progress, red ✗ failed,
green ✓ passed, nothing when no checks exist.

This builds directly on **#286** (merged, `470a8209`), which corrected the
`None` classification so that an empty combined-status (`state="pending"`,
`total_count=0`, no registered legacy statuses) no longer reads as `Pending`.
#264 assumes that correctness and adds the `Passing` state on top of it.

## Goals

1. Add `CiStatus.Passing` to the wire enum and emit it from the detector when
   checks have completed successfully.
2. Render all four states in the inbox row with GitHub-parity, hue-independent
   octicon glyphs and accessible labels.
3. Preserve the existing accessibility property from #227: CI state must read
   in greyscale, for colour-blind users, and against any user-chosen accent —
   i.e. distinguished by **shape**, not hue alone.

## Non-goals

- **Mergeability** ("can this PR merge / has conflicts"). A separate axis, not
  in the inbox payload today; folded into **#259**. Passing CI ≠ mergeable.
- **Sort / filter changes.** #262 already shipped the `ci-failing` filter axis;
  this slice only upgrades the per-row glyph that axis points at.
- **Row-layout changes.** #227 shipped the row layout and the status slot; this
  slice reuses the slot as-is.
- **Pending motion.** The pending glyph is static (see Decision 3).
- **Done-row CI.** Merged/closed rows show no CI glyph (current `!isDone` gate
  stays — a green check on a merged PR is redundant; closed-PR CI is irrelevant).

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
  only emits `Failing`/`Pending`/`None`). Track whether *any* check-run was
  observed across all pages. If runs exist and none are failing or pending →
  **`Passing`**. No runs at all (missing or empty `check_runs`) → `None`
  (unchanged). The existing "completed + conclusion failure/timed_out/cancelled
  → failing" and "status != completed → pending" classification is unchanged.

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

### Frontend — octicons in the status slot

`InboxRow.tsx` renders the status slot, gated on `!isDone`:

| State | Octicon | Token |
|-------|---------|-------|
| `passing` | `check-circle-fill-16` (✓) | `--success-fg` |
| `failing` | `x-circle-fill-16` (✗) | `--danger-fg` |
| `pending` | `dot-fill-16` (●, static) | `--warning-fg` |
| `none` | nothing rendered, slot width reserved | — |

- Inline SVG paths, the same pattern as the existing comment octicon already in
  this row. Glyph size tuned to the current slot at the B1 pass (the comment
  octicon uses a 12px render in a 16-viewBox; the CI glyph follows suit).
- The slot keeps `flex: none` and a reserved width so the title column stays
  aligned across all four states (matching today's invisible-placeholder
  behaviour for `none`).

**Accessibility:**

- Each glyph is `aria-hidden="true"` (decorative); the CI state is carried in
  the row's `aria-label` via the existing `ciSuffix` mechanism, extended to all
  three visible states: `· CI passing` / `· CI failing` / `· CI pending`.
  `none` contributes nothing (no CI to announce).
- A `title=` tooltip on each glyph (`CI passing` / `CI failing` / `CI pending`)
  for sighted hover.
- Hue-independent readability is preserved because ✓, ✗, and ● are
  shape-distinct — state survives greyscale, colour-blindness, and any
  user-chosen accent, honouring the #227 design intent.

## Testing

- **Backend (TDD), extending `GitHubCiFailingDetectorTests`:**
  - all check-runs completed successfully → `Passing`
  - combined status `success` **with** registered statuses → `Passing`
  - combined status `success` with **no** registered statuses → `None`
    (regression guard reinforcing #286)
  - mixed sources: one `Passing`, other `Failing` → `Failing` (precedence)
  - `Passing` observed while the other probe is degraded → result not cached
    (re-probes next tick)
  - existing Failing/Pending/None tests remain green.

- **Frontend (`InboxRow` unit tests):**
  - each state renders its expected glyph; `none` renders no glyph
  - `aria-label` carries the correct `· CI <state>` suffix per state
  - existing failing/pending assertions updated from dot/ring markup to the
    octicon markup.

- **B1 visual gate:** Playwright screenshots of the inbox showing all four
  states in **both** light and dark themes, posted to the PR for owner
  sign-off before merge. Contrast of `--success-fg` / `--danger-fg` /
  `--warning-fg` against the row surface verified AA in both themes.

## Decisions

1. **Octicons over an extended dot family.** Adding a filled green dot for
   passing would make passing-green and failing-red both filled dots
   distinguished only by hue, breaking the greyscale/colour-blind
   distinguishability the #227 hollow-ring specifically protected. GitHub-style
   octicons (✓ / ✗ / ●) are inherently shape-distinct, are what the issue asks
   for, and are already house style (the comment octicon in this same row).

2. **`none` renders nothing (width reserved).** Matches GitHub's PR list. Most
   `none` PRs are no-CI sandbox/doc PRs; a neutral marker on every one of them
   is noise for zero information. The slot still reserves width so alignment
   holds.

3. **Pending is static, not animated.** GitHub's PR *list* uses a static amber
   dot (the spinner only appears on the PR page). A spinner in a dense list
   competes with the unread accent bar and needs `prefers-reduced-motion`
   handling for no signal gain.

4. **`Passing` is not cacheable when degraded.** Consistent with the #213
   conservative caching model: only a definitively-observed `Failing` is
   cached; `Passing` could mask a `Failing` on an unread source, so it
   re-probes next tick.

## Coordination

- **#286** (merged): made `None` correct for empty combined-status; this slice
  depends on it and reuses its `HasRegisteredStatuses` helper.
- **#262** (merged): owns the `ci-failing` filter axis; unchanged here. This
  slice makes the per-row glyph that axis points at more legible.
- **#227** (merged): owns the row layout and status slot; reused as-is.
- **#259**: owns mergeability + row-payload expansion; mergeability stays there.
- **#279**: broader top-of-screen bar/SSE-accuracy family; not touched here.
