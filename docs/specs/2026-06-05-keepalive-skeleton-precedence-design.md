# Keep-alive skeleton precedence (#180) — design

**Issue:** [#180](https://github.com/prpande/PRism/issues/180) — returning to a kept-alive Files tab resets the selected file + scroll position.

**Tier/Risk:** T2, gated B1 (UI-visual). Pause for a visual assert after green-and-ready; the human merges.

## Problem

Under keep-alive (#166/#168), every visited PR-detail view stays mounted so its sub-tab, selected file, and scroll position survive a tab switch. But returning to a tab triggers a brief skeleton flash that **partially resets the view**: you remain on the Files sub-tab, yet the selected file reverts to the first file and both the file-tree and diff scroll jump to the top.

## Root cause

The reset is **not** the auto-select effect re-firing. `useFileDiff` is keyed on `[owner, repo, number, range]` — none change on re-activation — so the diff never refetches, `fileList` keeps its identity, and the auto-select guard (`FilesTab.tsx`) does not re-run.

The real mechanism is a **skeleton-unmount**:

1. On re-activation (`active` false→true), `useActivationTransition` calls `reload()` (`PrDetailView.tsx`).
2. `reload()` bumps `reloadCounter`, re-running `usePrDetail`'s effect, which sets `isLoading = true` **unconditionally**. `data` is deliberately kept (it is cleared only on PR-navigation, so the page does not flash empty).
3. The detail GET to GitHub exceeds `useDelayedLoading`'s `WAIT_MS` (100 ms), so `showSkeleton` flips true (and holds ≥ `HOLD_MS` = 300 ms).
4. `PrDetailView` renders `showSkeleton ? <PrDetailSkeleton/> : data ? <content/> : null`. **The skeleton wins even though `data` is still present**, so the entire `data ?` subtree — `PrDetailContextProvider` wrapping `OverviewTab`/`FilesTab`/`DraftsTab` — unmounts.
5. `FilesTab` loses its local state (`selectedPath`, `viewedPaths`) and its inner diff/tree scrollers are destroyed. On data-return it **remounts fresh**, auto-selecting the first file with scroll at the top.

One mechanism explains both reported symptoms (file resets *and* scroll resets) and the "small refresh" feel — a ~300 ms skeleton swap that blows away the kept-alive subtree. `useTabScrollMemory` only restores the outer `[data-app-scroll]` scroller, never the inner diff/tree scrollers, so those depend entirely on the subtree staying mounted.

The defect is a precedence contradiction: `usePrDetail` keeps `data` across same-PR reloads expressly to avoid a flash, but `PrDetailView` then shows the skeleton anyway — which is worse than an empty flash, because it unmounts everything.

## Fix

Gate the page skeleton on the **absence of data**:

```tsx
{!data && showSkeleton ? (
  <PrDetailSkeleton />
) : data ? (
  <PrDetailContextProvider value={ctxValue}>…</PrDetailContextProvider>
) : null}
```

- **Initial load** (`data === null`, `showSkeleton` true after 100 ms): skeleton shows, unchanged.
- **PR navigation A→B**: `usePrDetail` clears `data` on the key change, so `data === null` and the skeleton shows for the fresh PR, unchanged.
- **Same-PR background reload** (re-activation freshness, or the manual Reload button): `data` is present, so content stays mounted and updates in place — no skeleton, no unmount, no lost selection or scroll.

This is the minimal correct change at the right altitude: it aligns the render with `usePrDetail`'s existing data-preservation intent rather than special-casing the re-activation path or plumbing scroll restoration into the inner containers. Because the subtree is no longer unmounted, the inner diff/tree scroll positions survive naturally (a `hidden`/re-shown element retains its descendants' `scrollTop`).

### Why not the alternatives

- **Guard the auto-select effect to fire only on first mount.** Wrong layer and incomplete: the auto-select effect is not what fires (the diff does not refetch); it would not address the scroll reset or the OverviewTab/DraftsTab state loss, all of which stem from the unmount.
- **Persist + restore inner scroll across the skeleton swap.** Treats the symptom: it would still unmount FilesTab (losing composer state, viewed-checkbox state, etc.) and reintroduce a visible flash. The unmount is the disease.
- **Suppress the re-activation reload entirely.** Regresses #168's freshness contract (a returned-to tab must re-GET).

## Scope

- **Change:** one render-gate edit in `frontend/src/components/PrDetail/PrDetailView.tsx`.
- **Tests:** the red-on-main regression in `PrDetailView.freshness.test.tsx` (showSkeleton + data present → Files subtree and selection survive). Existing freshness tests (activation refetch, OQ6 error-preserves-content, OQ5 stale-selection reset) stay green — none assert skeleton-over-data.
- **No backend change. No B2 surface** (no auth/PAT, submit pipeline, migration, cross-tab stamp, sidecar, or architectural invariant).

## Acceptance criteria

- [ ] Returning to a kept-alive Files tab keeps the same file selected (no reset to first file).
- [ ] Returning keeps the inner diff + tree scroll position (no jump to top).
- [ ] No skeleton flash on a same-PR background reload while `data` is present.
- [ ] The cross-PR initial-load skeleton is unchanged (still shows when `data === null`).
- [ ] OverviewTab/DraftsTab local state likewise survives re-activation.
