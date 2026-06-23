# Wire the Overview "Viewed" stats tile (#442)

**Status:** spec (T3-sized refactor, gated B1)
**Issue:** [#442](https://github.com/prpande/PRism/issues/442) — deferred from #330.

## Problem

The Overview tab's **Viewed** stats tile is hardcoded to `viewedCount={0}`
(`OverviewTab.tsx`), so it permanently reads `0 / N`.

## Premise correction (important)

The issue says to source the count from "the persisted file-view state (the same
state the Files tab reads)." **The Files tab does not read persisted viewed
state.** Its `viewedPaths` is a local `Set<string>` initialized empty on every
mount (`FilesTab.tsx:164`) and only filled by in-session checkbox clicks
(`handleToggleViewed`, lines 302–327). It is never hydrated from the backend.

The genuinely-persisted viewed state **is** available client-side, just unused by
the tabs:

- Backend persists `ReviewSessionState.ViewedFiles: Dictionary<path, headSha>`,
  written only by `POST /files/viewed` (`PrDetailEndpoints.cs:203`). `viewed:false`
  **removes** the entry (`viewedFiles.Remove(canonical)`, line 255). (`/mark-viewed`
  is unrelated — it writes tab stamps + the unread-comment anchor. The issue's
  mention of `postMarkViewed` is a red herring.)
- It is already returned to the frontend on the draft-session GET as
  `ReviewSessionDto.fileViewState.viewedFiles` (`PrDraftEndpoints.cs:566`;
  TS type `frontend/src/api/types.ts:421-433`).
- `useDraftSession`'s `mergeSession` takes `fileViewState` verbatim from the
  server, so any `refetch()` / reload picks up the latest persisted value.

So persisted viewed state is reachable; the gap is that nothing consumes it.

## Decision (owner-selected): shared-state refactor

Lift viewed-state into a single shared source so the Files tab and the Overview
tile read the **same** state, hydrated from persistence. This also fixes a latent
gap: the Files-tab checkboxes will reflect persisted views on load instead of
always starting unchecked. That is a **user-visible rendered-output change → B1
(UI-visual) gated**; pause for the human visual assert after green-and-ready.

### Design — `useFileViewState` (derive + optimistic overlay)

New hook `frontend/src/hooks/useFileViewState.ts`. Rather than seeding and owning a
mutable `Set` (which loses a toggle made before the seed arrives, or loses
persisted state if the seed is skipped — see Rejected alternatives), `viewedPaths`
is **derived** from the persisted server state plus a local optimistic overlay:

```ts
export interface FileViewState {
  viewedPaths: Set<string>;
  toggleViewed: (path: string) => void;
}

export function useFileViewState(
  prRef: PrReference,
  headSha: string | undefined,                               // data?.pr.headSha — undefined while detail loads
  persistedViewedFiles: Record<string, string> | undefined,  // draftSession.session?.fileViewState.viewedFiles
): FileViewState
```

- **`serverViewed` (memo):** the **head-matched** persisted set —
  `{ path | persistedViewedFiles[path] === headSha }`. Empty when `headSha` or the
  session is undefined. Recomputed only when `persistedViewedFiles` / `headSha`
  change.
- **`overrides` (state):** `Map<path, boolean>` of in-flight / locally-toggled
  intentions. Cleared whenever the **key** (`owner/repo/number@headSha`) changes —
  i.e. on a new PR or a head advance.
- **`viewedPaths` (memo):** `serverViewed` with `overrides` applied
  (`true` adds, `false` deletes). Stable reference unless server state or overrides
  actually change — so the context value it feeds only changes on real viewed
  changes, not every render.
- **`toggleViewed(path)` (stable `useCallback`):** `desired = !current`; set
  `overrides[path] = desired` (optimistic); `postFileViewed(prRef, { path, headSha,
  viewed: desired })`. On error, **delete** that override so the value falls back to
  `serverViewed` (the pre-toggle truth — same rollback semantics as the current
  `handleToggleViewed`). No-op if `headSha` is undefined (tabs are only interactive
  after detail loads, so this is the load-window guard, not a reachable UX path).

Why the overlay is correct where seed-once is not: a toggle that races ahead of the
first server response lands in `overrides` and is layered onto `serverViewed` the
moment it arrives — neither the toggle nor the persisted set is lost. A later
`draftSession.refetch()` that carries newer server state is reflected automatically
(overlay still wins for in-flight paths), so cross-tab marks delivered by an
unrelated refetch appear rather than being suppressed.

### Wiring

`PrDetailView` instantiates the hook next to `draftSession` / `fileFocus` /
`pendingFilePath`, reading `draftSession.session?.fileViewState.viewedFiles` and
`data?.pr.headSha`, and adds `{ viewedPaths, toggleViewed }` to the existing
`PrDetailContextValue` it memoizes. Because `viewedPaths` is memo-stable and
`toggleViewed` is `useCallback`-stable, `ctxValue` changes only when viewed state
actually changes — when all readers should update anyway. (A dedicated second
context to spare the two light hidden tabs a re-render per user-paced click was
weighed and rejected as not worth the extra provider + test-fixture churn.)

**Consumers (complete list):**

- `FilesTab` — drops its local `viewedPaths` / `handleToggleViewed`; reads
  `viewedPaths` + `toggleViewed` from context. Two call sites rewire:
  the `FileTree` props (`viewedPaths`, `onToggleViewed`) and the **`v` keyboard
  shortcut** (`FilesTab.tsx:376` — `onToggleViewed` handler), now calling context
  `toggleViewed`.
- `OverviewTab` — replaces `viewedCount={0}` with
  `countViewedFiles(diff.data?.files ?? [], viewedPaths)`.
- `StatsTiles` — add an accessible label to the Viewed tile so screen readers read
  "Viewed: N of M files" rather than "N slash M".
- New pure helper `countViewedFiles(files, viewedPaths)` =
  `files.filter(f => viewedPaths.has(f.path)).length`, exported from the hook
  module. `OverviewTab` (over `diff.data.files`) and `FileTree`'s existing
  `viewedCount` memo (over its `files` prop) both call it — one definition, two
  file-list inputs.
- `frontend/src/components/PrDetail/testUtils.tsx` — `makePrDetailContextValue`
  enumerates every field, so it must gain `viewedPaths` (default empty `Set`) and
  `toggleViewed` (default no-op) or every `renderWithPrDetailContext` test fails to
  typecheck.

### Count bound

`countViewedFiles` filters over the current diff's files, so
`0 ≤ viewedCount ≤ filesCount` is guaranteed by that filter alone — independent of
head-matching. (A head-matched `viewedPaths` path absent from the Overview's diff
range is simply not counted.)

### Head-staleness semantics

Each persisted entry is stamped with the head it was marked at, and stale entries
are never pruned. The backend rejects writes at a stale head (409), so viewed-state
is conceptually head-scoped. `serverViewed` therefore counts **only entries
matching the current `headSha`**; after a head advance the key changes, overrides
clear, and the tile + checkboxes reset to `0/N` until files are re-viewed at the new
head. This matches the backend's write-gate semantics. The reset is **silent** (the
checkboxes reset too, so the tile stays consistent with them) — a "previously
viewed at an older head" affordance is out of scope for this slice and a candidate
follow-up; flagged for the owner at the B1 visual assert.

### Loading / empty state

The tile renders `countViewedFiles(...)/filesCount`. While the diff loads,
`filesCount` is `0` and the tile reads `0/0` — unchanged from today's behavior
(the existing stub already produced `0/0` during load), so this introduces no new
loading-state regression. No skeleton is added.

### Live update

Toggling in the Files tab mutates the shared overlay → `viewedPaths` recomputes →
the Overview tile and the Files-tab tree re-render immediately (same source).
Cross–browser-tab changes are not live-synced (no SSE on `/files/viewed`); they
appear after a reload, per the existing snapshot/freshness model — consistent with
AC#2's "next render/reload." No staleness indicator is added (consistent with how
other reload-gated state is handled); flagged for the owner at the B1 assert.

## Rejected alternatives

- **Minimal: Overview reads `draftSession.fileViewState` directly** (no shared
  state). Smaller, but doesn't fix the Files-tab hydration gap and gives no live
  in-tab cross-update. Owner chose the refactor.
- **Hydrate-once into a local `Set`.** A toggle before the first seed is either
  clobbered by the seed, or (if the seed is skipped on a dirty flag) the persisted
  set is lost for the session. The derive+overlay model has neither failure.
- **Dedicated `FileViewStateContext`.** Avoids re-rendering the two light hidden
  tabs per toggle, but adds a provider + test fixtures for a negligible,
  user-paced cost. Rejected.

## Residual risks (noted, not blocking)

- **Snapshot-vs-detail head drift:** if a background `pr-updated` SSE advances the
  cached snapshot head while the loaded detail still shows the old head
  (`headShaChanged` drift), a write stamped at the new head won't match the
  detail's `headSha`, so the tile under-counts until reload — consistent with the
  freshness model.
- **NFC path parity:** persisted keys are the backend's NFC-canonical form; a diff
  path in decomposed Unicode wouldn't match. Narrow — the write path's
  `IsPathInAnyCachedDiff(canonical)` check means canonical already matches a
  cached-diff path.
- **Override staleness:** a succeeded override persists over `serverViewed` until
  the key changes; a cross-tab unmark wouldn't surface until reload. Acceptable
  under the reload-freshness model.

## Tests (TDD)

- `useFileViewState`: derives head-matched entries; ignores stale-head entries;
  a toggle made **before** persisted state arrives is preserved once it arrives
  (overlay race); clears overrides on headSha/PR key change; `toggleViewed`
  optimistic + rollback (delete override) on POST failure; POSTs the right body;
  no-op when `headSha` undefined.
- `countViewedFiles`: counts intersection; bounded `0 ≤ n ≤ files.length`.
- `OverviewTab`: tile shows real `viewed/total` bounded to diff files; reflects a
  shared toggle; `0/total` when none viewed; aria-label present.
- `FilesTab`: checkboxes reflect derived persisted state on load; checkbox and the
  `v` shortcut both route through the shared `toggleViewed`.
- Existing-test fixups: `FilesTab.viewPreservation.test.tsx` (drive the toggle
  through the shared state — the override persists across a prDetail rerender since
  `PrDetailView` doesn't remount on a data swap) and `testUtils.tsx` stub.
- Regression guard: `FileTree.test.tsx` viewed behavior stays green.

## Gates

Ship gate: all ACs green **and** the owner completes the **B1 visual assert**
(Files-tab checkboxes reflect persisted views on load; tile shows the real count)
before merge. The status-header "gated B1" refers to this gate.

## Acceptance

- [ ] Overview "Viewed" tile shows the real head-matched viewed/total count, correct on cold load.
- [ ] Marking a file viewed in the Files tab updates the Overview tile live and persists across reload.
- [ ] Files-tab checkboxes reflect persisted views on load. (B1 visual assert.)
