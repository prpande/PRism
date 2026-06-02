# PR-root Post + Submit Discard — Deferrals

Deferrals surfaced during implementation of `docs/plans/2026-06-01-pr-root-post-and-submit-discard.md`. Each is a conscious scope decision recorded here rather than silently dropped.

## D1 — `already-posted-body-mismatch` recovery banner is data-reduced (Task 21)

**Spec § 4.7** prescribes the recovery banner copy: *"This comment was already posted on `{createdAt}`. Your edits since then haven't been shipped. `[Open on GitHub]` `[Discard local edits]`."*

**Reality:** the backend `PostMismatchErrorDto(string Code, string Message, long PostedCommentId)` (PrRootCommentEndpoints.cs / PrSubmitDtos.cs) carries **only** `PostedCommentId` — no `createdAt`, no comment `html_url`. So the full banner (timestamp + GitHub deep-link) is impossible to render from the current wire.

**Shipped instead:** a data-honest banner surfacing the comment id + a discard/reload instruction (`data-testid="post-error-already-posted"`), preserving the load-bearing semantics (already-posted + edits-not-shipped + concrete recovery path). No Retry, no auto-close.

**To restore the full spec banner (deferred):** enrich the backend mismatch DTO with `createdAt` + the comment `html_url` (thread GitHub's create-result `html_url` through), expose them on the frontend `PostRootCommentError`, then render the `[Open on GitHub]` link + timestamp. Low risk; the SSE refetch + discard/reload path already lets the user recover — the deferred piece is only the convenience link + timestamp.

## D2 — Optimistic "Posted ✓" badge (~600ms) not implemented (Task 21)

**Spec § 4.7 step 4** describes a ~600 ms "Posted ✓" badge shown before the composer closes, to mask the SSE-refetch window.

**Shipped instead:** `handlePost` calls `onClose()` immediately on the 204; the `RootCommentPostedBusEvent` SSE refetch (Task 14) reflects the posted comment + draft removal. Functional outcome is correct and complete — the badge is a pure perceived-latency nicety.

**Deferred:** add the optimistic badge to close the "did it work?" window. Pure UX polish, no correctness/data impact.

## D3 — Cross-surface lock holder read is non-reactive (ref-based registry) (Task 22, root cause Task 19)

`useDraftSession`'s open-composer registry is a `useRef<Map<string, Set<ComposerOwnerKey>>>` (Task 19). `getPrRootHolder()` reads that ref during render, and ref mutations don't trigger re-renders. So if a composer claims/releases the PR-root draft *while a consumer is already mounted*, the consumer's `cantEdit`/Edit-disabled state can be stale until the next unrelated re-render — a theoretical under-locking window (both surfaces editing the same draft).

**Why it's not reachable in practice today:** the lock is read on a *fresh* render at SubmitDialog open (reset-to-preview effect → fresh `getPrRootHolder()` reads the current ref), so opening the dialog over an active Overview composer correctly disables Edit. The holder only changes via composer mount/unmount (UI-driven), and the SubmitDialog's modal backdrop blocks Overview-tab interaction while it's open — so the holder cannot change underneath an open dialog through the UI. The symmetric direction (Overview composer disabling while the dialog edits) is likewise gated by the backdrop.

**Deferred (correct fix):** make the registry reactive — bump a `composerVersion` state counter inside `registerOpenComposer`/its cleanup (or store `openComposers` as state rather than a ref) so `getPrRootHolder`/`isOpen` consumers re-render on registry change. Assess both surfaces together. Low priority given the backdrop makes the gap unreachable via normal UI.
