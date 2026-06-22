# Files-tab hunk navigation: stop resetting the change index on same-file recomputes

**Issue:** #577 · **Tier:** T2 · **Risk:** gated B1 (UI interaction; live assert required) · **Date:** 2026-06-22

## Problem

In the Files-tab diff, the prev/next change controls behave erratically:

- **Counter desync** — after advancing, the change counter snaps back to **1** even though the diff has scrolled to a later hunk.
- **Double-click to advance** — "Next change" sometimes does nothing on the first click; a second click is needed.

## Root cause

`useChangeNavigation` keeps a "reset to the top" effect:

```ts
useEffect(() => {
  animatingRef.current = false;
  setCurrentIdx(-1); // -1 displays as "1"
}, [changes]);
```

It is meant to fire only on a **genuine view swap** (different file / whole-file
toggle). But it is keyed on the **identity of the `changes` array**, and
`changes = useMemo(() => computeChanges(allLines), [allLines])`. `allLines`
recomputes — producing a new `changes` reference for the *same file* — on any of
its dependencies changing: `[file, wholeFileEnabled, wholeFile.fetchStatus,
headContent, baseContent]`.

So a **same-file** recompute re-fires the reset and wipes `currentIdx`:

- **Counter says 1 while scrolled ahead:** the reset fires after you navigate, on
  an unrelated recompute.
- **Needs double-click:** a recompute interleaves between two clicks and wipes the
  first advance (it also clears `animatingRef`), so the first click "does nothing."

### Correction to the issue's hypothesis

The issue's leading hypothesis states the recompute fires because "`allLines`
recomputes whenever the rendered diff **content changes height** — async **AI hunk
annotations** arriving, **comment widgets** mounting, syntax highlighting landing."
Those are **not** the trigger: annotations, comment widgets, and highlighting
render as separate rows/cells and never enter `allLines` (whose deps are only
`[file, wholeFileEnabled, wholeFile.fetchStatus, headContent, baseContent]`), so
they do not change `changes`. The real same-file triggers are:

1. **Whole-file async expansion** (`fetchStatus` idle→ok; `headContent` populates).
2. **Parent `files` re-fetch / refresh** → `selectedFile = files.find(...)` returns
   a new object → `allLines` recomputes. Fires on snapshot refresh, comment-post
   cache invalidation, AI-enrichment republish, inbox re-poll.

The fix is trigger-agnostic, so the mis-attribution does not change it — but the
acceptance test reproduces the **real** mechanism (a same-view `changes` swap),
not the phantom annotation one.

## Decision

Key the index-reset on the **stable view identity**, not the array reference.

`useChangeNavigation` gains a **required** `resetKey: string` parameter (typed
`string`, not `unknown`, so the compiler rejects passing the `changes` array or an
object identity — the exact mistake this fix prevents); the reset effect depends
on `[resetKey]`. The call site passes
`` `${selectedPath ?? ''}\n${wholeFileEnabled}` `` — the **same view identity** the
existing scroll-reset already uses (`DiffPane.tsx` line ~372,
`useEffect(... , [wholeFileEnabled, selectedPath])`); the two move in lockstep, a
real view swap resets both to the top and a same-file content recompute resets
neither. (The scroll-reset uses the raw `[wholeFileEnabled, selectedPath]`
dependency pair; the nav-reset uses a string built from the same two values —
identical *identity*, different syntactic form. `resetKey` is compared by value, so
a fresh string with the same contents does not re-fire.) The `\n` separator is
collision-proof: a newline can't appear in a file path, so no path+flag pair can
alias another. `resetKey` is required (not optional) so a future caller can't
silently pass `undefined`/a stale value and reintroduce #577.

On a same-file recompute, `currentIdx` is **not snapped back to "1"**: while parked
the existing `remeasure` path (`if (!animatingRef.current)
setCurrentIdx(computeCurrentIdx(...))`) re-derives it from the live scroll position
against the new geometry; during an in-flight jump (`animatingRef = true`) it stays
pinned to the jump target, and `remeasure` instead **clamps** the pinned index into
the new bounds (so the counter can never read "N of M" with N > M when the change
set shrank) and **re-aims** the smooth scroll at the target row's new top.

`wholeFileEnabled` here is the **derived** whole-file mode (`DiffPane` receives
`deriveWholeFileEnabled(...)`, which ANDs in `!failedPaths.has(selectedPath)`), not
a raw toggle flag. So an async whole-file **success** leaves it `true` → key stable
→ index survives the load; a whole-file **failure** flips it `true→false` → key
changes → index resets — which is correct, because the same flip fires the
scroll-reset to the top, so counter and scroll stay in lockstep.

### Rejected alternative

**Content signature inside the hook** (reset when a `length + startLineNum[]`
signature changes). Rejected: a whole-file toggle keeps the same `startLineNum`s,
so the signature would not change and the index-reset would **diverge** from the
scroll-reset that still fires on toggle (scroll jumps to top, counter stays put).
Reusing the component's existing view-identity key avoids that split-brain.

## Secondary fix: mid-animation target staleness

The programmatic smooth-scroll clears `animatingRef` only when scroll arrives
within 2px of `targetTopRef` (line ~142). If content height shifts mid-animation
(a same-view recompute landing during the ~300–600ms scroll), `targetTopRef` is
stale and arrival may never fire, leaving `animatingRef` stuck until the 1200ms
`ANIM_CAP_MS` cap — during which scroll-derived counter tracking is suppressed.

The primary fix **removes** the incidental "rescue" the old reset gave (it cleared
`animatingRef` on every recompute), so this window is no longer masked. Rather than
leave it to the cap, `remeasure` now re-aims `targetTopRef` at the pinned change's
new top and re-issues the scroll, so the jump settles via the arrival check
normally (read via a `currentIdxRef` so it isn't a `remeasure` callback dep — that
would re-measure on every navigation step). This was raised as the issue's
secondary suspect ("re-validate the mid-animation arrival logic against
content-height changes") and is now handled, not deferred.

## Update (B1 live validation): two further root causes of the "double-click / counter desync"

Driving the running app against this PR's own multi-hunk `useChangeNavigation.ts`
diff surfaced that the reset fix above was necessary but **not sufficient** — the
counter still drifted from the click count and the view sometimes didn't move.
Two additional root causes, both in how `currentIdx` is *re-derived from scroll
position* (which clobbers the deterministic pin `goToChange` sets):

1. **Activation-margin boundary under-count.** `goToChange(i)` snaps the change to
   exactly `startTops[i] − SCROLL_MARGIN` (8px), landing it *on* the activation
   boundary. The browser then settles `scrollTop` to a device-pixel integer a
   sub-pixel **below** the fractional target, so `computeCurrentIdx(scrollTop,
   margin=8)` reads `startTops[i] <= scrollTop + 8` as **false** and returns the
   *previous* change / −1. A parked `remeasure` (content still settling) re-derived
   that value and wiped the pin → the first "Next" landed change 1, a parked
   remeasure reset the pin to −1, and the next click re-navigated to change 1 (the
   double-click). Measured live: `startTops[0] = 201.40625`, target `193.40625`,
   settled `scrollTop = 193`, `201.40625 <= 201` → false → −1.
   **Fix:** a dedicated `ACTIVATION_MARGIN = SCROLL_MARGIN + 4` for derivation, so
   a snapped change reads as reached despite rounding (still well under the
   minimum change spacing, so the next change never activates early).

2. **Final-viewport clustering (maxTop clamp).** Changes packed into the last,
   unscrollable viewport all clamp to the **same** `scrollTop = maxTop`, so
   position cannot distinguish them — `computeCurrentIdx` can only ever return the
   last *scroll-reachable* change. Position-derivation is therefore fundamentally
   incapable of addressing those changes; the **pin is the only source of truth**.
   **Fix:** a `pinnedIdxRef` holds the last jump's index, and the derive paths
   (`remeasure` parked branch + scroll handler) yield to it while the scroll is
   still within `PIN_RELEASE_PX` (8px) of the jump target. Once the user scrolls
   away (including via keyboard, which fires `scroll` but no wheel/pointer
   gesture) the pin releases and position drives again. This subsumes (1) for
   jumps (the pin can't be clobbered at all while parked) while `ACTIVATION_MARGIN`
   keeps **manual** scroll-to-a-change correct.

### Display decision (reverses #486): em-dash above the first change

`ChangeNavControls` previously clamped the "above the first change" state
(`currentIdx === −1`) to `"1"` (no em-dash, #486). That made the *first* "Next"
appear to do nothing — the number stayed `"1"` while the view jumped to change 1.
The counter now reads `"— / M"` above the first change and `"1 / M"` only when
actually on change 1, so every advance increments the counter in lockstep with the
click. (Owner-approved during B1: the em-dash is the honest representation of "not
yet on a hunk".)

### Live proof (8-change file)

`— / 8` → Next ×8 → `1…8 / 8` (each click advances exactly one; changes 6–8 share
the clamped `scrollTop = 1871` because the view can't scroll further — correct);
Prev ×3 → `7,6,5`; file-switch → `— / N`; at `4 / 8` Refresh PR (same-view
recompute) holds `4 / 8`.

## Acceptance criteria

1. Same file open, `changes` recomputes (new identity, same content/view) → counter
   **does not snap back to "1"**; an in-flight advance survives. — covered by
   `useChangeNavigation.test.tsx` "preserves currentIdx when changes recomputes".
2. A single "Next change" always advances exactly one hunk. — same test
   (`goToNext` → `currentIdx` 1 → 2).
3. A genuine view swap (different file / whole-file toggle / whole-file failure)
   still resets to the top. — "resets currentIdx to the top when the view identity
   changes".
4. A same-view recompute that **shrinks** the change set clamps the pinned index to
   `total-1` — the counter never reads "N of M" with N > M. — "clamps a pinned
   index into bounds when a same-view recompute shrinks the set".
5. A mid-animation recompute re-aims the in-flight jump at the moved target (settles
   via arrival, not the 1200ms cap). — "re-aims an in-flight jump at the moved
   target".
6. Live, AI-enabled multi-hunk file with whole-file load / re-fetch churn: counter
   stays correct and single "Next" always advances; reduced-motion (`behavior:
   'auto'`) settles within the cap. — B1 live assert.

## Files

- `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.ts`
  — add required `resetKey` param; reset effect deps `[changes]` → `[resetKey]`;
  `remeasure` clamps + re-aims the pinned index during an in-flight jump.
- `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` — pass
  `` `${selectedPath ?? ''}\n${wholeFileEnabled}` `` as the reset key.
- `frontend/src/components/PrDetail/FilesTab/DiffChangeNav/useChangeNavigation.test.tsx`
  — regression tests (red-on-main captured).
