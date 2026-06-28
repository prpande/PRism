# Issue #603 — Frontend reliability / re-entrancy hardening

Branch: `fix/603-fe-reentrancy-abort` (off `main`). Frontend-only; backend (#605)
and desktop (#607) are owned by parallel issues and untouched here.

Four independent defects, each fixed TDD-first.

## A (Major) — `useReconcile` had no re-entrancy guard / abort / mounted guard

File: `frontend/src/hooks/useReconcile.ts` (+ `frontend/src/api/draft.ts`
`postReload` gains an optional `signal`).

`reload()` previously:

- fired a POST on every call (two rapid Reload clicks → two POSTs; whichever
  resolved last won, regardless of recency);
- had no timeout / AbortController (a hung fetch left `state==='reloading'`
  forever);
- set state and called `onReloadComplete()` unconditionally, so a reload that
  resolved after the view tore down warned (setState-after-unmount) and fired the
  completion callback against a dead view.

Fix mirrors the sibling `usePrDetailRefresh`:

- `inFlight` ref guard — a second `reload()` while one is in flight is a no-op.
- A single `AbortController` + 30s timeout spanning the initial POST **and** the
  stale-head auto-retry; on timeout the fetch aborts and surfaces the generic
  banner (`postReload` maps the abort to its no-throw `network` result).
- A `mounted` ref; the terminal outcome (banner / state / `onReloadComplete`) is
  applied once at the end and skipped entirely if the view unmounted.

The branch logic is refactored to compute a single terminal `outcome`
(`{ complete, banner, state }`) so the mounted-gate and `inFlight`/timer cleanup
live in one place instead of being duplicated across every return.

Tests (`frontend/__tests__/useReconcile.test.ts`): double-click fires one POST
and the late resolver can't clobber; unmount-mid-reload fires neither
`onReloadComplete` nor a state update; a hung fetch aborts after the timeout and
lands on the generic error banner. Existing `toHaveBeenNthCalledWith` assertions
updated for the new `signal` arg.

## B (Major, UI-mitigated) — `useSubmit` submit/retry had no re-entrancy guard

File: `frontend/src/hooks/useSubmit.ts`.

`submit`/`retry` (both via `fire`) lacked the in-flight guard the foreign
Resume/Discard actions already have via `foreignActionInFlightRef`. A rapid
double-fire let POST#2's pre-pipeline 409 (the pending review POST#1 already
created) run its catch — clearing ownership + idling the dialog — which dropped
POST#1's later `Finalize:Succeeded` SSE.

Fix (defense-in-depth; `SubmitDialog` already freezes controls in-flight):

- `submitInFlightRef` re-entrancy guard — a second `fire()` while the POST is in
  flight is a no-op (mirrors `foreignActionInFlightRef`). Cleared in `finally`
  after the POST resolves (the SSE-driven phase is intentionally not guarded).
- `submitGenRef` generation token — the catch only reverts ownership/state when
  its captured generation is still current, so a superseding fire can't have its
  ownership clobbered by an older call's late rejection.

Test (`frontend/__tests__/useSubmit.test.tsx`): a double-fire issues exactly one
POST; POST#1's `Finalize:Succeeded` is honored and the trailing POST resolution
does not clobber the success state.

## C (Major) — optimistic comment placeholder could become a permanent duplicate

Files: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`,
`frontend/src/components/PrDetail/FilesTab/optimisticComment.ts`.

De-dup was keyed solely on `databaseId === postedCommentId`. `databaseId` is
genuinely nullable and real GitHub responses ship `databaseId: null` (fixture
`pr19-graphql-response.json`), so a posted comment can surface without it → the
dimmed "posting" placeholder never drops → a permanent visible duplicate.

Fix: a bounded fallback eviction (`pruneOptimistic` in `optimisticComment.ts`,
unit-tested pure function):

- fast path unchanged — drop on `databaseId` match;
- fallback — drop a placeholder once **a refetch has landed after it was
  created** (generation counter) **and** it has aged past a small bound
  (`OPTIMISTIC_FALLBACK_MAX_AGE_MS = 4000`), independent of any `databaseId`
  match.

`OptimisticComment` gains an optional `createdGen` (generation at creation).
FilesTab bumps a `refetchGenRef` whenever `allRealComments` changes (each refetch
yields a fresh array), stamps `createdGen` at placeholder creation, and runs the
prune both when a refetch lands and on a one-shot timer scheduled for the age
bound (so a `databaseId`-less placeholder still evicts without a further refetch).

Test (`frontend/src/components/PrDetail/FilesTab/optimisticComment.test.ts`): a
placeholder whose real comment returns with `databaseId: null` is retained before
the age bound and evicted once a refetch has landed and it has aged out; the
`databaseId` fast-path and the "no refetch yet → keep" cases stay correct.

## D (Minor) — AI fetch hooks abandoned but did not abort

Files: `frontend/src/hooks/useAiHunkAnnotations.ts`,
`useAiDraftSuggestions.ts`, `useFileFocusResult.ts` and their API modules
(`api/aiHunkAnnotations.ts`, `api/aiDraftSuggestions.ts`, `api/aiFileFocus.ts`).

Each used a `cancelled` flag (correctly discards stale resolutions) but threaded
no `AbortSignal`, so abandoned fetches on PR-switch / gate-toggle / unmount ran to
completion. Fix mirrors `useWholeFileContent`: each effect creates an
`AbortController`, threads `controller.signal` through the API call, and aborts in
cleanup. The `cancelled` flag is retained (guards setState).

Tests: each hook aborts the in-flight request on unmount.

## Decisions / deviations

- `createdGen` is added as **optional** on `OptimisticComment` rather than
  required, to avoid churning unrelated belt-and-suspenders test literals;
  `pruneOptimistic` treats an absent generation as `0`. Production always stamps
  it.
- The eviction predicate is extracted as a pure function and unit-tested directly
  rather than driving it through a full `FilesTab` render — the heavy component
  harness adds no signal over the pure predicate for this defect.
- Public hook signatures are unchanged. Only internal API helpers (`postReload`
  and the three AI `get*` functions) gain an optional trailing `signal`.
</content>
</invoke>
