# DiffPane render-perf memoization (#670)

**Tier:** T2 · **Risk:** hands-off (perf-only, no rendered-output change, no B2 surface)
**Scope:** `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` **only.**
(The spec's first draft proposed `useCallback` changes in `FilesTab.tsx`; the
`ce-doc-review` feasibility pass showed they are unnecessary for the dominant win —
see "Why no FilesTab change" below. They are deferred.)

## Problem

`DiffPane` is the app's most expensive component and its hot path is unmemoized.
Verified against current `main`:

1. **`fileThreads` + `threadsByLine` rebuilt every render** (`DiffPane.tsx:496-502`) —
   plain `.filter()` + a fresh `Map`, while every *other* derived structure in the
   file is `useMemo`'d (`allLines`, `gutterDigits`, `annotationsByRowIdx`, `changes`,
   the boundary maps). The fresh `Map` identity also defeats row-level memo, because
   each row receives a new `threadsAtLine` reference.
2. **`MergedPairedContent` re-runs `diffWordsWithSpace` + `mergeWordDiffWithTokens`
   every render** (`DiffPane.tsx:103-109`) — the per-paired-line word-diff cost. An
   in-code `PERF (PoC-deferred)` note already flags it.
3. **`DiffLineRow` (`:903`) and `SplitDiffLineRow` (`:1044`) are not `React.memo`'d**,
   so React reconciles every `<tr>` (up to `MAX_FILE_LINES = 2000`) on any parent
   re-render — including the *frequent* change-nav scroll re-renders.

### Why it matters
This plan targets **re-render jank**, not initial-mount jank (see Scope boundary).
On a re-render, interactions that should be cheap — **scrolling** (change-nav
re-renders `DiffPane` to update `currentIdx`), opening/closing a composer, toggling
a thread — currently re-run the row builder over up to 2000 lines, re-reconcile every
`<tr>`, and re-invoke the word-diff per paired line. Visibly janky on large diffs.

### Relative leverage (the two costs are non-substitutable)
- **Word-diff cost** = (paired lines, a *small subset* per the in-code note) × per-line
  cost. Dominant on **modify-heavy** diffs. Addressed by change #2.
- **Row-reconciliation cost** = (all lines, up to 2000) × reconcile cost. Dominant on
  the **common large diff that is mostly insert/delete/context lines** — the exact
  large-diff case #670 names. Addressed by change #3.

Neither change substitutes for the other; both ship.

## Approach

Three changes, all in `DiffPane.tsx`, all preserving rendered output exactly.

### 1. Memoize the thread maps (prerequisite)
Hoist `fileThreads` + `threadsByLine` from below the early-return guards into a
`useMemo` keyed on `[reviewThreads, selectedPath]`, alongside the other derived
`useMemo`s (above the guards, for rules-of-hooks). Removes the per-render `Map`
rebuild **and** gives each row a stable `threadsAtLine` reference (the precondition
for change #3 to bail). `selectedPath`/`reviewThreads` are available before the
guards; the empty-guard branches return before the maps are read, so computing them
unconditionally is harmless (`reviewThreads` is small).

### 2. Memoize the word-diff: `React.memo(MergedPairedContent)`
Wrap `MergedPairedContent` in `React.memo`. Props: `syntax, side, lineNum, oldText,
newText`. `syntax` is `useSyntaxTokens`'s `useMemo`'d return (stable `EMPTY` sentinel
until tokens genuinely change), so its identity survives unrelated renders; the rest
are primitives derived from memoized `allLines`. Default shallow compare bails on
every unrelated re-render and skips `diffWordsWithSpace` — **even when the parent row
re-renders** (the memo is per instance).

**Why memo-the-component over an internal `useMemo`:** `MergedPairedContent` has two
early returns (no-tokens fallback `:76`, token/blob-mismatch fallback `:94`) before
the word-diff at `:107`. An internal `useMemo` would have to run unconditionally above
those returns, computing `diffWordsWithSpace` for large/suppressed files that always
fall back to `WordDiffOverlay` — a regression for exactly the large-diff case this
issue targets. `React.memo` caches the whole output (fallbacks included) with no
hooks-ordering hazard. This is the "or memo the component" option the in-code note
itself suggests.

### 3. `React.memo` the row components — `DiffLineRow` + `SplitDiffLineRow`
Default shallow compare; the rows are pure functions of their props
(`handleClick`/`renderContent` close only over props, no external mutable reads).
After change #1 makes `threadsAtLine` stable, all row props are referentially stable
across a **scroll re-render**, so the rows bail instead of all ~2000 reconciling.

**Why no FilesTab change is needed for the scroll win.** A scroll updates change-nav
state that lives *inside* `DiffPane` (`useChangeNavigation` at `:422`), so a scroll
re-renders `DiffPane` only — `FilesTab` is **not** in that render path. The callbacks
`FilesTab` passed down (`onLineClick`, `renderComposerForLine`) therefore keep their
identities from the previous `FilesTab` render across every scroll re-render, so the
row `React.memo` bails without any `useCallback`. Stabilizing those callbacks would
only help `FilesTab`-*originated* re-renders (a rarer case) and is non-trivial
(`renderComposerForLine` closes over `activeAnchor` and ~12 other values; a naive
`useCallback` either goes stale — composer fails to open — or changes identity every
render — no benefit). Deferred (see below).

## Scope boundary & explicit non-goals
- **Re-render jank only, not initial-mount jank.** `React.memo`/memoized derivations
  never help the first paint: opening a file still builds up to 2000 rows and runs the
  word-diff for every paired line once. If a large-file *open* hitches, the fix is
  virtualization (issue step 4), **deferred**. This plan addresses the enumerated
  re-render interactions (scroll, composer, thread toggle).
- **`FilesTab` callback stabilization** (for `FilesTab`-originated re-render bailout) —
  deferred; needs the `activeAnchor`-dep `useCallback` design above, out of scope here.
- **Whole-`<tbody>` virtualization** (issue step 4) — deferred; the row builder still
  allocates the element array each render (cheap relative to the word-diff and DOM
  reconciliation that #2/#3 eliminate). Tracked on #670 for a follow-up.
- **Theme-toggle word-diff caching** — a theme change legitimately changes `syntax`,
  so `React.memo(MergedPairedContent)` re-runs the (theme-independent) word-diff on
  toggle; caching across themes needs an internal `useMemo` keyed `[oldText, newText]`
  only, which reintroduces the early-return hazard. Deferred.
- **Composer-open and thread-collapse-toggle still re-render rows** — those change a
  parent-supplied prop identity (`renderComposerForLine`/`collapse`), so the memoized
  rows do not bail on them. Change #2 still spares the word-diff on those renders.

## Test strategy
Two regression guards (existing suite is the correctness backstop):

1. **Word-diff sparing (guards change #2 specifically — not the whole perf claim).**
   `vi.mock('diff', async (importOriginal) => { const actual = await importOriginal();
   return { ...actual, diffWordsWithSpace: vi.fn(actual.diffWordsWithSpace) }; })` —
   a wrapping mock (not `vi.spyOn`; `diff@9` is an externalized ESM dep whose named
   export can't be redefined in place), preserving real behavior so output is
   unchanged. Precondition: `await getHighlighterAsync()` and assert against a **paired
   line whose token concatenation equals the normalized side content**, so the word-diff
   path at `:107` actually runs (otherwise the render hits the `WordDiffOverlay`
   fallback, which uses `diffWords`, and `diffWordsWithSpace` is never called). Render
   a paired-line diff, record the call count, trigger an unrelated re-render (rerender
   with a thread added on a *different* line), assert the paired line's call count does
   not increase.

2. **Row-render bailout (guards change #3 — the dominant scroll cost).** Instrument a
   row's render (e.g. a `vi.fn` render-counter via a spy on a module-level function the
   row calls, or a test-only wrapper) and assert it is **not** re-invoked when an
   unrelated line's thread toggles while all other props are referentially stable —
   the scroll-equivalent condition. This is the assertion the word-diff count alone
   cannot make.

Plus: the full existing DiffPane suite (`DiffPane.test.tsx`, `.highlight`,
`.threadHighlight`, `.changeNav`, `.lineNumbers`, `.stickyViewport`, `.driftGuard`)
must pass unchanged — the correctness backstop that no memo dropped a needed
re-render (stale render).

## Proof obligations (issue-resolution-workflow)
- Non-bug (tech-debt/perf): new tests authored test-first (red→green within PR
  history) + acceptance checklist.
- Secrets scan over the diff.
- `ce-doc-review` dispositions recorded in the PR `## Proof`.
