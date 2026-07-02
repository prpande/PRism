# #327 — Decompose DiffPane, FilesTab, PrHeader

**Issue:** [#327](https://github.com/prpande/PRism/issues/327) (2026-06 code-quality epic #317). **Tier:** T3, hands-off (machine doc-review substitutes the human gates). **Risk:** pixel-identical refactor; no Axis-B surface. Re-classify to B1 if any intentional visual delta appears.

**Premises re-verified against main on 2026-07-02.** The issue's June line refs are stale; current refs are used throughout. Already fixed on main and **out of scope**: gutter-button JSX (shared `NewGutterCell` exists), the `3em` gutter constants (now `--diff-gutter-w`), `onSessionRefetch` memoization in PrDetailView (`useCallback` at `PrDetailView.tsx:487-490`), and the synthetic-h-scrollbar `height: 14px` mirrors (issue marks them "when next touched" — this work does not touch them).

## Goal

Three components mix orchestration, layout, and policy, and carry internal duplication:

| File | Lines now | Target |
|---|---|---|
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` | 1,305 | ≤ ~400 |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` | 804 | orchestration only; subsystems in hooks |
| `frontend/src/components/PrDetail/PrHeader.tsx` | 693 | layout + action row |

Behavior-preserving decomposition, shipped as **three sequential PRs** (slice 1 DiffPane → slice 2 FilesTab → slice 3 PrHeader). Each PR leaves the app pixel-identical and all existing suites green.

## Non-goals

- No visual or interaction changes of any kind.
- No new memoization *policy* beyond what restoring component boundaries yields; `<tbody>` virtualization and theme-toggle word-diff caching stay in #688 (items 1 and 3).
- Slice 2 stabilizes the identities crossing the DiffPane boundary, which **delivers the "FilesTab-originated re-render bailout" half of #688 item 2** — cross-link it in the PR, do not close #688.
- No breakpoint value changes (the `900` stays `900`; #146's 1180px sheet is separate, coordinated by using one named constant it can later edit).
- The four newer menu/dismissal copies and modal chrome belong to #328, not here.

## Approach

Considered:

1. **Sibling-file extraction within existing directories (chosen).** Row components and hooks move to sibling files under `DiffPane/`; FilesTab/PrHeader subsystems become hooks in the same directories. Smallest diff, no import churn outside the touched directories, matches repo convention (`DiffChangeNav/` already holds `useChangeNavigation.ts` beside its components).
2. Full subdirectory restructure (`DiffPane/rows/`, `FilesTab/hooks/`). Cleaner tree but renames every test-file import path and inflates the diff for zero behavior gain. Rejected.
3. Dedup-only (extract `AnnotationRows`, unify handlers, keep the monolith). Fails the ≤ ~400-line and memoizability acceptance criteria. Rejected.

## Slice 1 — DiffPane (PR 1)

Current single-file contents: orchestrator (`:226-905`) with `renderUnifiedRows` (`:553`) / `renderSplitRows` (`:641`) closures capturing ~15 outer variables; `MergedPairedContent` (`:71`, memo), `NewGutterCell` (`:185`), `DiffLineRow` (`:928`, memo), `SplitDiffLineRow` (`:1072`, memo), `ComposerSlot`; whole-file failure latch (`:283-332`).

Extractions (all new files sibling to `DiffPane.tsx`, importing the existing `DiffPane.module.css`):

- **`AnnotationRows.tsx`** — the `<tr className={styles.aiHunkRow}><td colSpan={colSpan}><AiHunkAnnotation …/></td></tr>` block currently emitted verbatim ×4 (`:585, :604, :702, :720`). A fragment-returning component would also work (cf. `DiffLineRow`, which already returns a fragment of up to three `<tr>`s), but the four sites push into a `rows` array, so the seam is a **function returning `tr` elements**, `annotationRows({ annotations, colSpan, keyPrefix })` — per-annotation keys stay at the call site and the diff is smallest. One definition, four call sites.
- **`DiffLineRow.tsx`**, **`SplitDiffLineRow.tsx`**, **`MergedPairedContent.tsx`**, **`gutter.tsx`** (`NewGutterCell` + `ComposerSlot`) — moved verbatim with their `React.memo` wrappers and prop types. The 3 near-identical `handleClick` closures inside `SplitDiffLineRow` (`:1100, :1179, :1225`, differing only in `anchoredLineContent`: `content ?? ''` ×2, `newText ?? ''`) collapse into one `makeGutterClick(anchoredLineContent)` helper; `DiffLineRow`'s structurally-similar handler (`:986`) adopts the same helper.
- **`useWholeFileFailureLatch.ts`** — the ~50-line latch (`localFailure` state, `prevStatus` ref, fire-once effect, file-navigation clear with initial-mount skip, `dismissBanner`, `retryWholeFile`). Returned surface: `{ failure, dismiss, retry }`.
- **`UnifiedDiffBody.tsx` / `SplitDiffBody.tsx`** — the two render closures become components with **explicit props** (`lines`, `threadsByLine`, `annotationsForFile` (hunk-mode map, distinct from `annotationsByRowIdx`), `annotationsByRowIdx` (whole-file mode), `wholeFileEnabled`, `wholeFileFetchStatus`, `colSpan`, `syntax`, `onLineClick`, `renderComposerForLine`, `replyContext`, `collapse`, `changeStartMap`, `changeEndMap`, `selectedPath`, and — added in slice 2 — `activeComposerKey`; the plan enumerates the full list from the closure bodies). They render the `<tbody>` rows. Wrapping them in `React.memo` is what "diff body memoizable" means. **Phasing (per Risks):** extract first *without* `React.memo`, suites green, then add the `memo` wrappers still within slice 1; the bail-out cannot pay off until slice 2 stabilizes the callback identities, so the render-count *test* lands in slice 2, and until then the memo compare simply never bails (harmless).
- **`prUrl` → `htmlUrl`** rename at the DiffPane boundary (`:129, :233`, forward at `:902`; caller `FilesTab.tsx:786`) — the issue's "rename at next touch"; this is the touch. `DiffTruncationBanner`'s own `prUrl` prop renames too (single consumer, same PR).

DiffPane.tsx keeps: hooks/orchestration, scroll wiring, table skeleton (`colgroup`, sticky header), and composition of the above. Expected ≈ 350–400 lines.

**Testing:** the nine existing `DiffPane.*.test.tsx` suites (including `rowMemo.perf` and `wordDiffMemo.perf`) are the behavior guard and must pass unmodified except for (a) import-path updates if any test reaches into internals and (b) the mechanical `prUrl` → `htmlUrl` prop rename in test fixtures (`rowMemo.perf` and `wordDiffMemo.perf` both pass `prUrl: ''`). Both perf tests mock external module paths (`HighlightedLine`, the `diff` package), so the file moves don't invalidate their counting mechanism (verified). New: a focused unit test for `useWholeFileFailureLatch` (fire-once, clear-on-navigation, initial-mount skip — currently only covered indirectly). The hook's `retry` is conditionally `undefined` today (only when `onWholeFileRetry` is provided) — the extracted surface preserves that optionality.

## Slice 2 — FilesTab (PR 2)

- **`useOptimisticComments.ts`** (sibling to FilesTab.tsx) — owns `optimistic` state (`:391`), `refetchGenRef` (`:397`), prune effect + fallback timer (`:408-418`), `optimisticByThread` memo (`:423-430`), dedup-by-`databaseId` filtering (`:529, :646`), and the `onPosted` (`:577-596`) / `onReplyPosted` (`:647-661`) mutators. Surface: `{ optimisticByThread, optimisticForLine(path,line,realComments), notePosted(...), noteReplyPosted(...), }` — exact shape settled at plan time against the existing `optimisticComment.ts` helpers it wraps.
- **`useInlineComposer.ts`** — `activeAnchor` (`:378`), `composerDraftId` (`:379`), `activeComposerFlushRef` (`:383`), `findExistingDraft` (`:432`), `openComposerAt` (`:444`), `handleLineClick` (`:457`), `handleComposerClose` (`:486`).
- **Stable identities across the DiffPane boundary.** `handleLineClick` via the latest-ref pattern (already used in DiffPane for the n/p handler); `renderComposerForLine` via `useCallback` whose deps exclude `activeAnchor` by reading it through a ref, with the per-line active check inside — per #688 item 2's analysis.
- **Composer-location invalidation channel (required correctness counterpart).** Today the composer mounts/unmounts *because* `renderComposerForLine` is a fresh closure every render, busting every row memo. Once it's stable and the bodies are memoized, an `activeAnchor` change would alter **no** prop of the memoized bodies/rows — the composer would never open or close. So slice 2 threads an explicit **`activeComposerKey: string | null`** (`"${filePath}:${lineNumber}"` when a composer or optimistic placeholder is present, else `null`) through `UnifiedDiffBody`/`SplitDiffBody` (and into the row-level memo compare where a row's own key matches or stops matching), making the memo break exactly when the composer's location changes.
- **`replyContext` identity.** The `replyContext` memo's deps include `draftSession.session?.draftComments`/`draftReplies` and `optimisticByThread`, so its identity churns on every autosave refetch and reaches every unified-mode `DiffLineRow` — stabilizing only the two callbacks is not enough. Slice 2 splits `replyContext` into a stable-callbacks bag (latest-ref-backed) plus per-widget data resolved at render time inside the widget (exact split settled at plan time against `ExistingCommentWidget`'s consumption).
- **Render-count acceptance test** (extends the existing `rowMemo.perf` harness pattern): (a) typing in an open composer — spanning at least one autosave refetch in unified mode — does not re-render `DiffLineRow`s; (b) the inverse: clicking a line mounts the composer row, closing removes it (guards the `activeComposerKey` channel against staleness).
- **Single tree build:** FilesTab keeps its `useMemo(() => buildTree(files))` (`:188`) and passes the built tree to `FileTree` as a prop; `FileTree.tsx:151` drops its duplicate. The `tree` prop is **additive** — `files` stays, because FileTree uses it beyond tree-building (viewed count, empty state, header count). `FileTree.test.tsx` / `FileTree.scrollbar.test.tsx` fixtures gain the prop. FileTree has no consumers besides FilesTab (verified).
- **`useViewportWidth` (`:73-83`) deleted** in favor of the existing `hooks/useMediaQuery.ts`; the three literal `900`s (`:159, :336, :707`) become one exported `SPLIT_DIFF_MIN_WIDTH = 900` constant consumed through a single subscription (e.g. one `useIsSplitCapable()` wrapper feeding `effectiveDiffMode`, the shortcut guard, and `splitDisabled` — final shape at plan time) so #146 has a single edit point. `useMediaQuery('(min-width: 900px)')` — the *inverse* of the CSS `@media (max-width: 899px)` breakpoint, at the same 900px threshold — is equivalent in browsers to the current `window.innerWidth >= 900` check for integer viewport metrics (fractional widths differ by <1px and only transiently; accepted).
  **Test-environment caveat (breaks the "suites pass unmodified" guarantee for two named files):** jsdom has no `matchMedia`, and `frontend/__tests__/setup.ts:28-43` installs a stub returning `matches: false` for *every* query with no-op listeners — so `useMediaQuery('(min-width: 900px)')` reports narrow in all jsdom tests while `useViewportWidth` sees jsdom's default `innerWidth` of 1024 (wide). `__tests__/FilesTab.test.tsx` (split-radio default + the `<900` branch driven by redefining `window.innerWidth`, a mechanism matchMedia never observes) and `FilesTab.viewPreservation.test.tsx` (asserts `diff-pane--split`) would fail. Fix in the same PR: upgrade the global stub to evaluate `(min-width: Npx)` / `(max-width: Npx)` queries against `window.innerWidth` at call time (preserving `matches: false` for non-width queries so existing per-test overrides — e.g. InboxPage's save/restore pattern — keep working), and convert viewport-changing tests to re-render or per-test matchMedia mocks where the stub's no-op listeners can't observe a mid-test change. The "pass unmodified" guard is scoped to exclude exactly this named test-infrastructure change.
- Handler-convention cleanup: everything crossing a memoized child boundary is `useCallback`; local-only helpers may stay plain.

**Testing:** existing `FilesTab.*` + `optimisticComment.test.ts` suites; new unit tests for the two hooks; the new render-count test above.

## Slice 3 — PrHeader (PR 3)

- **Error-copy map out of the component:** the `SubmitConflictError → string` switch (`:333-373`) moves to `frontend/src/api/submit.ts` next to `KnownSubmitErrorCode` (whose comment already binds it to `PrSubmitEndpoints.cs`), as a pure exported function `submitErrorMessage(err)`.
- **`useSubmitFlow.ts`** (sibling to PrHeader.tsx) — `onResume` (`:316`), `surfaceSubmitError` (`:375`), `surfaceForeignReviewError` (`:393`), `onResumeForeignPendingReview` (`:411`), `onDiscardForeignPendingReview` (`:419`), `onDiscardAllDrafts` (`:430`), `handlePillDiscard` (`:442`), `patchVerdict` (`:305`), and the two related effects (`:279-303`). PrHeader consumes the returned handlers and renders layout + action row.

**Testing:** existing `PrHeader.test.tsx` / `PrHeader.actions.test.tsx`; new unit test for `submitErrorMessage` (pure function, one case per `KnownSubmitErrorCode`).

## Acceptance criteria (per issue, re-scoped to verified state)

1. Annotation-row markup defined once; gutter click-handler logic defined once. (Slice 1)
2. `DiffPane.tsx` ≤ ~400 lines; row components in sibling files; diff bodies are memoizable components. (Slice 1)
3. Typing in a composer (spanning an autosave refetch) no longer re-renders the diff table, and composer open/close still updates the affected rows — render-count test with inverse assertion. (Slice 2)
4. One `buildTree` per diff change; `useViewportWidth` deleted; breakpoint literal named once. (Slice 2)
5. PrHeader free of error-copy mapping and submit orchestration. (Slice 3)
6. Pixel-identical rendering: full frontend suite + e2e parity baselines green, no baseline regen. (All slices)

## Sequencing & mechanics

- Three PRs from three branches, each rebased on the prior merge (per-issue worktree; slice branches cut sequentially).
- Each PR: full pre-push checklist (`.ai/docs/development-process.md`), `/simplify` before the verify gate, pr-autopilot to green-and-ready, then notify (hands-off — human merges).
- `Closes #327` only on PR 3; PRs 1–2 reference `#327` bare. PR 2 cross-references #688 item 2.
- Doc maintenance: no `.ai/docs/` file documents these internals; no doc edits expected beyond this spec and its plan.

## Risks

- **Hidden coupling in the render closures.** The closures capture ~15 variables; converting to explicit props risks missing a reactive dependency (a prop that changes without re-rendering the body if memo deps are wrong). Mitigation: extraction first without `React.memo`, suites green, then add `memo` with the render-count test proving both bail-out and non-staleness (thread highlight, annotation arrival, collapse toggle each still update — covered by existing suites).
- **Perf-test brittleness.** `rowMemo.perf` / `wordDiffMemo.perf` count renders; moving components must not change their observable render counts. If a perf test needs its import path updated, that's allowed; behavior thresholds are not.
- **FileTree prop change** (slice 2) touches `FileTree.tsx`'s public props — check its own tests and any e2e locators (none reference the tree-building seam; locators are DOM-based).
