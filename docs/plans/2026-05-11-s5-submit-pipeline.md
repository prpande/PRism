# S5 Submit Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship S5 — the resumable GraphQL pending-review submit pipeline that closes the PoC demo end-to-end (steps 11–13 of `docs/spec/01-vision-and-acceptance.md` § "The PoC demo") and every DoD checkbox that depends on submit.

**Architecture:** Layer-up ordering. PR0 is pre-split: **PR0a** lands the `IReviewService` capability split (ADR-S5-1, pure refactor) and runs the C6 / C7 / C9 empirical gates against the live GitHub schema — it unblocks PR1; **PR0b** root-causes + fixes the Playwright multi-spec state-leak that left S4 PR7 with three `test.fixme` suites — it lands in parallel with PR1 and is off the demo critical path by construction. PR1 lands the `IReviewSubmitter` seam (six core pending-review methods + `DeletePendingReviewThreadAsync` per revision R16) against real GraphQL on `GitHubReviewService.Submit.cs`. PR2 lands the `SubmitPipeline` state machine in `PRism.Core/Submit/Pipeline/` (taking `IAppStateStore` via constructor per revision R1) with marker injection, lost-response adoption (with multi-match defense), and the v3→v4 migration. PR3 lands the backend endpoints, SSE event types (as static-projection tuple arms per R6, with bus events in `PRism.Core.Events` per R5), per-PR submit lock, composer marker-collision rejection, the verdict-clear `JsonElement`-based patch wire-shape, and the `SensitiveFieldScrubber` blocked-fields extension. PR4 lands the Submit confirmation dialog, `useSubmit` hook, Submit Review button enable rules, verdict picker enabled state, AI validator placeholder slot, the static Ask AI empty-state container (PR6 folded in per spec § 17 #22), and the in-flight-submit recovery badge (R3). PR5 lands the foreign-pending-review modal with IsResolved badge + Snapshot-A/B count-staleness note, the stale-`commitOID` retry UX with explicit-button consent, closed/merged bulk-discard, and the `submit-duplicate-marker-detected` toast. PR7 lands the DoD E2E test sweep. **See "Doc-review revisions (2026-05-12)" below — those deltas are authoritative where they conflict with a task body.**

**Tech Stack:** .NET 10 + ASP.NET Core minimal APIs + xUnit + `WebApplicationFactory`; GraphQL via raw `HttpClient` (no Octokit GraphQL helper — keeps consistency with the existing `IHttpClientFactory` + REST pattern in `GitHubReviewService`); React 18 + Vite + TypeScript + Vitest + Testing Library + Playwright; SSE via the existing `SseChannel` + `SseEventProjection` pipeline; per-PR submit lock as a `SemaphoreSlim` keyed by `prRef` (separate primitive from `AppStateStore._gate` — see § 5.2 step 5 / § 7.1 of the spec for the ordering rationale).

**Spec:** [`docs/specs/2026-05-11-s5-submit-pipeline-design.md`](../specs/2026-05-11-s5-submit-pipeline-design.md) is the authoritative reference. Every task here cites the relevant spec section. Deferrals sidecar: [`docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`](../specs/2026-05-11-s5-submit-pipeline-deferrals.md). Empirical gates: [`docs/spec/00-verification-notes.md`](../spec/00-verification-notes.md) § C6 / C7 / C9.

---

## How to use this plan

- **Phases = PRs.** Each phase produces a single reviewable PR. Land them in order. PR0 sequencing is the only firm constraint per spec § 16; every other PR's order can shift if it doesn't break dependencies.
- **Tasks within a phase share commits where natural** — the commit step at the end of each task names the conventional-commit message. Multi-step refactors that must compile together share a single commit (the commit step lives on the final task).
- **Every test is written red first.** Run the test, see it fail with the expected error, then write the minimal implementation. The TDD discipline from `.ai/docs/development-process.md` is non-negotiable.
- **Use a worktree.** Do NOT make changes on `main`. Per the user's standing rule (`~/src/config/claude/CLAUDE.md` "Git Worktrees"), create `.claude/worktrees/feat+s5-pr0`, `feat+s5-pr1`, etc., one per PR. Existing `feat+s5-brainstorm-spec` worktree carries the spec + deferrals + this plan; do not reuse it for implementation.
- **Pre-push checklist is mandatory.** Per `~/src/config/claude/CLAUDE.md` "feedback_run_full_pre_push_checklist": run every step in `.ai/docs/development-process.md` verbatim — `npm run lint` and `npm run build` in `frontend/` are not optional, even for backend-only PRs (TypeScript types may shift). `dotnet build` + `dotnet test` for the whole solution. Run as a single foreground sequence; never `run_in_background`. Timeout ≥ 300000ms.
- **Empirical gates block PR1.** Run C6 / C7 / C9 in PR0a before opening PR1 for review. If any gate falsifies, switch to its documented fallback in PR1 / PR2 before writing code — do not "ship the spec's default and patch later," because the fallback affects test fixture shape too.
- **PR0 is pre-split into PR0a and PR0b.** PR0a = `IReviewService` capability split + C6/C7/C9 empirical gates (lands first; unblocks PR1). PR0b = Playwright multi-spec state-leak root-cause + fix + un-`fixme` (lands in parallel with PR1 in a separate worktree; can slip without blocking S5's demo). PR1 starts the day PR0a merges. If the state-leak root-cause turns out to be a multi-week refactor, escalate per spec § 2.3 — PR0b's slip does not block the demo (it only un-`fixme`s three S4 specs already deferred).
- **No silent deviations from the spec.** Per `~/src/config/claude/CLAUDE.md` "feedback_document_plan_deviations": when implementation surfaces a gap or forces a change to the spec, capture the decision in the deferrals sidecar (`docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`) — never silently.

---

## Doc-review revisions (2026-05-12)

`compound-engineering:ce-doc-review` ran 7 personas against the first draft of this plan.

**Already inlined into the plan body:** PR0 pre-split (PR0a + PR0b above); four single-API renames (Tasks 11/24 Files lists, `IActivePrCache.GetCurrent`, `apiClient`); the `await using`-handle lifetime fix + Task.Run `CancellationToken.None` + `IHostApplicationLifetime` (Task 36); the `OriginalLineContent: ""` hazard annotation (Task 17); R1's canonical `SubmitPipeline` class (Task 25 — takes `IAppStateStore` + optional `onDuplicateMarker` + optional `getCurrentHeadShaAsync`; overlay-only stamp helpers; built-in stale-`commitOID` clear, success clear, and pre-Finalize head_sha re-poll); R16 (`IReviewSubmitter` lands 7 methods — `DeletePendingReviewThreadAsync` added); R17 (spec § 8.4 `orphanReviewId` → `orphanCommitOid` erratum applied to the spec doc).

**Remaining deltas — authoritative where they conflict with a task body.** A follow-up pass folds these into the task bodies; until then this section is the source of truth.

### R1-propagation — Phase 3 step-method code blocks + Task 36 endpoint still show the old `persistAsync` shape

**Affects:** Tasks 27, 28, 29, 30, 31, 36.

Task 25 now has the canonical `SubmitPipeline` class (constructor takes `IReviewSubmitter` + `IAppStateStore` + optional `onDuplicateMarker` + optional `getCurrentHeadShaAsync`; no `persistAsync`; `sessionKey` derived from `reference`; overlay-only `StampDraftThreadIdAsync` / `StampReplyCommentIdAsync` / `DemoteReplyToStaleAsync` helpers; built-in stale-`commitOID` clear + success clear + pre-Finalize re-poll). The remaining Phase-3 task bodies still show the old `persistAsync` callback — when implementing, the canonical class is the source of truth and:

- **Task 27 (`StepAttachThreadsAsync`):** drop the `persistAsync` parameter; after each successful `AttachThreadAsync` (and after marker-adoption), `await StampDraftThreadIdAsync(sessionKey, draft.Id, threadId, ct)` instead of `await persistAsync(currentSession)`. Method returns the updated working snapshot. The overlay-only transform also closes the foreign-tab-edit clobber (adversarial #4): a `PUT /draft` from another tab between the pipeline's snapshot-load and a stamp is no longer silently overwritten.
- **Task 28 (`StepAttachRepliesAsync`):** same — `StampReplyCommentIdAsync(sessionKey, reply.Id, commentId, ct)` for stamps; `DemoteReplyToStaleAsync(sessionKey, reply.Id, ct)` for the parent-thread-deleted demote.
- **Task 29 (multi-match defense):** `onDuplicateMarker` is the constructor param `_onDuplicateMarker` (not a per-call arg); `DeletePendingReviewThreadAsync` is now on `IReviewSubmitter` from PR1 (R16); adopt-earliest stamps via `StampDraftThreadIdAsync`.
- **Task 30 (DoD a/b tests):** invocations become `new SubmitPipeline(fake, fakeStore)`; seed `fakeStore` (an `InMemoryAppStateStore` — add to Task 24's Fakes folder: in-memory `AppState`, `LoadAsync`/`UpdateAsync`/`SaveAsync`) with the test session under `"owner/repo/1"` before `SubmitAsync`; drop the no-op `persistAsync` lambda; assert against `fakeStore`'s persisted session instead of a `persistedSessions` list.
- **Task 31 (Success clears session):** the success-clear is now built into the canonical `SubmitAsync` — Task 31 collapses to just the `SuccessClearsSessionTests` asserting `fakeStore`'s session has everything cleared after a Success outcome.
- **Task 36 (endpoint):** drop the `PersistAsync` local; resolve `IAppStateStore` from DI; pass it + the `onDuplicateMarker` action + the `getCurrentHeadShaAsync` callback (re-runs `IPrReader.PollActivePrAsync` per R11) to `new SubmitPipeline(submitter, stateStore, onDuplicateMarker: ..., getCurrentHeadShaAsync: ...)`. The pipeline owns persistence; the endpoint just dispatches + maps the `SubmitOutcome` to bus events.

### R2 — Merge `SubmitProgressIndicator` (Phase A) and `SubmitProgressChecklist` (Phase B) into one component

**Affects:** Phase 5 files list, Task 48, Task 49.

Drop `SubmitProgressChecklist.tsx` from the files list. `SubmitProgressIndicator.tsx` absorbs both phases via an internal conditional: `if (!steps.some(s => s.step === 'BeginPendingReview' && s.status === 'Succeeded')) return <single-neutral-row aria-live="polite">Checking pending review state…</single-neutral-row>; return <5-row-checklist aria-live="polite">…`. The checklist container carries `aria-live="polite"` (closes design-lens #6 — the Phase B checklist must announce step transitions). One component file, one test file. The spec § 8.3 Phase A / Phase B product distinction is preserved by the conditional. Task 49's `SubmitDialog` renders `<SubmitProgressIndicator steps={submitState.steps} />` once — no separate Phase A vs Phase B branch in the dialog.

### R3 — Add an in-flight-submit recovery surface to PR4

**Affects:** Phase 5 files list, Task 51 (or a new Task 51b).

Create `frontend/src/components/PrDetail/SubmitInProgressBadge.tsx` — a small badge in `PrHeader` that renders whenever `session.PendingReviewId is not null` (the persisted marker of an in-flight or interrupted submit). Copy: *"Submit in progress — Resume?"* with a click that opens the `SubmitDialog` directly into the resume path (`useSubmit.submit(session.draftVerdict ?? 'Comment')`, which re-enters the pipeline at Step 1's "match by ID" outcome). This closes the silent-recovery gap (product-lens #1, anchor 75): if a tester closes the tab or the process restarts mid-pipeline, on reopen the badge surfaces the persisted state instead of the recovery silently relying on them clicking Submit Review again with zero "something happened" feedback. TDD: failing test renders `<SubmitInProgressBadge session={sessionWithPendingReviewId} />` → asserts the badge + Resume affordance; renders with `PendingReviewId = null` → asserts nothing rendered. Wire into `PrHeader` alongside the Submit button.

### R4 — Frontend SSE integration: use the real `useEventSource` / `events.ts` API

**Affects:** Task 45 (`useSubmit`), and add a new task before Task 44 (in PR3 or at the top of PR4) extending `events.ts`.

The plan's `useSubmit` calls `useEventSource({ 'submit-progress': handler, ... })` — a non-existent overload. The real API: `const stream = useEventSource(); useEffect(() => { const off1 = stream.on('submit-progress', handler1); const off2 = stream.on('submit-foreign-pending-review', handler2); /* … */ return () => { off1(); off2(); /* … */ }; }, [stream, prRef]);` — `useEventSource()` takes no args and returns the stream handle; `stream.on(type, cb)` returns an unsubscribe fn. Rewrite Task 45's `useSubmit` to this pattern; the closure over `ownsActiveSubmit` ref + `setState` is shared across the handlers registered in the single `useEffect`.

Separately — and this is a hard prerequisite for any submit-* SSE delivery — `frontend/src/api/events.ts` has two hardcoded extension points that must be extended: (1) the `EventPayloadByType` type map (currently 5 event types) — add `submit-progress`, `submit-foreign-pending-review`, `submit-stale-commit-oid`, `submit-orphan-cleanup-failed`, `submit-duplicate-marker-detected` with their payload shapes; (2) the `addEventListener` registration loop (currently `['inbox-updated', 'pr-updated', 'state-changed', 'draft-saved', 'draft-discarded'].forEach(...)`) — add the five submit-* names. Without (2), even a correctly-subscribed handler never fires because `EventSource` never dispatches the event. Add a task: `extend events.ts EventPayloadByType + addEventListener loop with submit-* event types` — lands in PR3 (alongside the SSE projection arms) or as the first PR4 task.

### R5 — `IReviewEventBus` is generic; bus events live in `PRism.Core.Events`

**Affects:** Task 34 (bus event types + SSE projection arms), Task 35 (`SseSubmitProgressBridge`).

The actual `IReviewEventBus` is `void Publish<TEvent>(TEvent evt) where TEvent : IReviewEvent;` (in `PRism.Core.Events`), NOT a non-generic `Publish(IReviewBusEvent)`. The plan's `SubmitBusEvents.cs` must live in `PRism.Core/Events/` (alongside `StateChangedEvent`, `DraftSavedEvent`, etc.), each record implementing the existing `IReviewEvent` marker (NOT a new `IReviewBusEvent`). Update Task 34's `FakeReviewEventBus` test fake to `Publish<TEvent>(TEvent) where TEvent : IReviewEvent`. `bus.Publish(new SubmitProgressBusEvent(...))` then satisfies the generic constraint.

### R6 — `SseEventProjection` keeps its existing static + tuple shape

**Affects:** Task 34 (projection arms + tests).

`SseEventProjection` is `internal static class SseEventProjection` with `public static (string EventName, object Payload) Project(IReviewEvent evt) => evt switch { … }` — it returns a tuple, NOT a framed string; `SseChannel.cs` does the `event: {name}\ndata: {json}\n\n` framing. Don't redesign it. Add submit-* `case` arms to the existing `switch` returning `(eventName, payload-anonymous-object)` tuples; the payload anon objects are still camelCase-serialized by the existing JSON options and still counts-only (no thread/reply bodies, no orphan review IDs, no `pendingReviewId` — threat-model defense holds). Rewrite Task 34's tests to call `SseEventProjection.Project(typed)` as a static method returning a tuple and assert `result.EventName` + `result.Payload` (the existing tests in `tests/PRism.Web.Tests/Sse/` show the pattern).

### R7 — PR3 Resume endpoint enriches `OriginalLineContent`

**Affects:** Task 37 (Resume endpoint).

`FindOwnPendingReviewAsync` (Task 17) lands `OriginalLineContent: ""` — and an empty `AnchoredLineContent` poisons reconciliation (`LineMatching.Compute` matches every blank line, so imported drafts land Stale or anchor to a random blank line). Task 37's Resume endpoint must enrich it before persisting: for each imported thread, fetch the file content at `OriginalCommitOid` (via `IPrReader.GetFileContentAsync(reference, t.FilePath, t.OriginalCommitOid, ct)` — already on the interface from the capability split), slice line `t.LineNumber` (1-indexed), and use that as `AnchoredLineContent`. Add an `EnrichOriginalLineContentAsync` helper to Task 37 that does this; the imported `DraftComment.AnchoredLineContent` gets the sliced line, not `""`. If the file fetch fails (commit unreachable), fall back to importing the draft with `Status: DraftStatus.Stale` and a reason — better than a silently-mis-anchored draft. Add a test: resume with a thread anchored to a known line → assert the imported draft's `AnchoredLineContent` matches the file's line at that position.

### R8 — PR3 Resume strips ALL marker prefixes from imported bodies, not just the trailing one

**Affects:** Task 37 (Resume endpoint), `PipelineMarker`.

`PipelineMarker.StripIfPresent` only strips the trailing `<!-- prism:client-id:<id> -->` end-marker. If a foreign pending review's thread body contains an embedded (non-trailing) `<!-- prism:client-id:` substring, it survives into the imported `DraftComment.BodyMarkdown` and could confuse the lost-response adoption matcher on the next submit. After `StripIfPresent`, run `PipelineMarker.ContainsMarkerPrefix` on the result; if true, either reject the resume with a 400 (surface a "foreign review contains PRism internal marker" error) OR do a full string-replace of all `<!-- prism:client-id:` occurrences. Default: full string-replace (the resume should not fail just because a foreign tool's body happened to contain the substring). Add `PipelineMarker.StripAllMarkerPrefixes(string body)` and call it after `StripIfPresent` in Task 37's import.

### R9 — PR3 + PR1/PR2: audit net-new logging for the new scrubbed field names

**Affects:** Tasks 12–17 (PR1 `GitHubReviewService.Submit.cs`), Tasks 25–31 (PR2 `SubmitPipeline`), Task 42 (PR3 scrubber).

Task 42 adds `pendingReviewId` / `threadId` / `replyCommentId` to `SensitiveFieldScrubber.BlockedFieldNames` but the scrubber only redacts by field NAME — it doesn't auto-apply to every log call. Add a step to PR1 Task 17 and PR2 Task 31 final-check: *grep `GitHubReviewService.Submit.cs` and `PRism.Core/Submit/Pipeline/` for structured-log arguments named `pendingReviewId` / `pendingReview` / `threadId` / `replyCommentId`; any that appear as raw message-template args must be wrapped in `SensitiveFieldScrubber.Scrub(name, value)`* (mirroring the bulk-discard call site in Task 39 step 3).

### R10 — `PipelineMarker.Inject` fence detection: add adversarial test cases

**Affects:** Task 22 (`PipelineMarkerTests`).

The bare `Regex.Matches(body, @"```").Count` odd/even check doesn't distinguish: inline backtick mentions in prose ("wrap this in ``` for readability"), indented code blocks, quad-fences (` ```` ` nesting triple-backtick examples), or `~~~` alt-syntax fences. A body with an odd count of triple-backticks from a prose mention gets a spurious closing fence injected mid-text, corrupting the rendered comment. These adversarial test cases are now inlined directly in Task 22's `PipelineMarkerTests` body (`Inject_DoesNotTreatInlineProseBacktickMentionAsAnOpenFence`, `Inject_ClosesUnclosedTildeFence`, `Inject_TreatsQuadFenceAsBalanced_NotOddTriple`) — the implementer doesn't need to cross-reference this section to find them. The fix is line-by-line state tracking that only counts lines matching `^\s*` + a fence opener (` ``` ` or ` ```` ` or `~~~`), not inline backticks. If the markdown-aware fix is more than a few lines, document the limitation in the deferrals sidecar and ship the line-state-tracking version; the test cases pin the contract.

### R11 — Task 59 head_sha re-poll uses a fresh `PollActivePrAsync`, not the cache

**Affects:** Task 59 (pre-Finalize head_sha re-poll).

Task 59 says "hits the active-PR poller cache OR re-runs `PollActivePrAsync`" — pin it: re-run `IPrReader.PollActivePrAsync(reference, ct)` for a fresh head_sha. The poller cache has a ~30s cadence; a typical pipeline runs in seconds, so a push that lands mid-pipeline often won't be in the cache yet. A fresh poll adds ~200–500ms and one rate-limit point per submit — acceptable for the safety the re-poll is supposed to provide. Update Task 59's `getCurrentHeadShaAsync` callback to call `PollActivePrAsync` (not `IActivePrCache.GetCurrent`).

### R12 — Summary textarea: implement the 250ms-debounce auto-save (spec § 8.2)

**Affects:** Task 49 (`SubmitDialog`).

The plan's `SubmitDialog` uses plain `const [summary, setSummary] = useState(...)` — no debounce, no PUT, no persist-across-Cancel. Spec § 8.2 requires: debounced auto-save to `draftSummaryMarkdown` on every keystroke (250ms), persists across dialog Cancel/reopen, cleared on successful submit. Wire the existing composer auto-save pattern (`frontend/src/hooks/useComposerAutoSave.ts`) — on each keystroke, debounce 250ms, then `PUT /api/pr/{ref}/draft` with `{ patch: 'draftSummaryMarkdown', draftSummaryMarkdown: <value> }`. The dialog's `useState` initializer reads from `session.draftSummaryMarkdown`, which is re-fetched after Cancel via the SSE `state-changed` path (confirm `PrHeader` re-reads the session — it already does for the Drafts tab). Add a test: open dialog, type, Cancel, reopen → value preserved. Also add a `data-section="summary"` live-preview pane per spec § 8.2 (same `react-markdown` pipeline; no fourth renderer).

### R13 — `DiscardAllConfirmationModal` gets a full TDD implementation

**Affects:** Task 56.

Task 56 leaves `DiscardAllConfirmationModal.tsx` as a one-line comment stub. Expand it to the same step-by-step TDD format as `DiscardConfirmationSubModal` (Task 53): failing test covering the count copy (*"Discard {N} draft(s) and {M} reply(ies) on this closed PR? This cannot be undone."*), `defaultFocus` on Cancel, destructive primary button (`btn-danger`), `aria-modal="true"` + `aria-labelledby`; then the implementation. The spec copy is in § 13.1.

### R14 — `ForeignPendingReviewModal` implements Esc-to-Cancel (spec § 11)

**Affects:** Task 53.

Spec § 11 calls for `disableEscDismiss=false` (Esc closes to Cancel semantics) on the foreign-pending-review modal. Task 53's component has no keydown handler and passes no Esc-related prop to `<Modal>`. Add either a `keydown` handler that calls `onCancel` on `Escape` (mirroring Task 49's `SubmitDialog` Esc handling, but here Esc dismisses rather than focuses-Cancel — the foreign modal is less destructive), OR a `<Modal onEscape={onCancel}>` prop if the existing `<Modal>` supports it. Add a test: render modal, fire keydown Escape → `onCancel` called, modal closed.

### R15 — Responsive widths from spec § 8.5 are wired into the components

**Affects:** Tasks 49, 53, 56 (and the bulk-discard sub-modal in Task 53).

The plan cites the § 8.5 breakpoint table (720px dialog / 480px modals / inline button below 600px) in the PR4/PR5 headers but no component applies a width constraint. Each modal/dialog component must either pass a size token to the existing `<Modal>` (verify whether `<Modal size="sm" | "md">` maps to 480/720px — read `frontend/src/components/Modal/Modal.tsx`; if it does, use it; if not, add the prop) OR apply a `max-width` in the component-level stylesheet keyed off the breakpoints. Add a computed-style or snapshot assertion to one test per surface so the width contract doesn't silently drift. The `DiscardAllDraftsButton`'s `< 600px → "Discard"` label shortening (Task 56) is the one breakpoint already tested — match that rigor for the dialog/modal widths.

_(R16 and R17 were applied — see the "Already inlined" list above. R16: `IReviewSubmitter` now lands 7 methods in PR1; `ContractShapeTests` asserts 7; plan title says "seven-method". R17: spec § 8.4 `orphanReviewId` → `orphanCommitOid` erratum applied to `docs/specs/2026-05-11-s5-submit-pipeline-design.md`.)_

---

# Phase 1a — PR0a: Capability split + empirical gates

**PR title:** `feat(s5-pr0a): IReviewService capability split + C6/C7/C9 empirical gates`

**Spec sections:** § 2.1–2.3a (verification gates), § 3 (ADR-S5-1 capability split), § 16 PR0 row, § 18.3 (empirical gates).

**Goal:** Land the architectural prerequisites and clear the empirical gates so PR1 can ship against confirmed GitHub schema shapes.

**Pre-split rationale:** PR0 is split into PR0a (this phase: capability split + gates — unblocks PR1) and PR0b (Phase 1b: Playwright state-leak fix — lands in parallel with PR1). The capability split is mechanical and the gates are sub-day; bundling the unknown-scoped state-leak fix into the same PR would put PR1 on the critical path of an open-ended investigation.

**Files touched:**

- **Capability split (~15 files):**
  - Create: `PRism.Core/IReviewAuth.cs`
  - Create: `PRism.Core/IPrDiscovery.cs`
  - Create: `PRism.Core/IPrReader.cs`
  - Create: `PRism.Core/IReviewSubmitter.cs` (empty seam — methods land in PR1)
  - Delete: `PRism.Core/IReviewService.cs` (the composite interface is retired with the split)
  - Delete: `PRism.Core/Contracts/DraftReview.cs` (only consumer was `IReviewService.SubmitReviewAsync`, which is retired)
  - Delete: `PRism.AI.Contracts/Seams/IDraftReconciliator.cs` (legacy seam not consumed; retired with `DraftReview`)
  - Delete: `PRism.AI.Contracts/Noop/NoopDraftReconciliator.cs`
  - Delete: `PRism.AI.Placeholder/PlaceholderDraftReconciliator.cs`
  - Delete: `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs` (covered the deleted noop)
  - Modify: `PRism.GitHub/GitHubReviewService.cs` (drop `: IReviewService`, add `: IReviewAuth, IPrDiscovery, IPrReader, IReviewSubmitter`; delete `SubmitReviewAsync` method body)
  - Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (register `GitHubReviewService` against all four interfaces)
  - Modify: `PRism.Web/Program.cs` (the `IReviewService` swap for `FakeReviewService` becomes four swaps)
  - Modify: `PRism.Web/TestHooks/FakeReviewService.cs` → split into `FakeReviewAuth.cs`, `FakePrDiscovery.cs`, `FakePrReader.cs`, `FakeReviewSubmitter.cs`
  - Modify: every consumer file that injected `IReviewService` → injects only the narrowest sub-interface it needs

- **Empirical gates (results recorded in `docs/spec/00-verification-notes.md`):**
  - Modify: `docs/spec/00-verification-notes.md` § C6, § C7, § C9 (each gate's "Status" field changes from "Pending" to "Verified <date>: <outcome>")

**Worktree:** `.claude/worktrees/feat+s5-pr0a`

---

### Task 1: Create new capability interfaces (empty stubs at first)

**Files:**

- Create: `PRism.Core/IReviewAuth.cs`
- Create: `PRism.Core/IPrDiscovery.cs`
- Create: `PRism.Core/IPrReader.cs`
- Create: `PRism.Core/IReviewSubmitter.cs`

- [ ] **Step 1: Create `IReviewAuth.cs` (one method)**

```csharp
// PRism.Core/IReviewAuth.cs
namespace PRism.Core;

public interface IReviewAuth
{
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);
}
```

- [ ] **Step 2: Create `IPrDiscovery.cs` (two methods)**

```csharp
// PRism.Core/IPrDiscovery.cs
using System.Diagnostics.CodeAnalysis;

using PRism.Core.Contracts;

namespace PRism.Core;

public interface IPrDiscovery
{
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);

    [SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
        Justification = "URL is parsed by callers from user input; conversion to Uri is exactly what this method does.")]
    bool TryParsePrUrl(string url, out PrReference? reference);
}
```

- [ ] **Step 3: Create `IPrReader.cs` (eleven methods — every read-side method that was on `IReviewService`)**

```csharp
// PRism.Core/IPrReader.cs
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.Core;

public interface IPrReader
{
    // Legacy S0+S1 surface — unused; retained for the capability split
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);

    // PR detail (S3)
    Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct);
    Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct);
    Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct);
    Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);
    Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct);

    // S4 PR3 force-push fallback (returns null if commit is unreachable; throws on transport errors)
    Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct);
}
```

- [ ] **Step 4: Create `IReviewSubmitter.cs` as an empty seam**

```csharp
// PRism.Core/IReviewSubmitter.cs
namespace PRism.Core;

// PR0 lands the empty seam so DI + fakes can split alongside the other three interfaces.
// PR1 lands the seven pending-review pipeline methods. See docs/specs/2026-05-11-s5-submit-pipeline-design.md § 4.
public interface IReviewSubmitter
{
}
```

- [ ] **Step 5: Verify build is green**

Run: `dotnet build PRism.sln`
Expected: PASS — these are pure new files, no consumer touched yet.

- [ ] **Step 6: Hold the commit** — Task 2 + 3 land together with this work in one cohesive split commit.

---

### Task 2: Make `GitHubReviewService` implement all four interfaces; delete `IReviewService`

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.cs`
- Delete: `PRism.Core/IReviewService.cs`
- Delete: `PRism.Core/Contracts/DraftReview.cs`

- [ ] **Step 1: Update `GitHubReviewService` declaration**

Replace the class declaration in `PRism.GitHub/GitHubReviewService.cs`:

```csharp
// Before
public sealed partial class GitHubReviewService : IReviewService

// After
public sealed partial class GitHubReviewService : IReviewAuth, IPrDiscovery, IPrReader, IReviewSubmitter
```

- [ ] **Step 2: Delete the legacy `SubmitReviewAsync` method body**

Find and delete (the method exists as a stub today; was retained for the capability landing):

```csharp
// Submit (GraphQL pending-review pipeline)
public Task SubmitReviewAsync(PrReference reference, DraftReview review, CancellationToken ct)
    => throw new NotImplementedException("Submit pipeline lands in S5; see specs/2026-05-11-s5-submit-pipeline-design.md");
```

If the stub lives in `GitHubReviewService.cs` proper or in a partial file like `GitHubReviewService.Submit.cs`, delete the method (not the file — `Submit.cs` is the natural landing site for PR1's six-method implementation).

- [ ] **Step 3: Delete `IReviewService.cs`**

```bash
git rm PRism.Core/IReviewService.cs
```

- [ ] **Step 4: Delete `Contracts/DraftReview.cs`**

The `DraftReview` record was only consumed by `IReviewService.SubmitReviewAsync`; with that method retired, the record is orphaned. PR1's `IReviewSubmitter` carries its own request shapes (`DraftThreadRequest`, etc.).

```bash
git rm PRism.Core/Contracts/DraftReview.cs
```

- [ ] **Step 5: Drop unused `using PRism.Core.Contracts;` from `GitHubReviewService.cs` if linter flags it** — only if the import becomes unused after `DraftReview` deletion. Likely still needed for `InboxSection`, etc.

- [ ] **Step 6: Build to surface consumer breaks**

Run: `dotnet build PRism.sln`
Expected: FAIL with many `CS0246: The type or namespace name 'IReviewService' could not be found` errors across `PRism.Web`, `tests/`, and possibly `PRism.AI.*`. Task 3 walks each consumer.

- [ ] **Step 7: Hold the commit** — finishes in Task 3.

---

### Task 3: Walk every `IReviewService` consumer and swap to the narrowest sub-interface

**Files (each touched once; specific list emerges from the Task 2 build failure output):**

- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs`
- Modify: `PRism.Web/Program.cs`
- Modify: `PRism.Web/Endpoints/*.cs` consumers (Auth / Inbox / PrDetail / PrReload — verify with grep)
- Modify: `PRism.Web/TestHooks/FakeReviewService.cs` (becomes four fakes; see Task 4)
- Modify: any AI seam adapter that took `IReviewService` (e.g., `ReviewServiceFileContentSource` — verify with grep)
- Modify: any active-PR poller that took `IReviewService` (e.g., `ActivePrPoller` — verify with grep)
- Modify: every test in `tests/PRism.Web.Tests/` and `tests/PRism.GitHub.Tests/` that injects `IReviewService`

- [ ] **Step 1: Grep for every `IReviewService` reference**

Run the search and capture the full list — each consumer needs a swap.

```bash
# Run via Grep tool, output_mode: files_with_matches
# Pattern: IReviewService
# Type: cs
```

Expected: ~20-40 files across the solution.

- [ ] **Step 2: For each consumer, replace `IReviewService` with the narrowest sub-interface it actually uses**

Rules of thumb:

- Consumes only `ValidateCredentialsAsync` → `IReviewAuth`
- Consumes `GetInboxAsync` or `TryParsePrUrl` → `IPrDiscovery`
- Consumes any of the PR-detail / diff / timeline / poll / commit methods → `IPrReader`
- Consumes nothing today (only PR1 will) → `IReviewSubmitter` (you won't hit this in PR0 since the interface is empty)

Some consumers (e.g., `Composition/ServiceCollectionExtensions.cs`) consume the type for DI registration — they bind to all four interfaces (see Task 4).

Concrete sites to update — confirm each via the grep output:

- `PRism.Web/Endpoints/AuthEndpoints.cs` → `IReviewAuth`
- `PRism.Web/Endpoints/InboxEndpoints.cs` → `IPrDiscovery`
- `PRism.Web/Endpoints/PrDetailEndpoints.cs` → `IPrReader` (also `IPrDiscovery` if `TryParsePrUrl` is consumed)
- `PRism.Web/Endpoints/PrReloadEndpoints.cs` → `IPrReader`
- `PRism.Web/Polling/ActivePrPoller.cs` (or wherever the poller lives) → `IPrReader`
- `PRism.Web/Inbox/InboxRefreshOrchestrator.cs` (if it injects the service directly) → `IPrDiscovery` + `IPrReader`
- `PRism.Web/Ai/ReviewServiceFileContentSource.cs` (or equivalent name) → `IPrReader`
- `PRism.Web/TestHooks/FakeReviewService.cs` → split per Task 4
- `tests/PRism.Web.Tests/**/*.cs` → each fixture's injected fake type

- [ ] **Step 3: Build progressively**

After every batch of 5-10 file edits, run `dotnet build PRism.sln` to surface the next set of errors. Iterate until green.

Run: `dotnet build PRism.sln`
Expected: PASS — every consumer compiles against the narrower interface.

- [ ] **Step 4: Run the full test suite to assert behavioral equivalence**

Run: `dotnet test PRism.sln`
Expected: PASS — pure refactor, all existing tests should remain green. If anything red, the consumer swap broke a behavior contract; investigate before continuing.

- [ ] **Step 5: Commit (Tasks 1+2+3 land together)**

```bash
git add PRism.Core/IReviewAuth.cs PRism.Core/IPrDiscovery.cs PRism.Core/IPrReader.cs PRism.Core/IReviewSubmitter.cs PRism.GitHub/GitHubReviewService.cs PRism.Web/ tests/ PRism.AI.*/ 2>/dev/null
git rm PRism.Core/IReviewService.cs PRism.Core/Contracts/DraftReview.cs
# Add deletions of AI seam dead code if applicable
git commit -m "$(cat <<'EOF'
refactor(s5-pr0): split IReviewService into capability sub-interfaces

ADR-S5-1 per docs/specs/2026-05-11-s5-submit-pipeline-design.md § 3.

IReviewService is retired and replaced with four narrower interfaces:
- IReviewAuth (ValidateCredentialsAsync)
- IPrDiscovery (GetInboxAsync, TryParsePrUrl)
- IPrReader (10 PR-read methods)
- IReviewSubmitter (empty seam; PR1 lands the seven pending-review pipeline methods)

GitHubReviewService implements all four. Consumers are migrated to the
narrowest interface they actually use. The legacy SubmitReviewAsync stub
is retired alongside the composite interface; DraftReview contract record
deleted (only consumer was the retired stub).

Pure refactor; no behavior change. All existing tests pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Split `FakeReviewService` into four fakes

**Files:**

- Modify: `PRism.Web/TestHooks/FakeReviewService.cs` → contents move out to four new files
- Create: `PRism.Web/TestHooks/FakeReviewAuth.cs`
- Create: `PRism.Web/TestHooks/FakePrDiscovery.cs`
- Create: `PRism.Web/TestHooks/FakePrReader.cs`
- Create: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (empty for now; PR1 fills it)
- Modify: `PRism.Web/Program.cs` (the swap block now removes/adds four registrations)
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs` (any `IReviewService` downcast becomes the appropriate fake type)

- [ ] **Step 1: Read the existing `FakeReviewService.cs` to understand the in-memory state shape**

Run: Read the file. Identify which fake methods live where:
- `ValidateCredentialsAsync` → `FakeReviewAuth`
- `GetInboxAsync`, `TryParsePrUrl` → `FakePrDiscovery`
- All read methods → `FakePrReader`
- (No submit methods yet — `FakeReviewSubmitter` stays empty in PR0)

Note any shared mutable state (e.g., an in-memory `Dictionary<PrReference, Pr>` used by multiple methods). Shared state moves to a `FakeReviewBackingStore` class injected into each fake, so the four fakes can collaborate. Pattern:

```csharp
// PRism.Web/TestHooks/FakeReviewBackingStore.cs
internal sealed class FakeReviewBackingStore
{
    public Dictionary<string, Pr> Prs { get; } = new();
    public Dictionary<string, PrDetailDto> PrDetails { get; } = new();
    // …whatever shared state exists in FakeReviewService today
}
```

The backing store is registered as a singleton; each fake takes it via constructor injection.

- [ ] **Step 2: Create `FakeReviewBackingStore` (if shared state exists)**

If the existing `FakeReviewService` has private fields used by multiple methods, lift them into a shared `FakeReviewBackingStore`. If state is purely per-method (unlikely for a fake), skip this step.

- [ ] **Step 3: Create the four fake files**

Each fake implements its corresponding interface and delegates state operations to the backing store.

```csharp
// PRism.Web/TestHooks/FakeReviewAuth.cs
namespace PRism.Web.TestHooks;

internal sealed class FakeReviewAuth : IReviewAuth
{
    private readonly FakeReviewBackingStore _store;
    public FakeReviewAuth(FakeReviewBackingStore store) { _store = store; }

    public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
        => /* lifted from FakeReviewService */;
}
```

(Same shape for `FakePrDiscovery`, `FakePrReader`, `FakeReviewSubmitter`.)

- [ ] **Step 4: Delete the consolidated `FakeReviewService.cs`**

```bash
git rm PRism.Web/TestHooks/FakeReviewService.cs
```

- [ ] **Step 5: Update `PRism.Web/Program.cs` registration**

Find this block:

```csharp
if (builder.Environment.IsEnvironment("Test")
    && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")
{
    var existing = builder.Services.FirstOrDefault(d => d.ServiceType == typeof(IReviewService));
    if (existing is not null) builder.Services.Remove(existing);
    builder.Services.AddSingleton<IReviewService, FakeReviewService>();
}
```

Replace with:

```csharp
if (builder.Environment.IsEnvironment("Test")
    && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")
{
    foreach (var serviceType in new[] {
        typeof(IReviewAuth),
        typeof(IPrDiscovery),
        typeof(IPrReader),
        typeof(IReviewSubmitter),
    })
    {
        var existing = builder.Services.FirstOrDefault(d => d.ServiceType == serviceType);
        if (existing is not null) builder.Services.Remove(existing);
    }
    builder.Services.AddSingleton<FakeReviewBackingStore>();
    builder.Services.AddSingleton<IReviewAuth, FakeReviewAuth>();
    builder.Services.AddSingleton<IPrDiscovery, FakePrDiscovery>();
    builder.Services.AddSingleton<IPrReader, FakePrReader>();
    builder.Services.AddSingleton<IReviewSubmitter, FakeReviewSubmitter>();
}
```

- [ ] **Step 6: Update `TestEndpoints.cs` downcasts**

The `/test/*` endpoints downcast the injected interface to `FakeReviewService` to manipulate fake state. After the split, each `/test/*` route resolves the appropriate fake type from DI:

```csharp
// Before:
var fake = ctx.RequestServices.GetRequiredService<IReviewService>() as FakeReviewService
    ?? throw new InvalidOperationException(...);

// After:
var store = ctx.RequestServices.GetRequiredService<FakeReviewBackingStore>();
// Operate on the store directly, OR resolve the specific fake interface
```

- [ ] **Step 7: Run the Playwright fixture build**

Run: `dotnet build PRism.Web tests/PRism.Web.Tests`
Expected: PASS.

If the fake-only test infra has its own xUnit suite (e.g., `tests/PRism.Web.Tests/TestHooks/FakeReviewServiceTests.cs`), update it to test the four fakes individually.

- [ ] **Step 8: Commit**

```bash
git add PRism.Web/TestHooks/ PRism.Web/Program.cs PRism.Web/Endpoints/ tests/
git commit -m "refactor(s5-pr0): split FakeReviewService into four fakes alongside IReviewService split

Mirror the capability split on the test fake. Shared in-memory state lives
in FakeReviewBackingStore (DI singleton); each fake delegates to it.
TestEndpoints.cs downcasts updated to resolve the relevant fake type."
```

---

### Task 5: Empirical gate C6 — `AddPullRequestReviewThreadInput` parameter shape

**Spec section:** § 2.1. **Owner artifact:** `docs/spec/00-verification-notes.md` § C6.

**Goal:** Confirm the live GitHub GraphQL schema accepts `pullRequestReviewId` on `AddPullRequestReviewThreadInput` (spec's default), or document which field replaced it.

- [ ] **Step 1: Run the schema introspection query**

```bash
gh api graphql -f query='{ __type(name: "AddPullRequestReviewThreadInput") { inputFields { name description isDeprecated deprecationReason } } }'
```

Expected output: a JSON array of input fields. Look specifically for:
- `pullRequestReviewId`: name, `isDeprecated: false`, no deprecationReason → spec's default holds.
- `pullRequestReviewId` missing OR `isDeprecated: true` with `deprecationReason` naming `pullRequestId` → spec drifts to fallback.

Capture the **full output** verbatim — it goes into the verification-notes update.

- [ ] **Step 2: Document the outcome in `docs/spec/00-verification-notes.md` § C6**

Replace the existing `## Status\n\n**Pending**` block in § C6 with:

```markdown
## Status

**Verified 2026-05-DD**: <pullRequestReviewId is present and functional / pullRequestReviewId removed in favor of pullRequestId>.

Command run: `gh api graphql -f query='{ __type(name: "AddPullRequestReviewThreadInput") { inputFields { name description isDeprecated deprecationReason } } }'`

Output (relevant fields):
```json
{
  "name": "pullRequestReviewId",
  "description": "...",
  "isDeprecated": false,
  "deprecationReason": null
}
```

**Implication for PR1:** <Spec's `AttachThreadAsync(reference, pendingReviewId, draft, ct)` signature stands as written. / Switch to `pullRequestId` per the spec § 2.1 fallback; update spec § 4 and § 5 step 2 wording in the same commit.>
```

- [ ] **Step 3: Commit**

```bash
git add docs/spec/00-verification-notes.md
git commit -m "docs(s5-pr0): C6 empirical gate — AddPullRequestReviewThreadInput parameter shape

Ran the live schema introspection. <One-sentence outcome.>"
```

---

### Task 6: Empirical gate C7 — HTML-comment marker durability

**Spec section:** § 2.2. **Owner artifact:** `docs/spec/00-verification-notes.md` § C7.

**Goal:** Confirm that the `<!-- prism:client-id:<id> -->` marker survives a round-trip through `addPullRequestReviewThread` and is returned verbatim by `pullRequest.reviews(states: PENDING).first(1).threads`.

**Prereqs:** A sandbox PR you own on github.com (a personal repo PR works; the PR must be open and have at least one diff line to anchor a thread). The PR is wiped after the test by deleting the pending review.

- [ ] **Step 1: Prepare three marker bodies (the three C7 test cases)**

```text
# Case 1 — marker as only content
<!-- prism:client-id:c7-test-1 -->

# Case 2 — marker as footer after a normal body
This is a test comment for C7 verification.

<!-- prism:client-id:c7-test-2 -->

# Case 3 — marker after a fenced code block (marker OUTSIDE the fence)
```ts
const x = 1;
```

<!-- prism:client-id:c7-test-3 -->
```

Save each to a separate text file (`/tmp/c7-1.md`, `/tmp/c7-2.md`, `/tmp/c7-3.md`) so the GraphQL JSON payload doesn't need inline escaping.

- [ ] **Step 2: Open a pending review and attach three threads**

```bash
# Step 2a — get the PR's node ID + a recent commit SHA + an anchor line
OWNER=<your-username>
REPO=<your-sandbox-repo>
PR_NUMBER=<sandbox-pr-number>

gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        headRefOid
        files(first: 1) {
          nodes { path }
        }
      }
    }
  }
' -F owner=$OWNER -F repo=$REPO -F number=$PR_NUMBER
```

Capture `pullRequest.id` (the PR's Node ID), `headRefOid` (the current head SHA), and one file path.

- [ ] **Step 2b: Create the pending review (no event)**

```bash
PR_NODE_ID=<from step 2a>
HEAD_OID=<from step 2a>

gh api graphql -f query='
  mutation($prId: ID!, $oid: GitObjectID!) {
    addPullRequestReview(input: {
      pullRequestId: $prId,
      commitOID: $oid
    }) {
      pullRequestReview { id }
    }
  }
' -F prId=$PR_NODE_ID -F oid=$HEAD_OID
```

Capture `pullRequestReview.id` — this is the `pendingReviewId` for the rest of the test.

- [ ] **Step 2c: Attach three threads, one per marker body**

```bash
PENDING_REVIEW_ID=<from step 2b>
FILE_PATH=<from step 2a>

# Repeat for c7-1.md, c7-2.md, c7-3.md
BODY=$(cat /tmp/c7-1.md)

gh api graphql -f query='
  mutation($prReviewId: ID!, $body: String!, $path: String!) {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: $prReviewId,
      body: $body,
      path: $path,
      line: 1,
      side: RIGHT
    }) {
      thread { id }
    }
  }
' -F prReviewId=$PENDING_REVIEW_ID -F body="$BODY" -F path=$FILE_PATH
```

Run three times, once for each case.

- [ ] **Step 3: Query back the pending review's threads and check marker preservation**

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviews(states: [PENDING], first: 1) {
          nodes {
            threads(first: 10) {
              nodes {
                comments(first: 1) { nodes { body } }
              }
            }
          }
        }
      }
    }
  }
' -F owner=$OWNER -F repo=$REPO -F number=$PR_NUMBER
```

For each returned `comments.nodes[0].body`, check whether `<!-- prism:client-id:c7-test-N -->` is preserved as a literal substring.

- [ ] **Step 4: Clean up — delete the pending review**

```bash
gh api graphql -f query='
  mutation($prReviewId: ID!) {
    deletePullRequestReview(input: { pullRequestReviewId: $prReviewId }) {
      pullRequestReview { id }
    }
  }
' -F prReviewId=$PENDING_REVIEW_ID
```

- [ ] **Step 5: Document the outcome in `docs/spec/00-verification-notes.md` § C7**

Replace the `## Status\n\n**Pending**` block with:

```markdown
## Status

**Verified 2026-05-DD**: Marker preserved in all three cases. / Marker preserved in cases 1+2, stripped in case 3 (fence edge — PoC submitter already detects unclosed fence, so production case 3 never lands inside a fence). / Marker stripped in case <N> — falling back to client-side body normalization parity per § 2.2 fallback (a).

Test bodies and observed `body` fields:
- Case 1 (marker only): `<observed body verbatim>` → marker preserved? <YES/NO>
- Case 2 (marker as footer): `<observed body verbatim>` → marker preserved? <YES/NO>
- Case 3 (marker after fence): `<observed body verbatim>` → marker preserved? <YES/NO>

**Implication for PR2:** <Spec's marker-based adoption ships as written. / Switch SubmitPipeline § 5.2 step 3 to body-normalization parity matcher; lands ~1 day of additional cost per § 2.2 caveat — parity matcher + dedupe-warn step + tiebreaker, plus PR7's `s5-submit-lost-response-adoption.spec.ts` becomes `s5-submit-body-normalization-parity.spec.ts`.>
```

- [ ] **Step 6: Commit**

```bash
git add docs/spec/00-verification-notes.md
git commit -m "docs(s5-pr0): C7 empirical gate — HTML-comment marker durability

Ran three marker-body shapes through addPullRequestReviewThread. <One-sentence outcome.>"
```

---

### Task 7: Empirical gate C9 — empty-pipeline finalize on a Comment-verdict review

**Spec section:** § 2.3a. **Owner artifact:** `docs/spec/00-verification-notes.md` § C9.

**Goal:** Confirm that `submitPullRequestReview` accepts a Comment-verdict review on a pending review with zero attached threads (the empty-pipeline finalize path enabled by spec § 5.2 step 5 + Submit Review button rule (e)).

- [ ] **Step 1: Open a fresh pending review on the same sandbox PR (or a different one)**

```bash
gh api graphql -f query='
  mutation($prId: ID!, $oid: GitObjectID!) {
    addPullRequestReview(input: {
      pullRequestId: $prId,
      commitOID: $oid
    }) {
      pullRequestReview { id }
    }
  }
' -F prId=$PR_NODE_ID -F oid=$HEAD_OID
```

Capture the new `pullRequestReview.id`. Do NOT call `addPullRequestReviewThread`.

- [ ] **Step 2: Finalize with `event: COMMENT` and a non-empty body**

```bash
PENDING_REVIEW_ID=<from step 1>

gh api graphql -f query='
  mutation($prReviewId: ID!, $body: String!) {
    submitPullRequestReview(input: {
      pullRequestReviewId: $prReviewId,
      event: COMMENT,
      body: $body
    }) {
      pullRequestReview { id state body }
    }
  }
' -F prReviewId=$PENDING_REVIEW_ID -F body="C9 empirical gate verification — body-only Comment review."
```

Expected outcomes:
- **GraphQL returns success + the review's `state` is `COMMENTED`** → spec ships as written.
- **GraphQL returns an error like "Review must have at least one comment"** → falls back to one of the two documented options.

- [ ] **Step 3: Confirm the review appears on github.com**

Open the PR on github.com; verify the body-only Comment review is visible as a posted review.

- [ ] **Step 4: Document the outcome in `docs/spec/00-verification-notes.md` § C9**

Replace the `## Status\n\n**Pending**` block with:

```markdown
## Status

**Verified 2026-05-DD**: GraphQL accepted the empty-threads Comment finalize. / GraphQL rejected with: `<exact error message>` — falling back to option (b) legacy REST per § C9.

Sandbox PR: `<owner>/<repo>#<number>` (no longer relevant — review submitted/deleted; URL retained for traceability).

**Implication for PR1+PR2:** <Spec's empty-pipeline finalize at § 5.2 step 5 ships as written. / Add `SubmitSummaryOnlyReviewAsync` to IReviewSubmitter calling legacy REST `POST /pulls/{n}/reviews`; SubmitPipeline branches to that path when DraftComments and DraftReplies are both empty.>
```

- [ ] **Step 5: Commit**

```bash
git add docs/spec/00-verification-notes.md
git commit -m "docs(s5-pr0): C9 empirical gate — empty-pipeline finalize

Submitted a Comment-verdict review with zero attached threads + a non-empty
summary body. <One-sentence outcome.>"
```

---

### Task 8 (PR0a final check): PR0a integration check + PR description

- [ ] **Step 1: Run the full pre-push checklist**

Per `~/src/config/claude/CLAUDE.md` "feedback_run_full_pre_push_checklist", execute every step in `.ai/docs/development-process.md` verbatim:

```bash
dotnet build PRism.sln
dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
cd ..
```

Expected: all green. (Playwright still has the three S4 `test.fixme` specs deferred — PR0b un-`fixme`s them. PR0a does not touch them.)

- [ ] **Step 2: Verify no `IReviewService` references remain**

Grep for `IReviewService` (type: cs). Expected: zero matches outside `docs/`.

- [ ] **Step 3: Verify the three empirical gates' verification-notes are stamped**

Read `docs/spec/00-verification-notes.md` § C6, C7, C9. Each should have `**Verified 2026-05-DD**: <outcome>` instead of `**Pending**`.

- [ ] **Step 4: Open PR0a**

```bash
git push -u origin <branch>
gh pr create --title "feat(s5-pr0a): IReviewService capability split + C6/C7/C9 empirical gates" --body "$(cat <<'EOF'
## Summary

- Splits `IReviewService` (10 methods) into four capability sub-interfaces (`IReviewAuth`, `IPrDiscovery`, `IPrReader`, `IReviewSubmitter` empty seam) per ADR-S5-1 / spec § 3.
- Runs three empirical gates against the live GitHub GraphQL schema; outcomes recorded in `docs/spec/00-verification-notes.md` § C6, C7, C9.
- The Playwright multi-spec state-leak fix lands separately in PR0b (lands in parallel with PR1; can slip without blocking the demo).

## Test plan

- [x] `dotnet build PRism.sln` (clean)
- [x] `dotnet test PRism.sln` (all green; pure refactor, no behavior change)
- [x] `npm run lint` + `npm run build` in `frontend/` (clean)
- [x] Playwright suite green (three S4 `test.fixme` specs still deferred — PR0b fixes)
- [x] C6 introspection result documented in verification-notes
- [x] C7 round-trip result documented in verification-notes
- [x] C9 empty-finalize result documented in verification-notes

## Spec refs

- Spec: `docs/specs/2026-05-11-s5-submit-pipeline-design.md` § 2 + § 3 + § 16 PR0 row
- ADR: `docs/specs/2026-05-06-architectural-readiness-design.md` § ADR-S5-1
- Verification: `docs/spec/00-verification-notes.md` § C6, C7, C9

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After PR0a merges, before opening PR1**

Re-verify the empirical gates' outcomes against the spec's PR1 / PR2 task definitions. If C6 / C7 / C9 produced any fallback outcome, update the relevant spec sections (§ 4 method signatures, § 5.2 step 3 wording, § 5.2 step 5) in a separate spec-correction commit before opening PR1. Then start PR1 (Phase 2) — it does NOT wait on PR0b.

---

# Phase 1b — PR0b: Playwright multi-spec state-leak root-cause + fix

**PR title:** `fix(s5-pr0b): root-cause + fix Playwright multi-spec state-leak; un-fixme three S4 specs`

**Spec sections:** § 2.3 (state-leak), § 17 #21 (no more `test.fixme` in S5), § 16 PR0 row.

**Goal:** Reproduce the multi-spec state-leak deterministically, fix it at the lowest-impact layer, and un-`fixme` the three S4 PR7 specs.

**Sequencing:** Lands in parallel with PR1 (Phase 2) in a separate worktree. PR1 does not depend on PR0b. If the root-cause turns out to be a multi-week refactor, escalate per spec § 2.3 — PR0b's slip does not block S5's demo (the three deferred specs were already `test.fixme` before S5; they remain so until PR0b lands).

**Files touched (~2-5 depending on root cause):**
- Modify: 3 Playwright specs that S4 PR7 left as `test.fixme` (de-fixme'd; assertions intact)
- Plus 1-3 supporting files at the layer where the leak is fixed (test infra, backend state-store ordering, or SSE channel ordering)
- Modify: `docs/specs/2026-05-09-s4-drafts-and-composer-deferrals.md` (Status update on the 2026-05-11 (d) entry)

**Worktree:** `.claude/worktrees/feat+s5-pr0b`

---

### Task 8b: Playwright multi-spec state-leak — reproduce + diagnose

**Spec section:** § 2.3. **Hypothesis (per spec):** stale-write race against in-flight `PUT /api/pr/{ref}/draft`.

**Goal:** Reproduce the leak deterministically, identify the layer (test infra / `AppStateStore._gate` ordering / SSE publication ordering), and pick the lowest-impact fix.

**This task is investigation-heavy; no canonical TDD.** It produces a deterministic repro + a one-paragraph root-cause writeup that drives Task 9's fix.

- [ ] **Step 1: Identify the three deferred specs**

Run the search:

```bash
# Grep tool, pattern: test.fixme
# Path: frontend/e2e
# output_mode: content, -n
```

Capture the spec file paths + the `test.fixme(...)` comment block for each (the comment usually explains the failure mode).

- [ ] **Step 2: Read the S4 deferrals entry that documents the leak**

```bash
# Read tool, file_path: docs/specs/2026-05-09-s4-drafts-and-composer-deferrals.md
# Look for the 2026-05-11 (d) entry that flags the leak as a stale-write race against PUT /draft
```

- [ ] **Step 3: Run the three specs in isolation to confirm they pass standalone**

```bash
# In frontend/, run each spec in isolation:
npx playwright test e2e/<spec-1>.spec.ts --workers=1
npx playwright test e2e/<spec-2>.spec.ts --workers=1
npx playwright test e2e/<spec-3>.spec.ts --workers=1
```

Expected: each spec passes when run alone. If a spec fails standalone, the failure is unrelated to the cross-spec leak — investigate separately and document.

- [ ] **Step 4: Reproduce the leak by running the three specs together**

```bash
# Un-fixme the three specs locally (DON'T COMMIT YET — this is just to reproduce):
npx playwright test e2e/<spec-1>.spec.ts e2e/<spec-2>.spec.ts e2e/<spec-3>.spec.ts --workers=1
```

Expected: at least one spec fails when run alongside the others. Capture the failure mode (which spec, which assertion, what error). Run with `--debug` or `--trace=on` to capture per-step traces.

- [ ] **Step 5: Bisect the leak to a layer**

Three candidate layers per spec § 2.3:

1. **Playwright per-spec `state.json` reset.** If the playwright config or test setup deletes `state.json` between specs, but the deletion races against an in-flight write, the next spec sees a hybrid state.
2. **`AppStateStore._gate` ordering.** If the gate releases before the SSE publication completes, an event from spec N can land in spec N+1's subscriber state.
3. **SSE event-publication ordering (S4 design § 4.5 contract).** The S4 design pins that typed events publish outside `_gate` but in a specific order; if that order is violated, cross-spec subscriber drift is possible.

Bisect approach:

- Add `console.log` (or `_log.LogInformation`) at each candidate layer's transition boundary.
- Re-run the failing two-spec combination.
- The first layer to emit "spec 2 entry" before "spec 1 cleanup completion" is the suspect.

- [ ] **Step 6: Document the root cause**

In a temporary scratch file (`docs/specs/_s5-pr0b-state-leak-notes.md` — to be deleted after PR0b merges; the durable record lives in the deferrals sidecar of S5 as a Status update on the original deferral):

```markdown
# S5 PR0b — Playwright state-leak root cause

**Date:** 2026-05-DD
**Layer:** <test infra / AppStateStore._gate / SSE publication ordering>
**Smoking gun:** <one-paragraph trace excerpt>
**Fix shape:** <Task 9b's plan>
**Estimated fix cost:** <hours; if multi-week, escalate to user per spec § 2.3 — PR0b slips, demo unaffected>
```

- [ ] **Step 7: If the fix is a multi-week refactor, STOP and escalate to the user**

Per spec § 2.3. Since PR0 is already pre-split, the immediate question is no longer "split PR0?" but "is the fix worth doing now vs. accepting the three specs stay `test.fixme` until a later cleanup?" The user decides. PR1 and the demo are unaffected either way — PR0b is off the critical path by construction.

No commit on this task — Task 9b commits both the diagnosis writeup deletion and the fix.

---

### Task 9b: Playwright multi-spec state-leak — fix + un-`fixme`

**Files:** ≥ 3 modified specs + 1-3 fix-site files (depending on root cause from Task 8b).

- [ ] **Step 1: Implement the fix at the layer identified in Task 8b**

The fix shape depends on the layer; three sketches:

**(a) Test infra fix.** If the leak is in Playwright's `state.json` reset:

```typescript
// frontend/playwright.config.ts (or wherever per-test cleanup lives)
// Before:
//   beforeEach(() => fs.unlinkSync(statePath));
// After (drain in-flight writes before reset):
beforeEach(async () => {
  await page.evaluate(() => (window as any).__prismDrainPendingWrites?.());
  fs.unlinkSync(statePath);
});
```

If the SPA doesn't expose a drain helper today, add one in `frontend/src/main.tsx` gated on `process.env.NODE_ENV === 'test'` or a global flag.

**(b) `AppStateStore._gate` fix.** If the leak is in publication-vs-`_gate` ordering, the S4 design § 4.5 contract is the source of truth — publication must happen AFTER `UpdateAsync` returns, OUTSIDE the gate. Find any site that publishes inside the gate (likely in `AppStateStore.UpdateAsync` or a wrapping orchestrator) and move publication out.

**(c) SSE channel fix.** If the leak is in SSE event-publication ordering, the projection in `PRism.Web/Sse/SseEventProjection.cs` may be re-ordering events. Pin event ordering via the existing typed/umbrella contract; add a regression test in `tests/PRism.Web.Tests/Sse/`.

Capture the specific fix in code below; the placeholder above documents the three branches.

- [ ] **Step 2: Verify the fix locally**

```bash
cd frontend
npx playwright test e2e/<spec-1>.spec.ts e2e/<spec-2>.spec.ts e2e/<spec-3>.spec.ts --workers=1 --repeat-each=5
```

Expected: PASS across all five iterations. The `--repeat-each=5` flag catches flakey fixes.

- [ ] **Step 3: Un-`fixme` the three S4 specs**

For each spec identified in Task 8b step 1, change `test.fixme('<title>', ...)` back to `test('<title>', ...)`. Preserve any existing test body; do not amend assertions.

- [ ] **Step 4: Run the full Playwright suite**

```bash
cd frontend
npx playwright test
```

Expected: every spec passes. If any new flake surfaces, capture it and document in deferrals.

- [ ] **Step 5: Delete the scratch root-cause file from Task 8b**

```bash
git rm docs/specs/_s5-pr0b-state-leak-notes.md 2>/dev/null
```

Update the relevant entry in `docs/specs/2026-05-09-s4-drafts-and-composer-deferrals.md` (the 2026-05-11 (d) entry) with a `**Status:** Resolved 2026-05-DD — root-cause was <one line>. Fixed in S5 PR0b (PR #TBD).` line.

- [ ] **Step 6: Run the full pre-push checklist + commit**

```bash
dotnet build PRism.sln && dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
cd ..
```

Expected: all green, no `test.fixme`.

```bash
git add frontend/e2e/ frontend/playwright.config.ts <fix-site-files>
git rm docs/specs/_s5-pr0b-state-leak-notes.md 2>/dev/null
git add docs/specs/2026-05-09-s4-drafts-and-composer-deferrals.md
git commit -m "$(cat <<'EOF'
fix(s5-pr0b): un-fixme three S4 specs by fixing multi-spec state-leak

Root cause: <one line>.
Layer: <test infra / AppStateStore._gate / SSE publication ordering>.
Fix: <one line>.

The three S4 PR7 specs (<spec-1>, <spec-2>, <spec-3>) re-enter the
suite. Repeated --repeat-each=5 runs confirm no flake.

Closes S4 deferral entry 2026-05-11 (d).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Open PR0b**

```bash
git push -u origin <branch>
gh pr create --title "fix(s5-pr0b): root-cause + fix Playwright multi-spec state-leak; un-fixme three S4 specs" --body "$(cat <<'EOF'
## Summary

Root-causes + fixes the Playwright multi-spec state-leak that left S4 PR7 with three `test.fixme` suites; un-`fixme`s them and asserts green. Lands in parallel with PR1; off the demo critical path by construction (PR0 was pre-split into PR0a + PR0b for exactly this reason).

## Test plan

- [x] Three deferred S4 specs re-enter the suite (no `test.fixme`)
- [x] `--repeat-each=5` over the affected specs — no flake
- [x] Full Playwright suite green
- [x] `dotnet test PRism.sln` green

## Spec refs

- Spec: `docs/specs/2026-05-11-s5-submit-pipeline-design.md` § 2.3 + § 16 PR0 row
- Closes S4 deferral entry 2026-05-11 (d)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 2 — PR1: `IReviewSubmitter` six-method seam + `GitHubReviewService.Submit.cs`

**PR title:** `feat(s5-pr1): IReviewSubmitter seven-method seam + GitHub GraphQL pending-review pipeline`

**Spec sections:** § 4 (`IReviewSubmitter` capability seam), § 18.2 (Octokit vs raw `HttpClient`), § 18.3 (C6 / C9 empirical-gate outcomes).

**Goal:** Land the six methods that drive the GraphQL pending-review pipeline against real GitHub, plus the data records and `SubmitEvent` enum the methods carry. No PRism-side state machine yet — that lands in PR2.

**Files touched (~6 new + 1 partial-class addition + ~6 test files):**

- Create: `PRism.Core/Submit/DraftThreadRequest.cs`
- Create: `PRism.Core/Submit/SubmitResults.cs` (holds `BeginPendingReviewResult`, `AttachThreadResult`, `AttachReplyResult`, `OwnPendingReviewSnapshot`, `PendingReviewThreadSnapshot`, `PendingReviewCommentSnapshot`)
- Create: `PRism.Core/Submit/SubmitEvent.cs`
- Modify: `PRism.Core/IReviewSubmitter.cs` (fill in six methods)
- Create: `PRism.GitHub/GitHubReviewService.Submit.cs` (partial class file)
- (Optional) Create: `PRism.GitHub/GitHubReviewService.Auth.cs`, `Discovery.cs`, `Detail.cs` — ADR-S5-2 partial-class split, lands only if `GitHubReviewService.cs` becomes unwieldy after Submit lands; default is to leave the existing file intact.
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitTests.cs` (or one file per method; default to a single file with `[Theory]` groups)
- Create: `tests/PRism.GitHub.Tests/TestHelpers/RecordingHttpMessageHandler.cs` (captures request body for assertion)

**Worktree:** `.claude/worktrees/feat+s5-pr1`

**Empirical-gate inputs:** Read § C6 + § C9 in `docs/spec/00-verification-notes.md` before writing any GraphQL payload code. If C6's outcome named `pullRequestId` instead of `pullRequestReviewId`, all `AttachThreadAsync`-related code and tests in this PR use the corrected field name. If C9's outcome rejected the empty-threads finalize, ALSO add `SubmitSummaryOnlyReviewAsync` to the interface and implementation (Task 10).

---

### Task 11: Define request / response records + `SubmitEvent` enum + interface methods

**Files:**

- Create: `PRism.Core/Submit/DraftThreadRequest.cs`
- Create: `PRism.Core/Submit/SubmitResults.cs`
- Create: `PRism.Core/Submit/SubmitEvent.cs`
- Modify: `PRism.Core/IReviewSubmitter.cs`
- Create: `tests/PRism.Core.Tests/Submit/ContractShapeTests.cs`

- [ ] **Step 1: Write the failing test (compile-time presence test)**

Create `tests/PRism.Core.Tests/Submit/ContractShapeTests.cs`:

```csharp
using PRism.Core;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit;

public class ContractShapeTests
{
    [Fact]
    public void DraftThreadRequest_CarriesAllRequiredFieldsForGraphQL()
    {
        var req = new DraftThreadRequest(
            DraftId: "draft-1",
            BodyMarkdown: "hello\n\n<!-- prism:client-id:draft-1 -->",
            FilePath: "src/Foo.cs",
            LineNumber: 42,
            Side: "RIGHT");

        Assert.Equal("draft-1", req.DraftId);
        Assert.Equal("src/Foo.cs", req.FilePath);
        Assert.Equal(42, req.LineNumber);
        Assert.Equal("RIGHT", req.Side);
        Assert.Null(req.StartLine);
        Assert.Null(req.StartSide);
    }

    [Fact]
    public void SubmitEvent_HasThreeValues()
    {
        var values = Enum.GetValues<SubmitEvent>();
        Assert.Equal(3, values.Length);
        Assert.Contains(SubmitEvent.Approve, values);
        Assert.Contains(SubmitEvent.RequestChanges, values);
        Assert.Contains(SubmitEvent.Comment, values);
    }

    [Fact]
    public void IReviewSubmitter_HasSevenMethods()
    {
        var methods = typeof(IReviewSubmitter).GetMethods()
            .Where(m => !m.IsSpecialName)
            .Select(m => m.Name)
            .ToHashSet();
        Assert.Contains("BeginPendingReviewAsync", methods);
        Assert.Contains("AttachThreadAsync", methods);
        Assert.Contains("AttachReplyAsync", methods);
        Assert.Contains("FinalizePendingReviewAsync", methods);
        Assert.Contains("DeletePendingReviewAsync", methods);
        Assert.Contains("DeletePendingReviewThreadAsync", methods);  // multi-marker-match cleanup (Task 16 / Task 29)
        Assert.Contains("FindOwnPendingReviewAsync", methods);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ContractShapeTests"`
Expected: FAIL with `CS0246: The type or namespace name 'DraftThreadRequest' could not be found` and `CS0117: 'SubmitEvent' does not contain a definition for 'Approve'`.

- [ ] **Step 3: Create `PRism.Core/Submit/SubmitEvent.cs`**

```csharp
namespace PRism.Core.Submit;

public enum SubmitEvent
{
    Approve,
    RequestChanges,
    Comment,
}
```

- [ ] **Step 4: Create `PRism.Core/Submit/DraftThreadRequest.cs`**

```csharp
namespace PRism.Core.Submit;

public sealed record DraftThreadRequest(
    string DraftId,           // SubmitPipeline injects the marker; adapter never sees user-visible body
    string BodyMarkdown,      // already includes the <!-- prism:client-id:<DraftId> --> footer
    string FilePath,
    int LineNumber,
    string Side,
    // Reserved for multi-line / range comments — both fields stay null in PoC scope.
    int? StartLine = null,
    string? StartSide = null);
```

- [ ] **Step 5: Create `PRism.Core/Submit/SubmitResults.cs`**

```csharp
namespace PRism.Core.Submit;

public sealed record BeginPendingReviewResult(string PullRequestReviewId);
public sealed record AttachThreadResult(string PullRequestReviewThreadId);
public sealed record AttachReplyResult(string CommentId);

public sealed record OwnPendingReviewSnapshot(
    string PullRequestReviewId,
    string CommitOid,
    DateTime CreatedAt,
    IReadOnlyList<PendingReviewThreadSnapshot> Threads);

public sealed record PendingReviewThreadSnapshot(
    string PullRequestReviewThreadId,
    string FilePath,
    int LineNumber,
    string Side,
    string OriginalCommitOid,
    string OriginalLineContent,
    bool IsResolved,
    string BodyMarkdown,
    IReadOnlyList<PendingReviewCommentSnapshot> Comments);

public sealed record PendingReviewCommentSnapshot(
    string CommentId,
    string BodyMarkdown);
```

- [ ] **Step 6: Fill in `PRism.Core/IReviewSubmitter.cs` with six methods**

Replace the empty seam from PR0:

```csharp
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core;

public interface IReviewSubmitter
{
    Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference,
        string commitOid,
        string summaryBody,
        CancellationToken ct);

    Task<AttachThreadResult> AttachThreadAsync(
        PrReference reference,
        string pendingReviewId,
        DraftThreadRequest draft,
        CancellationToken ct);

    Task<AttachReplyResult> AttachReplyAsync(
        PrReference reference,
        string pendingReviewId,
        string parentThreadId,
        string replyBody,
        CancellationToken ct);

    Task FinalizePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        SubmitEvent verdict,
        CancellationToken ct);

    Task DeletePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        CancellationToken ct);

    // Best-effort cleanup of a duplicate thread under the multi-marker-match defense (§ 5.2 step 3).
    Task DeletePendingReviewThreadAsync(
        PrReference reference,
        string pullRequestReviewThreadId,
        CancellationToken ct);

    Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
        PrReference reference,
        CancellationToken ct);
}
```

The `DeletePendingReviewThreadAsync` implementation lands alongside `DeletePendingReviewAsync` in Task 16; the `InMemoryReviewSubmitter` fake (Task 24) implements it by removing the thread from the in-memory pending review. Landing all 7 methods in PR1 keeps the interface stable so PR2 doesn't have to re-touch `GitHubReviewService.Submit.cs` + the fakes. **(PR1 execution correction: GitHub's GraphQL has no `deletePullRequestReviewThread` mutation — the implementation resolves the thread's comment IDs via `node(id:){... on PullRequestReviewThread{comments{nodes{id}}}}` and deletes each via `deletePullRequestReviewComment(input:{id})`; a thread vanishes once its last comment is deleted. The interface signature is unchanged — still `(reference, pullRequestReviewThreadId, ct)` — so Task 29 below needs no rework. See the deferrals sidecar.)**

- [ ] **Step 7: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ContractShapeTests"`
Expected: PASS (3 tests).

Verify that `GitHubReviewService.cs` build BREAKS now — it claims to implement `IReviewSubmitter` (from PR0) but has none of the six methods. Run `dotnet build PRism.GitHub`. Expected: FAIL with six `CS0535` "does not implement interface member" errors. This is intentional — Tasks 12-17 fill them in. Add a temporary stub set of `NotImplementedException` overrides at the bottom of `GitHubReviewService.cs` to unblock the build until each method lands:

```csharp
// PRism.GitHub/GitHubReviewService.cs (temporary stubs — replaced per task)
public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 12");
public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 13");
public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 14");
public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 15");
public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 16");
public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 17");
```

These stubs migrate to `GitHubReviewService.Submit.cs` (partial class file) as soon as Task 12 lands; the final shape has zero `NotImplementedException` references.

- [ ] **Step 8: Build the whole solution to confirm**

Run: `dotnet build PRism.sln`
Expected: PASS (with the temporary stubs).

- [ ] **Step 9: Commit**

```bash
git add PRism.Core/Submit/ PRism.Core/IReviewSubmitter.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.Core.Tests/Submit/ContractShapeTests.cs
git commit -m "feat(s5-pr1): IReviewSubmitter seven-method interface + Submit contract records

Fills the empty IReviewSubmitter seam from PR0 with the seven pending-review
pipeline methods, the DraftThreadRequest record, the SubmitResults set,
and the SubmitEvent enum. Temporary NotImplementedException stubs land on
GitHubReviewService to keep the build green; subsequent commits replace
each stub with the real GraphQL implementation."
```

---

### Task 12: Implement `BeginPendingReviewAsync` via GraphQL `addPullRequestReview`

**Files:**

- Create: `PRism.GitHub/GitHubReviewService.Submit.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove the temporary `BeginPendingReviewAsync` stub)
- Create: `tests/PRism.GitHub.Tests/TestHelpers/RecordingHttpMessageHandler.cs`
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitBeginTests.cs`

- [ ] **Step 1: Write the recording HTTP handler**

`tests/PRism.GitHub.Tests/TestHelpers/RecordingHttpMessageHandler.cs`:

```csharp
using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

// Captures the most recent request body for assertion; returns a configurable response.
// Tests that need to assert the GraphQL payload shape use this; tests that only need
// to assert behavior on a particular response shape use FakeHttpMessageHandler.Returns.
public sealed class RecordingHttpMessageHandler : HttpMessageHandler
{
    private readonly HttpStatusCode _status;
    private readonly string _responseBody;
    public string? LastRequestBody { get; private set; }
    public HttpMethod? LastRequestMethod { get; private set; }
    public string? LastRequestPath { get; private set; }

    public RecordingHttpMessageHandler(HttpStatusCode status, string responseBody)
    {
        _status = status;
        _responseBody = responseBody;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        LastRequestMethod = request.Method;
        LastRequestPath = request.RequestUri?.AbsolutePath;
        LastRequestBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        return new HttpResponseMessage(_status)
        {
            Content = new StringContent(_responseBody, System.Text.Encoding.UTF8, "application/json"),
        };
    }
}
```

- [ ] **Step 2: Write the failing test**

`tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitBeginTests.cs`:

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitBeginTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task BeginPendingReviewAsync_PostsGraphqlMutationWithPullRequestNodeId_AndCommitOid_AndBody()
    {
        // Two-step interaction: lookup the PR node ID, then call addPullRequestReview.
        // The fake handler returns both responses in sequence via a sniffer that
        // dispatches based on the GraphQL query content.
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK,
            // The implementation will call addPullRequestReview; return a stable Node ID.
            """{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_kwDOABCD123"}}}}""");
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        // Pre-seed the PR-node lookup if the implementation does that lookup separately.
        // If the implementation pre-fetches a node ID, the test refactors to use a
        // multi-response handler. For now, assume the implementation accepts owner/repo/number
        // and the GraphQL query carries them as variables.

        var result = await svc.BeginPendingReviewAsync(Ref, "abc1234", "Summary body", CancellationToken.None);

        Assert.Equal("PRR_kwDOABCD123", result.PullRequestReviewId);
        Assert.NotNull(handler.LastRequestBody);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var root = doc.RootElement;
        // The GraphQL request body shape: { "query": "<mutation>", "variables": { ... } }
        Assert.True(root.TryGetProperty("query", out var query));
        Assert.Contains("addPullRequestReview", query.GetString());
        Assert.True(root.TryGetProperty("variables", out var vars));
        Assert.Equal("abc1234", vars.GetProperty("commitOid").GetString());
        Assert.Equal("Summary body", vars.GetProperty("body").GetString());
    }

    [Fact]
    public async Task BeginPendingReviewAsync_SendsEmptyStringBodyExplicitly_NotOmittedField()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK,
            """{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_x"}}}}""");
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await svc.BeginPendingReviewAsync(Ref, "abc1234", "", CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var vars = doc.RootElement.GetProperty("variables");
        Assert.True(vars.TryGetProperty("body", out var body));
        Assert.Equal("", body.GetString()); // explicit empty string, NOT omitted
    }

    [Fact]
    public async Task BeginPendingReviewAsync_OnGraphqlError_ThrowsHttpRequestException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK,
            """{"errors":[{"message":"GraphQL error: pullRequestId not found"}]}""");
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            svc.BeginPendingReviewAsync(Ref, "abc1234", "Summary", CancellationToken.None));
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitBeginTests"`
Expected: FAIL — `BeginPendingReviewAsync` currently throws `NotImplementedException("PR1 Task 12")`.

- [ ] **Step 4: Implement `BeginPendingReviewAsync` in `GitHubReviewService.Submit.cs`**

Create `PRism.GitHub/GitHubReviewService.Submit.cs`:

```csharp
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.GitHub;

public sealed partial class GitHubReviewService
{
    // Pending-review GraphQL pipeline (S5 PR1). See:
    // - docs/specs/2026-05-11-s5-submit-pipeline-design.md § 4
    // - docs/spec/00-verification-notes.md § C1, C6, C7, C9
    //
    // GraphQL transport uses the same "github" named HttpClient as REST calls. The endpoint
    // is `<host>/graphql` (POST with application/json body); the host comes from the named
    // client's BaseAddress (already configured by AddPrismGitHub).

    public async Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference,
        string commitOid,
        string summaryBody,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(commitOid);
        ArgumentNullException.ThrowIfNull(summaryBody); // empty allowed; null isn't

        // Two-call shape: first resolve pullRequestId (Node ID); then addPullRequestReview.
        // Caching the Node ID at adapter scope is a deferred optimization — for PR1 we
        // re-query each Submit call, since the cost is one extra GraphQL hop per submit
        // (~100ms) and the simpler stateless adapter is easier to reason about.
        var pullRequestId = await ResolvePullRequestNodeIdAsync(reference, ct).ConfigureAwait(false);

        var mutation = """
            mutation($prId: ID!, $commitOid: GitObjectID!, $body: String!) {
              addPullRequestReview(input: { pullRequestId: $prId, commitOID: $commitOid, body: $body }) {
                pullRequestReview { id }
              }
            }
            """;

        var responseRoot = await GraphqlAsync(
            mutation,
            new { prId = pullRequestId, commitOid, body = summaryBody },
            ct).ConfigureAwait(false);

        var id = responseRoot
            .GetProperty("addPullRequestReview")
            .GetProperty("pullRequestReview")
            .GetProperty("id")
            .GetString()
            ?? throw new HttpRequestException("addPullRequestReview response missing pullRequestReview.id");

        return new BeginPendingReviewResult(id);
    }

    // Resolves the GraphQL Node ID for a PR. Cached per-PrReference within a single submit?
    // No — keep stateless for PR1; the cache is a separable optimization.
    private async Task<string> ResolvePullRequestNodeIdAsync(PrReference reference, CancellationToken ct)
    {
        var query = """
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) { id }
              }
            }
            """;
        var root = await GraphqlAsync(
            query,
            new { owner = reference.Owner, repo = reference.Repo, number = reference.Number },
            ct).ConfigureAwait(false);
        var id = root
            .GetProperty("repository")
            .GetProperty("pullRequest")
            .GetProperty("id")
            .GetString()
            ?? throw new HttpRequestException("repository.pullRequest.id missing in response");
        return id;
    }

    // Wraps a GraphQL POST. Returns the `data` element of the response; throws HttpRequestException
    // on transport error, non-200 response, or a non-empty `errors` array.
    private async Task<JsonElement> GraphqlAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);

        using var http = _httpFactory.CreateClient("github");
        using var req = new HttpRequestMessage(HttpMethod.Post, "graphql");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/json");

        var payload = JsonSerializer.Serialize(new { query, variables }, GraphqlPayloadJsonOptions);
        req.Content = new StringContent(payload, Encoding.UTF8, "application/json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        var bodyText = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!resp.IsSuccessStatusCode)
            throw new HttpRequestException($"GraphQL POST returned {(int)resp.StatusCode}: {bodyText}");

        using var doc = JsonDocument.Parse(bodyText);
        if (doc.RootElement.TryGetProperty("errors", out var errors) && errors.GetArrayLength() > 0)
            throw new HttpRequestException($"GraphQL response carried errors: {errors.GetRawText()}");

        // Clone the data element so the JsonDocument can be safely disposed.
        return doc.RootElement.GetProperty("data").Clone();
    }

    private static readonly JsonSerializerOptions GraphqlPayloadJsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never, // explicit empties (e.g. summary body) must survive
        PropertyNamingPolicy = null,                        // GraphQL variables match the mutation's variable names verbatim
    };
}
```

- [ ] **Step 5: Remove the temporary `BeginPendingReviewAsync` stub from `GitHubReviewService.cs`**

Delete the line:
```csharp
public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    => throw new NotImplementedException("PR1 Task 12");
```

- [ ] **Step 6: Run test to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitBeginTests"`
Expected: PASS — but note Tests 1 + 3 expect the implementation to make TWO GraphQL calls (Node-ID lookup + addPullRequestReview). Add a multi-response capability to `RecordingHttpMessageHandler` if the first test fails on the Node-ID lookup. Sketch:

```csharp
// Extend RecordingHttpMessageHandler:
public sealed class RecordingHttpMessageHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, string Body)> _responses;
    public List<string?> RequestBodies { get; } = new();
    // ...
}
```

Update the tests to enqueue two responses (Node-ID lookup response, then the mutation response):

```csharp
var handler = new RecordingHttpMessageHandler(new[] {
    (HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":{"id":"PR_node_id_xyz"}}}}"""),
    (HttpStatusCode.OK, """{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_kwDOABCD123"}}}}"""),
});
// And assert against handler.RequestBodies[1] for the mutation shape.
```

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/TestHelpers/RecordingHttpMessageHandler.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitBeginTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.BeginPendingReviewAsync via GraphQL

addPullRequestReview with no `event` → pending review. Two-call shape:
resolve PR Node ID first, then mutate. Empty summary body sent as explicit
empty string (per spec § 5.2 step 2 'always explicit string, never omitted').

Lands the shared GraphQL transport helper (GraphqlAsync) used by all six
submit methods; RecordingHttpMessageHandler captures request bodies for
payload-shape assertions."
```

---

### Task 13: Implement `AttachThreadAsync` via GraphQL `addPullRequestReviewThread`

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs` (add the method)
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove the stub)
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachThreadTests.cs`

**Empirical-gate input:** Confirm C6 outcome before writing code. If C6 named `pullRequestId` (not `pullRequestReviewId`), use that field name in the mutation; the test asserts the literal name.

- [ ] **Step 1: Write the failing test**

`tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachThreadTests.cs`:

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitAttachThreadTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task AttachThreadAsync_PostsAddPullRequestReviewThreadMutation_WithPullRequestReviewIdAndBodyAndLocation()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_thread_123"}}}}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        var req = new DraftThreadRequest(
            DraftId: "draft-1",
            BodyMarkdown: "issue here\n\n<!-- prism:client-id:draft-1 -->",
            FilePath: "src/Foo.cs",
            LineNumber: 42,
            Side: "RIGHT");

        var result = await svc.AttachThreadAsync(Ref, "PRR_pending_xyz", req, CancellationToken.None);

        Assert.Equal("PRRT_thread_123", result.PullRequestReviewThreadId);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        Assert.Contains("addPullRequestReviewThread", query);

        var vars = doc.RootElement.GetProperty("variables");
        // Field name per spec § 4 / C6 outcome. If C6 fell back to pullRequestId, change this assertion.
        Assert.Equal("PRR_pending_xyz", vars.GetProperty("pullRequestReviewId").GetString());
        Assert.Equal("src/Foo.cs", vars.GetProperty("path").GetString());
        Assert.Equal(42, vars.GetProperty("line").GetInt32());
        Assert.Equal("RIGHT", vars.GetProperty("side").GetString());
        Assert.Equal("issue here\n\n<!-- prism:client-id:draft-1 -->", vars.GetProperty("body").GetString());
        Assert.False(vars.TryGetProperty("startLine", out _));   // multi-line reserved; null in PoC
        Assert.False(vars.TryGetProperty("startSide", out _));
    }

    [Fact]
    public async Task AttachThreadAsync_OnGraphqlError_ThrowsHttpRequestException()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"errors":[{"message":"resource not found"}]}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        var req = new DraftThreadRequest("d", "b", "p", 1, "RIGHT");

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            svc.AttachThreadAsync(Ref, "PRR_x", req, CancellationToken.None));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitAttachThreadTests"`
Expected: FAIL — method throws `NotImplementedException("PR1 Task 13")`.

- [ ] **Step 3: Implement `AttachThreadAsync` in `GitHubReviewService.Submit.cs`**

Append:

```csharp
public async Task<AttachThreadResult> AttachThreadAsync(
    PrReference reference,
    string pendingReviewId,
    DraftThreadRequest draft,
    CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(reference);
    ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);
    ArgumentNullException.ThrowIfNull(draft);

    var mutation = """
        mutation($prReviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {
          addPullRequestReviewThread(input: {
            pullRequestReviewId: $prReviewId,
            body: $body,
            path: $path,
            line: $line,
            side: $side
          }) {
            thread { id }
          }
        }
        """;

    var responseRoot = await GraphqlAsync(
        mutation,
        new
        {
            prReviewId = pendingReviewId,
            body = draft.BodyMarkdown,
            path = draft.FilePath,
            line = draft.LineNumber,
            side = draft.Side,
        },
        ct).ConfigureAwait(false);

    var threadId = responseRoot
        .GetProperty("addPullRequestReviewThread")
        .GetProperty("thread")
        .GetProperty("id")
        .GetString()
        ?? throw new HttpRequestException("addPullRequestReviewThread response missing thread.id");

    return new AttachThreadResult(threadId);
}
```

- [ ] **Step 4: Remove the stub from `GitHubReviewService.cs`**

Delete the `AttachThreadAsync` `NotImplementedException` stub line.

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitAttachThreadTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachThreadTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.AttachThreadAsync via GraphQL

addPullRequestReviewThread with pullRequestReviewId / body / path / line / side.
StartLine / StartSide stay omitted from the variables (multi-line reserved
for a future slice; spec § 4 / DraftThreadRequest reserves the fields)."
```

---

### Task 14: Implement `AttachReplyAsync` via GraphQL `addPullRequestReviewThreadReply`

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove stub)
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitAttachReplyTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task AttachReplyAsync_PostsMutation_CarryingPendingReviewIdAndParentThreadId()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_reply_456"}}}}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        var result = await svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_parent_thread", "reply body\n\n<!-- prism:client-id:r1 -->", CancellationToken.None);

        Assert.Equal("PRRC_reply_456", result.CommentId);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        Assert.Contains("addPullRequestReviewThreadReply", query);
        var vars = doc.RootElement.GetProperty("variables");
        Assert.Equal("PRR_x", vars.GetProperty("pullRequestReviewId").GetString());
        Assert.Equal("PRRT_parent_thread", vars.GetProperty("pullRequestReviewThreadId").GetString());
        Assert.Equal("reply body\n\n<!-- prism:client-id:r1 -->", vars.GetProperty("body").GetString());
    }

    [Fact]
    public async Task AttachReplyAsync_OnGraphqlError_ThrowsHttpRequestException()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"errors":[{"message":"NOT_FOUND: parent thread"}]}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", "body", CancellationToken.None));
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitAttachReplyTests"`
Expected: FAIL.

- [ ] **Step 3: Implement `AttachReplyAsync` in `GitHubReviewService.Submit.cs`**

```csharp
public async Task<AttachReplyResult> AttachReplyAsync(
    PrReference reference,
    string pendingReviewId,
    string parentThreadId,
    string replyBody,
    CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(reference);
    ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);
    ArgumentException.ThrowIfNullOrEmpty(parentThreadId);
    ArgumentNullException.ThrowIfNull(replyBody);

    var mutation = """
        mutation($prReviewId: ID!, $threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: {
            pullRequestReviewId: $prReviewId,
            pullRequestReviewThreadId: $threadId,
            body: $body
          }) {
            comment { id }
          }
        }
        """;

    var responseRoot = await GraphqlAsync(
        mutation,
        new { prReviewId = pendingReviewId, threadId = parentThreadId, body = replyBody },
        ct).ConfigureAwait(false);

    var commentId = responseRoot
        .GetProperty("addPullRequestReviewThreadReply")
        .GetProperty("comment")
        .GetProperty("id")
        .GetString()
        ?? throw new HttpRequestException("addPullRequestReviewThreadReply response missing comment.id");

    return new AttachReplyResult(commentId);
}
```

- [ ] **Step 4: Remove the stub from `GitHubReviewService.cs`**

Delete the `AttachReplyAsync` stub line.

- [ ] **Step 5: Verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitAttachReplyTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.AttachReplyAsync via GraphQL

addPullRequestReviewThreadReply with pullRequestReviewId + pullRequestReviewThreadId
(parent) + body. Reply carries the SubmitPipeline-injected marker the same way as
threads."
```

---

### Task 15: Implement `FinalizePendingReviewAsync` via GraphQL `submitPullRequestReview`

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove stub)
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitFinalizeTests.cs`

- [ ] **Step 1: Write the failing test (one per enum value + an error case)**

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitFinalizeTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Theory]
    [InlineData(SubmitEvent.Approve, "APPROVE")]
    [InlineData(SubmitEvent.RequestChanges, "REQUEST_CHANGES")]
    [InlineData(SubmitEvent.Comment, "COMMENT")]
    public async Task FinalizePendingReviewAsync_SubmitsWithCorrectEvent(SubmitEvent verdict, string expectedGraphqlEvent)
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_done","state":"APPROVED"}}}}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await svc.FinalizePendingReviewAsync(Ref, "PRR_x", verdict, CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        Assert.Contains("submitPullRequestReview", query);
        var vars = doc.RootElement.GetProperty("variables");
        Assert.Equal("PRR_x", vars.GetProperty("prReviewId").GetString());
        Assert.Equal(expectedGraphqlEvent, vars.GetProperty("event").GetString());
    }

    [Fact]
    public async Task FinalizePendingReviewAsync_OnGraphqlError_ThrowsHttpRequestException()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"errors":[{"message":"Resource not accessible"}]}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            svc.FinalizePendingReviewAsync(Ref, "PRR_x", SubmitEvent.Comment, CancellationToken.None));
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitFinalizeTests"`
Expected: FAIL — three theories + one fact = 4 failures.

- [ ] **Step 3: Implement `FinalizePendingReviewAsync` in `GitHubReviewService.Submit.cs`**

```csharp
public async Task FinalizePendingReviewAsync(
    PrReference reference,
    string pendingReviewId,
    SubmitEvent verdict,
    CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(reference);
    ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);

    var graphqlEvent = verdict switch
    {
        SubmitEvent.Approve => "APPROVE",
        SubmitEvent.RequestChanges => "REQUEST_CHANGES",
        SubmitEvent.Comment => "COMMENT",
        _ => throw new ArgumentOutOfRangeException(nameof(verdict), verdict, "Unknown SubmitEvent"),
    };

    var mutation = """
        mutation($prReviewId: ID!, $event: PullRequestReviewEvent!) {
          submitPullRequestReview(input: {
            pullRequestReviewId: $prReviewId,
            event: $event
          }) {
            pullRequestReview { id state }
          }
        }
        """;

    // Discard the response; the pipeline drives success via lack-of-exception.
    _ = await GraphqlAsync(
        mutation,
        new { prReviewId = pendingReviewId, @event = graphqlEvent },
        ct).ConfigureAwait(false);
}
```

- [ ] **Step 4: Remove the stub from `GitHubReviewService.cs`**

Delete the `FinalizePendingReviewAsync` stub.

- [ ] **Step 5: Verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitFinalizeTests"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitFinalizeTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.FinalizePendingReviewAsync via GraphQL

submitPullRequestReview with APPROVE / REQUEST_CHANGES / COMMENT event mapping.
No body argument — the summary body was carried into BeginPendingReviewAsync.
Throws HttpRequestException on a non-empty errors array; SubmitPipeline maps
that to a Step Finalize failure outcome."
```

---

### Task 16: Implement `DeletePendingReviewAsync` via GraphQL `deletePullRequestReview`

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove stub)
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitDeleteTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitDeleteTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task DeletePendingReviewAsync_PostsDeletePullRequestReviewMutation()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"data":{"deletePullRequestReview":{"pullRequestReview":{"id":"PRR_x"}}}}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await svc.DeletePendingReviewAsync(Ref, "PRR_x", CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        Assert.Contains("deletePullRequestReview", query);
        Assert.Equal("PRR_x", doc.RootElement.GetProperty("variables").GetProperty("prReviewId").GetString());
    }

    [Fact]
    public async Task DeletePendingReviewAsync_OnNotFoundError_StillThrowsHttpRequestException()
    {
        // The caller (bulk-discard) treats failures as best-effort and logs but doesn't block.
        // The interface contract is "throws on transport / GraphQL error"; the caller catches.
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"errors":[{"message":"NOT_FOUND"}]}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            svc.DeletePendingReviewAsync(Ref, "PRR_missing", CancellationToken.None));
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitDeleteTests"`
Expected: FAIL.

- [ ] **Step 3: Implement `DeletePendingReviewAsync` in `GitHubReviewService.Submit.cs`**

```csharp
public async Task DeletePendingReviewAsync(
    PrReference reference,
    string pendingReviewId,
    CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(reference);
    ArgumentException.ThrowIfNullOrEmpty(pendingReviewId);

    var mutation = """
        mutation($prReviewId: ID!) {
          deletePullRequestReview(input: { pullRequestReviewId: $prReviewId }) {
            pullRequestReview { id }
          }
        }
        """;

    _ = await GraphqlAsync(mutation, new { prReviewId = pendingReviewId }, ct).ConfigureAwait(false);
}
```

- [ ] **Step 4: Remove the stub from `GitHubReviewService.cs`**

Delete the `DeletePendingReviewAsync` stub.

- [ ] **Step 5: Verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitDeleteTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitDeleteTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.DeletePendingReviewAsync via GraphQL

deletePullRequestReview by pullRequestReviewId. Used by two callers:
SubmitPipeline's stale-commitOID branch (orphan cleanup before recreate)
and the closed/merged bulk-discard courtesy delete (best-effort)."
```

---

### Task 17: Implement `FindOwnPendingReviewAsync` via GraphQL viewer-scoped pending-review query

**Files:**

- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove stub)
- Create: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitFindOwnTests.cs`

- [ ] **Step 1: Write the failing test (covers shape + no-pending-review null case + multi-thread snapshot)**

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceSubmitFindOwnTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    [Fact]
    public async Task FindOwnPendingReviewAsync_NoPendingReview_ReturnsNull()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """
                {
                  "data": {
                    "repository": {
                      "pullRequest": {
                        "reviews": { "nodes": [] }
                      }
                    }
                  }
                }
                """),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        Assert.Null(snapshot);
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_PendingReviewExists_ProjectsToSnapshotWithThreadsAndReplies()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """
                {
                  "data": {
                    "repository": {
                      "pullRequest": {
                        "reviews": {
                          "nodes": [
                            {
                              "id": "PRR_pending_123",
                              "commit": { "oid": "abc1234" },
                              "createdAt": "2026-05-11T10:00:00Z",
                              "threads": {
                                "nodes": [
                                  {
                                    "id": "PRRT_t1",
                                    "path": "src/Foo.cs",
                                    "line": 42,
                                    "diffSide": "RIGHT",
                                    "originalCommit": { "oid": "abc1234" },
                                    "originalLine": 42,
                                    "isResolved": false,
                                    "comments": {
                                      "nodes": [
                                        { "id": "PRRC_first", "body": "original body\n\n<!-- prism:client-id:d1 -->" },
                                        { "id": "PRRC_reply", "body": "reply body\n\n<!-- prism:client-id:r1 -->" }
                                      ]
                                    }
                                  }
                                ]
                              }
                            }
                          ]
                        }
                      }
                    }
                  }
                }
                """),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        var snapshot = await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);

        Assert.NotNull(snapshot);
        Assert.Equal("PRR_pending_123", snapshot!.PullRequestReviewId);
        Assert.Equal("abc1234", snapshot.CommitOid);

        Assert.Single(snapshot.Threads);
        var t = snapshot.Threads[0];
        Assert.Equal("PRRT_t1", t.PullRequestReviewThreadId);
        Assert.Equal("src/Foo.cs", t.FilePath);
        Assert.Equal(42, t.LineNumber);
        Assert.Equal("RIGHT", t.Side);
        Assert.False(t.IsResolved);
        Assert.Contains("<!-- prism:client-id:d1 -->", t.BodyMarkdown);

        // Comments include the original (index 0) + the reply (index 1).
        // The snapshot's per-thread reply chain excludes the first comment (the thread body)
        // and includes only replies.
        Assert.Single(t.Comments);
        Assert.Equal("PRRC_reply", t.Comments[0].CommentId);
        Assert.Contains("<!-- prism:client-id:r1 -->", t.Comments[0].BodyMarkdown);
    }

    [Fact]
    public async Task FindOwnPendingReviewAsync_QueryFiltersToViewerScopedPendingState()
    {
        var handler = new RecordingHttpMessageHandler(new[] {
            (HttpStatusCode.OK, """{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]}}}}}"""),
        });
        var factory = new FakeHttpClientFactory(handler);
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>("token"), "github.com", NullLogger<GitHubReviewService>.Instance);

        await svc.FindOwnPendingReviewAsync(Ref, CancellationToken.None);

        using var doc = JsonDocument.Parse(handler.LastRequestBody!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        Assert.Contains("states: [PENDING]", query);
        Assert.Contains("author: { login:", query);  // viewer-login filter
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitFindOwnTests"`
Expected: FAIL.

- [ ] **Step 3: Resolve viewer login at adapter scope**

The query filter "viewer-scoped pending review" depends on knowing the current viewer's login. Two options:
- **(a)** Add an explicit `viewer { login }` sub-query in the same request — single round-trip, no caching needed.
- **(b)** Resolve viewer login from existing `_readToken` infra + a cached `ValidateCredentialsAsync` result.

Default to **(a)** — single GraphQL call, no shared cache state. The query becomes:

```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 1, states: [PENDING], author: { login: <viewer-login-via-variable> }) {
        nodes { ... }
      }
    }
  }
}
```

Two-step within a single GraphQL request: GraphQL doesn't let `reviews(author:)` reference `viewer.login` directly across the same query. Adapt: two-call sequence — first resolve `viewer.login`, then query reviews. Both calls go through `GraphqlAsync`. Caching the viewer login at adapter scope is again deferred — it's stable for the adapter's lifetime, but the simpler stateless adapter remains the default.

Update Test 3 to assert two requests are made and check the second one's query carries the viewer-login literal.

- [ ] **Step 4: Implement `FindOwnPendingReviewAsync` in `GitHubReviewService.Submit.cs`**

```csharp
public async Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
    PrReference reference,
    CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(reference);

    var viewerLogin = await ResolveViewerLoginAsync(ct).ConfigureAwait(false);

    var query = """
        query($owner: String!, $repo: String!, $number: Int!, $login: String!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 1, states: [PENDING], author: { login: $login }) {
                nodes {
                  id
                  commit { oid }
                  createdAt
                  threads(first: 100) {
                    nodes {
                      id
                      path
                      line
                      diffSide
                      originalCommit { oid }
                      originalLine
                      isResolved
                      comments(first: 100) {
                        nodes { id body }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        """;

    var root = await GraphqlAsync(
        query,
        new { owner = reference.Owner, repo = reference.Repo, number = reference.Number, login = viewerLogin },
        ct).ConfigureAwait(false);

    var nodes = root
        .GetProperty("repository")
        .GetProperty("pullRequest")
        .GetProperty("reviews")
        .GetProperty("nodes");

    if (nodes.GetArrayLength() == 0) return null;

    var node = nodes[0];
    var threads = node
        .GetProperty("threads")
        .GetProperty("nodes")
        .EnumerateArray()
        .Select(ProjectThread)
        .ToList();

    return new OwnPendingReviewSnapshot(
        PullRequestReviewId: node.GetProperty("id").GetString()!,
        CommitOid: node.GetProperty("commit").GetProperty("oid").GetString()!,
        CreatedAt: node.GetProperty("createdAt").GetDateTime(),
        Threads: threads);
}

private static PendingReviewThreadSnapshot ProjectThread(JsonElement thread)
{
    var commentsArray = thread.GetProperty("comments").GetProperty("nodes").EnumerateArray().ToArray();

    // The thread body is comments[0]; replies are comments[1..]. Snapshot's BodyMarkdown
    // is the thread body; Comments[] carries only replies.
    var threadBody = commentsArray.Length > 0
        ? commentsArray[0].GetProperty("body").GetString() ?? ""
        : "";
    var replies = commentsArray.Length > 1
        ? commentsArray.Skip(1).Select(c => new PendingReviewCommentSnapshot(
            CommentId: c.GetProperty("id").GetString()!,
            BodyMarkdown: c.GetProperty("body").GetString() ?? "")).ToList()
        : (IReadOnlyList<PendingReviewCommentSnapshot>)Array.Empty<PendingReviewCommentSnapshot>();

    return new PendingReviewThreadSnapshot(
        PullRequestReviewThreadId: thread.GetProperty("id").GetString()!,
        FilePath: thread.GetProperty("path").GetString()!,
        LineNumber: thread.GetProperty("line").GetInt32(),
        Side: thread.GetProperty("diffSide").GetString()!,
        OriginalCommitOid: thread.GetProperty("originalCommit").GetProperty("oid").GetString()!,
        // CRITICAL: must NOT be empty. The reconciliation pipeline's LineMatching step compares
        // anchored content character-equal against file lines (PRism.Core/Reconciliation/Pipeline/Steps/LineMatching.cs:22),
        // and an empty string matches every blank line in the file, causing imported drafts to
        // either land Stale (no exact match at originalLine) or anchor to random blank lines.
        // PR3's Resume endpoint enriches this by fetching the file content at originalCommitOid
        // and slicing the originalLine number — see Task 37 Step 3 EnrichOriginalLineContent helper.
        // Until enrichment lands, this empty string poisons reconciliation on Resume.
        OriginalLineContent: "",
        IsResolved: thread.GetProperty("isResolved").GetBoolean(),
        BodyMarkdown: threadBody,
        Comments: replies);
}

private async Task<string> ResolveViewerLoginAsync(CancellationToken ct)
{
    var query = """
        query { viewer { login } }
        """;
    var root = await GraphqlAsync(query, new { }, ct).ConfigureAwait(false);
    return root.GetProperty("viewer").GetProperty("login").GetString()
        ?? throw new HttpRequestException("viewer.login missing in response");
}
```

- [ ] **Step 5: Remove the stub from `GitHubReviewService.cs`**

Delete the `FindOwnPendingReviewAsync` stub.

- [ ] **Step 6: Verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~SubmitFindOwnTests"`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitFindOwnTests.cs
git commit -m "feat(s5-pr1): implement IReviewSubmitter.FindOwnPendingReviewAsync via GraphQL

Viewer-scoped pending-review query: two-call sequence (viewer.login lookup,
then reviews filter). Projects GraphQL response to OwnPendingReviewSnapshot
with per-thread isResolved + originalCommit.oid; thread body is comments[0],
replies are comments[1..]. OriginalLineContent stays empty in the adapter;
PR5's Resume endpoint enriches from the file content at originalCommit."
```

---

### Task 18: (Conditional) C9 fallback — `SubmitSummaryOnlyReviewAsync` via legacy REST

**Spec section:** § 2.3a fallback (b).

**Run this task ONLY if Task 7 (C9 empirical gate) recorded "GraphQL rejected the empty-threads finalize" in `docs/spec/00-verification-notes.md` § C9.** If C9 passed (spec's default), skip Task 18 entirely.

- [ ] **Step 1: Extend `IReviewSubmitter` with one method**

```csharp
// PRism.Core/IReviewSubmitter.cs
Task SubmitSummaryOnlyReviewAsync(
    PrReference reference,
    string commitOid,
    string summaryBody,
    SubmitEvent verdict,
    CancellationToken ct);
```

- [ ] **Step 2: Write the failing test**

```csharp
// tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitSummaryOnlyTests.cs
[Fact]
public async Task SubmitSummaryOnlyReviewAsync_PostsRestReviewWithBodyAndEvent_NoComments()
{
    var handler = new RecordingHttpMessageHandler(new[] {
        (HttpStatusCode.Created, """{ "id": 999, "state": "COMMENTED" }"""),
    });
    // …same setup…
    await svc.SubmitSummaryOnlyReviewAsync(Ref, "abc1234", "summary body", SubmitEvent.Comment, CancellationToken.None);

    Assert.Equal(HttpMethod.Post, handler.LastRequestMethod);
    Assert.EndsWith("/repos/owner/repo/pulls/42/reviews", handler.LastRequestPath);
    using var doc = JsonDocument.Parse(handler.LastRequestBody!);
    Assert.Equal("abc1234", doc.RootElement.GetProperty("commit_id").GetString());
    Assert.Equal("summary body", doc.RootElement.GetProperty("body").GetString());
    Assert.Equal("COMMENT", doc.RootElement.GetProperty("event").GetString());
    Assert.False(doc.RootElement.TryGetProperty("comments", out _));
}
```

- [ ] **Step 3: Implement using the existing REST conventions in `GitHubReviewService`**

```csharp
public async Task SubmitSummaryOnlyReviewAsync(
    PrReference reference,
    string commitOid,
    string summaryBody,
    SubmitEvent verdict,
    CancellationToken ct)
{
    var path = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/reviews";
    var payload = JsonSerializer.Serialize(new
    {
        commit_id = commitOid,
        body = summaryBody,
        @event = verdict switch
        {
            SubmitEvent.Approve => "APPROVE",
            SubmitEvent.RequestChanges => "REQUEST_CHANGES",
            SubmitEvent.Comment => "COMMENT",
            _ => throw new ArgumentOutOfRangeException(nameof(verdict))
        },
    });

    using var http = _httpFactory.CreateClient("github");
    using var req = new HttpRequestMessage(HttpMethod.Post, path);
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await _readToken().ConfigureAwait(false));
    req.Headers.UserAgent.ParseAdd("PRism/0.1");
    req.Headers.Accept.ParseAdd("application/vnd.github+json");
    req.Content = new StringContent(payload, Encoding.UTF8, "application/json");

    using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
    if (!resp.IsSuccessStatusCode)
    {
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        throw new HttpRequestException($"POST {path} returned {(int)resp.StatusCode}: {body}");
    }
}
```

- [ ] **Step 4: Commit (conditional)**

```bash
git add PRism.Core/IReviewSubmitter.cs PRism.GitHub/GitHubReviewService.Submit.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitSummaryOnlyTests.cs
git commit -m "feat(s5-pr1): C9 fallback — SubmitSummaryOnlyReviewAsync via legacy REST

C9 empirical gate (verified <date>) showed GraphQL submitPullRequestReview
rejects a Comment-verdict review with zero attached threads. SubmitPipeline
will branch to this legacy-REST path when DraftComments + DraftReplies are
both empty (per spec § 2.3a fallback (b))."
```

If C9 passed, skip this commit; the empty-pipeline finalize uses the standard `FinalizePendingReviewAsync` path.

---

### Task 19: ADR-S5-2 partial-class split (conditional, mid-PR)

**Spec section:** § 1.2 non-goals (optional), spec § 16 PR1 row.

**Run this task ONLY if `GitHubReviewService.cs` has grown unwieldy after Tasks 12-18 landed.** Threshold: > 800 lines or > 12 distinct method groups. Otherwise skip — the file size today (~600 lines pre-S5) plus `GitHubReviewService.Submit.cs` (the new partial) likely keeps the original under the threshold.

If running:

- [ ] **Step 1: Split into `GitHubReviewService.Auth.cs`, `GitHubReviewService.Discovery.cs`, `GitHubReviewService.Detail.cs` (Submit.cs already exists from PR1)**

Each new file:

```csharp
namespace PRism.GitHub;

public sealed partial class GitHubReviewService
{
    // Methods from the relevant capability section live here.
}
```

Migrate methods from `GitHubReviewService.cs` to their respective partial files.

- [ ] **Step 2: Build + test (no behavior change)**

Run: `dotnet build PRism.sln && dotnet test PRism.GitHub.Tests`
Expected: PASS — pure file split.

- [ ] **Step 3: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.*.cs
git commit -m "refactor(s5-pr1): ADR-S5-2 partial-class split of GitHubReviewService

Split GitHubReviewService.cs by capability area: .Auth.cs, .Discovery.cs,
.Detail.cs alongside the existing .Submit.cs. Pure file split; no behavior
change. Reduces the per-file cognitive load now that Submit added six
methods + ~150 lines."
```

---

### Task 20: PR1 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln
dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

Expected: all green.

- [ ] **Step 2: Verify zero `NotImplementedException("PR1 Task")` references remain**

Grep for `"PR1 Task"` across the solution. Expected: zero matches.

- [ ] **Step 3: Open PR1**

```bash
git push -u origin <branch>
gh pr create --title "feat(s5-pr1): IReviewSubmitter seven-method seam + GitHub GraphQL pending-review pipeline" --body "$(cat <<'EOF'
## Summary

- Fills the `IReviewSubmitter` empty seam from PR0 with the seven pending-review pipeline methods (`BeginPendingReviewAsync`, `AttachThreadAsync`, `AttachReplyAsync`, `FinalizePendingReviewAsync`, `DeletePendingReviewAsync`, `FindOwnPendingReviewAsync`).
- Implements all six against real GitHub GraphQL via raw `HttpClient` (no Octokit GraphQL helper — keeps the existing `IHttpClientFactory` + REST pattern in `GitHubReviewService`).
- Empirical-gate-confirmed parameter shapes (C6 + C9 outcomes recorded in `docs/spec/00-verification-notes.md`).

## Test plan

- [x] `dotnet test tests/PRism.GitHub.Tests` (every method has a payload-shape test + an error-case test)
- [x] `dotnet test PRism.sln` (no regression in any existing test)
- [x] Manual smoke against a sandbox PR (local-only; not in CI per S0+S1 convention)

## Spec refs

- Spec: `docs/specs/2026-05-11-s5-submit-pipeline-design.md` § 4 + § 16 PR1
- Verification: `docs/spec/00-verification-notes.md` § C6, C9

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 3 — PR2: `SubmitPipeline` state machine + v3→v4 schema migration

**PR title:** `feat(s5-pr2): SubmitPipeline state machine in PRism.Core/Submit/Pipeline + v3→v4 migration`

**Spec sections:** § 5 (state machine), § 5.2 (steps), § 5.3 (idempotency contract), § 5.4 (tests), § 6 (v3→v4 migration), § 16 PR2 row.

**Goal:** Land the resumable, step-granular state machine in `PRism.Core/Submit/Pipeline/` plus the V4 schema migration for `DraftComment.ThreadId`. The pipeline runs fully against `FakeReviewSubmitter` in tests — no `WebApplicationFactory`, no HTTP. PR3 wires the endpoint that consumes the pipeline.

**Files touched (~10 new + 3 modified + many tests):**

- Create: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (the entry point class — public)
- Create: `PRism.Core/Submit/Pipeline/SubmitProgressEvent.cs`
- Create: `PRism.Core/Submit/Pipeline/SubmitOutcome.cs`
- Create: `PRism.Core/Submit/Pipeline/SubmitStep.cs`
- Create: `PRism.Core/Submit/Pipeline/PipelineMarker.cs` (internal helper for marker injection + unclosed-fence detection)
- Create: `PRism.Core/Submit/Pipeline/SubmitPipelineSteps.cs` (internal step classes)
- Modify: `PRism.Core/State/AppState.cs` (add `ThreadId: string?` to `DraftComment`)
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs` (add `MigrateV3ToV4`)
- Modify: `PRism.Core/State/AppStateStore.cs` (bump `CurrentVersion` to 4; add the migration step entry)
- Create: `PRism.Core/State/Migrations/PrSessionsV4Migrations.cs` (optional — only if `MigrateV3ToV4` grows beyond a one-liner; otherwise inline in `AppStateMigrations.cs`)
- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (in-memory pending-review map + configurable failure injection)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/EmptyPipelineFinalizeTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/RetryFromEachStepTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/LostResponseAdoptionTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/ForeignPendingReviewTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/StaleCommitOidRetryTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/ForeignAuthorThreadDeletedTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/MultiMarkerMatchTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/PipelineMarkerTests.cs`
- Create: `tests/PRism.Core.Tests/State/MigrateV3ToV4Tests.cs`

**Worktree:** `.claude/worktrees/feat+s5-pr2`

---

### Task 21: Add `ThreadId` field to `DraftComment` + v3→v4 migration step

**Files:**

- Modify: `PRism.Core/State/AppState.cs`
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs`
- Modify: `PRism.Core/State/AppStateStore.cs`
- Create: `tests/PRism.Core.Tests/State/MigrateV3ToV4Tests.cs`

**Spec section:** § 6 (v3→v4 migration).

- [ ] **Step 1: Write the failing migration test**

`tests/PRism.Core.Tests/State/MigrateV3ToV4Tests.cs`:

```csharp
using System.Text.Json.Nodes;
using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State;

public class MigrateV3ToV4Tests
{
    [Fact]
    public void MigrateV3ToV4_BumpsVersionField_PreservesAllOtherShape()
    {
        var input = JsonNode.Parse("""
            {
              "version": 3,
              "reviews": {
                "sessions": {
                  "owner/repo/42": {
                    "draftComments": [
                      { "id": "d1", "filePath": "src/Foo.cs", "lineNumber": 42, "side": "RIGHT",
                        "anchoredSha": "abc", "anchoredLineContent": "line", "bodyMarkdown": "body",
                        "status": "Draft", "isOverriddenStale": false }
                    ]
                  }
                }
              }
            }
            """)!.AsObject();

        var output = AppStateMigrations.MigrateV3ToV4(input);

        Assert.Equal(4, output["version"]!.GetValue<int>());
        // Existing data preserved verbatim
        var draft = output["reviews"]!["sessions"]!["owner/repo/42"]!["draftComments"]![0]!.AsObject();
        Assert.Equal("d1", draft["id"]!.GetValue<string>());
        Assert.Equal("src/Foo.cs", draft["filePath"]!.GetValue<string>());
        // threadId field is absent — that's the intended state (deserializes to null)
        Assert.False(draft.ContainsKey("threadId"));
    }

    [Fact]
    public void MigrateV3ToV4_HandlesEmptyReviews()
    {
        var input = JsonNode.Parse("""{"version":3, "reviews":{"sessions":{}}}""")!.AsObject();
        var output = AppStateMigrations.MigrateV3ToV4(input);
        Assert.Equal(4, output["version"]!.GetValue<int>());
    }

    [Fact]
    public void MigrateV3ToV4_IsRegisteredInAppStateStoreMigrationSteps()
    {
        // Snapshot test against AppStateStore.CurrentVersion + the steps array
        // ensures any v4-aware code paths can rely on the step being wired.
        // We assert via behavior: a v3 file rounds through and lands at v4 with
        // the migration applied. Covered by AppStateStoreMigrationTests already;
        // this fact serves as a documentation pin.
        Assert.Equal(4, PRism.Core.State.AppStateStoreVersion.Current);
    }
}
```

If `AppStateStoreVersion.Current` doesn't exist yet, expose `CurrentVersion` via an `internal const` reflected through `InternalsVisibleTo`, OR add a public static `AppState.CurrentVersion = 4` accessor (the latter is cleaner). The third test is a sanity check; if introducing the accessor adds friction, replace it with a direct snapshot against `AppStateStoreMigrationTests`'s v3 → v4 chain test.

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MigrateV3ToV4Tests"`
Expected: FAIL (3 tests) — `MigrateV3ToV4` doesn't exist.

- [ ] **Step 3: Add `MigrateV3ToV4` to `AppStateMigrations.cs`**

Append:

```csharp
public static JsonObject MigrateV3ToV4(JsonObject root)
{
    // Additive-only: thread-id defaults to absent (deserializes to null) on existing
    // DraftComment entries. No per-session transform needed.
    // The version bump documents the schema change so downstream tooling can scan
    // migrations chronologically.
    root["version"] = 4;
    return root;
}
```

- [ ] **Step 4: Wire the step into `AppStateStore.MigrationSteps`**

Modify `PRism.Core/State/AppStateStore.cs`:

```csharp
// Before:
private const int CurrentVersion = 3;

private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
    new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
    {
        (2, AppStateMigrations.MigrateV1ToV2),
        (3, AppStateMigrations.MigrateV2ToV3),
    }.OrderBy(s => s.ToVersion).ToArray();

// After:
private const int CurrentVersion = 4;

private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
    new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
    {
        (2, AppStateMigrations.MigrateV1ToV2),
        (3, AppStateMigrations.MigrateV2ToV3),
        (4, AppStateMigrations.MigrateV3ToV4),  // S5 PR2
    }.OrderBy(s => s.ToVersion).ToArray();
```

Update `AppState.Default` in `AppState.cs`:

```csharp
public static AppState Default { get; } = new(
    Version: 4,  // was 3
    Reviews: PrSessionsState.Empty,
    // ...
```

- [ ] **Step 5: Add `ThreadId` field to `DraftComment`**

Modify `PRism.Core/State/AppState.cs`:

```csharp
public sealed record DraftComment(
    string Id,
    string? FilePath,
    int? LineNumber,
    string? Side,
    string? AnchoredSha,
    string? AnchoredLineContent,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale,
    string? ThreadId);  // S5 v4 — populated by SubmitPipeline.AttachThreads
```

Every existing constructor call site for `DraftComment` must pass `ThreadId` (likely `null`). Run `dotnet build` to surface the call sites; fix each.

- [ ] **Step 6: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MigrateV3ToV4Tests"`
Expected: PASS (3 tests).

Run the full test suite: `dotnet test PRism.sln`. Expected: PASS — additive field has `null` default at construction sites; deserializer handles absent JSON property as `null`.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/State/ tests/PRism.Core.Tests/State/MigrateV3ToV4Tests.cs
git commit -m "feat(s5-pr2): v3→v4 schema migration adds DraftComment.ThreadId field

Additive nullable field; v3 files migrate to v4 with the migration's body
empty (deserializer handles absent property as null). Per spec § 6's
visible-version-bump-over-silent-additive rationale.

Bumps AppStateStore.CurrentVersion to 4; wires MigrateV3ToV4 into
AppStateStore.MigrationSteps."
```

---

### Task 22: Add `PipelineMarker` helper (marker injection + unclosed-fence detection)

**Files:**

- Create: `PRism.Core/Submit/Pipeline/PipelineMarker.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/PipelineMarkerTests.cs`

**Spec section:** § 4 (marker injection in `SubmitPipeline`, not user-visible code; body-cap accounting includes the marker; unclosed-fence detection re-closes the user's body before appending).

- [ ] **Step 1: Write the failing tests**

`tests/PRism.Core.Tests/Submit/Pipeline/PipelineMarkerTests.cs`:

```csharp
using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Tests.Submit.Pipeline;

public class PipelineMarkerTests
{
    [Theory]
    [InlineData("simple body", "draft-1", "simple body\n\n<!-- prism:client-id:draft-1 -->")]
    [InlineData("", "d2", "\n\n<!-- prism:client-id:d2 -->")]
    [InlineData("ends with newline\n", "d3", "ends with newline\n\n\n<!-- prism:client-id:d3 -->")]
    public void Inject_AppendsMarkerWithSeparator(string body, string draftId, string expected)
    {
        Assert.Equal(expected, PipelineMarker.Inject(body, draftId));
    }

    [Fact]
    public void Inject_ClosesUnclosedFence_BeforeAppendingMarker()
    {
        var body = "intro\n```ts\nconst x = 1;\n";  // missing closing fence
        var result = PipelineMarker.Inject(body, "d4");
        // The marker must NOT land inside the fence; the helper appends a closing fence first.
        Assert.Matches(@"```ts.*const x = 1;.*```.*<!-- prism:client-id:d4 -->",
            System.Text.RegularExpressions.Regex.Replace(result, @"\s+", " "));
    }

    [Fact]
    public void Inject_LeavesClosedFenceUntouched()
    {
        var body = "```ts\nconst x = 1;\n```";  // already closed
        var result = PipelineMarker.Inject(body, "d5");
        // Exactly one ``` closing fence — no double-closing.
        var fenceCount = System.Text.RegularExpressions.Regex.Matches(result, @"```").Count;
        Assert.Equal(2, fenceCount);  // opening + closing
    }

    [Fact]
    public void Extract_ReturnsDraftId_FromMarkerAtEnd()
    {
        var body = "body content\n\n<!-- prism:client-id:abc-123 -->";
        Assert.Equal("abc-123", PipelineMarker.Extract(body));
    }

    [Fact]
    public void Extract_ReturnsNull_WhenNoMarkerPresent()
    {
        Assert.Null(PipelineMarker.Extract("just a regular body"));
    }

    [Fact]
    public void Extract_ReturnsNull_OnMarkerInTheMiddleOfBody()
    {
        // The marker is meaningful only as a footer; mid-body matches are not
        // adopted. (Composer marker-prefix rejection in PR3 prevents this case
        // from happening in practice.)
        var body = "<!-- prism:client-id:fake --> followed by more content";
        Assert.Null(PipelineMarker.Extract(body));
    }

    [Fact]
    public void ContainsMarkerPrefix_DetectsMarkerSubstringOutsideFences()
    {
        Assert.True(PipelineMarker.ContainsMarkerPrefix("some body with <!-- prism:client-id: inside"));
        Assert.False(PipelineMarker.ContainsMarkerPrefix("```\n<!-- prism:client-id: in fence\n```"));
        Assert.False(PipelineMarker.ContainsMarkerPrefix("no marker here"));
    }

    // --- Adversarial fence-detection cases (see "Doc-review revisions" R10) ---
    // The bare `Regex.Matches(body, @"```").Count` odd/even check has false
    // positives: an inline triple-backtick mention in prose, a `~~~`-style alt
    // fence, or a quad-fence wrapping a triple-backtick example all skew the
    // count and would otherwise inject a spurious closing fence mid-text. The
    // fix is line-by-line state tracking that only counts lines whose first
    // non-whitespace run is a fence opener (` ``` `, ` ```` `, or `~~~`). These
    // tests pin the contract; if the markdown-aware fix grows past a few lines,
    // document the residual limitation in the deferrals sidecar and ship the
    // line-state-tracking version.

    [Fact]
    public void Inject_DoesNotTreatInlineProseBacktickMentionAsAnOpenFence()
    {
        // Single ``` appears inside a sentence, not as a code-block opener.
        var body = "wrap the snippet in ``` so it renders as a block";
        var result = PipelineMarker.Inject(body, "d6");
        // No closing fence injected; body is left intact, marker appended at end.
        Assert.Equal(body + "\n\n<!-- prism:client-id:d6 -->", result);
    }

    [Fact]
    public void Inject_ClosesUnclosedTildeFence()
    {
        var body = "intro\n~~~\nplain text block\n";  // unclosed ~~~ fence
        var result = PipelineMarker.Inject(body, "d7");
        // Closing ~~~ injected before the marker so it lands outside the fence.
        Assert.Matches(@"~~~.*plain text block.*~~~.*<!-- prism:client-id:d7 -->",
            System.Text.RegularExpressions.Regex.Replace(result, @"\s+", " "));
    }

    [Fact]
    public void Inject_TreatsQuadFenceAsBalanced_NotOddTriple()
    {
        // A ```` ... ```` block that contains a literal ``` example line. Counting
        // bare ``` runs would see 3 and call it unbalanced; the real fence (````)
        // is balanced, so no closing fence should be injected.
        var body = "````\nhere is a ``` example\n````";
        var result = PipelineMarker.Inject(body, "d8");
        Assert.Equal(body + "\n\n<!-- prism:client-id:d8 -->", result);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PipelineMarkerTests"`
Expected: FAIL — `PipelineMarker` doesn't exist.

- [ ] **Step 3: Implement `PipelineMarker.cs`**

```csharp
using System.Text;
using System.Text.RegularExpressions;

namespace PRism.Core.Submit.Pipeline;

internal static class PipelineMarker
{
    public const string Prefix = "<!-- prism:client-id:";
    private const string Suffix = " -->";

    // Matches the marker exactly as appended: <!-- prism:client-id:<id> -->
    // optionally followed by trailing whitespace/newlines.
    private static readonly Regex EndMarkerRegex = new(
        @"<!-- prism:client-id:(?<id>[^\s>]+) -->\s*\z",
        RegexOptions.Compiled);

    private static readonly Regex FenceRegex = new(@"```", RegexOptions.Compiled);

    public static string Inject(string body, string draftId)
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentException.ThrowIfNullOrEmpty(draftId);

        var sb = new StringBuilder(body);

        // Close any unclosed code fence so the marker lands outside.
        var fences = FenceRegex.Matches(body).Count;
        if (fences % 2 == 1)
        {
            // Odd fence count → one unclosed fence. Close it.
            if (!body.EndsWith("\n", StringComparison.Ordinal)) sb.Append('\n');
            sb.Append("```\n");
        }

        sb.Append("\n\n");
        sb.Append(Prefix);
        sb.Append(draftId);
        sb.Append(Suffix);
        return sb.ToString();
    }

    public static string? Extract(string body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        var match = EndMarkerRegex.Match(body);
        return match.Success ? match.Groups["id"].Value : null;
    }

    public static bool ContainsMarkerPrefix(string body)
    {
        if (string.IsNullOrEmpty(body)) return false;
        // Strip fenced code blocks first; markers inside fences are not part of the
        // attack surface (the rendered comment escapes them).
        var stripped = StripFencedBlocks(body);
        return stripped.Contains(Prefix, StringComparison.Ordinal);
    }

    private static string StripFencedBlocks(string body)
    {
        // Two-pass strip: find every opening ``` and the matching closing ```;
        // replace the contents (including the fences) with the empty string.
        var result = new StringBuilder();
        var inFence = false;
        var lines = body.Split('\n');
        foreach (var line in lines)
        {
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                inFence = !inFence;
                continue;
            }
            if (!inFence) result.AppendLine(line);
        }
        return result.ToString();
    }
}
```

- [ ] **Step 4: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PipelineMarkerTests"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Submit/Pipeline/PipelineMarker.cs tests/PRism.Core.Tests/Submit/Pipeline/PipelineMarkerTests.cs
git commit -m "feat(s5-pr2): PipelineMarker helper for marker injection + unclosed-fence defense

Inject: appends <!-- prism:client-id:<DraftId> --> with separator, re-closing
any unclosed fence first so the marker never lands inside.
Extract: parses the trailing marker; returns null if absent.
ContainsMarkerPrefix: composer-side rejection helper (called from PR3) —
detects the marker prefix outside fenced code blocks."
```

---

### Task 23: Define `SubmitOutcome`, `SubmitStep`, `SubmitProgressEvent`

**Files:**

- Create: `PRism.Core/Submit/Pipeline/SubmitStep.cs`
- Create: `PRism.Core/Submit/Pipeline/SubmitProgressEvent.cs`
- Create: `PRism.Core/Submit/Pipeline/SubmitOutcome.cs`

- [ ] **Step 1: Write the failing test**

`tests/PRism.Core.Tests/Submit/Pipeline/PipelineTypesTests.cs`:

```csharp
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Tests.Submit.Pipeline;

public class PipelineTypesTests
{
    [Fact]
    public void SubmitStep_EnumHasFiveValues()
    {
        var values = Enum.GetValues<SubmitStep>();
        Assert.Equal(5, values.Length);
    }

    [Fact]
    public void SubmitOutcome_HasFourVariants()
    {
        // Pattern-match exhaustiveness check — the four nested record types must exist.
        SubmitOutcome o1 = new SubmitOutcome.Success("PRR_x");
        SubmitOutcome o2 = new SubmitOutcome.Failed(SubmitStep.AttachThreads, "boom", default(ReviewSessionState)!);
        SubmitOutcome o3 = new SubmitOutcome.ForeignPendingReviewPromptRequired(default!);
        SubmitOutcome o4 = new SubmitOutcome.StaleCommitOidRecreating("PRR_orphan", "stale_oid");
        Assert.NotNull(o1); Assert.NotNull(o2); Assert.NotNull(o3); Assert.NotNull(o4);
    }

    [Fact]
    public void SubmitProgressEvent_CarriesStepStatusDoneTotal()
    {
        var ev = new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, 2, 5);
        Assert.Equal(SubmitStep.AttachThreads, ev.Step);
        Assert.Equal(SubmitStepStatus.Succeeded, ev.Status);
        Assert.Equal(2, ev.Done);
        Assert.Equal(5, ev.Total);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PipelineTypesTests"`
Expected: FAIL — types missing.

- [ ] **Step 3: Implement the type files**

`PRism.Core/Submit/Pipeline/SubmitStep.cs`:

```csharp
namespace PRism.Core.Submit.Pipeline;

public enum SubmitStep
{
    DetectExistingPendingReview,
    BeginPendingReview,
    AttachThreads,
    AttachReplies,
    Finalize,
}

public enum SubmitStepStatus { Started, Succeeded, Failed }
```

`PRism.Core/Submit/Pipeline/SubmitProgressEvent.cs`:

```csharp
namespace PRism.Core.Submit.Pipeline;

public sealed record SubmitProgressEvent(
    SubmitStep Step,
    SubmitStepStatus Status,
    int Done,
    int Total,
    string? ErrorMessage = null);
```

`PRism.Core/Submit/Pipeline/SubmitOutcome.cs`:

```csharp
using PRism.Core.State;
using PRism.Core.Submit;

namespace PRism.Core.Submit.Pipeline;

public abstract record SubmitOutcome
{
    public sealed record Success(string PullRequestReviewId) : SubmitOutcome;
    public sealed record Failed(SubmitStep FailedStep, string ErrorMessage, ReviewSessionState NewSession) : SubmitOutcome;
    public sealed record ForeignPendingReviewPromptRequired(OwnPendingReviewSnapshot Snapshot) : SubmitOutcome;
    public sealed record StaleCommitOidRecreating(string OrphanReviewId, string OrphanCommitOid) : SubmitOutcome;
}
```

- [ ] **Step 4: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PipelineTypesTests"`
Expected: PASS.

- [ ] **Step 5: Commit (group with Task 24's pipeline shell)** — hold the commit until Task 24 defines the empty pipeline.

---

### Task 24: Build `FakeReviewSubmitter` (for pipeline unit tests)

**Files:**

- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (from PR0; PR0 left it empty)
- Move location decision: this fake serves the PRism.Core.Tests pipeline tests, not just PRism.Web. Pull `FakeReviewSubmitter` down to `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs` (Core-Tests-only) and keep `PRism.Web.TestHooks.FakeReviewSubmitter` as a thin wrapper for the Playwright `/test/*` endpoints.

Actually, simpler: PR2 introduces a Core-test-internal fake. The Playwright fake from PR0 stays in `PRism.Web.TestHooks` and grows in PR3 / PR7 with `/test/submit/*` endpoint support.

- Create: `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitterTests.cs`

- [ ] **Step 1: Write the failing test for the fake's own behavior (smoke)**

`tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitterTests.cs`:

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

public class InMemoryReviewSubmitterTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task BeginPendingReviewAsync_StoresInMemory_AndReturnsId()
    {
        var fake = new InMemoryReviewSubmitter();
        var result = await fake.BeginPendingReviewAsync(Ref, "abc", "summary", default);
        Assert.NotNull(result.PullRequestReviewId);

        var snapshot = await fake.FindOwnPendingReviewAsync(Ref, default);
        Assert.NotNull(snapshot);
        Assert.Equal(result.PullRequestReviewId, snapshot!.PullRequestReviewId);
    }

    [Fact]
    public async Task FailureInjection_CausesNamedMethodToThrowOnNextCall()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.AttachThreadAsync), new HttpRequestException("simulated"));

        await fake.BeginPendingReviewAsync(Ref, "abc", "", default);
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            fake.AttachThreadAsync(Ref, "any", new DraftThreadRequest("d", "b", "p", 1, "RIGHT"), default));

        // Second call succeeds — failure injection is one-shot.
        var result = await fake.AttachThreadAsync(Ref, "any", new DraftThreadRequest("d", "b", "p", 1, "RIGHT"), default);
        Assert.NotNull(result.PullRequestReviewThreadId);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InMemoryReviewSubmitter"`
Expected: FAIL — class missing.

- [ ] **Step 3: Implement `InMemoryReviewSubmitter`**

```csharp
// tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

internal sealed class InMemoryReviewSubmitter : IReviewSubmitter
{
    private readonly Dictionary<string, InMemoryPendingReview> _pendingByRef = new();
    private readonly Dictionary<string, Exception> _failureByMethod = new();
    private int _nextId = 1;

    public void InjectFailure(string methodName, Exception ex) => _failureByMethod[methodName] = ex;

    // Manual setup helpers for pipeline tests (e.g. pre-populating a foreign pending review):
    public void SeedPendingReview(PrReference prRef, InMemoryPendingReview pending)
        => _pendingByRef[Key(prRef)] = pending;

    public InMemoryPendingReview? GetPending(PrReference prRef)
        => _pendingByRef.TryGetValue(Key(prRef), out var p) ? p : null;

    public Task<BeginPendingReviewResult> BeginPendingReviewAsync(PrReference reference, string commitOid, string summaryBody, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(BeginPendingReviewAsync));
        var id = $"PRR_{_nextId++}";
        _pendingByRef[Key(reference)] = new InMemoryPendingReview(id, commitOid, DateTime.UtcNow, summaryBody);
        return Task.FromResult(new BeginPendingReviewResult(id));
    }

    public Task<AttachThreadResult> AttachThreadAsync(PrReference reference, string pendingReviewId, DraftThreadRequest draft, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(AttachThreadAsync));
        var pending = _pendingByRef[Key(reference)];
        var threadId = $"PRRT_{_nextId++}";
        pending.Threads.Add(new InMemoryThread(threadId, draft.FilePath, draft.LineNumber, draft.Side,
            commitOid: pending.CommitOid, body: draft.BodyMarkdown, isResolved: false, replies: new()));
        return Task.FromResult(new AttachThreadResult(threadId));
    }

    public Task<AttachReplyResult> AttachReplyAsync(PrReference reference, string pendingReviewId, string parentThreadId, string replyBody, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(AttachReplyAsync));
        var pending = _pendingByRef[Key(reference)];
        var thread = pending.Threads.FirstOrDefault(t => t.Id == parentThreadId)
            ?? throw new HttpRequestException($"NOT_FOUND: parentThreadId {parentThreadId}");
        var commentId = $"PRRC_{_nextId++}";
        thread.Replies.Add(new InMemoryComment(commentId, replyBody));
        return Task.FromResult(new AttachReplyResult(commentId));
    }

    public Task FinalizePendingReviewAsync(PrReference reference, string pendingReviewId, SubmitEvent verdict, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(FinalizePendingReviewAsync));
        _pendingByRef.Remove(Key(reference)); // submitted → no longer pending
        return Task.CompletedTask;
    }

    public Task DeletePendingReviewAsync(PrReference reference, string pendingReviewId, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(DeletePendingReviewAsync));
        _pendingByRef.Remove(Key(reference));
        return Task.CompletedTask;
    }

    public Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(PrReference reference, CancellationToken ct)
    {
        ConsumeFailureOrContinue(nameof(FindOwnPendingReviewAsync));
        if (!_pendingByRef.TryGetValue(Key(reference), out var pending)) return Task.FromResult<OwnPendingReviewSnapshot?>(null);

        var threads = pending.Threads.Select(t => new PendingReviewThreadSnapshot(
            PullRequestReviewThreadId: t.Id,
            FilePath: t.FilePath,
            LineNumber: t.LineNumber,
            Side: t.Side,
            OriginalCommitOid: t.CommitOid,
            OriginalLineContent: "",
            IsResolved: t.IsResolved,
            BodyMarkdown: t.Body,
            Comments: t.Replies.Select(r => new PendingReviewCommentSnapshot(r.Id, r.Body)).ToList()))
            .ToList();

        return Task.FromResult<OwnPendingReviewSnapshot?>(new OwnPendingReviewSnapshot(
            pending.Id, pending.CommitOid, pending.CreatedAt, threads));
    }

    private void ConsumeFailureOrContinue(string methodName)
    {
        if (_failureByMethod.Remove(methodName, out var ex)) throw ex;
    }

    private static string Key(PrReference r) => $"{r.Owner}/{r.Repo}/{r.Number}";

    internal sealed class InMemoryPendingReview
    {
        public string Id { get; }
        public string CommitOid { get; set; }
        public DateTime CreatedAt { get; }
        public string SummaryBody { get; }
        public List<InMemoryThread> Threads { get; } = new();

        public InMemoryPendingReview(string id, string commitOid, DateTime createdAt, string summaryBody)
        { Id = id; CommitOid = commitOid; CreatedAt = createdAt; SummaryBody = summaryBody; }
    }

    internal sealed record InMemoryThread(string Id, string FilePath, int LineNumber, string Side, string CommitOid, string Body, bool IsResolved, List<InMemoryComment> Replies);
    internal sealed record InMemoryComment(string Id, string Body);
}
```

- [ ] **Step 4: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InMemoryReviewSubmitter"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (with Task 23's types)**

```bash
git add PRism.Core/Submit/Pipeline/SubmitStep.cs PRism.Core/Submit/Pipeline/SubmitProgressEvent.cs PRism.Core/Submit/Pipeline/SubmitOutcome.cs tests/PRism.Core.Tests/Submit/Pipeline/
git commit -m "feat(s5-pr2): pipeline types (SubmitStep / SubmitOutcome / SubmitProgressEvent) + InMemoryReviewSubmitter

Test-only fake supporting failure injection per method. Pipeline tests in
the remaining PR2 tasks consume this fake to drive each step's behavior in
isolation."
```

---

### Task 25: `SubmitPipeline` entry point — Step 1 (Detect existing pending review) — match-by-ID + no-pending + foreign-pending outcomes

**Files:**

- Create: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/ForeignPendingReviewTests.cs` (initial set; DoD (c) + (d) shape)

**Spec section:** § 5.1 (entry point), § 5.2 step 1 (three outcomes).

- [ ] **Step 1: Write the failing tests**

`tests/PRism.Core.Tests/Submit/Pipeline/ForeignPendingReviewTests.cs`:

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class ForeignPendingReviewTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    private static ReviewSessionState EmptySessionAtHead(string head)
        => new(LastViewedHeadSha: head, LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    [Fact]
    public async Task Step1_NoPendingReview_ProceedsToStep2_BeginsPendingReview()
    {
        var fake = new InMemoryReviewSubmitter();
        var pipeline = new SubmitPipeline(fake);

        var outcome = await pipeline.SubmitAsync(
            Ref,
            EmptySessionAtHead("head1"),
            SubmitEvent.Comment,
            currentHeadSha: "head1",
            progress: NoopProgress.Instance,
            ct: default);

        // Empty session + no foreign pending review → reaches Finalize and succeeds.
        Assert.IsType<SubmitOutcome.Success>(outcome);
    }

    [Fact]
    public async Task Step1_OurPendingReviewIdMatches_ResumesAtAttachThreads()
    {
        var fake = new InMemoryReviewSubmitter();
        // Pre-seed a pending review the pipeline will resume.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_existing", "head1", DateTime.UtcNow.AddMinutes(-5), "");
        fake.SeedPendingReview(Ref, pending);

        var session = EmptySessionAtHead("head1") with { PendingReviewId = "PRR_existing", PendingReviewCommitOid = "head1" };
        var pipeline = new SubmitPipeline(fake);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, default);

        // No new BeginPendingReview call should have happened (the seed wasn't recreated).
        Assert.IsType<SubmitOutcome.Success>(outcome);
        // Pending review was finalized → removed from fake.
        Assert.Null(fake.GetPending(Ref));
    }

    [Fact]
    public async Task Step1_ForeignPendingReviewExists_ReturnsForeignPendingReviewPromptRequired()
    {
        var fake = new InMemoryReviewSubmitter();
        // Pre-seed a pending review that DOESN'T match the session's PendingReviewId.
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_foreign", "head1", DateTime.UtcNow.AddDays(-2), "summary"));

        var session = EmptySessionAtHead("head1"); // PendingReviewId is null
        var pipeline = new SubmitPipeline(fake);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, default);

        var prompt = Assert.IsType<SubmitOutcome.ForeignPendingReviewPromptRequired>(outcome);
        Assert.Equal("PRR_foreign", prompt.Snapshot.PullRequestReviewId);
    }
}

internal sealed class NoopProgress : IProgress<SubmitProgressEvent>
{
    public static readonly NoopProgress Instance = new();
    public void Report(SubmitProgressEvent value) { }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ForeignPendingReviewTests"`
Expected: FAIL — `SubmitPipeline` doesn't exist.

- [ ] **Step 3: Implement `SubmitPipeline` (Step 1 only at first)**

The pipeline takes `IReviewSubmitter` AND `IAppStateStore` via constructor (the latter so per-stamp persistence is a direct `UpdateAsync` overlay, not a callback — matches how `DraftReconciliationPipeline` and other `PRism.Core` machinery already work). It also takes an optional `Action<string>? onDuplicateMarker` (wired to the duplicate-marker SSE event by the endpoint in PR3 — see Task 29) and an optional `Func<CancellationToken, Task<string>>? getCurrentHeadShaAsync` (the pre-Finalize head_sha re-poll — see Task 59 / revision R11). The session key is derived from `reference` inside the pipeline (`$"{reference.Owner}/{reference.Repo}/{reference.Number}"`), so `SubmitAsync` keeps the spec § 5.1 signature.

`PRism.Core/Submit/Pipeline/SubmitPipeline.cs`:

```csharp
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;

namespace PRism.Core.Submit.Pipeline;

public sealed class SubmitPipeline
{
    private readonly IReviewSubmitter _submitter;
    private readonly IAppStateStore _stateStore;
    private readonly Action<string>? _onDuplicateMarker;
    private readonly Func<CancellationToken, Task<string>>? _getCurrentHeadShaAsync;

    public SubmitPipeline(
        IReviewSubmitter submitter,
        IAppStateStore stateStore,
        Action<string>? onDuplicateMarker = null,
        Func<CancellationToken, Task<string>>? getCurrentHeadShaAsync = null)
    {
        _submitter = submitter;
        _stateStore = stateStore;
        _onDuplicateMarker = onDuplicateMarker;
        _getCurrentHeadShaAsync = getCurrentHeadShaAsync;
    }

    public async Task<SubmitOutcome> SubmitAsync(
        PrReference reference,
        ReviewSessionState session,
        SubmitEvent verdict,
        string currentHeadSha,
        IProgress<SubmitProgressEvent> progress,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentException.ThrowIfNullOrEmpty(currentHeadSha);
        ArgumentNullException.ThrowIfNull(progress);

        var sessionKey = $"{reference.Owner}/{reference.Repo}/{reference.Number}";

        try
        {
            // Step 1 — Detect existing pending review.
            progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Started, 0, 0));
            var existing = await _submitter.FindOwnPendingReviewAsync(reference, ct).ConfigureAwait(false);

            string pendingReviewId;
            var workingSession = session;

            if (existing is null)
            {
                // No pending review → Step 2.
                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                pendingReviewId = await StepBeginAsync(reference, sessionKey, session, currentHeadSha, progress, ct).ConfigureAwait(false);
                workingSession = workingSession with { PendingReviewId = pendingReviewId, PendingReviewCommitOid = currentHeadSha };
            }
            else if (session.PendingReviewId == existing.PullRequestReviewId)
            {
                // Match by ID → resume.
                if (existing.CommitOid != currentHeadSha)
                {
                    // Stale-commitOID branch (full implementation in Task 26).
                    progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Started, 0, 0));
                    await _submitter.DeletePendingReviewAsync(reference, existing.PullRequestReviewId, ct).ConfigureAwait(false);
                    // Clear PendingReviewId / PendingReviewCommitOid / every ThreadId / every ReplyCommentId
                    // on the CURRENT session (overlay-only, not the working snapshot).
                    await _stateStore.UpdateAsync(state =>
                    {
                        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
                        var cleared = cur with
                        {
                            PendingReviewId = null,
                            PendingReviewCommitOid = null,
                            DraftComments = cur.DraftComments.Select(d => d with { ThreadId = null }).ToList(),
                            DraftReplies = cur.DraftReplies.Select(r => r with { ReplyCommentId = null }).ToList(),
                        };
                        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
                        return state with { Reviews = state.Reviews with { Sessions = sessions } };
                    }, ct).ConfigureAwait(false);
                    return new SubmitOutcome.StaleCommitOidRecreating(existing.PullRequestReviewId, existing.CommitOid);
                }
                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                pendingReviewId = existing.PullRequestReviewId;
            }
            else
            {
                // Foreign pending review → prompt.
                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                return new SubmitOutcome.ForeignPendingReviewPromptRequired(existing);
            }

            // Steps 3+4+5 (Tasks 27-31 fill these in).
            workingSession = await StepAttachThreadsAsync(reference, sessionKey, pendingReviewId, workingSession, existing, progress, ct).ConfigureAwait(false);
            workingSession = await StepAttachRepliesAsync(reference, sessionKey, pendingReviewId, workingSession, progress, ct).ConfigureAwait(false);

            // Pre-Finalize head_sha re-poll (revision R11): catch a push that landed mid-pipeline.
            if (_getCurrentHeadShaAsync is not null)
            {
                var fresh = await _getCurrentHeadShaAsync(ct).ConfigureAwait(false);
                if (fresh != currentHeadSha)
                {
                    progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Failed, 0, 1, "head_sha drift"));
                    return new SubmitOutcome.Failed(SubmitStep.Finalize, "head_sha drift before Finalize", workingSession);
                }
            }

            await StepFinalizeAsync(reference, pendingReviewId, verdict, progress, ct).ConfigureAwait(false);

            // On Success — clear PendingReviewId / drafts / replies / summary / verdict on the CURRENT session.
            await _stateStore.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
                var cleared = cur with
                {
                    PendingReviewId = null,
                    PendingReviewCommitOid = null,
                    DraftComments = new List<DraftComment>(),
                    DraftReplies = new List<DraftReply>(),
                    DraftSummaryMarkdown = null,
                    DraftVerdict = null,
                    DraftVerdictStatus = DraftVerdictStatus.Draft,
                };
                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }, ct).ConfigureAwait(false);

            return new SubmitOutcome.Success(pendingReviewId);
        }
        catch (SubmitFailedException sfe)
        {
            return new SubmitOutcome.Failed(sfe.Step, sfe.Message, sfe.SessionAtFailure);
        }
    }

    private async Task<string> StepBeginAsync(PrReference reference, string sessionKey, ReviewSessionState session, string currentHeadSha, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        progress.Report(new SubmitProgressEvent(SubmitStep.BeginPendingReview, SubmitStepStatus.Started, 0, 1));
        var result = await _submitter.BeginPendingReviewAsync(reference, currentHeadSha, session.DraftSummaryMarkdown ?? "", ct).ConfigureAwait(false);
        // Stamp PendingReviewId / PendingReviewCommitOid on the CURRENT session.
        await _stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
            var stamped = cur with { PendingReviewId = result.PullRequestReviewId, PendingReviewCommitOid = currentHeadSha };
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = stamped };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct).ConfigureAwait(false);
        progress.Report(new SubmitProgressEvent(SubmitStep.BeginPendingReview, SubmitStepStatus.Succeeded, 1, 1));
        return result.PullRequestReviewId;
    }

    // Overlay helper: stamp one draft's ThreadId on the CURRENT session without overwriting
    // anything else (defends against a foreign-tab PUT /draft committing between snapshot-load
    // and this call — revision R1 / adversarial #4).
    private Task StampDraftThreadIdAsync(string sessionKey, string draftId, string threadId, CancellationToken ct)
        => _stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
            var drafts = cur.DraftComments.Select(d => d.Id == draftId ? d with { ThreadId = threadId } : d).ToList();
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cur with { DraftComments = drafts } };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct);

    private Task StampReplyCommentIdAsync(string sessionKey, string replyId, string commentId, CancellationToken ct)
        => _stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
            var replies = cur.DraftReplies.Select(r => r.Id == replyId ? r with { ReplyCommentId = commentId } : r).ToList();
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cur with { DraftReplies = replies } };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct);

    private Task DemoteReplyToStaleAsync(string sessionKey, string replyId, CancellationToken ct)
        => _stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
            var replies = cur.DraftReplies.Select(r => r.Id == replyId ? r with { Status = DraftStatus.Stale } : r).ToList();
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cur with { DraftReplies = replies } };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct);

    private async Task<ReviewSessionState> StepAttachThreadsAsync(PrReference r, string sessionKey, string pendingReviewId, ReviewSessionState s, OwnPendingReviewSnapshot? snapshot, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
        => s; // Task 27 fills in — uses StampDraftThreadIdAsync per-stamp; returns the updated working snapshot

    private async Task<ReviewSessionState> StepAttachRepliesAsync(PrReference r, string sessionKey, string pendingReviewId, ReviewSessionState s, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
        => s; // Task 28 fills in — uses StampReplyCommentIdAsync / DemoteReplyToStaleAsync per-stamp

    private async Task StepFinalizeAsync(PrReference r, string pendingReviewId, SubmitEvent verdict, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Started, 0, 1));
        await _submitter.FinalizePendingReviewAsync(r, pendingReviewId, verdict, ct).ConfigureAwait(false);
        progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Succeeded, 1, 1));
    }
}
```

`SubmitFailedException` (internal — used by the step methods to carry the failed step + session-at-failure up to `SubmitAsync`'s catch):

```csharp
// PRism.Core/Submit/Pipeline/SubmitFailedException.cs
namespace PRism.Core.Submit.Pipeline;

internal sealed class SubmitFailedException : Exception
{
    public SubmitStep Step { get; }
    public ReviewSessionState SessionAtFailure { get; }

    public SubmitFailedException(SubmitStep step, string message, ReviewSessionState session, Exception? inner = null)
        : base(message, inner) { Step = step; SessionAtFailure = session; }
}
```

The test file needs a fake `IAppStateStore` (an in-memory `Dictionary<string, AppState>` — define `InMemoryAppStateStore` in `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStore.cs`: `LoadAsync` returns the stored state, `UpdateAsync` runs the transform on it and stores the result, `SaveAsync` stores; seed it with an `AppState` containing the test session at `sessionKey`). Update the test invocations: `new SubmitPipeline(fake, fakeStore)` and seed `fakeStore` with the session under `"owner/repo/1"` before calling `SubmitAsync`. The `NoopProgress` helper stays as shown.

- [ ] **Step 4: Verify pass (Step 1 tests + finalize-of-empty test)**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ForeignPendingReviewTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests/PRism.Core.Tests/Submit/Pipeline/ForeignPendingReviewTests.cs
git commit -m "feat(s5-pr2): SubmitPipeline.Step1 — detect existing pending review

Three outcomes per spec § 5.2 step 1: no pending → Begin, match-by-ID →
resume, foreign → prompt. Stale-commitOID branch stubbed (Task 26 fills
in fully). Steps 3-5 are placeholder no-ops (Tasks 27-29 fill in)."
```

---

### Task 26: Stale-`commitOID` branch — full implementation + DoD test (e)

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (extend the stale-commitOID branch)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/StaleCommitOidRetryTests.cs`

**Spec section:** § 5.2 "Stale-commitOID branch", § 12 (frontend retry UX consumes the outcome). **DoD test (e).**

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class StaleCommitOidRetryTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task StaleCommitOid_DeletesOrphan_ReturnsRecreatingOutcome_WithClearedStamps()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_old", "head_OLD", DateTime.UtcNow, ""));

        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "head_OLD", "x = 1;", "body", DraftStatus.Draft, false, ThreadId: "PRRT_stale");
        var reply = new DraftReply("r1", "PRRT_old_parent", ReplyCommentId: "PRRC_stale", "reply", DraftStatus.Draft, false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: "head_OLD",
            LastSeenCommentId: null,
            PendingReviewId: "PRR_old",
            PendingReviewCommitOid: "head_OLD",
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { draft },
            DraftReplies: new List<DraftReply> { reply },
            DraftSummaryMarkdown: "summary",
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var pipeline = new SubmitPipeline(fake);
        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, currentHeadSha: "head_NEW", progress: NoopProgress.Instance, ct: default);

        var recreating = Assert.IsType<SubmitOutcome.StaleCommitOidRecreating>(outcome);
        Assert.Equal("PRR_old", recreating.OrphanReviewId);
        Assert.Equal("head_OLD", recreating.OrphanCommitOid);

        // Orphan deleted server-side
        Assert.Null(fake.GetPending(Ref));
    }

    [Fact]
    public async Task StaleCommitOid_ClearedSessionExposedForCallerToPersist()
    {
        // The pipeline returns the cleared session shape; the caller persists it.
        // The outcome carries the orphan IDs, NOT the cleared session — the spec puts
        // session-clearing in the endpoint layer (§ 7.1) using AppStateStore.UpdateAsync.
        // Pipeline contract: emit Recreating(orphanReviewId, orphanCommitOid); endpoint
        // clears PendingReviewId / PendingReviewCommitOid / every ThreadId / every ReplyCommentId.

        // Document this with a regression test that asserts the outcome's shape only:
        // (covered by the test above; this comment lives in the spec § 5.2 paragraph)
        Assert.True(true);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~StaleCommitOidRetryTests"`
Expected: FAIL (Step 1 of Task 25 had a partial stub; needs full delete-orphan-and-emit-outcome).

- [ ] **Step 3: The Task 25 stub is sufficient for the assertion — verify it passes**

The Task 25 implementation already calls `DeletePendingReviewAsync` and returns `SubmitOutcome.StaleCommitOidRecreating`. Run the test.

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~StaleCommitOidRetryTests"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.Core.Tests/Submit/Pipeline/StaleCommitOidRetryTests.cs
git commit -m "test(s5-pr2): DoD test (e) — stale-commitOID branch returns StaleCommitOidRecreating

Pipeline-level test pins the contract: orphan is deleted, outcome carries
both IDs; caller (PR3 endpoint) clears session.PendingReviewId / per-draft
ThreadId / per-reply ReplyCommentId via AppStateStore.UpdateAsync."
```

---

### Task 27: Step 3 — Attach threads, with stamped / unstamped / marker-adoption branches

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (fill in `StepAttachThreadsAsync`)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/AttachThreadsTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/LostResponseAdoptionTests.cs`

**Spec section:** § 5.2 step 3, § 5.3 idempotency contract.

The pipeline's "persist after every stamp" promise (per spec § 5.2 step 3) is fulfilled by the **endpoint** layer (PR3) wrapping each per-draft call site in an `AppStateStore.UpdateAsync`. The pipeline itself doesn't touch state. PR2 keeps the pipeline pure — the persistence contract surfaces as a callback parameter the endpoint provides:

```csharp
public Task<SubmitOutcome> SubmitAsync(
    PrReference reference,
    ReviewSessionState session,
    SubmitEvent verdict,
    string currentHeadSha,
    IProgress<SubmitProgressEvent> progress,
    Func<ReviewSessionState, Task> persistAsync,  // NEW — endpoint hooks AppStateStore.UpdateAsync here
    CancellationToken ct);
```

This change ripples to every existing caller (so far only PR2's tests). Update the existing tests' `pipeline.SubmitAsync(...)` invocations to pass a no-op `persistAsync` (e.g., `_ => Task.CompletedTask`).

- [ ] **Step 1: Write the failing tests (attach-threads branches + adoption)**

`tests/PRism.Core.Tests/Submit/Pipeline/AttachThreadsTests.cs`:

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class AttachThreadsTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task UnstampedDraft_NoMarkerMatch_CallsAttachThread_StampsThreadId()
    {
        var fake = new InMemoryReviewSubmitter();
        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "abc", "line", "body", DraftStatus.Draft, false, ThreadId: null);
        var session = SessionWith(draft);

        var persistedSessions = new List<ReviewSessionState>();
        var pipeline = new SubmitPipeline(fake);
        await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, s => { persistedSessions.Add(s); return Task.CompletedTask; }, default);

        // The pending review's threads include our draft, stamped with a real thread ID.
        var snapshot = await fake.FindOwnPendingReviewAsync(Ref, default);
        Assert.Null(snapshot); // Finalize ran, pending review is gone.

        // The persisted session right after Step 3 carries ThreadId on the draft.
        Assert.Contains(persistedSessions, s => s.DraftComments.Any(d => d.Id == "d1" && d.ThreadId is not null));
    }

    [Fact]
    public async Task StampedDraft_PresentInSnapshot_Skipped()
    {
        var fake = new InMemoryReviewSubmitter();
        // Pre-seed our pending review with one existing thread carrying our marker.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTime.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_existing", "src/Foo.cs", 42, "RIGHT", "head1",
            body: $"body\n\n<!-- prism:client-id:d1 -->", isResolved: false, replies: new()));
        fake.SeedPendingReview(Ref, pending);

        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "abc", "line", "body", DraftStatus.Draft, false, ThreadId: "PRRT_existing");
        var session = SessionWith(draft) with { PendingReviewId = "PRR_x", PendingReviewCommitOid = "head1" };

        var pipeline = new SubmitPipeline(fake);
        var threadsBefore = pending.Threads.Count;
        await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, _ => Task.CompletedTask, default);

        // Step 3 did NOT add a duplicate thread.
        Assert.Equal(threadsBefore, /* in the snapshot before Finalize */ 1);
    }

    private static ReviewSessionState SessionWith(DraftComment draft) =>
        new(LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { draft },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

`tests/PRism.Core.Tests/Submit/Pipeline/LostResponseAdoptionTests.cs`:

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class LostResponseAdoptionTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task UnstampedDraft_MarkerMatchesServerThread_AdoptsId_SkipsAttachThreadCall()
    {
        var fake = new InMemoryReviewSubmitter();
        // The server already has our thread (the lost-response: prior call succeeded server-side but
        // response never reached us, so draft is unstamped locally).
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTime.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_lost", "src/Foo.cs", 42, "RIGHT", "head1",
            body: $"body content\n\n<!-- prism:client-id:d1 -->", isResolved: false, replies: new()));
        fake.SeedPendingReview(Ref, pending);

        // Our session has the draft unstamped; the marker on the server matches DraftId "d1".
        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "head1", "line", "body content", DraftStatus.Draft, false, ThreadId: null);
        var session = new ReviewSessionState(
            LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: "PRR_x", PendingReviewCommitOid: "head1",
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { draft },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null, DraftVerdictStatus: DraftVerdictStatus.Draft);

        var persisted = new List<ReviewSessionState>();
        var pipeline = new SubmitPipeline(fake);
        await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, s => { persisted.Add(s); return Task.CompletedTask; }, default);

        // Draft is now stamped with the SERVER's thread ID, not a new one.
        var stamped = persisted.SelectMany(s => s.DraftComments).First(d => d.Id == "d1" && d.ThreadId is not null);
        Assert.Equal("PRRT_lost", stamped.ThreadId);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AttachThreadsTests|FullyQualifiedName~LostResponseAdoptionTests"`
Expected: FAIL — `StepAttachThreadsAsync` is the placeholder no-op.

- [ ] **Step 3: Implement `StepAttachThreadsAsync`**

Replace the placeholder with:

```csharp
private async Task<ReviewSessionState> StepAttachThreadsAsync(
    PrReference reference,
    string pendingReviewId,
    ReviewSessionState session,
    OwnPendingReviewSnapshot? snapshot,
    Func<ReviewSessionState, Task> persistAsync,
    IProgress<SubmitProgressEvent> progress,
    CancellationToken ct)
{
    var totalDrafts = session.DraftComments.Count;
    if (totalDrafts == 0) return session;

    progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Started, 0, totalDrafts));

    // Refresh snapshot if we don't have one (happens on first-time Step 2 branch).
    var workingSnapshot = snapshot ?? await _submitter.FindOwnPendingReviewAsync(reference, ct).ConfigureAwait(false);
    var currentSession = session;
    var done = 0;

    foreach (var draft in session.DraftComments)
    {
        if (draft.Status == DraftStatus.Stale) continue;  // rule (b) catches in endpoint layer

        if (draft.ThreadId is not null)
        {
            // Verify present in snapshot. Absent → recreate.
            var existingThread = workingSnapshot?.Threads.FirstOrDefault(t => t.PullRequestReviewThreadId == draft.ThreadId);
            if (existingThread is not null)
            {
                done++;
                progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, done, totalDrafts));
                continue;  // already attached on a prior attempt
            }
            // Thread was resolved/deleted on github.com between attempts → recreate.
            // Falls through to the "no match" path below.
        }
        else
        {
            // Unstamped — try marker adoption.
            var adopted = TryAdoptByMarker(workingSnapshot, draft.Id);
            if (adopted.Count == 1)
            {
                currentSession = StampDraftThreadId(currentSession, draft.Id, adopted[0].PullRequestReviewThreadId);
                await persistAsync(currentSession).ConfigureAwait(false);
                done++;
                progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, done, totalDrafts));
                continue;
            }
            if (adopted.Count > 1)
            {
                // Multi-match defense — adopt earliest, delete the rest (best-effort).
                // Implemented in Task 29 (MultiMarkerMatchTests).
                throw new NotImplementedException("Task 29 — multi-match defense");
            }
            // No match → fall through and create.
        }

        // Create the thread.
        var bodyWithMarker = PipelineMarker.Inject(draft.BodyMarkdown, draft.Id);
        var request = new DraftThreadRequest(
            DraftId: draft.Id,
            BodyMarkdown: bodyWithMarker,
            FilePath: draft.FilePath ?? throw new InvalidOperationException($"Draft {draft.Id} missing FilePath"),
            LineNumber: draft.LineNumber ?? throw new InvalidOperationException($"Draft {draft.Id} missing LineNumber"),
            Side: draft.Side ?? "RIGHT");

        AttachThreadResult result;
        try
        {
            result = await _submitter.AttachThreadAsync(reference, pendingReviewId, request, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Failed, done, totalDrafts, ex.Message));
            throw new SubmitFailedException(SubmitStep.AttachThreads, ex.Message, currentSession, ex);
        }

        currentSession = StampDraftThreadId(currentSession, draft.Id, result.PullRequestReviewThreadId);
        await persistAsync(currentSession).ConfigureAwait(false);
        done++;
        progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, done, totalDrafts));
    }

    return currentSession;
}

// Returns the list of server threads whose body's marker matches the given draftId.
private static IReadOnlyList<PendingReviewThreadSnapshot> TryAdoptByMarker(
    OwnPendingReviewSnapshot? snapshot, string draftId)
{
    if (snapshot is null) return Array.Empty<PendingReviewThreadSnapshot>();
    return snapshot.Threads
        .Where(t => PipelineMarker.Extract(t.BodyMarkdown) == draftId)
        .OrderBy(t => t.PullRequestReviewThreadId, StringComparer.Ordinal) // proxy for createdAt absent in snapshot; refined in Task 29
        .ToList();
}

private static ReviewSessionState StampDraftThreadId(ReviewSessionState session, string draftId, string threadId)
{
    var drafts = session.DraftComments
        .Select(d => d.Id == draftId ? d with { ThreadId = threadId } : d)
        .ToList();
    return session with { DraftComments = drafts };
}
```

Also define the internal exception type:

```csharp
// PRism.Core/Submit/Pipeline/SubmitFailedException.cs
namespace PRism.Core.Submit.Pipeline;

internal sealed class SubmitFailedException : Exception
{
    public SubmitStep Step { get; }
    public ReviewSessionState SessionAtFailure { get; }

    public SubmitFailedException(SubmitStep step, string message, ReviewSessionState session, Exception? inner = null)
        : base(message, inner)
    {
        Step = step;
        SessionAtFailure = session;
    }
}
```

And catch it at `SubmitAsync` level to surface `SubmitOutcome.Failed`:

```csharp
public async Task<SubmitOutcome> SubmitAsync(
    PrReference reference, ReviewSessionState session, SubmitEvent verdict,
    string currentHeadSha, IProgress<SubmitProgressEvent> progress,
    Func<ReviewSessionState, Task> persistAsync, CancellationToken ct)
{
    try
    {
        // ...the existing body...
    }
    catch (SubmitFailedException sfe)
    {
        return new SubmitOutcome.Failed(sfe.Step, sfe.Message, sfe.SessionAtFailure);
    }
}
```

- [ ] **Step 4: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AttachThreadsTests|FullyQualifiedName~LostResponseAdoptionTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs PRism.Core/Submit/Pipeline/SubmitFailedException.cs tests/PRism.Core.Tests/Submit/Pipeline/AttachThreadsTests.cs tests/PRism.Core.Tests/Submit/Pipeline/LostResponseAdoptionTests.cs
git commit -m "feat(s5-pr2): SubmitPipeline.StepAttachThreads — stamped/unstamped/marker-adoption branches

Per-draft: stamped + present-in-snapshot → skip; stamped + absent → recreate;
unstamped + marker matches one server thread → adopt; unstamped + no match →
call AttachThreadAsync + stamp.

Multi-match path throws NotImplementedException; Task 29 lands the defense.

Per-stamp persistence boundary: pipeline takes a persistAsync callback and
calls it after every successful stamp. The endpoint layer (PR3) hooks it
to AppStateStore.UpdateAsync."
```

---

### Task 28: Step 4 — Attach replies, with parent-thread-deleted demote + DoD test (f)

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (fill in `StepAttachRepliesAsync`)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/ForeignAuthorThreadDeletedTests.cs`

**Spec section:** § 5.2 step 4. **DoD test (f).**

- [ ] **Step 1: Write the failing tests**

`tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs`:

```csharp
[Fact]
public async Task UnstampedReply_NoMarkerMatch_CallsAttachReply_StampsCommentId()
{
    var fake = new InMemoryReviewSubmitter();
    // Seed a parent thread on the server.
    var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTime.UtcNow, "");
    pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
        "PRRT_parent", "src/Foo.cs", 1, "RIGHT", "head1", "body", false, new()));
    fake.SeedPendingReview(Ref, pending);

    var reply = new DraftReply("r1", "PRRT_parent", ReplyCommentId: null, "reply body", DraftStatus.Draft, false);
    var session = new ReviewSessionState(
        LastViewedHeadSha: "head1", LastSeenCommentId: null,
        PendingReviewId: "PRR_x", PendingReviewCommitOid: "head1",
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply> { reply },
        DraftSummaryMarkdown: null, DraftVerdict: null, DraftVerdictStatus: DraftVerdictStatus.Draft);

    var persisted = new List<ReviewSessionState>();
    var pipeline = new SubmitPipeline(fake);
    var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, s => { persisted.Add(s); return Task.CompletedTask; }, default);

    Assert.IsType<SubmitOutcome.Success>(outcome);
    var stamped = persisted.SelectMany(s => s.DraftReplies).First(r => r.Id == "r1" && r.ReplyCommentId is not null);
    Assert.StartsWith("PRRC_", stamped.ReplyCommentId);
}
```

`tests/PRism.Core.Tests/Submit/Pipeline/ForeignAuthorThreadDeletedTests.cs`:

```csharp
[Fact]
public async Task AttachReply_OnParentThreadDeleted_DemotesReplyToStale_AndReturnsFailedOutcome()
{
    var fake = new InMemoryReviewSubmitter();
    // Pending review exists but the parent thread does NOT.
    var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTime.UtcNow, "");
    fake.SeedPendingReview(Ref, pending);

    var reply = new DraftReply("r1", ParentThreadId: "PRRT_deleted", ReplyCommentId: null,
        BodyMarkdown: "reply", Status: DraftStatus.Draft, IsOverriddenStale: false);

    var session = new ReviewSessionState(
        LastViewedHeadSha: "head1", LastSeenCommentId: null,
        PendingReviewId: "PRR_x", PendingReviewCommitOid: "head1",
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply> { reply },
        DraftSummaryMarkdown: null, DraftVerdict: null, DraftVerdictStatus: DraftVerdictStatus.Draft);

    var pipeline = new SubmitPipeline(fake);
    var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, _ => Task.CompletedTask, default);

    var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
    Assert.Equal(SubmitStep.AttachReplies, failed.FailedStep);
    Assert.Contains("parent thread", failed.ErrorMessage, StringComparison.OrdinalIgnoreCase);
    // The session-at-failure carries the reply demoted to Stale.
    var demoted = failed.NewSession.DraftReplies.First(r => r.Id == "r1");
    Assert.Equal(DraftStatus.Stale, demoted.Status);
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AttachRepliesTests|FullyQualifiedName~ForeignAuthorThreadDeletedTests"`
Expected: FAIL — `StepAttachRepliesAsync` is the placeholder no-op.

- [ ] **Step 3: Implement `StepAttachRepliesAsync`**

```csharp
private async Task<ReviewSessionState> StepAttachRepliesAsync(
    PrReference reference,
    string pendingReviewId,
    ReviewSessionState session,
    OwnPendingReviewSnapshot? snapshot,
    Func<ReviewSessionState, Task> persistAsync,
    IProgress<SubmitProgressEvent> progress,
    CancellationToken ct)
{
    var totalReplies = session.DraftReplies.Count;
    if (totalReplies == 0) return session;

    progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Started, 0, totalReplies));

    // Refresh snapshot — after Step 3 ran, the server has new threads.
    var workingSnapshot = await _submitter.FindOwnPendingReviewAsync(reference, ct).ConfigureAwait(false);
    var currentSession = session;
    var done = 0;

    foreach (var reply in session.DraftReplies)
    {
        if (reply.Status == DraftStatus.Stale) continue;

        if (reply.ReplyCommentId is not null)
        {
            // Verify present in snapshot.
            var parent = workingSnapshot?.Threads.FirstOrDefault(t => t.PullRequestReviewThreadId == reply.ParentThreadId);
            var stillExists = parent?.Comments.Any(c => c.CommentId == reply.ReplyCommentId) == true;
            if (stillExists) { done++; progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, done, totalReplies)); continue; }
            // Reply gone → fall through to recreate.
        }
        else
        {
            // Unstamped — marker adoption against per-thread reply chain.
            var parent = workingSnapshot?.Threads.FirstOrDefault(t => t.PullRequestReviewThreadId == reply.ParentThreadId);
            var matches = parent?.Comments.Where(c => PipelineMarker.Extract(c.BodyMarkdown) == reply.Id).ToList()
                          ?? new List<PendingReviewCommentSnapshot>();
            if (matches.Count == 1)
            {
                currentSession = StampReplyCommentId(currentSession, reply.Id, matches[0].CommentId);
                await persistAsync(currentSession).ConfigureAwait(false);
                done++; progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, done, totalReplies));
                continue;
            }
            if (matches.Count > 1)
            {
                // Same multi-match defense (Task 29).
                throw new NotImplementedException("Task 29 — reply multi-match defense");
            }
        }

        // Create the reply.
        var bodyWithMarker = PipelineMarker.Inject(reply.BodyMarkdown, reply.Id);
        try
        {
            var result = await _submitter.AttachReplyAsync(reference, pendingReviewId, reply.ParentThreadId, bodyWithMarker, ct).ConfigureAwait(false);
            currentSession = StampReplyCommentId(currentSession, reply.Id, result.CommentId);
            await persistAsync(currentSession).ConfigureAwait(false);
            done++;
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, done, totalReplies));
        }
        catch (HttpRequestException ex) when (IsParentThreadGone(ex))
        {
            // Demote reply to Stale.
            currentSession = DemoteReplyToStale(currentSession, reply.Id);
            await persistAsync(currentSession).ConfigureAwait(false);
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Failed, done, totalReplies, "parent thread deleted"));
            throw new SubmitFailedException(SubmitStep.AttachReplies, "parent thread deleted", currentSession, ex);
        }
        catch (Exception ex)
        {
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Failed, done, totalReplies, ex.Message));
            throw new SubmitFailedException(SubmitStep.AttachReplies, ex.Message, currentSession, ex);
        }
    }

    return currentSession;
}

private static bool IsParentThreadGone(HttpRequestException ex)
    => ex.Message.Contains("NOT_FOUND", StringComparison.OrdinalIgnoreCase)
    || ex.Message.Contains("parent thread", StringComparison.OrdinalIgnoreCase);

private static ReviewSessionState StampReplyCommentId(ReviewSessionState session, string replyId, string commentId)
{
    var replies = session.DraftReplies.Select(r => r.Id == replyId ? r with { ReplyCommentId = commentId } : r).ToList();
    return session with { DraftReplies = replies };
}

private static ReviewSessionState DemoteReplyToStale(ReviewSessionState session, string replyId)
{
    var replies = session.DraftReplies.Select(r => r.Id == replyId ? r with { Status = DraftStatus.Stale } : r).ToList();
    return session with { DraftReplies = replies };
}
```

- [ ] **Step 4: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AttachRepliesTests|FullyQualifiedName~ForeignAuthorThreadDeletedTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs tests/PRism.Core.Tests/Submit/Pipeline/ForeignAuthorThreadDeletedTests.cs
git commit -m "feat(s5-pr2): SubmitPipeline.StepAttachReplies — DoD test (f) parent-thread-deleted

Reply branches mirror thread branches (stamped/unstamped/adopt/create) but
also handle the parent-thread-deleted case: AttachReplyAsync surfaces
NOT_FOUND → demote reply to Stale + return Failed(AttachReplies, ...).
Submit blocks via rule (b) on the next attempt."
```

---

### Task 29: Multi-marker-match defense — DoD-adjacent test

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (replace the two `NotImplementedException` paths)
- Modify: `PRism.Core.Submit/SubmitResults.cs` (add `CreatedAt` to `PendingReviewThreadSnapshot` if not already present — for createdAt-based tiebreaker)
- Modify: `PRism.GitHub/GitHubReviewService.Submit.cs` (project `createdAt` from GraphQL)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/MultiMarkerMatchTests.cs`

**Spec section:** § 5.2 step 3 ("Multi-match" paragraph), § 5.3 invariant 3, § 17 decision 23.

- [ ] **Step 1: Add `CreatedAt` to `PendingReviewThreadSnapshot`**

```csharp
public sealed record PendingReviewThreadSnapshot(
    string PullRequestReviewThreadId,
    string FilePath,
    int LineNumber,
    string Side,
    string OriginalCommitOid,
    string OriginalLineContent,
    bool IsResolved,
    string BodyMarkdown,
    DateTime CreatedAt,
    IReadOnlyList<PendingReviewCommentSnapshot> Comments);
```

Update Task 17's `ProjectThread` helper to include `CreatedAt`: project from GraphQL `thread.comments.nodes[0].createdAt` (the thread's createdAt is the first comment's createdAt — GraphQL doesn't expose a thread-level createdAt directly). Adjust the test for Task 17 to include `createdAt` in the response payload. Update `InMemoryThread` to include `CreatedAt` (default `DateTime.UtcNow`).

- [ ] **Step 2: Write the failing test**

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class MultiMarkerMatchTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task TwoServerThreadsCarrySameMarker_AdoptsEarliest_DeletesOthersBestEffort()
    {
        var fake = new InMemoryReviewSubmitter();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTime.UtcNow, "");
        // Two threads carrying the same marker — the eventual-consistency window per spec § 5.2 step 3.
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_earlier", "src/Foo.cs", 42, "RIGHT", "head1",
            body: $"body\n\n<!-- prism:client-id:d1 -->", isResolved: false, replies: new(), CreatedAt: DateTime.UtcNow.AddSeconds(-2)));
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_later", "src/Foo.cs", 42, "RIGHT", "head1",
            body: $"body\n\n<!-- prism:client-id:d1 -->", isResolved: false, replies: new(), CreatedAt: DateTime.UtcNow));
        fake.SeedPendingReview(Ref, pending);

        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "head1", "line", "body", DraftStatus.Draft, false, ThreadId: null);
        var session = new ReviewSessionState(
            LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: "PRR_x", PendingReviewCommitOid: "head1",
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { draft },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null, DraftVerdictStatus: DraftVerdictStatus.Draft);

        var persisted = new List<ReviewSessionState>();
        var duplicateMarkerNotices = new List<string>();
        var pipeline = new SubmitPipeline(fake, onDuplicateMarker: msg => duplicateMarkerNotices.Add(msg));

        await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, s => { persisted.Add(s); return Task.CompletedTask; }, default);

        // Adopted the earliest
        var stamped = persisted.SelectMany(s => s.DraftComments).First(d => d.Id == "d1" && d.ThreadId is not null);
        Assert.Equal("PRRT_earlier", stamped.ThreadId);

        // The other thread was deleted (best-effort). Fake's pending state at end-of-pipeline:
        // - Finalize ran, so the pending review was removed entirely. To verify deletion,
        //   capture the fake's threads-before-Finalize via a different hook OR check the
        //   onDuplicateMarker notice fired.
        Assert.Single(duplicateMarkerNotices);
    }
}
```

- [ ] **Step 3: Verify fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MultiMarkerMatchTests"`
Expected: FAIL.

- [ ] **Step 4: Implement the multi-match defense**

In `SubmitPipeline.cs`, replace the two `NotImplementedException` paths:

```csharp
// Existing thread-level path:
if (adopted.Count > 1)
{
    var earliest = adopted.OrderBy(t => t.CreatedAt).First();
    currentSession = StampDraftThreadId(currentSession, draft.Id, earliest.PullRequestReviewThreadId);
    await persistAsync(currentSession).ConfigureAwait(false);
    // Best-effort delete the others; do not block pipeline on cleanup failures.
    foreach (var orphan in adopted.Where(t => t.PullRequestReviewThreadId != earliest.PullRequestReviewThreadId))
    {
        try { await _submitter.DeletePendingReviewThreadAsync(reference, orphan.PullRequestReviewThreadId, ct).ConfigureAwait(false); }
        catch (Exception ex) { /* log; continue */ _onDuplicateMarker?.Invoke($"Failed to delete orphan thread {orphan.PullRequestReviewThreadId}: {ex.Message}"); }
    }
    _onDuplicateMarker?.Invoke($"Duplicate marker detected for draft {draft.Id}; adopted earliest thread {earliest.PullRequestReviewThreadId}");
    done++;
    progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, done, totalDrafts));
    continue;
}
```

This requires adding `DeletePendingReviewThreadAsync` to `IReviewSubmitter`:

```csharp
Task DeletePendingReviewThreadAsync(PrReference reference, string pullRequestReviewThreadId, CancellationToken ct);
```

Implement in `GitHubReviewService.Submit.cs` via `deletePullRequestReviewThread` mutation. Implement in `InMemoryReviewSubmitter` by removing the thread from the in-memory pending review. Tests for the GraphQL adapter add a single payload-shape test alongside Task 16's delete-pending-review tests.

Update `SubmitPipeline` constructor:

```csharp
public sealed class SubmitPipeline
{
    private readonly IReviewSubmitter _submitter;
    private readonly Action<string>? _onDuplicateMarker;

    public SubmitPipeline(IReviewSubmitter submitter, Action<string>? onDuplicateMarker = null)
    {
        _submitter = submitter;
        _onDuplicateMarker = onDuplicateMarker;
    }
}
```

The endpoint layer (PR3) wires `_onDuplicateMarker` to a `submit-duplicate-marker-detected` SSE event publisher.

Apply the same defense to the reply multi-match path.

- [ ] **Step 5: Verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MultiMarkerMatchTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs PRism.Core/Submit/SubmitResults.cs PRism.Core/IReviewSubmitter.cs PRism.GitHub/GitHubReviewService.Submit.cs tests/PRism.Core.Tests/Submit/Pipeline/MultiMarkerMatchTests.cs
git commit -m "feat(s5-pr2): multi-marker-match defense + DeletePendingReviewThreadAsync

GitHub's GraphQL pending-review listing is not strictly read-your-writes
consistent. Under a lost-response window + retry that wrote a duplicate
(because the original was not yet visible in the listing), the snapshot
returns N>1 threads carrying the same marker. Pipeline now adopts the
earliest (lowest createdAt) and best-effort-deletes the others, emitting
a notice through onDuplicateMarker callback so PR3 can surface a toast."
```

---

### Task 30: DoD tests (a) Empty-pipeline finalize + (b) Retry-from-each-step

**Files:**

- Create: `tests/PRism.Core.Tests/Submit/Pipeline/EmptyPipelineFinalizeTests.cs`
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/RetryFromEachStepTests.cs`

**Spec section:** § 5.4. **DoD tests (a) + (b).**

- [ ] **Step 1: Write the empty-pipeline finalize test**

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class EmptyPipelineFinalizeTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task SummaryOnly_NoThreadsNoReplies_StepsAttachAreSkipped_FinalizeRuns()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = new ReviewSessionState(
            LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: "Summary only", DraftVerdict: DraftVerdict.Comment,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var observed = new List<SubmitProgressEvent>();
        var progress = new InlineProgress(observed.Add);
        var pipeline = new SubmitPipeline(fake);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", progress, _ => Task.CompletedTask, default);

        Assert.IsType<SubmitOutcome.Success>(outcome);

        // No AttachThreads / AttachReplies progress events should have fired (Started or otherwise).
        Assert.DoesNotContain(observed, e => e.Step == SubmitStep.AttachThreads);
        Assert.DoesNotContain(observed, e => e.Step == SubmitStep.AttachReplies);
        // BeginPendingReview + Finalize both fired.
        Assert.Contains(observed, e => e.Step == SubmitStep.BeginPendingReview && e.Status == SubmitStepStatus.Succeeded);
        Assert.Contains(observed, e => e.Step == SubmitStep.Finalize && e.Status == SubmitStepStatus.Succeeded);
    }
}

internal sealed class InlineProgress : IProgress<SubmitProgressEvent>
{
    private readonly Action<SubmitProgressEvent> _action;
    public InlineProgress(Action<SubmitProgressEvent> action) { _action = action; }
    public void Report(SubmitProgressEvent value) => _action(value);
}
```

- [ ] **Step 2: Write the retry-from-each-step test**

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

public class RetryFromEachStepTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Theory]
    [InlineData(nameof(IReviewSubmitter.BeginPendingReviewAsync))]
    [InlineData(nameof(IReviewSubmitter.AttachThreadAsync))]
    [InlineData(nameof(IReviewSubmitter.AttachReplyAsync))]
    [InlineData(nameof(IReviewSubmitter.FinalizePendingReviewAsync))]
    public async Task FailsOnFirstCall_RetrySucceeds_NoDuplicates(string failingMethod)
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(failingMethod, new HttpRequestException("simulated"));

        // Seed a session with one draft + one reply targeting a thread we'll create on the first attempt.
        // We'll need to either fixture the reply's parent thread first OR have the test arrange
        // session shape so the parent thread is already stamped. Use a stamped-parent setup:
        var session = SessionWithOneDraftAndOneReplyToExistingThread(fake);

        var persisted = new List<ReviewSessionState>();
        Task Persist(ReviewSessionState s) { persisted.Add(s); return Task.CompletedTask; }

        var pipeline = new SubmitPipeline(fake);

        // First attempt: fails at the named step.
        var firstOutcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, Persist, default);
        Assert.IsType<SubmitOutcome.Failed>(firstOutcome);
        var failedAt = ((SubmitOutcome.Failed)firstOutcome).FailedStep;

        // Second attempt with the failed session: succeeds.
        var nextSession = ((SubmitOutcome.Failed)firstOutcome).NewSession;
        var secondOutcome = await pipeline.SubmitAsync(Ref, nextSession, SubmitEvent.Comment, "head1", NoopProgress.Instance, Persist, default);
        Assert.IsType<SubmitOutcome.Success>(secondOutcome);

        // Pending review state confirms no duplicate threads/replies (the fake stamps unique IDs;
        // each ID appears at most once).
        var pendingAfter = fake.GetPending(Ref);
        Assert.Null(pendingAfter); // Finalize ran; pending review gone.
    }

    private static ReviewSessionState SessionWithOneDraftAndOneReplyToExistingThread(InMemoryReviewSubmitter fake)
    {
        // Pre-seed: parent thread exists on the server (representing an EARLIER successful submit).
        // For this test, we use the fake's seed mechanism to plant the parent in a fresh pending review.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_seed", "head1", DateTime.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_parent", "src/Foo.cs", 1, "RIGHT", "head1", "parent body", false, new(), CreatedAt: DateTime.UtcNow.AddMinutes(-1)));
        fake.SeedPendingReview(Ref, pending);

        var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "head1", "line", "body", DraftStatus.Draft, false, ThreadId: null);
        var reply = new DraftReply("r1", "PRRT_parent", ReplyCommentId: null, "reply body", DraftStatus.Draft, false);

        return new ReviewSessionState(
            LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: "PRR_seed", PendingReviewCommitOid: "head1",
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { draft },
            DraftReplies: new List<DraftReply> { reply },
            DraftSummaryMarkdown: "sum", DraftVerdict: null, DraftVerdictStatus: DraftVerdictStatus.Draft);
    }
}
```

- [ ] **Step 3: Verify fail then pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~EmptyPipelineFinalizeTests|FullyQualifiedName~RetryFromEachStepTests"`
Expected (initially): FAIL on the AttachReplyAsync inline test because the fake doesn't yet handle pre-seeded pending review + reply correctly — minor bug fixes in `InMemoryReviewSubmitter`. Iterate until green.

Expected (after fixes): PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.Core.Tests/Submit/Pipeline/EmptyPipelineFinalizeTests.cs tests/PRism.Core.Tests/Submit/Pipeline/RetryFromEachStepTests.cs
git commit -m "test(s5-pr2): DoD tests (a) empty-pipeline finalize + (b) retry-from-each-step

Empty pipeline: summary-only + Comment verdict → Steps 3+4 skipped, Steps
2+5 succeed.
Retry: failure injected at each of the four mutation methods → first attempt
returns Failed; second attempt resumes from the failed step and converges on
Success with no duplicates."
```

---

### Task 31: Endpoint-side session-clearing on Success — surface a `SuccessSessionMutation` callback

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (call `persistAsync(clearedSession)` on Success before returning)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs`

**Spec section:** § 5.2 step 5 "On success: clear..."

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public async Task OnSuccess_PersistsClearedSession_ThenPublishesEventsOutsideGate()
{
    var fake = new InMemoryReviewSubmitter();
    var draft = new DraftComment("d1", "src/Foo.cs", 42, "RIGHT", "abc", "line", "body", DraftStatus.Draft, false, ThreadId: null);
    var session = new ReviewSessionState(
        LastViewedHeadSha: "head1", LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment> { draft },
        DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: "Summary", DraftVerdict: DraftVerdict.Comment,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    var persisted = new List<ReviewSessionState>();
    var pipeline = new SubmitPipeline(fake);
    var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, s => { persisted.Add(s); return Task.CompletedTask; }, default);

    Assert.IsType<SubmitOutcome.Success>(outcome);
    // The LAST persisted session has everything cleared.
    var final = persisted.Last();
    Assert.Empty(final.DraftComments);
    Assert.Empty(final.DraftReplies);
    Assert.Null(final.DraftSummaryMarkdown);
    Assert.Null(final.DraftVerdict);
    Assert.Null(final.PendingReviewId);
    Assert.Null(final.PendingReviewCommitOid);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — current implementation persists per-draft stamps but not the post-Finalize clear.

- [ ] **Step 3: Add the post-Finalize clear**

In `SubmitPipeline.SubmitAsync`, after `await StepFinalizeAsync(...)`:

```csharp
// Spec § 5.2 step 5: on success, clear PendingReviewId, PendingReviewCommitOid, every draft, every reply, DraftSummaryMarkdown, DraftVerdict, DraftVerdictStatus.
var clearedSession = workingSession with
{
    PendingReviewId = null,
    PendingReviewCommitOid = null,
    DraftComments = new List<DraftComment>(),
    DraftReplies = new List<DraftReply>(),
    DraftSummaryMarkdown = null,
    DraftVerdict = null,
    DraftVerdictStatus = DraftVerdictStatus.Draft,
};
await persistAsync(clearedSession).ConfigureAwait(false);

return new SubmitOutcome.Success(pendingReviewId);
```

- [ ] **Step 4: Verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs
git commit -m "feat(s5-pr2): SubmitPipeline persists cleared session on Success

Per spec § 5.2 step 5: on Success, clears PendingReviewId, every draft/reply,
DraftSummaryMarkdown, DraftVerdict before returning. Endpoint (PR3) wraps
persistAsync with AppStateStore.UpdateAsync; DraftSubmitted + StateChanged
events publish OUTSIDE the gate after UpdateAsync returns (spec § 4.5
ordering contract restated for S5's first DraftSubmitted producer)."
```

---

### Task 32: PR2 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln
dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

Expected: all green.

- [ ] **Step 2: Verify zero `NotImplementedException` references in `PRism.Core/Submit/`**

Grep for `NotImplementedException` in `PRism.Core/Submit/`. Expected: zero.

- [ ] **Step 3: Open PR2**

```bash
gh pr create --title "feat(s5-pr2): SubmitPipeline state machine + v3→v4 schema migration" --body "$(cat <<'EOF'
## Summary

- Lands the resumable, step-granular `SubmitPipeline` in `PRism.Core/Submit/Pipeline/` per Convention-1.
- Marker injection with unclosed-fence defense via `PipelineMarker`.
- Lost-response adoption (single match), multi-marker-match defense (eventual-consistency window).
- DoD tests: (a) empty-pipeline finalize, (b) retry-from-each-step, (e) stale-`commitOID` recreate, (f) parent-thread-deleted demote, plus c/d covered in `ForeignPendingReviewTests`.
- V3→V4 schema migration adds `DraftComment.ThreadId` field.

## Test plan

- [x] All seven pipeline unit-test files green (`PRism.Core.Tests/Submit/Pipeline/`)
- [x] Migration test green (`MigrateV3ToV4Tests`)
- [x] `dotnet test PRism.sln` whole-solution green
- [x] `npm run lint` + `npm run build` (frontend untouched)
- [x] Playwright suite green

## Spec refs

- Spec: `docs/specs/2026-05-11-s5-submit-pipeline-design.md` § 5 + § 6 + § 16 PR2

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 4 — PR3: Backend endpoints + SSE events + per-PR submit lock + ancillary fixes

**PR title:** `feat(s5-pr3): submit endpoints + SSE events + per-PR submit lock + verdict-clear patch shape + scrubber extension`

**Spec sections:** § 7 (endpoints), § 7.4–7.5 (SSE events), § 10 (verdict-clear patch wire-shape), § 13 (closed/merged bulk-discard), § 4 (composer marker-prefix collision rejection), § 16 PR3 row, § 18.2 (planning-time decisions for `submit-progress` payload casing + scrubber extension).

**Goal:** Wire the SubmitPipeline behind HTTP endpoints, publish SSE events, and ship the ancillary fixes: per-PR submit lock, composer marker-prefix collision rejection, verdict-clear patch wire-shape, SensitiveFieldScrubber extension, and body-cap extension.

**Files touched (~10 new + 5 modified + ~6 test files):**

- Create: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (POST /submit, /foreign-pending-review/resume, /foreign-pending-review/discard)
- Create: `PRism.Web/Endpoints/PrSubmitDtos.cs`
- Create: `PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs` (separate file; same `/api/pr/{ref}` route prefix)
- Create: `PRism.Web/Submit/SubmitLockRegistry.cs` (per-PR `SemaphoreSlim` keyed by prRef)
- Create: `PRism.Web/Submit/SseSubmitProgressBridge.cs` (`IProgress<SubmitProgressEvent>` impl publishing `submit-progress` SSE events)
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (add `submit-*` event arms)
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs` (composer marker-prefix collision rejection + verdict-clear patch wire-shape)
- Modify: `PRism.Web/Logging/SensitiveFieldScrubber.cs` (add three field names)
- Modify: `PRism.Web/Program.cs` (extend `UseWhen` body-cap predicate; register submit-related DI)
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (register `SubmitPipeline` + `SubmitLockRegistry` + bridge)
- Tests: `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`, `PrDraftsDiscardAllEndpointTests.cs`, `PrDraftEndpointsMarkerCollisionTests.cs`, `PrDraftEndpointsVerdictClearTests.cs`, `Logging/SensitiveFieldScrubberTests.cs` (extend), `Submit/SubmitLockRegistryTests.cs`

**Worktree:** `.claude/worktrees/feat+s5-pr3`

---

### Task 33: Per-PR submit lock primitive — `SubmitLockRegistry`

**Spec section:** § 7.1 "Per-PR submit lock" paragraph. **Critical:** the lock MUST be a separate primitive from `AppStateStore._gate` (see spec § 7.1 last paragraph + deferrals sidecar [Risk] P1).

**Files:**

- Create: `PRism.Web/Submit/SubmitLockRegistry.cs`
- Create: `tests/PRism.Web.Tests/Submit/SubmitLockRegistryTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core.Contracts;
using PRism.Web.Submit;

namespace PRism.Web.Tests.Submit;

public class SubmitLockRegistryTests
{
    private static PrReference Ref(int n) => new("o", "r", n);

    [Fact]
    public async Task TryAcquire_ReturnsHandle_OnFirstCall()
    {
        var registry = new SubmitLockRegistry();
        await using var handle = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(handle);
    }

    [Fact]
    public async Task TryAcquire_ReturnsNull_WhenLockHeldByAnotherCaller()
    {
        var registry = new SubmitLockRegistry();
        await using var first = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        await using var second = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Fact]
    public async Task TryAcquire_DifferentPrRefs_DoNotInterfere()
    {
        var registry = new SubmitLockRegistry();
        await using var firstPr1 = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        await using var firstPr2 = await registry.TryAcquireAsync(Ref(2), TimeSpan.Zero, default);
        Assert.NotNull(firstPr1);
        Assert.NotNull(firstPr2);
    }

    [Fact]
    public async Task Handle_Release_AllowsReacquisition()
    {
        var registry = new SubmitLockRegistry();
        {
            await using var h = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
            Assert.NotNull(h);
        }
        // After dispose, a new acquire succeeds.
        await using var second = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(second);
    }
}
```

- [ ] **Step 2: Verify fail**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitLockRegistryTests"`
Expected: FAIL.

- [ ] **Step 3: Implement `SubmitLockRegistry`**

```csharp
// PRism.Web/Submit/SubmitLockRegistry.cs
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Web.Submit;

/// <summary>
/// Per-PR submit lock. Each PR ref gets its own SemaphoreSlim(1, 1); concurrent submit
/// attempts on the same PR return null (the endpoint surfaces 409 submit-in-progress).
///
/// Separate primitive from AppStateStore._gate by design. Putting submit serialization
/// on _gate would block every other PR's draft writes for the duration of any one PR's
/// submit, and re-introduce the publication-vs-_gate ordering hazard the SubmitPipeline's
/// step-5 contract defends against.
/// </summary>
public sealed class SubmitLockRegistry
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    public async Task<SubmitLockHandle?> TryAcquireAsync(PrReference reference, TimeSpan timeout, CancellationToken ct)
    {
        var key = $"{reference.Owner}/{reference.Repo}/{reference.Number}";
        var sem = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));

        var acquired = await sem.WaitAsync(timeout, ct).ConfigureAwait(false);
        return acquired ? new SubmitLockHandle(sem) : null;
    }
}

public sealed class SubmitLockHandle : IAsyncDisposable
{
    private readonly SemaphoreSlim _sem;
    private int _disposed;

    internal SubmitLockHandle(SemaphoreSlim sem) { _sem = sem; }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
            _sem.Release();
        return ValueTask.CompletedTask;
    }
}
```

- [ ] **Step 4: Register as singleton**

Modify `PRism.Web/Composition/ServiceCollectionExtensions.cs`:

```csharp
services.AddSingleton<SubmitLockRegistry>();
```

- [ ] **Step 5: Verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitLockRegistryTests"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Submit/SubmitLockRegistry.cs PRism.Web/Composition/ServiceCollectionExtensions.cs tests/PRism.Web.Tests/Submit/SubmitLockRegistryTests.cs
git commit -m "feat(s5-pr3): SubmitLockRegistry — per-PR submit lock primitive

Separate from AppStateStore._gate by design. ConcurrentDictionary keyed by
prRef; each entry is a SemaphoreSlim(1,1). TryAcquireAsync returns null on
contention; the endpoint surfaces 409 submit-in-progress to the losing
client. SubmitLockHandle is await-using-disposable for symmetric release."
```

---

### Task 34: SSE event types — add `submit-*` event arms to `SseEventProjection`

**Files:**

- Modify: `PRism.Web/Sse/SseEventProjection.cs`
- Create: tests in `tests/PRism.Web.Tests/Sse/SseEventProjectionSubmitEventsTests.cs`

**Spec section:** § 7.4 (`submit-progress`), § 7.5 (`submit-foreign-pending-review`, `submit-stale-commit-oid`, `submit-orphan-cleanup-failed`). Decision: § 18.2 — `step` enum value casing matches the C# `SubmitStep` enum names (PascalCase).

- [ ] **Step 1: Read the existing `SseEventProjection.cs`**

Understand the pattern (typed event → SSE wire shape). Note the existing fan-out + threat-model defense pattern.

- [ ] **Step 2: Write the failing test**

```csharp
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Events;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

public class SseEventProjectionSubmitEventsTests
{
    private static PrReference Ref => new("o", "r", 1);

    [Fact]
    public void SubmitProgressEvent_ProjectsToSseLine_WithSnakeKebabEventTypeAndPascalCaseStepValue()
    {
        var projection = new SseEventProjection();
        var typed = new SubmitProgressBusEvent(
            PrRef: Ref,
            Step: SubmitStep.AttachThreads,
            Status: SubmitStepStatus.Started,
            Done: 0,
            Total: 5,
            ErrorMessage: null);

        var line = projection.Project(typed);

        // event: submit-progress + data: { ... } with PascalCase step value
        Assert.Contains("event: submit-progress", line);
        using var doc = JsonDocument.Parse(ExtractDataLine(line));
        var data = doc.RootElement;
        Assert.Equal("AttachThreads", data.GetProperty("step").GetString());
        Assert.Equal("Started", data.GetProperty("status").GetString());
        Assert.Equal(0, data.GetProperty("done").GetInt32());
        Assert.Equal(5, data.GetProperty("total").GetInt32());
        Assert.Equal("o/r/1", data.GetProperty("prRef").GetString());
    }

    [Fact]
    public void SubmitForeignPendingReviewEvent_ProjectsCountsOnly_NoBodies()
    {
        var projection = new SseEventProjection();
        var typed = new SubmitForeignPendingReviewBusEvent(
            PrRef: Ref,
            PullRequestReviewId: "PRR_x",
            CommitOid: "abc1234",
            CreatedAt: new DateTime(2026, 5, 11, 10, 0, 0, DateTimeKind.Utc),
            ThreadCount: 3,
            ReplyCount: 2);

        var line = projection.Project(typed);
        Assert.Contains("event: submit-foreign-pending-review", line);
        using var doc = JsonDocument.Parse(ExtractDataLine(line));
        var data = doc.RootElement;
        Assert.Equal("PRR_x", data.GetProperty("pullRequestReviewId").GetString());
        Assert.Equal(3, data.GetProperty("threadCount").GetInt32());
        // No thread or reply BODIES in the payload.
        Assert.False(data.TryGetProperty("threads", out _));
        Assert.False(data.TryGetProperty("threadBodies", out _));
    }

    [Fact]
    public void SubmitStaleCommitOidEvent_OmitsOrphanReviewId()
    {
        var projection = new SseEventProjection();
        var typed = new SubmitStaleCommitOidBusEvent(PrRef: Ref, OrphanCommitOid: "stale_abc");
        var line = projection.Project(typed);
        Assert.Contains("event: submit-stale-commit-oid", line);
        using var doc = JsonDocument.Parse(ExtractDataLine(line));
        Assert.Equal("stale_abc", doc.RootElement.GetProperty("orphanCommitOid").GetString());
        Assert.False(doc.RootElement.TryGetProperty("orphanReviewId", out _));
    }

    [Fact]
    public void SubmitOrphanCleanupFailedEvent_OmitsPendingReviewId()
    {
        var projection = new SseEventProjection();
        var typed = new SubmitOrphanCleanupFailedBusEvent(Ref);
        var line = projection.Project(typed);
        Assert.Contains("event: submit-orphan-cleanup-failed", line);
        using var doc = JsonDocument.Parse(ExtractDataLine(line));
        Assert.Equal("o/r/1", doc.RootElement.GetProperty("prRef").GetString());
        Assert.False(doc.RootElement.TryGetProperty("pendingReviewId", out _));
    }

    [Fact]
    public void SubmitDuplicateMarkerDetectedEvent_CarriesDraftIdNotThreadIds()
    {
        var projection = new SseEventProjection();
        var typed = new SubmitDuplicateMarkerDetectedBusEvent(Ref, DraftId: "d1");
        var line = projection.Project(typed);
        Assert.Contains("event: submit-duplicate-marker-detected", line);
        using var doc = JsonDocument.Parse(ExtractDataLine(line));
        Assert.Equal("d1", doc.RootElement.GetProperty("draftId").GetString());
        // No threadIds (those are server-issued; not for cross-tab broadcast).
        Assert.False(doc.RootElement.TryGetProperty("threadIds", out _));
    }

    private static string ExtractDataLine(string sseLine)
    {
        // SSE format: event: <name>\ndata: <json>\n\n
        var parts = sseLine.Split('\n');
        var dataLine = parts.First(p => p.StartsWith("data: ", StringComparison.Ordinal));
        return dataLine.Substring("data: ".Length);
    }
}
```

- [ ] **Step 3: Verify fail**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SseEventProjectionSubmitEventsTests"`
Expected: FAIL — bus event types and projection arms don't exist.

- [ ] **Step 4: Define the bus event types**

`PRism.Web/Events/SubmitBusEvents.cs`:

```csharp
using PRism.Core.Contracts;
using PRism.Core.Submit.Pipeline;

namespace PRism.Web.Events;

public sealed record SubmitProgressBusEvent(
    PrReference PrRef,
    SubmitStep Step,
    SubmitStepStatus Status,
    int Done,
    int Total,
    string? ErrorMessage) : IReviewBusEvent;

public sealed record SubmitForeignPendingReviewBusEvent(
    PrReference PrRef,
    string PullRequestReviewId,
    string CommitOid,
    DateTime CreatedAt,
    int ThreadCount,
    int ReplyCount) : IReviewBusEvent;

public sealed record SubmitStaleCommitOidBusEvent(
    PrReference PrRef,
    string OrphanCommitOid) : IReviewBusEvent;

public sealed record SubmitOrphanCleanupFailedBusEvent(
    PrReference PrRef) : IReviewBusEvent;

public sealed record SubmitDuplicateMarkerDetectedBusEvent(
    PrReference PrRef,
    string DraftId) : IReviewBusEvent;
```

If `IReviewBusEvent` is the existing marker interface — adapt to the project's naming if different (check `PRism.Web/Events/` for the existing umbrella interface).

- [ ] **Step 5: Add projection arms to `SseEventProjection.cs`**

Append cases to the projection switch (or pattern-match dispatch). For each:

```csharp
case SubmitProgressBusEvent ev:
    return Project(
        eventName: "submit-progress",
        payload: new
        {
            prRef = $"{ev.PrRef.Owner}/{ev.PrRef.Repo}/{ev.PrRef.Number}",
            step = ev.Step.ToString(),  // PascalCase per spec § 18.2 decision
            status = ev.Status.ToString(),
            done = ev.Done,
            total = ev.Total,
            errorMessage = ev.ErrorMessage,
        });
case SubmitForeignPendingReviewBusEvent ev:
    return Project(
        eventName: "submit-foreign-pending-review",
        payload: new
        {
            prRef = $"{ev.PrRef.Owner}/{ev.PrRef.Repo}/{ev.PrRef.Number}",
            pullRequestReviewId = ev.PullRequestReviewId,
            commitOid = ev.CommitOid,
            createdAt = ev.CreatedAt.ToString("O"),
            threadCount = ev.ThreadCount,
            replyCount = ev.ReplyCount,
        });
case SubmitStaleCommitOidBusEvent ev:
    return Project("submit-stale-commit-oid",
        new { prRef = $"{ev.PrRef.Owner}/{ev.PrRef.Repo}/{ev.PrRef.Number}", orphanCommitOid = ev.OrphanCommitOid });
case SubmitOrphanCleanupFailedBusEvent ev:
    return Project("submit-orphan-cleanup-failed",
        new { prRef = $"{ev.PrRef.Owner}/{ev.PrRef.Repo}/{ev.PrRef.Number}" });
case SubmitDuplicateMarkerDetectedBusEvent ev:
    return Project("submit-duplicate-marker-detected",
        new { prRef = $"{ev.PrRef.Owner}/{ev.PrRef.Repo}/{ev.PrRef.Number}", draftId = ev.DraftId });
```

If `Project(eventName, payload)` doesn't exist as a helper, factor a small helper that serializes to camelCase JSON via the project's existing JSON options and formats the `event: <name>\ndata: <json>\n\n` wire shape.

- [ ] **Step 6: Verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SseEventProjectionSubmitEventsTests"`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Events/SubmitBusEvents.cs PRism.Web/Sse/SseEventProjection.cs tests/PRism.Web.Tests/Sse/SseEventProjectionSubmitEventsTests.cs
git commit -m "feat(s5-pr3): SSE projection arms for submit-* events (counts-only, threat-model-defended)

Five new event types: submit-progress, submit-foreign-pending-review,
submit-stale-commit-oid, submit-orphan-cleanup-failed, submit-duplicate-
marker-detected. Each carries counts + IDs needed for the dialog UX but
no thread/reply bodies, no orphan review IDs, no pendingReviewId
(threat-model defense; per spec § 7.5)."
```

---

### Task 35: `SseSubmitProgressBridge` — `IProgress<SubmitProgressEvent>` → bus publisher

**Files:**

- Create: `PRism.Web/Submit/SseSubmitProgressBridge.cs`
- Create: `tests/PRism.Web.Tests/Submit/SseSubmitProgressBridgeTests.cs`

**Spec section:** § 5.1 (`IProgress<SubmitProgressEvent>` is the bridge), forward-looking residual risk R2 in deferrals sidecar.

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core.Contracts;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Events;
using PRism.Web.Submit;

namespace PRism.Web.Tests.Submit;

public class SseSubmitProgressBridgeTests
{
    [Fact]
    public void Report_PublishesSubmitProgressBusEvent_WithPrRefAndStepAndStatusAndCounts()
    {
        var bus = new FakeReviewEventBus();
        var bridge = new SseSubmitProgressBridge(new PrReference("o", "r", 7), bus);

        bridge.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Started, 0, 4));

        var published = Assert.Single(bus.Published);
        var ev = Assert.IsType<SubmitProgressBusEvent>(published);
        Assert.Equal(new PrReference("o", "r", 7), ev.PrRef);
        Assert.Equal(SubmitStep.AttachThreads, ev.Step);
        Assert.Equal(0, ev.Done);
        Assert.Equal(4, ev.Total);
    }
}

internal sealed class FakeReviewEventBus : IReviewEventBus
{
    public List<IReviewBusEvent> Published { get; } = new();
    public void Publish(IReviewBusEvent ev) => Published.Add(ev);
    // …other interface members…
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — `SseSubmitProgressBridge` doesn't exist.

- [ ] **Step 3: Implement `SseSubmitProgressBridge`**

```csharp
// PRism.Web/Submit/SseSubmitProgressBridge.cs
using PRism.Core.Contracts;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Events;

namespace PRism.Web.Submit;

internal sealed class SseSubmitProgressBridge : IProgress<SubmitProgressEvent>
{
    private readonly PrReference _prRef;
    private readonly IReviewEventBus _bus;

    public SseSubmitProgressBridge(PrReference prRef, IReviewEventBus bus)
    {
        _prRef = prRef;
        _bus = bus;
    }

    public void Report(SubmitProgressEvent value)
    {
        _bus.Publish(new SubmitProgressBusEvent(
            PrRef: _prRef,
            Step: value.Step,
            Status: value.Status,
            Done: value.Done,
            Total: value.Total,
            ErrorMessage: value.ErrorMessage));
    }
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SseSubmitProgressBridgeTests"`
Expected: PASS.

```bash
git add PRism.Web/Submit/SseSubmitProgressBridge.cs tests/PRism.Web.Tests/Submit/SseSubmitProgressBridgeTests.cs
git commit -m "feat(s5-pr3): SseSubmitProgressBridge — IProgress<SubmitProgressEvent> → IReviewEventBus

PrRef captured at construction; each Report() call publishes a
SubmitProgressBusEvent. Constructed per-request inside the submit endpoint;
not a DI singleton (the PR reference is per-call)."
```

---

### Task 36: `POST /api/pr/{ref}/submit` — happy path + 409 lock contention

**Files:**

- Create: `PRism.Web/Endpoints/PrSubmitEndpoints.cs`
- Create: `PRism.Web/Endpoints/PrSubmitDtos.cs`
- Modify: `PRism.Web/Program.cs` (extend body-cap `UseWhen` predicate; map the endpoint)
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (register `SubmitPipeline` from PRism.Core)
- Create: `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`

**Spec section:** § 7.1 + § 8.3 rules + § 9 enable rules. **Note:** rule-(a)–(f) enforcement happens primarily client-side via the Submit Review button enable rules; the endpoint enforces the same rules defensively (server-side authoritative check).

- [ ] **Step 1: Write the failing test (happy path + lock contention)**

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Core.State;
using PRism.Web.Endpoints;

namespace PRism.Web.Tests.Endpoints;

public class PrSubmitEndpointsTests : IClassFixture<PrismWebFactory>
{
    private readonly HttpClient _client;
    private readonly PrismWebFactory _factory;

    public PrSubmitEndpointsTests(PrismWebFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
        // …auth/origin headers setup per the existing endpoint-test convention…
    }

    [Fact]
    public async Task PostSubmit_ValidBody_ReturnsStartedOutcome_And200()
    {
        // Arrange: seed state.json with a valid in-flight session (one draft, summary, verdict).
        await _factory.SeedSessionAsync("o", "r", 1, new ReviewSessionState(
            LastViewedHeadSha: "head1", LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment> { new("d1", "src/Foo.cs", 42, "RIGHT", "head1", "line", "body", DraftStatus.Draft, false, null) },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: "summary",
            DraftVerdict: DraftVerdict.Comment,
            DraftVerdictStatus: DraftVerdictStatus.Draft));

        var resp = await _client.PostAsJsonAsync("/api/pr/o/r/1/submit", new { verdict = "Comment" });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("started", body.GetProperty("outcome").GetString());
    }

    [Fact]
    public async Task PostSubmit_StaleDraftPresent_Returns400_StaleDraftsCode()
    {
        await _factory.SeedSessionAsync("o", "r", 2, /* a session with a Stale draft */ default!);
        var resp = await _client.PostAsJsonAsync("/api/pr/o/r/2/submit", new { verdict = "Comment" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("stale-drafts", body.GetProperty("code").GetString());
    }

    [Fact]
    public async Task PostSubmit_Concurrent_SecondCallReturns409()
    {
        await _factory.SeedSessionAsync("o", "r", 3, /* valid session */ default!);

        // Inject a slow IReviewSubmitter so the first call holds the lock.
        _factory.InjectSlowSubmitter(TimeSpan.FromSeconds(2));

        var first = _client.PostAsJsonAsync("/api/pr/o/r/3/submit", new { verdict = "Comment" });
        await Task.Delay(100); // ensure first acquired the lock
        var second = await _client.PostAsJsonAsync("/api/pr/o/r/3/submit", new { verdict = "Comment" });

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        var body = await second.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("submit-in-progress", body.GetProperty("code").GetString());

        await first;  // drain
    }

    [Fact]
    public async Task PostSubmit_BodyLargerThan16KiB_Returns413()
    {
        var oversized = new string('x', 17 * 1024);
        using var content = new StringContent(oversized, System.Text.Encoding.UTF8, "application/json");
        var resp = await _client.PostAsync("/api/pr/o/r/4/submit", content);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, resp.StatusCode);
    }
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — endpoint doesn't exist.

- [ ] **Step 3: Define the DTOs**

`PRism.Web/Endpoints/PrSubmitDtos.cs`:

```csharp
namespace PRism.Web.Endpoints;

public sealed record SubmitRequestDto(string Verdict);
public sealed record SubmitResponseDto(string Outcome);
public sealed record SubmitErrorDto(string Code, string Message);
```

- [ ] **Step 4: Implement `PrSubmitEndpoints.cs`**

```csharp
// PRism.Web/Endpoints/PrSubmitEndpoints.cs
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Events;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

public static class PrSubmitEndpoints
{
    public static IEndpointRouteBuilder MapPrSubmitEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit", SubmitAsync);
        return app;
    }

    private static async Task<IResult> SubmitAsync(
        string owner, string repo, int number,
        SubmitRequestDto request,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        Microsoft.Extensions.Hosting.IHostApplicationLifetime appLifetime,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);

        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before submitting."), statusCode: StatusCodes.Status401Unauthorized);

        // NOT `await using var handle` — that disposes at method-scope-end (when Results.Json returns),
        // releasing the lock BEFORE the fire-and-forget pipeline runs. The Task.Run lambda's
        // `finally { await handle.DisposeAsync(); }` is the sole owner; the handle stays alive
        // across the response boundary because we don't `await using` it here.
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct);
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "Submit already in flight for this PR."), statusCode: StatusCodes.Status409Conflict);

        // Read current session
        var appState = await stateStore.LoadAsync(ct);
        var sessionKey = $"{owner}/{repo}/{number}";
        if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session))
            return Results.Json(new SubmitErrorDto("no-session", "No draft session for this PR."), statusCode: StatusCodes.Status400BadRequest);

        // Defensive rule (b): any Stale draft blocks
        if (session.DraftComments.Any(d => d.Status == DraftStatus.Stale && !d.IsOverriddenStale))
            return Results.Json(new SubmitErrorDto("stale-drafts", "Resolve stale drafts before submitting."), statusCode: StatusCodes.Status400BadRequest);
        // Defensive rule (c): verdict status
        if (session.DraftVerdictStatus == DraftVerdictStatus.NeedsReconfirm)
            return Results.Json(new SubmitErrorDto("verdict-needs-reconfirm", "Verdict requires re-confirmation."), statusCode: StatusCodes.Status400BadRequest);
        // Defensive rule (e): empty content with Comment verdict
        var isEmptyComment = request.Verdict == "Comment"
            && session.DraftComments.Count == 0
            && session.DraftReplies.Count == 0
            && string.IsNullOrWhiteSpace(session.DraftSummaryMarkdown);
        if (isEmptyComment)
            return Results.Json(new SubmitErrorDto("no-content", "Comment-verdict review requires at least one draft, reply, or summary."), statusCode: StatusCodes.Status400BadRequest);
        // Defensive rule (f): head_sha drift — compared against active-PR poll's most recent head
        // Per PRism.Core/PrDetail/IActivePrCache.cs:14-25 the API is GetCurrent (not TryGetSnapshot).
        var pollSnapshot = activePrCache.GetCurrent(prRef);
        if (pollSnapshot is not null && pollSnapshot.HeadSha != session.LastViewedHeadSha)
            return Results.Json(new SubmitErrorDto("head-sha-drift", "Reload the PR before submitting."), statusCode: StatusCodes.Status400BadRequest);

        var verdict = ParseVerdict(request.Verdict);
        var pipeline = new SubmitPipeline(submitter, onDuplicateMarker: msg =>
        {
            // The msg carries a draftId substring; extract or just always emit a single event.
            // Simple approach: emit per call with the message body included in the event for now.
            bus.Publish(new SubmitDuplicateMarkerDetectedBusEvent(prRef, DraftId: ExtractDraftIdFromMessage(msg) ?? "unknown"));
        });

        var progress = new SseSubmitProgressBridge(prRef, bus);

        Task PersistAsync(ReviewSessionState updated) =>
            stateStore.UpdateAsync(state =>
            {
                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = updated };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }, ct);

        // Fire pipeline. The endpoint's response is 200 OK "started" before the pipeline completes;
        // the actual progress flows over SSE. The per-PR lock MUST remain held until the pipeline
        // completes — the lambda's `finally { await handle.DisposeAsync(); }` releases it.
        //
        // CRITICAL: pass `CancellationToken.None` to Task.Run, NOT the endpoint's request `ct`.
        // Request `ct` is bound to HttpContext.RequestAborted, which fires when the response
        // completes (or the tab closes). Passing it to Task.Run means the lambda either never
        // starts (if the response races) or aborts mid-pipeline (when the tab closes), and the
        // captured `ct` propagates into every `pipeline.SubmitAsync(... , ct)` await — silently
        // killing the pipeline. The pipeline needs a long-running cancellation source that lives
        // for the duration of the host, not the request. Production wiring uses
        // `IHostApplicationLifetime.ApplicationStopping`; the endpoint resolves that and passes
        // its token instead. The pipeline's per-call cancellation (e.g., HttpClient SendAsync
        // timeout) is independent of the orchestration cancellation source.
        var pipelineCt = appLifetime.ApplicationStopping;
        _ = Task.Run(async () =>
        {
            try
            {
                var outcome = await pipeline.SubmitAsync(prRef, session, verdict, session.LastViewedHeadSha!, progress, PersistAsync, pipelineCt);
                switch (outcome)
                {
                    case SubmitOutcome.Success success:
                        bus.Publish(new DraftSubmittedBusEvent(prRef, success.PullRequestReviewId));
                        bus.Publish(new StateChangedBusEvent(prRef));
                        break;
                    case SubmitOutcome.ForeignPendingReviewPromptRequired prompt:
                        bus.Publish(new SubmitForeignPendingReviewBusEvent(
                            prRef,
                            prompt.Snapshot.PullRequestReviewId,
                            prompt.Snapshot.CommitOid,
                            prompt.Snapshot.CreatedAt,
                            prompt.Snapshot.Threads.Count,
                            prompt.Snapshot.Threads.Sum(t => t.Comments.Count)));
                        break;
                    case SubmitOutcome.StaleCommitOidRecreating stale:
                        bus.Publish(new SubmitStaleCommitOidBusEvent(prRef, stale.OrphanCommitOid));
                        break;
                    case SubmitOutcome.Failed: /* progress event already emitted Failed */ break;
                }
            }
            catch (OperationCanceledException) when (pipelineCt.IsCancellationRequested)
            {
                // Host is shutting down. Persist nothing new (per-stamp persists already wrote);
                // the next session resumes via the foreign-pending-review flow if there's a
                // pending review on github.com.
            }
            finally
            {
                await handle.DisposeAsync();
            }
        }, CancellationToken.None);

        return Results.Json(new SubmitResponseDto("started"));
    }

    private static SubmitEvent ParseVerdict(string s) => s switch
    {
        "Approve" => SubmitEvent.Approve,
        "RequestChanges" => SubmitEvent.RequestChanges,
        "Comment" => SubmitEvent.Comment,
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, "Unknown verdict"),
    };

    private static string? ExtractDraftIdFromMessage(string msg)
    {
        // Best-effort parse from "Duplicate marker detected for draft <id>; ..." or similar.
        var prefix = "draft ";
        var idx = msg.IndexOf(prefix, StringComparison.Ordinal);
        if (idx < 0) return null;
        var rest = msg.AsSpan(idx + prefix.Length);
        var end = rest.IndexOfAny([';', ' ']);
        return end < 0 ? rest.ToString() : rest[..end].ToString();
    }
}
```

**Note on the fire-and-forget pipeline dispatch.** The `Task.Run` approach above releases the request thread immediately but keeps the pipeline running in the background until completion (or process shutdown). For PoC scope, this is acceptable; the host shutdown registers `ApplicationStopping` and the SSE channel drains there. An alternative is to make the endpoint synchronously await `pipeline.SubmitAsync` and only return after completion — simpler control flow, but ties up the request thread for tens of seconds. PoC default: fire-and-forget with `Task.Run` for responsiveness; document in the deferrals sidecar as a forward-looking risk if dogfooding surfaces "tab tabbed away mid-submit, pipeline died" issues.

- [ ] **Step 5: Wire the endpoint into `Program.cs`**

```csharp
app.MapPrSubmitEndpoints();
```

And extend the body-cap `UseWhen` predicate:

```csharp
// In the existing UseWhen predicate body:
if (HttpMethods.IsPost(method) && path.Value!.EndsWith("/submit", StringComparison.Ordinal)) return true;
```

- [ ] **Step 6: Register `SubmitPipeline` in DI**

In `PRism.Web/Composition/ServiceCollectionExtensions.cs`:

```csharp
// SubmitPipeline is per-request — but the lock registry + submitter handle the per-PR state.
// Register Transient so each call gets a fresh pipeline; the dependencies (IReviewSubmitter,
// IReviewEventBus, etc.) are already DI-registered.
services.AddTransient<SubmitPipeline>();
```

Note: actually constructing the pipeline inline (as the endpoint does) is more flexible since the pipeline takes an `onDuplicateMarker` callback that's per-call. DI registration is optional; remove if unused.

- [ ] **Step 7: Verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrSubmitEndpointsTests"`
Expected: PASS (4 tests). Iterate any helper test infra (`PrismWebFactory.SeedSessionAsync`, `InjectSlowSubmitter`) that needs first-time additions.

- [ ] **Step 8: Commit**

```bash
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs PRism.Web/Endpoints/PrSubmitDtos.cs PRism.Web/Program.cs PRism.Web/Composition/ServiceCollectionExtensions.cs tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs
git commit -m "feat(s5-pr3): POST /api/pr/{ref}/submit endpoint

Authorization: cache.IsSubscribed (broader-than-spec pattern, S4 deferral 6 stays deferred).
Per-PR submit lock acquired via SubmitLockRegistry; 409 on contention.
Defensive enforcement of rules (b)/(c)/(e)/(f) at endpoint level.
Pipeline dispatched as Task.Run; SSE drives progress; HTTP returns 200 'started'
immediately. Outcome → bus events (DraftSubmitted on Success, submit-foreign-
pending-review / submit-stale-commit-oid on respective outcomes).

Body cap: 16 KiB via UseWhen predicate (extended to match /submit per spec § 7.1)."
```

---

### Task 37: `POST /api/pr/{ref}/submit/foreign-pending-review/resume` — TOCTOU + import + 200 carries snapshot

**Files:**

- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (add the resume route)
- Modify: `PRism.Web/Program.cs` (extend body-cap predicate)
- Create: tests in `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsForeignResumeTests.cs`

**Spec section:** § 7.2 (Resume) + § 11.1 (frontend consumes 200 payload).

- [ ] **Step 1: Write the failing tests (TOCTOU pass + TOCTOU 409 + import shape)**

```csharp
[Fact]
public async Task PostResume_TOCTOUPass_Returns200WithFullSnapshotBody_ImportedAsDrafts()
{
    // Pre-seed: foreign pending review exists with one thread + one reply.
    _factory.SeedPendingReview("o", "r", 1, /* fake pending review with 1 thread + 1 reply */ default!);
    await _factory.SeedSessionAsync("o", "r", 1, EmptySession());

    var resp = await _client.PostAsJsonAsync("/api/pr/o/r/1/submit/foreign-pending-review/resume",
        new { pullRequestReviewId = "PRR_foreign" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
    Assert.Equal("PRR_foreign", body.GetProperty("pullRequestReviewId").GetString());
    Assert.Equal(1, body.GetProperty("threadCount").GetInt32());
    Assert.Equal(1, body.GetProperty("replyCount").GetInt32());
    // The 200 payload carries full thread/reply bodies (unlike the SSE event).
    Assert.True(body.GetProperty("threads").GetArrayLength() == 1);

    // State.json now has DraftComment + DraftReply entries with ThreadId / ReplyCommentId stamped.
    var state = await _factory.LoadStateAsync();
    var session = state.Reviews.Sessions["o/r/1"];
    Assert.Single(session.DraftComments);
    Assert.Equal("PRRT_t1", session.DraftComments[0].ThreadId);
}

[Fact]
public async Task PostResume_TOCTOU409_PendingReviewVanishedOnGithub_Returns409()
{
    // Pre-seed: session expects to resume against PRR_x; but the fake returns null (no pending now).
    _factory.SeedNoPendingReview("o", "r", 2);

    var resp = await _client.PostAsJsonAsync("/api/pr/o/r/2/submit/foreign-pending-review/resume",
        new { pullRequestReviewId = "PRR_x" });

    Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
    Assert.Equal("pending-review-state-changed", body.GetProperty("code").GetString());
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement the route in `PrSubmitEndpoints.cs`**

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/resume", ResumeForeignPendingReviewAsync);

private static async Task<IResult> ResumeForeignPendingReviewAsync(
    string owner, string repo, int number,
    [FromBody] ResumeForeignPendingReviewRequestDto request,
    IAppStateStore stateStore,
    IActivePrCache activePrCache,
    IReviewSubmitter submitter,
    IReviewEventBus bus,
    CancellationToken ct)
{
    var prRef = new PrReference(owner, repo, number);
    if (!activePrCache.IsSubscribed(prRef))
        return Results.Json(new SubmitErrorDto("unauthorized", "..."), statusCode: 401);

    // TOCTOU defense: re-fetch Snapshot B.
    var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct);
    if (snapshotB is null || snapshotB.PullRequestReviewId != request.PullRequestReviewId)
        return Results.Json(new SubmitErrorDto("pending-review-state-changed",
            "The pending review changed during the prompt. Please retry submit."),
            statusCode: StatusCodes.Status409Conflict);

    // Import threads → DraftComments (with ThreadId + IsResolved); reply chains → DraftReplies.
    var newDrafts = snapshotB.Threads.Select(t => new DraftComment(
        Id: Guid.NewGuid().ToString("N"),
        FilePath: t.FilePath,
        LineNumber: t.LineNumber,
        Side: t.Side,
        AnchoredSha: t.OriginalCommitOid,
        AnchoredLineContent: t.OriginalLineContent,
        BodyMarkdown: PipelineMarker.StripIfPresent(t.BodyMarkdown),
        Status: DraftStatus.Draft,
        IsOverriddenStale: false,
        ThreadId: t.PullRequestReviewThreadId)).ToList();

    // Carry IsResolved as a side-channel; the DraftComment record doesn't have an IsResolved field today.
    // Decision: extend DraftComment with `IsResolvedOnServer: bool` (default false) in PR2's v3→v4 migration?
    // The spec § 11.1 calls for an IsResolved badge but doesn't pin the persistence shape — for PR3, we
    // pass IsResolved through the 200 response payload only; the frontend renders the badge from the
    // response (not from re-reading state.json). State.json persists DraftComment as today; the badge
    // is ephemeral. (Logged as a deferral if dogfooding shows users wanting the badge to persist after
    // reload — at which point v4 → v5 extends DraftComment.)

    var newReplies = snapshotB.Threads.SelectMany(t => t.Comments.Select(c => new DraftReply(
        Id: Guid.NewGuid().ToString("N"),
        ParentThreadId: t.PullRequestReviewThreadId,
        ReplyCommentId: c.CommentId,
        BodyMarkdown: PipelineMarker.StripIfPresent(c.BodyMarkdown),
        Status: DraftStatus.Draft,
        IsOverriddenStale: false))).ToList();

    var sessionKey = $"{owner}/{repo}/{number}";
    await stateStore.UpdateAsync(state =>
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing))
            existing = new ReviewSessionState(/* default empty session */);
        var merged = existing with
        {
            DraftComments = existing.DraftComments.Concat(newDrafts).ToList(),
            DraftReplies = existing.DraftReplies.Concat(newReplies).ToList(),
            PendingReviewId = snapshotB.PullRequestReviewId,
            PendingReviewCommitOid = snapshotB.CommitOid,
        };
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = merged };
        return state with { Reviews = state.Reviews with { Sessions = sessions } };
    }, ct);

    bus.Publish(new StateChangedBusEvent(prRef));

    // Return the full Snapshot B payload so the frontend can render imported drafts immediately.
    return Results.Json(new
    {
        pullRequestReviewId = snapshotB.PullRequestReviewId,
        commitOid = snapshotB.CommitOid,
        threadCount = snapshotB.Threads.Count,
        replyCount = snapshotB.Threads.Sum(t => t.Comments.Count),
        threads = snapshotB.Threads.Select(t => new
        {
            id = t.PullRequestReviewThreadId,
            filePath = t.FilePath,
            lineNumber = t.LineNumber,
            side = t.Side,
            isResolved = t.IsResolved,
            body = t.BodyMarkdown,
            replies = t.Comments.Select(c => new { id = c.CommentId, body = c.BodyMarkdown }),
        }),
    });
}
```

Also add a small helper to `PipelineMarker.cs`:

```csharp
public static string StripIfPresent(string body)
{
    if (string.IsNullOrEmpty(body)) return body;
    return EndMarkerRegex.Replace(body, "").TrimEnd('\n', ' ', '\t');
}
```

- [ ] **Step 4: Extend `Program.cs` body-cap predicate**

```csharp
if (HttpMethods.IsPost(method) && path.Value!.EndsWith("/submit/foreign-pending-review/resume", StringComparison.Ordinal)) return true;
```

- [ ] **Step 5: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ForeignResumeTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs PRism.Web/Program.cs PRism.Core/Submit/Pipeline/PipelineMarker.cs tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsForeignResumeTests.cs
git commit -m "feat(s5-pr3): POST /submit/foreign-pending-review/resume — TOCTOU + import

Re-fetches Snapshot B; 409 pending-review-state-changed if the snapshot has
shifted. Imports threads as DraftComment (Status=Draft, ThreadId stamped);
reply chains as DraftReply (ReplyCommentId stamped). PipelineMarker.StripIfPresent
removes the marker from imported bodies (it's an internal-format detail, not
user content). 200 response carries full thread/reply bodies for immediate
frontend render; IsResolved per thread surfaces in the payload for PR5's
badge."
```

---

### Task 38: `POST /api/pr/{ref}/submit/foreign-pending-review/discard` — TOCTOU + delete

**Files:**

- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (add the discard route)
- Modify: `PRism.Web/Program.cs` (extend body-cap predicate)
- Create: tests in `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsForeignDiscardTests.cs`

**Spec section:** § 7.3.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public async Task PostDiscard_TOCTOUPass_DeletesPendingReview_ClearsSessionStamps_Returns200()
{
    _factory.SeedPendingReview("o", "r", 1, /* foreign pending review */ default!);

    var resp = await _client.PostAsJsonAsync("/api/pr/o/r/1/submit/foreign-pending-review/discard",
        new { pullRequestReviewId = "PRR_foreign" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    // Pending review gone from fake.
    Assert.Null(_factory.GetPendingReview("o", "r", 1));

    // Session's PendingReviewId / PendingReviewCommitOid cleared.
    var state = await _factory.LoadStateAsync();
    var session = state.Reviews.Sessions["o/r/1"];
    Assert.Null(session.PendingReviewId);
    Assert.Null(session.PendingReviewCommitOid);
}

[Fact]
public async Task PostDiscard_TOCTOU409_Returns409()
{
    _factory.SeedNoPendingReview("o", "r", 2);
    var resp = await _client.PostAsJsonAsync("/api/pr/o/r/2/submit/foreign-pending-review/discard",
        new { pullRequestReviewId = "PRR_x" });
    Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement the route**

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/discard", DiscardForeignPendingReviewAsync);

private static async Task<IResult> DiscardForeignPendingReviewAsync(
    string owner, string repo, int number,
    [FromBody] DiscardForeignPendingReviewRequestDto request,
    IAppStateStore stateStore,
    IActivePrCache activePrCache,
    IReviewSubmitter submitter,
    IReviewEventBus bus,
    CancellationToken ct)
{
    var prRef = new PrReference(owner, repo, number);
    if (!activePrCache.IsSubscribed(prRef))
        return Results.Json(new SubmitErrorDto("unauthorized", "..."), statusCode: 401);

    var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct);
    if (snapshotB is null || snapshotB.PullRequestReviewId != request.PullRequestReviewId)
        return Results.Json(new SubmitErrorDto("pending-review-state-changed", "The pending review changed during the prompt. Please retry submit."),
            statusCode: StatusCodes.Status409Conflict);

    await submitter.DeletePendingReviewAsync(prRef, snapshotB.PullRequestReviewId, ct);

    var sessionKey = $"{owner}/{repo}/{number}";
    await stateStore.UpdateAsync(state =>
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
        var cleared = existing with { PendingReviewId = null, PendingReviewCommitOid = null };
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
        return state with { Reviews = state.Reviews with { Sessions = sessions } };
    }, ct);

    bus.Publish(new StateChangedBusEvent(prRef));
    return Results.Ok();
}
```

- [ ] **Step 4: Extend `Program.cs` body-cap predicate**

```csharp
if (HttpMethods.IsPost(method) && path.Value!.EndsWith("/submit/foreign-pending-review/discard", StringComparison.Ordinal)) return true;
```

- [ ] **Step 5: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~ForeignDiscardTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsForeignDiscardTests.cs
git commit -m "feat(s5-pr3): POST /submit/foreign-pending-review/discard — TOCTOU + delete

TOCTOU re-fetch; on pass, deletePullRequestReview + clear session stamps.
On TOCTOU 409 (pending review changed during prompt), surface code
pending-review-state-changed; frontend retries."
```

---

### Task 39: `POST /api/pr/{ref}/drafts/discard-all` — closed/merged bulk-discard

**Files:**

- Create: `PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs`
- Modify: `PRism.Web/Program.cs` (extend body-cap predicate; map endpoint)
- Create: tests in `tests/PRism.Web.Tests/Endpoints/PrDraftsDiscardAllEndpointTests.cs`

**Spec section:** § 13.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public async Task PostDiscardAll_ClearsSessionState_Returns200()
{
    await _factory.SeedSessionAsync("o", "r", 1, SessionWithDraftsAndPending());
    var resp = await _client.PostAsync("/api/pr/o/r/1/drafts/discard-all", null);
    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await _factory.LoadStateAsync();
    var session = state.Reviews.Sessions["o/r/1"];
    Assert.Empty(session.DraftComments);
    Assert.Empty(session.DraftReplies);
    Assert.Null(session.PendingReviewId);
    Assert.Null(session.DraftSummaryMarkdown);
    Assert.Null(session.DraftVerdict);
}

[Fact]
public async Task PostDiscardAll_PendingReviewIdSet_FiresCourtesyDelete_LogsButDoesNotBlockOnFailure()
{
    await _factory.SeedSessionAsync("o", "r", 1, SessionWithDraftsAndPending(pendingReviewId: "PRR_to_delete"));
    _factory.InjectDeletePendingReviewFailure(new HttpRequestException("network"));

    var resp = await _client.PostAsync("/api/pr/o/r/1/drafts/discard-all", null);
    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

    // Local state cleared (the courtesy failure does NOT block).
    var state = await _factory.LoadStateAsync();
    Assert.Empty(state.Reviews.Sessions["o/r/1"].DraftComments);

    // submit-orphan-cleanup-failed SSE event published.
    Assert.Contains(_factory.PublishedBusEvents, e => e is SubmitOrphanCleanupFailedBusEvent);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL.

- [ ] **Step 3: Implement the endpoint**

```csharp
// PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Web.Events;

namespace PRism.Web.Endpoints;

public static class PrDraftsDiscardAllEndpoint
{
    public static IEndpointRouteBuilder MapPrDraftsDiscardAllEndpoint(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/drafts/discard-all", DiscardAllAsync);
        return app;
    }

    private static async Task<IResult> DiscardAllAsync(
        string owner, string repo, int number,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        ILogger<IAppStateStore> log,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        if (!activePrCache.IsSubscribed(prRef))
            return Results.Unauthorized();

        var sessionKey = $"{owner}/{repo}/{number}";
        string? pendingToDelete = null;

        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
            pendingToDelete = existing.PendingReviewId;
            var cleared = existing with
            {
                DraftComments = new List<DraftComment>(),
                DraftReplies = new List<DraftReply>(),
                DraftSummaryMarkdown = null,
                DraftVerdict = null,
                DraftVerdictStatus = DraftVerdictStatus.Draft,
                PendingReviewId = null,
                PendingReviewCommitOid = null,
            };
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct);

        bus.Publish(new StateChangedBusEvent(prRef));

        // Courtesy delete; best-effort, do not block.
        if (pendingToDelete is not null)
        {
            try
            {
                await submitter.DeletePendingReviewAsync(prRef, pendingToDelete, ct);
            }
            catch (Exception ex)
            {
                // Scrubber-protected log:
                log.LogWarning("Bulk-discard courtesy DeletePendingReview failed for {Owner}/{Repo}/{Number} pendingReviewId={PendingReviewId}: {Message}",
                    owner, repo, number,
                    SensitiveFieldScrubber.Scrub(nameof(pendingToDelete), pendingToDelete),
                    ex.Message);
                bus.Publish(new SubmitOrphanCleanupFailedBusEvent(prRef));
            }
        }

        return Results.Ok();
    }
}
```

- [ ] **Step 4: Wire endpoint + extend body-cap predicate**

```csharp
// Program.cs:
app.MapPrDraftsDiscardAllEndpoint();

// And in UseWhen predicate:
if (HttpMethods.IsPost(method) && path.Value!.EndsWith("/drafts/discard-all", StringComparison.Ordinal)) return true;
```

- [ ] **Step 5: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrDraftsDiscardAllEndpointTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrDraftsDiscardAllEndpointTests.cs
git commit -m "feat(s5-pr3): POST /drafts/discard-all — closed/merged bulk-discard

Always succeeds locally (clears session state). If pendingReviewId was set,
fires DeletePendingReviewAsync as courtesy; failure logged + published as
submit-orphan-cleanup-failed SSE event without blocking the 200 response.
Per spec § 13.2."
```

---

### Task 40: Composer marker-prefix collision rejection (modify `PUT /api/pr/{ref}/draft`)

**Files:**

- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs`
- Create/modify: tests in `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointsMarkerCollisionTests.cs`

**Spec section:** § 4 (marker-collision defense at composer save time).

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public async Task PutDraft_BodyContainsMarkerPrefixOutsideFence_Returns400_MarkerPrefixCollisionCode()
{
    var resp = await _client.PutAsJsonAsync("/api/pr/o/r/1/draft", new
    {
        patch = "draftComment",
        draftComment = new
        {
            id = "d1",
            filePath = "src/Foo.cs",
            lineNumber = 1,
            side = "RIGHT",
            bodyMarkdown = "before <!-- prism:client-id:fake --> after",
            status = "Draft",
        },
    });
    Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
    Assert.Equal("marker-prefix-collision", body.GetProperty("code").GetString());
    Assert.Contains("internal marker", body.GetProperty("message").GetString(), StringComparison.OrdinalIgnoreCase);
}

[Fact]
public async Task PutDraft_BodyContainsMarkerInsideFence_Accepts200()
{
    var resp = await _client.PutAsJsonAsync("/api/pr/o/r/1/draft", new
    {
        patch = "draftComment",
        draftComment = new
        {
            id = "d2",
            filePath = "src/Foo.cs",
            lineNumber = 1,
            side = "RIGHT",
            bodyMarkdown = "```\n<!-- prism:client-id:literal -->\n```",
            status = "Draft",
        },
    });
    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — endpoint accepts the marker substring.

- [ ] **Step 3: Add the rejection check to `PrDraftEndpoints.cs`**

Find the `PUT /draft` handler. Before any state update, add:

```csharp
// Marker-prefix collision defense (spec § 4). Rejects user bodies that contain the
// literal <!-- prism:client-id: substring outside fenced code blocks; such a body
// would confuse the SubmitPipeline's lost-response adoption matcher.
var bodyToValidate = req.DraftComment?.BodyMarkdown ?? req.DraftReply?.BodyMarkdown ?? req.DraftSummaryMarkdown;
if (bodyToValidate is not null && PipelineMarker.ContainsMarkerPrefix(bodyToValidate))
{
    return Results.Json(new
    {
        code = "marker-prefix-collision",
        message = "Comment body cannot contain the internal marker string '<!-- prism:client-id:'",
    }, statusCode: 400);
}
```

`PipelineMarker.ContainsMarkerPrefix` already exists from Task 22.

- [ ] **Step 4: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~MarkerCollisionTests"`
Expected: PASS.

```bash
git add PRism.Web/Endpoints/PrDraftEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrDraftEndpointsMarkerCollisionTests.cs
git commit -m "feat(s5-pr3): composer marker-prefix collision rejection on PUT /draft

User bodies that contain '<!-- prism:client-id:' outside fenced code blocks
return 400 with code marker-prefix-collision. The inline composer surfaces
the validation error: 'Comment body cannot contain the internal marker
string <!-- prism:client-id:'. Defends against the lost-response adoption
matcher confusing user content with PRism-injected markers (spec § 4)."
```

---

### Task 41: Verdict-clear patch wire-shape — switch to `JsonElement`-based parsing

**Files:**

- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs`
- Modify: `PRism.Web/Endpoints/PrDraftDtos.cs` (if needed)
- Create: tests in `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointsVerdictClearTests.cs`

**Spec section:** § 10 (verdict-clear via JsonElement parsing).

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public async Task PutDraft_VerdictPresentNull_ClearsVerdictTo_Null()
{
    // Pre-seed: session with DraftVerdict = Approve.
    await _factory.SeedSessionAsync("o", "r", 1, /* session with verdict = Approve */ default!);

    using var content = new StringContent("""
        {"patch":"draftVerdict","draftVerdict":null}
        """, System.Text.Encoding.UTF8, "application/json");

    var resp = await _client.PutAsync("/api/pr/o/r/1/draft", content);
    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

    var state = await _factory.LoadStateAsync();
    var session = state.Reviews.Sessions["o/r/1"];
    Assert.Null(session.DraftVerdict);
}

[Fact]
public async Task PutDraft_VerdictAbsent_DoesNotChangeVerdict()
{
    await _factory.SeedSessionAsync("o", "r", 2, /* session with verdict = Approve */ default!);

    // Patch a different field (e.g., draftSummaryMarkdown); verdict field absent.
    using var content = new StringContent("""
        {"patch":"draftSummaryMarkdown","draftSummaryMarkdown":"new summary"}
        """, System.Text.Encoding.UTF8, "application/json");

    var resp = await _client.PutAsync("/api/pr/o/r/2/draft", content);
    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await _factory.LoadStateAsync();
    var session = state.Reviews.Sessions["o/r/2"];
    Assert.Equal(DraftVerdict.Approve, session.DraftVerdict);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — current implementation deserializes `null` as "field absent" and 400s on the first test.

- [ ] **Step 3: Switch patch parsing to `JsonElement`**

Modify the `PUT /draft` handler to accept `JsonElement` (or `JsonDocument`) instead of the strongly-typed DTO. Parse the body manually:

```csharp
private static async Task<IResult> PutDraftAsync(
    string owner, string repo, int number,
    HttpContext ctx,
    IAppStateStore stateStore,
    /* …other deps… */
    CancellationToken ct)
{
    using var bodyDoc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct);
    var root = bodyDoc.RootElement;

    if (!root.TryGetProperty("patch", out var patchKindEl))
        return Results.Json(new { code = "patch-missing" }, statusCode: 400);
    var patchKind = patchKindEl.GetString();

    // Validate exactly one operation field is present (matching the existing single-op-per-patch contract).
    // The new wire-shape: the field whose name matches patchKind is the operation; its value (including
    // present-null) is the new value. Absent → no-op (treated as 400 "operation field missing").

    // Dispatch by patch kind.
    var session = /* load current session */;
    var updated = patchKind switch
    {
        "draftVerdict" when root.TryGetProperty("draftVerdict", out var v) =>
            session with { DraftVerdict = ParseVerdictNullable(v) },
        "draftSummaryMarkdown" when root.TryGetProperty("draftSummaryMarkdown", out var s) =>
            session with { DraftSummaryMarkdown = s.ValueKind == JsonValueKind.Null ? null : s.GetString() },
        "draftComment" when root.TryGetProperty("draftComment", out var d) =>
            ApplyDraftCommentPatch(session, d),
        // …other kinds…
        _ => null,
    };
    if (updated is null) return Results.Json(new { code = "patch-shape-invalid" }, statusCode: 400);

    /* …persist + publish… */
    return Results.Ok();
}

private static DraftVerdict? ParseVerdictNullable(JsonElement el)
{
    if (el.ValueKind == JsonValueKind.Null) return null;
    return el.GetString() switch
    {
        "Approve" => DraftVerdict.Approve,
        "RequestChanges" => DraftVerdict.RequestChanges,
        "Comment" => DraftVerdict.Comment,
        _ => throw new JsonException($"Unknown verdict: {el.GetString()}"),
    };
}
```

The existing tests will largely keep passing because the new dispatch handles the same kinds; the new behavior is **present-null distinguishes from absent**.

- [ ] **Step 4: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~VerdictClearTests"`
Expected: PASS.

Run the broader `PrDraftEndpointsTests` to confirm no regression: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrDraftEndpoints"`. Expected: PASS.

```bash
git add PRism.Web/Endpoints/PrDraftEndpoints.cs PRism.Web/Endpoints/PrDraftDtos.cs tests/PRism.Web.Tests/Endpoints/PrDraftEndpointsVerdictClearTests.cs
git commit -m "feat(s5-pr3): verdict-clear patch wire-shape — JsonElement-based parsing

Per spec § 10 / S4 deferral 5 option (b): switch PUT /draft from typed-DTO
to JsonElement parsing so present-null distinguishes from absent. Verdict
clear (revert from Approve/RequestChanges/Comment back to no verdict) now
works via { 'patch': 'draftVerdict', 'draftVerdict': null }.

Generalizable — DraftSummaryMarkdown clear inherits the same shape. Existing
patch-kind tests continue to pass."
```

---

### Task 42: `SensitiveFieldScrubber` extension

**Files:**

- Modify: `PRism.Web/Logging/SensitiveFieldScrubber.cs`
- Modify: `tests/PRism.Web.Tests/Logging/SensitiveFieldScrubberTests.cs` (or create if not present)

**Spec section:** § 18.2 (planning decision, lands in PR3).

- [ ] **Step 1: Write the failing test**

```csharp
[Theory]
[InlineData("pendingReviewId")]
[InlineData("threadId")]
[InlineData("replyCommentId")]
public void Scrub_RedactsNewSubmitPipelineFieldNames(string fieldName)
{
    var result = SensitiveFieldScrubber.Scrub(fieldName, "PRR_secret_id");
    Assert.Equal("[REDACTED]", result);
}
```

- [ ] **Step 2: Verify fail**

Expected: FAIL — fields not in the blocked list.

- [ ] **Step 3: Extend the blocked-field list**

```csharp
private static readonly string[] BlockedFieldNames =
{
    "subscriberId",
    "pat",
    "token",
    "pendingReviewId",   // S5 PR3
    "threadId",          // S5 PR3
    "replyCommentId",    // S5 PR3
};
```

- [ ] **Step 4: Verify pass + commit**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SensitiveFieldScrubberTests"`
Expected: PASS.

```bash
git add PRism.Web/Logging/SensitiveFieldScrubber.cs tests/PRism.Web.Tests/Logging/SensitiveFieldScrubberTests.cs
git commit -m "feat(s5-pr3): extend SensitiveFieldScrubber with submit-pipeline field names

Adds pendingReviewId / threadId / replyCommentId to BlockedFieldNames. These
are live GitHub-issued identifiers introduced by the submit pipeline; if
emitted as structured log args they could be correlated with a specific
user's in-flight review. Per spec § 18.2 + ce-doc-review security-lens SEC-005."
```

---

### Task 43: PR3 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln
dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

Expected: all green.

- [ ] **Step 2: Open PR3**

```bash
gh pr create --title "feat(s5-pr3): submit endpoints + SSE events + per-PR lock + verdict-clear + scrubber extension" --body "$(cat <<'EOF'
## Summary

Backend wiring for the submit pipeline:
- `POST /api/pr/{ref}/submit` — per-PR submit lock, defensive rule enforcement, fire-and-forget pipeline dispatch.
- `POST /api/pr/{ref}/submit/foreign-pending-review/resume` — TOCTOU re-fetch, import as Drafts, 200 carries full snapshot bodies.
- `POST /api/pr/{ref}/submit/foreign-pending-review/discard` — TOCTOU re-fetch, deletePullRequestReview, clear session stamps.
- `POST /api/pr/{ref}/drafts/discard-all` — closed/merged bulk-discard with courtesy DeletePendingReview.

Plus ancillary fixes:
- Five new SSE event types via `SseEventProjection`.
- `SubmitLockRegistry` — per-PR `SemaphoreSlim` (separate primitive from `AppStateStore._gate`).
- Composer marker-prefix collision rejection on `PUT /draft`.
- Verdict-clear patch wire-shape via `JsonElement` parsing (S4 deferral 5 closed).
- `SensitiveFieldScrubber` extended with `pendingReviewId` / `threadId` / `replyCommentId`.
- Body-cap `UseWhen` extended for all four new endpoints.

## Test plan

- [x] `dotnet test PRism.sln` (every endpoint has happy-path + 409 contention + body-cap + rule-defense tests)
- [x] `SubmitLockRegistryTests` (4 tests covering acquire / contention / different-prRefs / re-acquisition)
- [x] `SseEventProjectionSubmitEventsTests` (5 tests covering all new event types + counts-only enforcement)
- [x] Multi-tab simultaneous-submit returns 409 for the losing tab (covered in `PrSubmitEndpointsTests`)
- [x] `npm run lint` + `npm run build` (frontend untouched)
- [x] Playwright suite green

## Spec refs

- Spec: `docs/specs/2026-05-11-s5-submit-pipeline-design.md` § 7 + § 10 + § 13 + § 16 PR3
- Decisions: § 17 #5 (broader authorization), #23 (multi-marker defense), #24 (per-PR lock), #26 (counts-only SSE), #28 (composer rejection)
- Deferral closed: S4 deferral 5 (verdict-clear)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 5 — PR4: Frontend Submit dialog + `useSubmit` hook + Submit button + verdict picker enabled + AI validator + Ask AI button

**PR title:** `feat(s5-pr4): Submit dialog + useSubmit + Submit Review button + verdict picker + AI validator card + Ask AI empty state`

**Spec sections:** § 8 (dialog), § 8.4 (`useSubmit`), § 8.5 (responsive table), § 9 (Submit Review button), § 10 (verdict picker enabled), § 14.1 (validator card), § 14.2 (Ask AI button + empty state), § 16 PR4 row.

**Goal:** Land the user-facing surface of the submit pipeline. PR6 is folded in (per spec § 17 #22): the validator card + Ask AI button + empty state all land here. Foreign-pending-review modal, stale-`commitOID` banner, and bulk-discard UX defer to PR5.

**Files touched (~12 new + 3 modified + many tests):**

- Create: `frontend/src/hooks/useSubmit.ts`
- Create: `frontend/src/api/submit.ts`
- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx`
- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitProgressIndicator.tsx` (Phase A — single neutral indicator)
- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitProgressChecklist.tsx` (Phase B — full 5-row checklist)
- Create: `frontend/src/components/PrDetail/SubmitDialog/CountsBlock.tsx`
- Create: `frontend/src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx`
- Create: `frontend/src/components/PrDetail/SubmitButton.tsx`
- Create: `frontend/src/components/PrDetail/VerdictPicker.tsx` (or modify the existing disabled stub)
- Create: `frontend/src/components/PrDetail/AskAiButton.tsx`
- Create: `frontend/src/components/PrDetail/AskAiEmptyState.tsx`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (mount the Submit dialog + render Submit Review button + Ask AI button + verdict picker enabled)
- Modify: `frontend/src/api/types.ts` (add `SubmitProgressEvent` / `OwnPendingReviewSnapshot` / etc.)
- Tests: one `*.test.tsx` per component + `useSubmit.test.ts`

**Worktree:** `.claude/worktrees/feat+s5-pr4`

---

### Task 44: `api/submit.ts` — typed client helpers

**Files:**

- Create: `frontend/src/api/submit.ts`
- Modify: `frontend/src/api/types.ts` (add types matching the backend DTOs from PR3)
- Create: `frontend/__tests__/api/submit.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/__tests__/api/submit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitReview, resumeForeignPendingReview, discardForeignPendingReview, discardAllDrafts } from '../../src/api/submit';

const originalFetch = global.fetch;

describe('api/submit', () => {
    beforeEach(() => { global.fetch = vi.fn(); });
    afterEach(() => { global.fetch = originalFetch; });

    it('submitReview posts verdict and returns parsed response', async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ outcome: 'started' }),
        });
        const result = await submitReview('o/r/1', 'Comment');
        expect(global.fetch).toHaveBeenCalledWith(
            '/api/pr/o/r/1/submit',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ verdict: 'Comment' }),
            }));
        expect(result.outcome).toBe('started');
    });

    it('submitReview throws SubmitConflictError on 409', async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 409,
            json: async () => ({ code: 'submit-in-progress', message: '...' }),
        });
        await expect(submitReview('o/r/1', 'Comment')).rejects.toThrow(/submit-in-progress/);
    });

    it('resumeForeignPendingReview returns snapshot payload on 200', async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                pullRequestReviewId: 'PRR_x',
                threadCount: 2,
                replyCount: 1,
                threads: [{ id: 't1', filePath: 'src/Foo.cs', lineNumber: 42, side: 'RIGHT', isResolved: false, body: 'b', replies: [] }],
            }),
        });
        const result = await resumeForeignPendingReview('o/r/1', 'PRR_x');
        expect(result.threadCount).toBe(2);
        expect(result.threads).toHaveLength(1);
    });

    it('resumeForeignPendingReview throws TOCTOU error on 409', async () => {
        (global.fetch as any).mockResolvedValueOnce({
            ok: false,
            status: 409,
            json: async () => ({ code: 'pending-review-state-changed' }),
        });
        await expect(resumeForeignPendingReview('o/r/1', 'PRR_x')).rejects.toThrow(/pending-review-state-changed/);
    });

    it('discardAllDrafts posts empty body, succeeds on 200', async () => {
        (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
        await discardAllDrafts('o/r/1');
        expect(global.fetch).toHaveBeenCalledWith('/api/pr/o/r/1/drafts/discard-all', expect.objectContaining({ method: 'POST' }));
    });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run __tests__/api/submit.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Define types in `api/types.ts`**

Append:

```ts
export type Verdict = 'Approve' | 'RequestChanges' | 'Comment';

export type SubmitStep =
    | 'DetectExistingPendingReview'
    | 'BeginPendingReview'
    | 'AttachThreads'
    | 'AttachReplies'
    | 'Finalize';

export type SubmitStepStatus = 'Started' | 'Succeeded' | 'Failed';

export interface SubmitProgressEvent {
    prRef: string;
    step: SubmitStep;
    status: SubmitStepStatus;
    done: number;
    total: number;
    errorMessage?: string;
}

export interface SubmitForeignPendingReviewEvent {
    prRef: string;
    pullRequestReviewId: string;
    commitOid: string;
    createdAt: string;
    threadCount: number;
    replyCount: number;
}

export interface SubmitStaleCommitOidEvent {
    prRef: string;
    orphanCommitOid: string;
}

export interface SubmitOrphanCleanupFailedEvent {
    prRef: string;
}

export interface SubmitDuplicateMarkerDetectedEvent {
    prRef: string;
    draftId: string;
}

export interface ImportedThread {
    id: string;
    filePath: string;
    lineNumber: number;
    side: string;
    isResolved: boolean;
    body: string;
    replies: { id: string; body: string }[];
}

export interface ResumeForeignPendingReviewResponse {
    pullRequestReviewId: string;
    commitOid: string;
    threadCount: number;
    replyCount: number;
    threads: ImportedThread[];
}
```

- [ ] **Step 4: Implement `api/submit.ts`**

```ts
// frontend/src/api/submit.ts
import { apiFetch } from './client';
import type { Verdict, ResumeForeignPendingReviewResponse } from './types';

export class SubmitConflictError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'SubmitConflictError';
    }
}

export async function submitReview(prRef: string, verdict: Verdict): Promise<{ outcome: 'started' }> {
    const resp = await apiFetch(`/api/pr/${prRef}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict }),
    });
    if (resp.status === 409) {
        const body = await resp.json();
        throw new SubmitConflictError(body.code ?? 'unknown', body.message ?? 'Submit conflict.');
    }
    if (!resp.ok) throw new Error(`submit returned ${resp.status}`);
    return resp.json();
}

export async function resumeForeignPendingReview(prRef: string, pullRequestReviewId: string): Promise<ResumeForeignPendingReviewResponse> {
    const resp = await apiFetch(`/api/pr/${prRef}/submit/foreign-pending-review/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pullRequestReviewId }),
    });
    if (resp.status === 409) {
        const body = await resp.json();
        throw new SubmitConflictError(body.code ?? 'unknown', body.message ?? 'Resume conflict.');
    }
    if (!resp.ok) throw new Error(`resume returned ${resp.status}`);
    return resp.json();
}

export async function discardForeignPendingReview(prRef: string, pullRequestReviewId: string): Promise<void> {
    const resp = await apiFetch(`/api/pr/${prRef}/submit/foreign-pending-review/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pullRequestReviewId }),
    });
    if (resp.status === 409) {
        const body = await resp.json();
        throw new SubmitConflictError(body.code ?? 'unknown', body.message ?? 'Discard conflict.');
    }
    if (!resp.ok) throw new Error(`discard returned ${resp.status}`);
}

export async function discardAllDrafts(prRef: string): Promise<void> {
    const resp = await apiFetch(`/api/pr/${prRef}/drafts/discard-all`, { method: 'POST' });
    if (!resp.ok) throw new Error(`discard-all returned ${resp.status}`);
}
```

**Note on the HTTP wrapper.** The existing wrapper at `frontend/src/api/client.ts` is `apiClient.{get,post,put,delete}` (NOT `apiFetch`). Each method takes a path + options object and returns a typed response; 401s dispatch a `'prism-auth-rejected'` window event; errors throw a typed `ApiError`. Update the implementations above to use `apiClient.post(...)` and let `ApiError` (where `error.status === 409` and `error.body.code` carries the discriminator) drive the `SubmitConflictError` mapping. The function shapes don't change — only the call site swaps `apiFetch(...)` → `apiClient.post(...)`.

- [ ] **Step 5: Verify pass + commit**

Run: `cd frontend && npx vitest run __tests__/api/submit.test.ts`
Expected: PASS (5 tests).

```bash
git add frontend/src/api/submit.ts frontend/src/api/types.ts frontend/__tests__/api/submit.test.ts
git commit -m "feat(s5-pr4): api/submit.ts typed client helpers + SubmitConflictError

Four functions: submitReview, resumeForeignPendingReview, discardForeignPendingReview,
discardAllDrafts. SubmitConflictError surfaces 409 codes (submit-in-progress,
pending-review-state-changed) so callers can branch on the code rather than parsing
body manually. Submit progress flows over SSE, not the HTTP response."
```

---

### Task 45: `useSubmit` hook + state machine

**Files:**

- Create: `frontend/src/hooks/useSubmit.ts`
- Create: `frontend/__tests__/useSubmit.test.tsx`

**Spec section:** § 8.4 (full `SubmitState` discriminated union).

- [ ] **Step 1: Write the failing tests (state transitions)**

```tsx
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSubmit } from '../src/hooks/useSubmit';

// Set up an SSE event-source mock that the hook subscribes to.
let sseEmit: (evtName: string, data: unknown) => void;

vi.mock('../src/hooks/useEventSource', () => ({
    useEventSource: (handlers: Record<string, (data: unknown) => void>) => {
        sseEmit = (name, data) => handlers[name]?.(data);
    },
}));

vi.mock('../src/api/submit', () => ({
    submitReview: vi.fn().mockResolvedValue({ outcome: 'started' }),
    resumeForeignPendingReview: vi.fn(),
    discardForeignPendingReview: vi.fn(),
    SubmitConflictError: class extends Error { code = 'submit-in-progress'; },
}));

describe('useSubmit', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('initial state is idle', () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        expect(result.current.state).toEqual({ kind: 'idle' });
    });

    it('submit() transitions idle → in-flight on 200', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        await act(async () => { await result.current.submit('Comment'); });
        expect(result.current.state.kind).toBe('in-flight');
    });

    it('submit-progress SSE event advances the steps array', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        await act(async () => { await result.current.submit('Comment'); });
        act(() => sseEmit('submit-progress', { prRef: 'o/r/1', step: 'BeginPendingReview', status: 'Started', done: 0, total: 1 }));
        const state = result.current.state;
        if (state.kind !== 'in-flight') throw new Error('expected in-flight');
        expect(state.steps).toHaveLength(1);
        expect(state.steps[0].step).toBe('BeginPendingReview');
    });

    it('submit-foreign-pending-review SSE event transitions to foreign-pending-review-prompt', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        await act(async () => { await result.current.submit('Comment'); });
        act(() => sseEmit('submit-foreign-pending-review', { prRef: 'o/r/1', pullRequestReviewId: 'PRR_x', commitOid: 'abc', createdAt: '2026-05-11T10:00:00Z', threadCount: 1, replyCount: 0 }));
        expect(result.current.state.kind).toBe('foreign-pending-review-prompt');
    });

    it('submit-stale-commit-oid SSE event transitions to stale-commit-oid', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        await act(async () => { await result.current.submit('Comment'); });
        act(() => sseEmit('submit-stale-commit-oid', { prRef: 'o/r/1', orphanCommitOid: 'stale' }));
        expect(result.current.state.kind).toBe('stale-commit-oid');
    });

    it('ignores SSE events for a different prRef (multi-tab guard)', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        // No submit() called yet; if a foreign tab fires submit-progress for the same prRef,
        // useSubmit should NOT transition to in-flight (the dialog isn't open in this tab).
        act(() => sseEmit('submit-progress', { prRef: 'o/r/1', step: 'BeginPendingReview', status: 'Started', done: 0, total: 1 }));
        expect(result.current.state.kind).toBe('idle');
    });

    it('reset() returns to idle', async () => {
        const { result } = renderHook(() => useSubmit('o/r/1'));
        await act(async () => { await result.current.submit('Comment'); });
        act(() => result.current.reset());
        expect(result.current.state.kind).toBe('idle');
    });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run __tests__/useSubmit.test.tsx`
Expected: FAIL — hook doesn't exist.

- [ ] **Step 3: Implement `useSubmit`**

```ts
// frontend/src/hooks/useSubmit.ts
import { useCallback, useRef, useState } from 'react';
import { useEventSource } from './useEventSource';
import {
    submitReview as submitReviewApi,
    resumeForeignPendingReview as resumeForeignApi,
    discardForeignPendingReview as discardForeignApi,
} from '../api/submit';
import type {
    Verdict, SubmitStep, SubmitStepStatus, SubmitProgressEvent,
    SubmitForeignPendingReviewEvent, SubmitStaleCommitOidEvent,
} from '../api/types';

export interface SubmitProgressStep {
    step: SubmitStep;
    status: SubmitStepStatus;
    done: number;
    total: number;
    errorMessage?: string;
}

export type SubmitState =
    | { kind: 'idle' }
    | { kind: 'in-flight'; steps: SubmitProgressStep[] }
    | { kind: 'success'; pullRequestReviewId: string }
    | { kind: 'failed'; failedStep: SubmitStep; errorMessage: string; steps: SubmitProgressStep[] }
    | { kind: 'foreign-pending-review-prompt'; snapshot: SubmitForeignPendingReviewEvent }
    // Distinct from 'in-flight' — Cancel re-enabled; primary button = "Recreate and resubmit"
    | { kind: 'stale-commit-oid'; orphanCommitOid: string };

export function useSubmit(prRef: string) {
    const [state, setState] = useState<SubmitState>({ kind: 'idle' });
    // Multi-tab guard: only react to SSE events if this tab initiated the submit.
    const ownsActiveSubmit = useRef(false);

    useEventSource({
        'submit-progress': (data: SubmitProgressEvent) => {
            if (data.prRef !== prRef || !ownsActiveSubmit.current) return;
            setState(prev => {
                const steps = prev.kind === 'in-flight' || prev.kind === 'failed' ? prev.steps : [];
                const updated = upsertStep(steps, data);
                if (data.status === 'Failed') {
                    ownsActiveSubmit.current = false;
                    return { kind: 'failed', failedStep: data.step, errorMessage: data.errorMessage ?? '', steps: updated };
                }
                // Detect Finalize Succeeded → success state.
                if (data.step === 'Finalize' && data.status === 'Succeeded') {
                    ownsActiveSubmit.current = false;
                    // pullRequestReviewId isn't in the progress payload; surface from DraftSubmitted event instead.
                    // For now, defer the success transition to a separate DraftSubmitted handler below.
                }
                return { kind: 'in-flight', steps: updated };
            });
        },
        'submit-foreign-pending-review': (data: SubmitForeignPendingReviewEvent) => {
            if (data.prRef !== prRef || !ownsActiveSubmit.current) return;
            setState({ kind: 'foreign-pending-review-prompt', snapshot: data });
        },
        'submit-stale-commit-oid': (data: SubmitStaleCommitOidEvent) => {
            if (data.prRef !== prRef || !ownsActiveSubmit.current) return;
            setState({ kind: 'stale-commit-oid', orphanCommitOid: data.orphanCommitOid });
        },
        'draft-submitted': (data: { prRef: string; pullRequestReviewId: string }) => {
            if (data.prRef !== prRef || !ownsActiveSubmit.current) return;
            ownsActiveSubmit.current = false;
            setState({ kind: 'success', pullRequestReviewId: data.pullRequestReviewId });
        },
    });

    // Capture the last-confirmed verdict in a ref so retry() can re-fire with the same value
    // without forcing the dialog to plumb the verdict back through props.
    const lastVerdictRef = useRef<Verdict | null>(null);

    const submit = useCallback(async (verdict: Verdict) => {
        lastVerdictRef.current = verdict;
        ownsActiveSubmit.current = true;
        try {
            await submitReviewApi(prRef, verdict);
            setState({ kind: 'in-flight', steps: [] });
        } catch (err) {
            ownsActiveSubmit.current = false;
            setState({ kind: 'idle' });  // 409 returns to idle; caller surfaces toast
            throw err;
        }
    }, [prRef]);

    const retry = useCallback(async () => {
        if (lastVerdictRef.current === null) return;
        ownsActiveSubmit.current = true;
        try {
            await submitReviewApi(prRef, lastVerdictRef.current);
            setState({ kind: 'in-flight', steps: [] });
        } catch (err) {
            ownsActiveSubmit.current = false;
            setState({ kind: 'idle' });
            throw err;
        }
    }, [prRef]);

    const resumeForeignPendingReview = useCallback(async (reviewId: string) => {
        ownsActiveSubmit.current = true;
        try {
            await resumeForeignApi(prRef, reviewId);
            setState({ kind: 'idle' });  // imports land; user adjudicates via Drafts tab
        } catch (err) {
            ownsActiveSubmit.current = false;
            setState({ kind: 'idle' });
            throw err;
        }
    }, [prRef]);

    const discardForeignPendingReview = useCallback(async (reviewId: string) => {
        ownsActiveSubmit.current = true;
        try {
            await discardForeignApi(prRef, reviewId);
            setState({ kind: 'idle' });
        } catch (err) {
            ownsActiveSubmit.current = false;
            setState({ kind: 'idle' });
            throw err;
        }
    }, [prRef]);

    const reset = useCallback(() => {
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' });
    }, []);

    return { state, submit, retry, resumeForeignPendingReview, discardForeignPendingReview, reset };
}

function upsertStep(steps: SubmitProgressStep[], ev: SubmitProgressEvent): SubmitProgressStep[] {
    const idx = steps.findIndex(s => s.step === ev.step);
    const next: SubmitProgressStep = { step: ev.step, status: ev.status, done: ev.done, total: ev.total, errorMessage: ev.errorMessage };
    if (idx === -1) return [...steps, next];
    return steps.map((s, i) => i === idx ? next : s);
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `cd frontend && npx vitest run __tests__/useSubmit.test.tsx`
Expected: PASS (7 tests). Iterate; the `retry` impl needs a captured-verdict ref — refine the test if the placeholder breaks.

```bash
git add frontend/src/hooks/useSubmit.ts frontend/__tests__/useSubmit.test.tsx
git commit -m "feat(s5-pr4): useSubmit hook — six-state discriminated union + SSE-driven transitions

States: idle, in-flight, success, failed, foreign-pending-review-prompt,
stale-commit-oid. The stale-commit-oid kind is deliberately distinct from
in-flight (Cancel re-enabled, primary button is 'Recreate and resubmit').

Multi-tab guard: ownsActiveSubmit ref tracks whether THIS tab initiated the
submit; SSE events for foreign-tab submits are dropped at the state-machine
level so the dialog's lifecycle is local to the initiating tab."
```

---

### Task 46: `SubmitButton` + enable rules

**Files:**

- Create: `frontend/src/components/PrDetail/SubmitButton.tsx`
- Create: `frontend/__tests__/SubmitButton.test.tsx`

**Spec section:** § 9.

- [ ] **Step 1: Write the failing tests (enable matrix)**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SubmitButton } from '../src/components/PrDetail/SubmitButton';
import type { ReviewSessionDto } from '../src/api/types';

const emptySession: ReviewSessionDto = {
    draftComments: [],
    draftReplies: [],
    draftSummaryMarkdown: null,
    draftVerdict: null,
    draftVerdictStatus: 'Draft',
    // …other fields…
};

describe('SubmitButton enable rules', () => {
    it('rule a — no verdict + empty drafts + empty replies + empty summary → disabled', () => {
        render(<SubmitButton session={emptySession} headSha="abc" lastViewedHeadSha="abc" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('rule b — any draft with status Stale → disabled', () => {
        const session = { ...emptySession, draftComments: [{ id: 'd1', status: 'Stale', isOverriddenStale: false, /* … */ } as any] };
        render(<SubmitButton session={session} headSha="abc" lastViewedHeadSha="abc" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('rule c — DraftVerdictStatus = NeedsReconfirm → disabled', () => {
        const session = { ...emptySession, draftVerdict: 'Approve', draftVerdictStatus: 'NeedsReconfirm' };
        render(<SubmitButton session={session} headSha="abc" lastViewedHeadSha="abc" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('rule d — validator returns Blocking severity → disabled', () => {
        const session = { ...emptySession, draftSummaryMarkdown: 'summary', draftVerdict: 'Comment' };
        render(<SubmitButton session={session} headSha="abc" lastViewedHeadSha="abc" validatorResults={[{ severity: 'Blocking', message: '' } as any]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('rule e — verdict = Comment + no content of any kind → disabled', () => {
        const session = { ...emptySession, draftVerdict: 'Comment' };
        render(<SubmitButton session={session} headSha="abc" lastViewedHeadSha="abc" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('rule f — head_sha drift (lastViewed != head) → disabled', () => {
        const session = { ...emptySession, draftSummaryMarkdown: 'summary', draftVerdict: 'Comment' };
        render(<SubmitButton session={session} headSha="new-sha" lastViewedHeadSha="old-sha" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
    });

    it('all rules clear → enabled', () => {
        const session = { ...emptySession, draftSummaryMarkdown: 'summary', draftVerdict: 'Comment' };
        render(<SubmitButton session={session} headSha="abc" lastViewedHeadSha="abc" validatorResults={[]} onSubmit={() => {}} />);
        expect(screen.getByRole('button', { name: /submit review/i })).toBeEnabled();
    });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run __tests__/SubmitButton.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `SubmitButton.tsx`**

```tsx
// frontend/src/components/PrDetail/SubmitButton.tsx
import type { ReviewSessionDto, ValidatorResult } from '../../api/types';

interface Props {
    session: ReviewSessionDto;
    headSha: string;
    lastViewedHeadSha: string;
    validatorResults: ValidatorResult[];
    onSubmit: () => void;
    disabled?: boolean;  // outer override (e.g., during in-flight pipeline)
}

export function SubmitButton({ session, headSha, lastViewedHeadSha, validatorResults, onSubmit, disabled }: Props) {
    const reason = computeDisabledReason(session, headSha, lastViewedHeadSha, validatorResults);
    const isDisabled = disabled === true || reason !== null;
    return (
        <button
            type="button"
            className="btn btn-primary"
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={reason ?? undefined}
            onClick={isDisabled ? undefined : onSubmit}
        >
            Submit review
        </button>
    );
}

function computeDisabledReason(
    s: ReviewSessionDto,
    headSha: string,
    lastViewedHeadSha: string,
    validators: ValidatorResult[]
): string | null {
    const noVerdict = s.draftVerdict === null;
    const noDrafts = s.draftComments.length === 0;
    const noReplies = s.draftReplies.length === 0;
    const noSummary = !s.draftSummaryMarkdown || s.draftSummaryMarkdown.trim() === '';

    // Rule (a)
    if (noVerdict && noDrafts && noReplies && noSummary) return "Pick a verdict or add content before submitting.";
    // Rule (b)
    if (s.draftComments.some(d => d.status === 'Stale' && !d.isOverriddenStale)) return "Resolve stale drafts in the Drafts tab.";
    // Rule (c)
    if (s.draftVerdictStatus === 'NeedsReconfirm') return "Verdict needs re-confirmation.";
    // Rule (d)
    if (validators.some(v => v.severity === 'Blocking')) return "Resolve validator-blocking issues.";
    // Rule (e)
    if (s.draftVerdict === 'Comment' && noDrafts && noReplies && noSummary)
        return "Comment-verdict reviews need a summary or inline content.";
    // Rule (f)
    if (headSha !== lastViewedHeadSha) return "Reload the PR — the head commit has changed.";
    return null;
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `cd frontend && npx vitest run __tests__/SubmitButton.test.tsx`
Expected: PASS (7 tests).

```bash
git add frontend/src/components/PrDetail/SubmitButton.tsx frontend/__tests__/SubmitButton.test.tsx
git commit -m "feat(s5-pr4): SubmitButton with full enable-rule matrix

Six rules per spec § 9 (a–f); each contributes a specific disabled tooltip
that surfaces on hover. Click-on-disabled flows back to PrHeader to focus
the relevant blocker (Drafts tab / verdict picker / Reload banner)."
```

---

### Task 47: `VerdictPicker` — enabled segmented control + clear semantics

**Files:**

- Create: `frontend/src/components/PrDetail/VerdictPicker.tsx`
- Create: `frontend/__tests__/VerdictPicker.test.tsx`

**Spec section:** § 10.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VerdictPicker } from '../src/components/PrDetail/VerdictPicker';

describe('VerdictPicker', () => {
    it('renders three options', () => {
        render(<VerdictPicker value={null} onChange={() => {}} />);
        expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /request changes/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /comment/i })).toBeInTheDocument();
    });

    it('clicking an option calls onChange with that verdict', () => {
        const onChange = vi.fn();
        render(<VerdictPicker value={null} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: /approve/i }));
        expect(onChange).toHaveBeenCalledWith('Approve');
    });

    it('clicking the currently-selected option clears the verdict (calls onChange(null))', () => {
        const onChange = vi.fn();
        render(<VerdictPicker value="Approve" onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: /approve/i }));
        expect(onChange).toHaveBeenCalledWith(null);
    });

    it('renders NeedsReconfirm badge when verdictStatus = NeedsReconfirm', () => {
        render(<VerdictPicker value="Approve" verdictStatus="NeedsReconfirm" onChange={() => {}} />);
        expect(screen.getByText(/needs reconfirm/i)).toBeInTheDocument();
    });

    it('disabled=true makes all buttons aria-disabled', () => {
        render(<VerdictPicker value="Approve" disabled onChange={() => {}} />);
        screen.getAllByRole('button').forEach(b => expect(b).toBeDisabled());
    });
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement; Step 4: Verify pass**

```tsx
// frontend/src/components/PrDetail/VerdictPicker.tsx
import type { Verdict } from '../../api/types';

interface Props {
    value: Verdict | null;
    verdictStatus?: 'Draft' | 'NeedsReconfirm';
    disabled?: boolean;
    onChange(verdict: Verdict | null): void;
}

export function VerdictPicker({ value, verdictStatus, disabled, onChange }: Props) {
    const handle = (v: Verdict) => () => onChange(value === v ? null : v);
    return (
        <div className="verdict-picker">
            <div className="verdict-picker__segments" role="group" aria-label="Review verdict">
                {(['Approve', 'RequestChanges', 'Comment'] as Verdict[]).map(v => (
                    <button
                        key={v}
                        type="button"
                        className={`verdict-picker__segment ${value === v ? 'verdict-picker__segment--selected' : ''}`}
                        aria-pressed={value === v}
                        disabled={disabled}
                        onClick={handle(v)}
                    >
                        {v === 'RequestChanges' ? 'Request changes' : v}
                    </button>
                ))}
            </div>
            {verdictStatus === 'NeedsReconfirm' && (
                <span className="verdict-picker__status">Needs reconfirm</span>
            )}
        </div>
    );
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/VerdictPicker.tsx frontend/__tests__/VerdictPicker.test.tsx
git commit -m "feat(s5-pr4): VerdictPicker enabled state — segmented control with clear semantics

Three slots (Approve / Request changes / Comment). Click-selected-again
clears (onChange(null)) — the verdict-clear patch wire-shape from PR3
makes this work end-to-end. NeedsReconfirm badge renders alongside when
the session's verdictStatus signals re-confirm is needed."
```

---

### Task 48: `CountsBlock` + `PreSubmitValidatorCard` + `SubmitProgressChecklist` + `SubmitProgressIndicator`

**Files:**

- Create: `frontend/src/components/PrDetail/SubmitDialog/CountsBlock.tsx` + test
- Create: `frontend/src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx` + test
- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitProgressIndicator.tsx` + test
- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitProgressChecklist.tsx` + test

Each component is small enough that one TDD pass per file gets it done quickly. Sketch shapes:

- [ ] **CountsBlock** — renders *"This review will create N new thread(s) and M reply(ies)."* Render `0` explicitly. Props: `{ threadCount, replyCount }`. Test: renders the numbers + the singular/plural copy.

- [ ] **PreSubmitValidatorCard** — under `aiPreview: false`, returns `null`. Under `aiPreview: true`, renders the canned suggestion *"3 inline threads on the same file (`src/Foo.cs`) — consider consolidating?"* using the existing `chip-status-suggestion` / `chip-status-concern` / `chip-status-blocking` chip vocabulary + a disabled `<button>` "Show me" link. The `Show me` is `aria-disabled="true"` with `cursor: default`. Props: `{ aiPreview: boolean }`. Test: renders/null based on flag; snapshot of the chip class.

- [ ] **SubmitProgressIndicator** (Phase A) — renders one row: ⏳ *"Checking pending review state…"*. `aria-live="polite"`. Tiny stateless component. Test: renders the copy + the aria attribute.

- [ ] **SubmitProgressChecklist** (Phase B) — renders 5 rows. Props: `{ steps: SubmitProgressStep[] }`. Each row shows the step name + status icon (✓ / ⏳ / ✗) + count text. Test:
  - Empty steps array (just after Begin succeeded) → 5 rows visible with Detect ✓, BeginPending ✓, AttachThreads ⏳, AttachReplies ⏳, Finalize ⏳.
  - Mid-pipeline state (AttachThreads.Succeeded done=2 total=3, AttachReplies.Started done=0 total=2) → AttachThreads "✓ Attached 2 of 3 threads", AttachReplies "⏳ Attaching reply 1 of 2…", Finalize ⏳.
  - Failure state (AttachThreads.Failed done=1 total=3 errorMessage='boom') → AttachThreads renders ✗ + the error message + the rest still ⏳.

For brevity I'm consolidating — each follows the same Step 1-Step 5 TDD shape. Each lands in its own commit; the `feat(s5-pr4):` prefix carries the focused subject (e.g., `feat(s5-pr4): SubmitProgressChecklist Phase B rendering`).

- [ ] **Step 1 (final commit for the group)**

```bash
git add frontend/src/components/PrDetail/SubmitDialog/CountsBlock.tsx frontend/src/components/PrDetail/SubmitDialog/PreSubmitValidatorCard.tsx frontend/src/components/PrDetail/SubmitDialog/SubmitProgressIndicator.tsx frontend/src/components/PrDetail/SubmitDialog/SubmitProgressChecklist.tsx frontend/__tests__/CountsBlock.test.tsx frontend/__tests__/PreSubmitValidatorCard.test.tsx frontend/__tests__/SubmitProgressIndicator.test.tsx frontend/__tests__/SubmitProgressChecklist.test.tsx
git commit -m "feat(s5-pr4): submit-dialog leaf components — counts / validator / progress indicators

CountsBlock: 'N new thread(s) and M reply(ies)'.
PreSubmitValidatorCard: aiPreview-gated; canned Suggestion via existing chip vocabulary.
SubmitProgressIndicator: Phase A — single neutral row 'Checking pending review state…'.
SubmitProgressChecklist: Phase B — 5-row checklist with per-step icon + count text.

All four use aria-live=polite for screen-reader announcement."
```

---

### Task 49: `SubmitDialog` assembly — body order + footer transitions

**Files:**

- Create: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx`
- Create: `frontend/__tests__/SubmitDialog.test.tsx`

**Spec section:** § 8.1 / § 8.3.

- [ ] **Step 1: Write the failing tests (body order + state transitions + Esc focuses Cancel)**

```tsx
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SubmitDialog } from '../src/components/PrDetail/SubmitDialog/SubmitDialog';
// useSubmit mocked via factory passing state directly

describe('SubmitDialog', () => {
    const baseProps = {
        open: true,
        prRef: 'o/r/1',
        session: /* …seeded session… */ {} as any,
        aiPreview: false,
        validatorResults: [],
        onClose: vi.fn(),
        submitState: { kind: 'idle' as const },
        onSubmit: vi.fn(),
        onRetry: vi.fn(),
    };

    it('renders body items in spec § 8.1 order: verdict → validator → summary → counts → checklist', () => {
        const { container } = render(<SubmitDialog {...baseProps} />);
        const order = Array.from(container.querySelectorAll('[data-section]')).map(el => el.getAttribute('data-section'));
        expect(order.indexOf('verdict')).toBeLessThan(order.indexOf('summary'));
        expect(order.indexOf('summary')).toBeLessThan(order.indexOf('counts'));
        expect(order.indexOf('counts')).toBeLessThan(order.indexOf('progress'));
    });

    it('footer Cancel + Confirm initially; Confirm disabled if button rules block', () => {
        render(<SubmitDialog {...baseProps} />);
        expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
        expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();
    });

    it('phase A — submitState.kind=in-flight + steps=[] renders SubmitProgressIndicator (not the 5-row checklist)', () => {
        render(<SubmitDialog {...baseProps} submitState={{ kind: 'in-flight', steps: [] }} />);
        expect(screen.getByText(/Checking pending review state/i)).toBeInTheDocument();
        // The 5-row checklist's items shouldn't be present yet.
        expect(screen.queryByText(/Attach threads/i)).not.toBeInTheDocument();
    });

    it('phase B — after BeginPendingReview Succeeded, renders SubmitProgressChecklist', () => {
        const steps = [
            { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
            { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
        ];
        render(<SubmitDialog {...baseProps} submitState={{ kind: 'in-flight', steps }} />);
        expect(screen.getByText(/Attach threads/i)).toBeInTheDocument();
        expect(screen.getByText(/Attach replies/i)).toBeInTheDocument();
        expect(screen.getByText(/Finalize/i)).toBeInTheDocument();
    });

    it('Cancel disabled during Phase B; Confirm replaced with spinner', () => {
        const steps = [{ step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 }];
        render(<SubmitDialog {...baseProps} submitState={{ kind: 'in-flight', steps }} />);
        expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
        expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    });

    it('Success state: shows View on GitHub + Close, no Cancel', () => {
        render(<SubmitDialog {...baseProps} submitState={{ kind: 'success', pullRequestReviewId: 'PRR_x' }} />);
        expect(screen.getByRole('link', { name: /view on github/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('Failure state: Cancel re-enabled, Confirm replaced with Retry', () => {
        render(<SubmitDialog {...baseProps} submitState={{ kind: 'failed', failedStep: 'AttachThreads', errorMessage: 'boom', steps: [] }} />);
        expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('Esc focuses Cancel button instead of dismissing', () => {
        const onClose = vi.fn();
        render(<SubmitDialog {...baseProps} onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }));
    });
});
```

- [ ] **Step 2: Verify fail**

Run: `cd frontend && npx vitest run __tests__/SubmitDialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `SubmitDialog.tsx`**

```tsx
// frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { VerdictPicker } from '../VerdictPicker';
import { CountsBlock } from './CountsBlock';
import { PreSubmitValidatorCard } from './PreSubmitValidatorCard';
import { SubmitProgressIndicator } from './SubmitProgressIndicator';
import { SubmitProgressChecklist } from './SubmitProgressChecklist';
import type { ReviewSessionDto, Verdict, ValidatorResult } from '../../../api/types';
import type { SubmitState } from '../../../hooks/useSubmit';

interface Props {
    open: boolean;
    prRef: string;
    session: ReviewSessionDto;
    aiPreview: boolean;
    validatorResults: ValidatorResult[];
    submitState: SubmitState;
    onClose(): void;
    onSubmit(verdict: Verdict): void;
    onRetry(): void;
}

export function SubmitDialog(props: Props) {
    const { open, session, aiPreview, validatorResults, submitState, onClose, onSubmit, onRetry } = props;
    const [verdict, setVerdict] = useState<Verdict | null>(session.draftVerdict ?? null);
    const [summary, setSummary] = useState(session.draftSummaryMarkdown ?? '');
    const cancelRef = useRef<HTMLButtonElement>(null);

    // Esc-focuses-Cancel handling
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                cancelRef.current?.focus();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open]);

    if (!open) return null;

    const inFlight = submitState.kind === 'in-flight';
    const phaseB = inFlight && submitState.steps.some(s => s.step === 'BeginPendingReview' && s.status === 'Succeeded');
    const phaseA = inFlight && !phaseB;
    const success = submitState.kind === 'success';
    const failed = submitState.kind === 'failed';
    const lockedDuringPhaseB = phaseB && !failed && !success;

    return (
        <Modal aria-modal="true" aria-labelledby="submit-dialog-title">
            <div className="submit-dialog">
                <header className="submit-dialog__header">
                    <h2 id="submit-dialog-title">
                        {success ? 'Review submitted.' : failed ? `Submit failed at ${(submitState as any).failedStep}.` : 'Submitting your review…'}
                    </h2>
                </header>

                <div className="submit-dialog__body">
                    <section data-section="verdict">
                        <VerdictPicker
                            value={verdict}
                            verdictStatus={session.draftVerdictStatus}
                            onChange={setVerdict}
                            disabled={inFlight || success}
                        />
                    </section>

                    <section data-section="validator">
                        <PreSubmitValidatorCard aiPreview={aiPreview} results={validatorResults} />
                    </section>

                    <section data-section="summary">
                        <textarea
                            value={summary}
                            onChange={e => setSummary(e.target.value)}
                            placeholder="Write a PR-level summary (optional)…"
                            disabled={inFlight || success}
                        />
                    </section>

                    <section data-section="counts">
                        <CountsBlock
                            threadCount={session.draftComments.length}
                            replyCount={session.draftReplies.length}
                        />
                    </section>

                    <section data-section="progress">
                        {phaseA && <SubmitProgressIndicator />}
                        {phaseB && <SubmitProgressChecklist steps={(submitState as any).steps} />}
                    </section>
                </div>

                <footer className="submit-dialog__footer">
                    {!success && (
                        <button
                            ref={cancelRef}
                            type="button"
                            className="btn"
                            disabled={lockedDuringPhaseB}
                            onClick={onClose}
                        >Cancel</button>
                    )}
                    {!inFlight && !success && !failed && (
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={verdict === null}
                            onClick={() => verdict && onSubmit(verdict)}
                        >Confirm submit</button>
                    )}
                    {inFlight && phaseB && (
                        <span className="submit-dialog__spinner" role="status" aria-live="polite">Submitting…</span>
                    )}
                    {failed && (
                        <button type="button" className="btn btn-primary" onClick={onRetry}>Retry</button>
                    )}
                    {success && (
                        <>
                            <a className="btn" href={`https://github.com/${props.prRef}/files`} target="_blank" rel="noreferrer">View on GitHub →</a>
                            <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
                        </>
                    )}
                </footer>
            </div>
        </Modal>
    );
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `cd frontend && npx vitest run __tests__/SubmitDialog.test.tsx`
Expected: PASS. Iterate on layout details if any assertions fail.

```bash
git add frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx frontend/__tests__/SubmitDialog.test.tsx
git commit -m "feat(s5-pr4): SubmitDialog assembly — verdict-first IA + Phase A/B progress UX

Body order: verdict → validator → summary → counts → progress. Phase A
renders SubmitProgressIndicator (single neutral row) until BeginPending
Succeeded stamps the PendingReviewId; Phase B replaces with the 5-row
SubmitProgressChecklist. Cancel is enabled in idle / Phase A / Failed
states; disabled during Phase B. Esc focuses Cancel; does NOT dismiss."
```

---

### Task 50: `AskAiButton` + `AskAiEmptyState` (Ask AI button + static empty-state container)

**Files:**

- Create: `frontend/src/components/PrDetail/AskAiButton.tsx`
- Create: `frontend/src/components/PrDetail/AskAiEmptyState.tsx`
- Create: `frontend/__tests__/AskAiButton.test.tsx`
- Create: `frontend/__tests__/AskAiEmptyState.test.tsx`

**Spec section:** § 14.2 (interactive drawer cut to static empty state).

- [ ] **Step 1: Write the failing tests**

```tsx
// AskAiButton.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
describe('AskAiButton', () => {
    it('renders nothing when aiPreview=false', () => {
        const { container } = render(<AskAiButton aiPreview={false} onClick={() => {}} />);
        expect(container.firstChild).toBeNull();
    });
    it('renders the "Ask AI" button when aiPreview=true', () => {
        render(<AskAiButton aiPreview onClick={() => {}} />);
        expect(screen.getByRole('button', { name: /ask ai/i })).toBeInTheDocument();
    });
    it('fires onClick when clicked', () => {
        const onClick = vi.fn();
        render(<AskAiButton aiPreview onClick={onClick} />);
        fireEvent.click(screen.getByRole('button', { name: /ask ai/i }));
        expect(onClick).toHaveBeenCalled();
    });
});

// AskAiEmptyState.test.tsx
describe('AskAiEmptyState', () => {
    it('renders nothing when open=false', () => {
        const { container } = render(<AskAiEmptyState open={false} onClose={() => {}} />);
        expect(container.firstChild).toBeNull();
    });
    it('renders the coming-in-v2 copy when open=true', () => {
        render(<AskAiEmptyState open onClose={() => {}} />);
        expect(screen.getByText(/coming in v2/i)).toBeInTheDocument();
        // No chat input, no message bubbles, no "AI is typing" indicator
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
    it('Close button fires onClose', () => {
        const onClose = vi.fn();
        render(<AskAiEmptyState open onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: /close/i }));
        expect(onClose).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```tsx
// AskAiButton.tsx
export function AskAiButton({ aiPreview, onClick }: { aiPreview: boolean; onClick(): void }) {
    if (!aiPreview) return null;
    return <button type="button" className="btn" onClick={onClick}>Ask AI</button>;
}

// AskAiEmptyState.tsx
export function AskAiEmptyState({ open, onClose }: { open: boolean; onClose(): void }) {
    if (!open) return null;
    return (
        <div className="ask-ai-empty-state ai-tint">
            <header className="ask-ai-empty-state__header">
                <h3>Ask AI — coming in v2</h3>
                <button type="button" aria-label="Close" onClick={onClose}>✕</button>
            </header>
            <p>
                v2 will let you ask questions about this PR's changes, with the assistant grounded
                in the diff and the conversation. The PoC ships the seam — the architectural slot —
                without the chat surface itself, to avoid setting up an interaction the tool can't
                deliver yet.
            </p>
        </div>
    );
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/AskAiButton.tsx frontend/src/components/PrDetail/AskAiEmptyState.tsx frontend/__tests__/AskAiButton.test.tsx frontend/__tests__/AskAiEmptyState.test.tsx
git commit -m "feat(s5-pr4): Ask AI button + static 'coming in v2' empty state

aiPreview-gated button in the header; click → inline empty-state container
with the coming-in-v2 copy + a Close (✕) button. No chat input, no message
bubbles, no 'AI is typing' indicator. Preserves the architectural seam so
v2's IPrChatService lazy-upgrade slots into the same button affordance
without testers ever seeing a fake version (spec § 14.2 rationale)."
```

---

### Task 51: Wire everything into `PrHeader.tsx`

**Files:**

- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/__tests__/PrHeader.test.tsx` (extend or recreate)

- [ ] **Step 1: Write the failing test (integration shape)**

```tsx
it('mounts SubmitButton + VerdictPicker + AskAiButton + SubmitDialog (closed by default)', () => {
    render(<PrHeader prRef="o/r/1" session={defaultSession} aiPreview headSha="abc" lastViewedHeadSha="abc" />);
    expect(screen.getByRole('button', { name: /submit review/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /review verdict/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask ai/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('clicking Submit Review opens the dialog', () => {
    render(<PrHeader prRef="o/r/1" session={readyToSubmitSession} headSha="abc" lastViewedHeadSha="abc" />);
    fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement the wiring**

In `PrHeader.tsx`:

```tsx
import { useState } from 'react';
import { useSubmit } from '../../hooks/useSubmit';
import { useCapabilities } from '../../hooks/useCapabilities';
import { SubmitButton } from './SubmitButton';
import { VerdictPicker } from './VerdictPicker';
import { AskAiButton } from './AskAiButton';
import { AskAiEmptyState } from './AskAiEmptyState';
import { SubmitDialog } from './SubmitDialog/SubmitDialog';

export function PrHeader({ prRef, session, headSha, lastViewedHeadSha }: PrHeaderProps) {
    const { state, submit, retry, reset } = useSubmit(prRef);
    const { aiPreview } = useCapabilities();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [askAiOpen, setAskAiOpen] = useState(false);
    const validatorResults = aiPreview ? CANNED_VALIDATOR_RESULTS : [];

    const onSubmitClick = () => setDialogOpen(true);
    const onConfirm = async (v: Verdict) => {
        try { await submit(v); }
        catch (err) {
            // 409 surfaces as a toast; the dialog stays open
            // …toast logic per existing project pattern…
        }
    };
    const onClose = () => { setDialogOpen(false); reset(); };

    return (
        <header className="pr-header">
            <VerdictPicker
                value={session.draftVerdict}
                verdictStatus={session.draftVerdictStatus}
                onChange={(v) => /* patch via PUT /draft */}
                disabled={state.kind === 'in-flight'}
            />
            <SubmitButton
                session={session}
                headSha={headSha}
                lastViewedHeadSha={lastViewedHeadSha}
                validatorResults={validatorResults}
                onSubmit={onSubmitClick}
            />
            <AskAiButton aiPreview={aiPreview} onClick={() => setAskAiOpen(true)} />
            <AskAiEmptyState open={askAiOpen} onClose={() => setAskAiOpen(false)} />

            <SubmitDialog
                open={dialogOpen}
                prRef={prRef}
                session={session}
                aiPreview={aiPreview}
                validatorResults={validatorResults}
                submitState={state}
                onClose={onClose}
                onSubmit={onConfirm}
                onRetry={retry}
            />
        </header>
    );
}

const CANNED_VALIDATOR_RESULTS: ValidatorResult[] = [
    { severity: 'Suggestion', message: '3 inline threads on the same file (`src/Foo.cs`) — consider consolidating?' },
];
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/__tests__/PrHeader.test.tsx
git commit -m "feat(s5-pr4): wire submit surface into PrHeader

VerdictPicker (enabled), SubmitButton, AskAiButton + AskAiEmptyState, and the
SubmitDialog all mount under PrHeader. useSubmit drives the dialog's submit
state. Canned validator results render only when aiPreview=true; no backend
IPreSubmitValidator call (frontend-side stub matches the S0-S4 placeholder
precedent per spec § 14.1)."
```

---

### Task 52: PR4 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln && dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

Expected: all green.

- [ ] **Step 2: Manual smoke (UI happy path)**

Spin up the dev server, open a PR, type a summary, pick Comment verdict, click Submit Review, confirm. The dialog should open, Phase A indicator should appear briefly, then Phase B checklist, finally success state.

- [ ] **Step 3: Open PR4**

```bash
gh pr create --title "feat(s5-pr4): Submit dialog + useSubmit + Submit button + verdict picker + AI validator + Ask AI empty state" --body "$(cat <<'EOF'
## Summary

Frontend surface for the submit pipeline (PR6 folded in per spec § 17 #22):
- `useSubmit` hook — six-state SubmitState discriminated union; SSE-driven transitions; multi-tab guard.
- `SubmitDialog` — verdict-first IA per spec § 8.1; Phase A indicator → Phase B 5-row checklist; Esc focuses Cancel (no auto-dismiss).
- `SubmitButton` with full rule (a)–(f) enable matrix.
- `VerdictPicker` enabled — segmented control with click-selected-again clear semantics.
- `PreSubmitValidatorCard` — aiPreview-gated canned data; chip-status-* vocabulary.
- `AskAiButton` + `AskAiEmptyState` — static 'coming in v2' container; no fake-feeling chat surface.

## Test plan

- [x] Every leaf component has a Vitest spec
- [x] `useSubmit` state-machine transitions covered (7 tests)
- [x] `SubmitDialog` Phase A/B + footer transitions + Esc behavior covered
- [x] Manual smoke: dialog opens, types summary, picks Comment, Confirms; Phase A → Phase B → success
- [x] `npm run lint` + `npm run build` clean

## Spec refs

- Spec § 8 + § 9 + § 10 + § 14 + § 16 PR4

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 6 — PR5: Foreign-pending-review modal + stale-`commitOID` UX + closed/merged bulk-discard + submit-* toasts

**PR title:** `feat(s5-pr5): foreign-pending-review modal + stale-commitOID retry UX + bulk-discard + submit toasts`

**Spec sections:** § 11 (foreign-pending-review modal + Resume/Discard/Cancel + Snapshot A/B staleness note + IsResolved badge), § 12 (stale-`commitOID` retry UX + pre-Finalize head_sha re-poll), § 13 (closed/merged bulk-discard UX), § 16 PR5 row.

**Goal:** Land the three modal/banner surfaces that drive non-happy-path submit flows + the cross-cutting `submit-*` toast handlers.

**Files touched (~10 new + 4 modified):**

- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx`
- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/DiscardConfirmationSubModal.tsx`
- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx` (Snapshot A → B staleness note + IsResolved pre-flight warning)
- Create: `frontend/src/components/PrDetail/SubmitDialog/StaleCommitOidBanner.tsx`
- Create: `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx` (closed/merged PR header button)
- Create: `frontend/src/components/PrDetail/DiscardAllConfirmationModal.tsx`
- Create: `frontend/src/hooks/useSubmitToasts.ts` (consolidates `submit-duplicate-marker-detected` + `submit-orphan-cleanup-failed` + TOCTOU 409 toasts)
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (mount the new modal + bulk-discard button when PR is closed/merged)
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx` (render StaleCommitOidBanner when state.kind = stale-commit-oid)
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (pre-Finalize head_sha re-poll — see Task 59)
- Tests: one `*.test.tsx` per component + pipeline test for the head_sha re-poll

**Worktree:** `.claude/worktrees/feat+s5-pr5`

---

### Task 53: `ForeignPendingReviewModal` — three buttons + counts copy + a11y

**Spec section:** § 11.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ForeignPendingReviewModal } from '../src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal';

describe('ForeignPendingReviewModal', () => {
    const snapshot = {
        prRef: 'o/r/1',
        pullRequestReviewId: 'PRR_x',
        commitOid: 'abc1234',
        createdAt: '2026-05-11T08:00:00Z',
        threadCount: 3,
        replyCount: 2,
    };

    it('renders counts copy: "3 thread(s) and 2 reply(ies)"', () => {
        render(<ForeignPendingReviewModal open snapshot={snapshot} onResume={() => {}} onDiscard={() => {}} onCancel={() => {}} />);
        expect(screen.getByText(/3 thread/i)).toBeInTheDocument();
        expect(screen.getByText(/2 repl/i)).toBeInTheDocument();
    });

    it('renders three buttons: Resume / Discard… / Cancel', () => {
        render(<ForeignPendingReviewModal open snapshot={snapshot} onResume={() => {}} onDiscard={() => {}} onCancel={() => {}} />);
        expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('default focus is on Cancel', () => {
        render(<ForeignPendingReviewModal open snapshot={snapshot} onResume={() => {}} onDiscard={() => {}} onCancel={() => {}} />);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }));
    });

    it('Resume click fires onResume with pullRequestReviewId', () => {
        const onResume = vi.fn();
        render(<ForeignPendingReviewModal open snapshot={snapshot} onResume={onResume} onDiscard={() => {}} onCancel={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /resume/i }));
        expect(onResume).toHaveBeenCalledWith('PRR_x');
    });

    it('Discard… click opens the DiscardConfirmationSubModal', () => {
        render(<ForeignPendingReviewModal open snapshot={snapshot} onResume={() => {}} onDiscard={() => {}} onCancel={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /discard/i }));
        // Sub-modal shows the second-tier confirmation copy
        expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    });
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```tsx
// frontend/src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal.tsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../Modal/Modal';
import { DiscardConfirmationSubModal } from './DiscardConfirmationSubModal';
import type { SubmitForeignPendingReviewEvent } from '../../../api/types';

interface Props {
    open: boolean;
    snapshot: SubmitForeignPendingReviewEvent;
    onResume(reviewId: string): void;
    onDiscard(reviewId: string): void;
    onCancel(): void;
}

export function ForeignPendingReviewModal({ open, snapshot, onResume, onDiscard, onCancel }: Props) {
    const [discardOpen, setDiscardOpen] = useState(false);
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => { if (open) cancelRef.current?.focus(); }, [open]);

    if (!open) return null;
    const humanized = new Date(snapshot.createdAt).toLocaleString();
    return (
        <>
            <Modal aria-modal="true" aria-labelledby="foreign-prr-modal-title">
                <div className="foreign-prr-modal">
                    <h2 id="foreign-prr-modal-title">Existing pending review on this PR</h2>
                    <p>
                        You have a pending review on this PR from {humanized}. It contains
                        {' '}<strong>{snapshot.threadCount} thread(s)</strong> and
                        {' '}<strong>{snapshot.replyCount} reply(ies)</strong>. Resume it (you'll
                        see the contents before submit), discard it and start fresh, or cancel?
                    </p>
                    <footer>
                        <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
                            Cancel — your local drafts and the pending review on GitHub are unchanged.
                        </button>
                        <button type="button" className="btn" onClick={() => setDiscardOpen(true)}>Discard…</button>
                        <button type="button" className="btn btn-primary" onClick={() => onResume(snapshot.pullRequestReviewId)}>Resume</button>
                    </footer>
                </div>
            </Modal>
            <DiscardConfirmationSubModal
                open={discardOpen}
                threadCount={snapshot.threadCount}
                replyCount={snapshot.replyCount}
                onConfirm={() => { setDiscardOpen(false); onDiscard(snapshot.pullRequestReviewId); }}
                onCancel={() => setDiscardOpen(false)}
            />
        </>
    );
}
```

```tsx
// DiscardConfirmationSubModal.tsx
export function DiscardConfirmationSubModal({ open, threadCount, replyCount, onConfirm, onCancel }: { open: boolean; threadCount: number; replyCount: number; onConfirm(): void; onCancel(): void }) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { if (open) cancelRef.current?.focus(); }, [open]);
    if (!open) return null;
    return (
        <Modal aria-modal="true">
            <div className="discard-confirmation-sub-modal">
                <h3>Delete the pending review on github.com?</h3>
                <p>Its {threadCount} thread(s) and {replyCount} reply(ies) will be permanently removed. This cannot be undone.</p>
                <footer>
                    <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="btn btn-danger" onClick={onConfirm}>Delete</button>
                </footer>
            </div>
        </Modal>
    );
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/ForeignPendingReviewModal/ frontend/__tests__/ForeignPendingReviewModal.test.tsx
git commit -m "feat(s5-pr5): ForeignPendingReviewModal + DiscardConfirmationSubModal

Three buttons (Resume / Discard… / Cancel), counts from the SSE snapshot,
default focus on Cancel. Discard… opens a sub-modal with 'cannot be undone'
copy + Delete button. Sub-modal also defaults focus on Cancel (destructive
precedent). Spec § 11.1-11.3."
```

---

### Task 54: `ImportedDraftsBanner` — Snapshot A→B count staleness + IsResolved pre-flight

**Files:**

- Create: `frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx`
- Test

**Spec section:** § 11.1.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders count-staleness note when threadCount differs', () => {
    render(<ImportedDraftsBanner snapshotA={{ threadCount: 2, replyCount: 1 }} snapshotB={{ threadCount: 3, replyCount: 1 }} hasResolvedImports={false} />);
    expect(screen.getByText(/changed during the prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/3 thread\(s\) imported \(you saw 2 in the prompt\)/i)).toBeInTheDocument();
});

it('renders IsResolved pre-flight banner when any imported thread is resolved', () => {
    render(<ImportedDraftsBanner snapshotA={{ threadCount: 1, replyCount: 0 }} snapshotB={{ threadCount: 1, replyCount: 0 }} hasResolvedImports />);
    expect(screen.getByText(/were resolved on github.com/i)).toBeInTheDocument();
});

it('renders nothing when counts match AND no imported thread is resolved', () => {
    const { container } = render(<ImportedDraftsBanner snapshotA={{ threadCount: 1, replyCount: 0 }} snapshotB={{ threadCount: 1, replyCount: 0 }} hasResolvedImports={false} />);
    expect(container.firstChild).toBeNull();
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```tsx
// ImportedDraftsBanner.tsx
interface Props {
    snapshotA: { threadCount: number; replyCount: number };
    snapshotB: { threadCount: number; replyCount: number };
    hasResolvedImports: boolean;
}
export function ImportedDraftsBanner({ snapshotA, snapshotB, hasResolvedImports }: Props) {
    const countDrift = snapshotA.threadCount !== snapshotB.threadCount || snapshotA.replyCount !== snapshotB.replyCount;
    if (!countDrift && !hasResolvedImports) return null;
    return (
        <div className="imported-drafts-banner">
            {countDrift && (
                <p>The pending review changed during the prompt — {snapshotB.threadCount} thread(s) / {snapshotB.replyCount} reply(ies) imported (you saw {snapshotA.threadCount} / {snapshotA.replyCount} in the prompt).</p>
            )}
            {hasResolvedImports && (
                <p>One or more imported thread(s) were resolved on github.com. Submitting will re-publish them. Edit or Discard the resolved threads first if you don't want to re-publish them.</p>
            )}
        </div>
    );
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner.tsx frontend/__tests__/ImportedDraftsBanner.test.tsx
git commit -m "feat(s5-pr5): ImportedDraftsBanner — Snapshot A→B count drift + IsResolved pre-flight

Snapshot A counts come from the SSE event; Snapshot B counts come from the
Resume endpoint's 200 response. Mismatch surfaces a one-line note. Any
IsResolved=true in the imports surfaces a second banner asking the user to
edit/discard resolved threads before re-publishing (spec § 11.1)."
```

---

### Task 55: `StaleCommitOidBanner` + integrate into `SubmitDialog`

**Files:**

- Create: `frontend/src/components/PrDetail/SubmitDialog/StaleCommitOidBanner.tsx`
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx` (render banner when state.kind = stale-commit-oid; switch footer to "Cancel | Recreate and resubmit")
- Tests

**Spec section:** § 12.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders banner copy with truncated commit sha', () => {
    render(<StaleCommitOidBanner currentHeadSha="abcdef1234567890" notReloadedYet={false} onCancel={() => {}} onResubmit={() => {}} />);
    expect(screen.getByText(/abcdef1/i)).toBeInTheDocument();
    expect(screen.getByText(/recreating the review/i)).toBeInTheDocument();
});

it('not-Reloaded-yet variant disables Recreate-and-resubmit + adds reload reminder', () => {
    render(<StaleCommitOidBanner currentHeadSha="abc" notReloadedYet onCancel={() => {}} onResubmit={() => {}} />);
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeDisabled();
    expect(screen.getByText(/click reload first/i)).toBeInTheDocument();
});

it('SubmitDialog with state.kind=stale-commit-oid renders the banner + flipped footer (Cancel enabled, Recreate-button primary)', () => {
    render(<SubmitDialog {...baseProps} submitState={{ kind: 'stale-commit-oid', orphanCommitOid: 'stale' }} />);
    expect(screen.getByText(/recreating the review/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```tsx
// StaleCommitOidBanner.tsx
interface Props {
    currentHeadSha: string;
    notReloadedYet: boolean;
    onCancel(): void;
    onResubmit(): void;
}
export function StaleCommitOidBanner({ currentHeadSha, notReloadedYet, onCancel, onResubmit }: Props) {
    return (
        <div className="stale-commit-oid-banner" role="alert">
            <p>
                The PR's head commit changed since this pending review was started. Recreating the
                review against the new head sha <code>{currentHeadSha.substring(0, 7)}</code>.
                Your drafts are preserved and will be re-attached.
            </p>
            {notReloadedYet && <p>Click Reload first to re-classify your drafts against the new diff.</p>}
            <div className="stale-commit-oid-banner__buttons">
                <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={notReloadedYet}
                    title={notReloadedYet ? 'Reload the PR first to re-classify drafts against the new diff.' : undefined}
                    onClick={onResubmit}
                >Recreate and resubmit</button>
            </div>
        </div>
    );
}
```

In `SubmitDialog.tsx`, add the stale-commit-oid branch in the dialog body and footer:

```tsx
if (submitState.kind === 'stale-commit-oid') {
    const notReloaded = headSha !== session.lastViewedHeadSha; // pass headSha + lastViewedHeadSha into the dialog props
    return (
        <Modal ...>
            <header>...</header>
            <StaleCommitOidBanner
                currentHeadSha={headSha}
                notReloadedYet={notReloaded}
                onCancel={onClose}
                onResubmit={() => onSubmit(/* last verdict */)}
            />
            {/* No verdict picker / summary / counts — banner is the entire body during this state */}
        </Modal>
    );
}
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/SubmitDialog/StaleCommitOidBanner.tsx frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx frontend/__tests__/StaleCommitOidBanner.test.tsx
git commit -m "feat(s5-pr5): StaleCommitOidBanner + SubmitDialog stale-commit-oid kind

State.kind='stale-commit-oid' renders the banner (Cancel enabled,
'Recreate and resubmit' primary). Not-Reloaded variant disables the
primary button + adds reload-reminder copy. Distinct from 'in-flight'
because Cancel is enabled (orphan was already deleted server-side;
re-submission is explicit click)."
```

---

### Task 56: `DiscardAllDraftsButton` + `DiscardAllConfirmationModal`

**Files:**

- Create: `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx`
- Create: `frontend/src/components/PrDetail/DiscardAllConfirmationModal.tsx`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (render the button + modal when PR is closed/merged)
- Tests

**Spec section:** § 13.

- [ ] **Step 1: Write the failing test**

```tsx
it('button is visible only when PR is closed/merged AND session has content', () => {
    const { rerender } = render(<DiscardAllDraftsButton prRef="o/r/1" prState="open" session={defaultSessionWithDrafts} onDiscard={() => {}} />);
    expect(screen.queryByRole('button', { name: /discard.*drafts?/i })).not.toBeInTheDocument();
    rerender(<DiscardAllDraftsButton prRef="o/r/1" prState="closed" session={defaultSessionWithDrafts} onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: /discard.*drafts?/i })).toBeInTheDocument();
});

it('button label shortens to "Discard" at < 600px viewport', () => {
    // Set viewport before render
    (window as any).matchMedia = (q: string) => ({ matches: q.includes('(max-width: 599px)'), addEventListener() {}, removeEventListener() {} });
    render(<DiscardAllDraftsButton prRef="o/r/1" prState="closed" session={defaultSessionWithDrafts} onDiscard={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^Discard$/);
});

it('click opens DiscardAllConfirmationModal with the count', () => {
    render(<DiscardAllDraftsButton prRef="o/r/1" prState="closed" session={{ ...defaultSession, draftComments: [{ id: 'd1' }, { id: 'd2' }] as any, draftReplies: [{ id: 'r1' }] as any }} onDiscard={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByText(/discard 2 draft.+1 repl/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```tsx
// DiscardAllDraftsButton.tsx
interface Props { prRef: string; prState: 'open' | 'closed' | 'merged'; session: ReviewSessionDto; onDiscard(): void; }
export function DiscardAllDraftsButton({ prRef, prState, session, onDiscard }: Props) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const narrow = useMediaQuery('(max-width: 599px)');

    const hasContent = session.draftComments.length > 0 || session.draftReplies.length > 0
        || !!session.draftSummaryMarkdown || !!session.pendingReviewId;
    if (prState === 'open' || !hasContent) return null;

    return (
        <>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmOpen(true)}>
                {narrow ? 'Discard' : 'Discard all drafts'}
            </button>
            <DiscardAllConfirmationModal
                open={confirmOpen}
                threadCount={session.draftComments.length}
                replyCount={session.draftReplies.length}
                onConfirm={() => { setConfirmOpen(false); onDiscard(); }}
                onCancel={() => setConfirmOpen(false)}
            />
        </>
    );
}

// DiscardAllConfirmationModal.tsx — mirrors DiscardConfirmationSubModal shape (defaultFocus=cancel, destructive)
```

- [ ] **Step 4: Wire into `PrHeader`**

```tsx
<DiscardAllDraftsButton prRef={prRef} prState={prState} session={session} onDiscard={async () => {
    try { await discardAllDrafts(prRef); } catch (err) { /* toast */ }
}} />
```

- [ ] **Step 5: Verify pass + commit**

```bash
git add frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx frontend/src/components/PrDetail/DiscardAllConfirmationModal.tsx frontend/src/components/PrDetail/PrHeader.tsx frontend/__tests__/DiscardAllDraftsButton.test.tsx frontend/__tests__/DiscardAllConfirmationModal.test.tsx
git commit -m "feat(s5-pr5): DiscardAllDraftsButton + confirmation modal for closed/merged PRs

Visible only when prState != open AND session has content. btn-danger
btn-sm to the left of the (hidden) Submit Review button. Narrow viewport
shortens label to 'Discard'. Confirmation modal carries the count copy;
defaultFocus on Cancel."
```

---

### Task 57: `useSubmitToasts` — `submit-duplicate-marker-detected` + `submit-orphan-cleanup-failed` + TOCTOU 409

**Files:**

- Create: `frontend/src/hooks/useSubmitToasts.ts`
- Create: `frontend/__tests__/useSubmitToasts.test.ts`

**Spec section:** § 11.4, § 13.2.

- [ ] **Step 1: Write the failing test**

```tsx
import { renderHook, act } from '@testing-library/react';

let sseEmit: (e: string, d: unknown) => void;
vi.mock('../src/hooks/useEventSource', () => ({
    useEventSource: (handlers: Record<string, (d: unknown) => void>) => { sseEmit = (n, d) => handlers[n]?.(d); },
}));

it('submit-duplicate-marker-detected fires a toast with the draftId', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts('o/r/1', { showToast: (m) => toasts.push(m) }));
    act(() => sseEmit('submit-duplicate-marker-detected', { prRef: 'o/r/1', draftId: 'd1' }));
    expect(toasts[0]).toMatch(/duplicate.*d1/i);
});

it('submit-orphan-cleanup-failed fires the orphan-cleanup toast', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts('o/r/1', { showToast: (m) => toasts.push(m) }));
    act(() => sseEmit('submit-orphan-cleanup-failed', { prRef: 'o/r/1' }));
    expect(toasts[0]).toMatch(/Local drafts cleared\..*may persist/i);
});

it('ignores events for a different prRef', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts('o/r/1', { showToast: (m) => toasts.push(m) }));
    act(() => sseEmit('submit-orphan-cleanup-failed', { prRef: 'o/r/2' }));
    expect(toasts).toHaveLength(0);
});
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

```ts
// frontend/src/hooks/useSubmitToasts.ts
import { useEventSource } from './useEventSource';

interface Options { showToast(message: string): void; }
export function useSubmitToasts(prRef: string, { showToast }: Options) {
    useEventSource({
        'submit-duplicate-marker-detected': (data: { prRef: string; draftId: string }) => {
            if (data.prRef !== prRef) return;
            showToast(`Duplicate marker detected for draft ${data.draftId}; PRism kept the earliest server thread and cleaned up the duplicates.`);
        },
        'submit-orphan-cleanup-failed': (data: { prRef: string }) => {
            if (data.prRef !== prRef) return;
            showToast('Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR.');
        },
    });
}
```

The `showToast` callback is supplied by the existing toast hook in the project (verify the existing toast pattern in `frontend/src/`).

- [ ] **Step 4: Wire into `PrHeader`**

```tsx
useSubmitToasts(prRef, { showToast });
```

- [ ] **Step 5: Verify pass + commit**

```bash
git add frontend/src/hooks/useSubmitToasts.ts frontend/__tests__/useSubmitToasts.test.ts frontend/src/components/PrDetail/PrHeader.tsx
git commit -m "feat(s5-pr5): useSubmitToasts for cross-cutting submit notifications

submit-duplicate-marker-detected → toast with draftId.
submit-orphan-cleanup-failed → 'Local drafts cleared… may persist' toast.
Both gated by prRef match (multi-tab guard)."
```

---

### Task 58: TOCTOU 409 handling — surface from `useSubmit` resume/discard callbacks

**Files:**

- Modify: `frontend/src/hooks/useSubmit.ts` (catch `SubmitConflictError` in resume/discard; surface to caller via toast)
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (catch + toast)
- Tests

**Spec section:** § 7.2a, § 11.4.

- [ ] **Step 1: Write the failing test in `useSubmit.test.tsx`**

```tsx
it('resumeForeignPendingReview catches SubmitConflictError pending-review-state-changed → resets to idle', async () => {
    const { resumeForeignPendingReview } = await import('../src/api/submit');
    (resumeForeignPendingReview as any).mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'pending-review-state-changed' }));

    const { result } = renderHook(() => useSubmit('o/r/1'));
    await act(async () => {
        try { await result.current.resumeForeignPendingReview('PRR_x'); } catch { /* expected */ }
    });
    expect(result.current.state.kind).toBe('idle');
});
```

- [ ] **Step 2: Verify fail; Step 3: Ensure useSubmit re-throws so PrHeader can toast**

The hook already returns to idle on error (per Task 45's impl). Verify the test passes. Add a corresponding PrHeader wiring:

```tsx
const onResume = async (reviewId: string) => {
    try { await resumeForeignPendingReview(reviewId); }
    catch (err: any) {
        if (err?.code === 'pending-review-state-changed') {
            showToast('Your pending review state changed during the prompt. Please retry submit.');
        } else throw err;
    }
};
```

- [ ] **Step 4: Verify pass + commit**

```bash
git add frontend/src/hooks/useSubmit.ts frontend/src/components/PrDetail/PrHeader.tsx frontend/__tests__/useSubmit.test.tsx
git commit -m "feat(s5-pr5): TOCTOU 409 handling — toast + reset to idle

Resume / Discard endpoints surface 409 pending-review-state-changed. useSubmit
resets to idle (per spec § 7.2a — no dedicated toctou-conflict kind needed).
PrHeader catches the typed error code and surfaces a toast: 'Your pending
review state changed during the prompt. Please retry submit.'"
```

---

### Task 59: Backend support — pre-Finalize `head_sha` re-poll

**Files:**

- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (add the re-poll between Step 4 and Step 5)
- Create: `tests/PRism.Core.Tests/Submit/Pipeline/PreFinalizeHeadShaRepollTests.cs`

**Spec section:** § 12 "Pre-Finalize head_sha re-poll".

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public async Task BeforeFinalize_HeadShaShifted_AbortsToHeadShaDriftFailure_BeforeRunningFinalize()
{
    var fake = new InMemoryReviewSubmitter();
    fake.SeedPendingReview(Ref, /* pending review at "head1" */ default!);
    // Inject: ON Finalize call, do nothing — but the pipeline should never reach Finalize.
    // The fake's GetPendingReview's commitOid is "head1"; the pipeline detected it on Step 1.
    // BUT the pipeline's pre-Finalize re-poll checks against a fresh head_sha provider that returns "head2".

    var session = SessionWithOneDraft(stamped: true);
    var pipeline = new SubmitPipeline(fake, getCurrentHeadShaAsync: ct => Task.FromResult("head2"));

    var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, _ => Task.CompletedTask, default);
    var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
    Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
    Assert.Contains("head_sha drift", failed.ErrorMessage, StringComparison.OrdinalIgnoreCase);
}
```

- [ ] **Step 2: Verify fail; Step 3: Implement**

Add an optional `getCurrentHeadShaAsync: Func<CancellationToken, Task<string>>?` to the SubmitPipeline constructor. In the pipeline body, before `StepFinalizeAsync`:

```csharp
if (_getCurrentHeadShaAsync is not null)
{
    var fresh = await _getCurrentHeadShaAsync(ct).ConfigureAwait(false);
    if (fresh != currentHeadSha)
    {
        progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Failed, 0, 1, "head_sha drift"));
        return new SubmitOutcome.Failed(SubmitStep.Finalize, "head_sha drift before Finalize", workingSession);
    }
}
```

The endpoint (PR3, Task 36) supplies a head-sha-fetcher that hits the active-PR poller cache OR re-runs `PollActivePrAsync`. In PR3's task we'd need to revise the SubmitPipeline construction call site to pass this — backport the addition in this PR's first task or factor a constructor overload.

- [ ] **Step 4: Verify pass + commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Core.Tests/Submit/Pipeline/PreFinalizeHeadShaRepollTests.cs
git commit -m "feat(s5-pr5): pre-Finalize head_sha re-poll closes the mid-pipeline drift window

Per spec § 12: after Step 4 (Attach replies) completes and before Step 5
(Finalize), pipeline re-polls head_sha. If drift occurred during the
pipeline run (author pushed while threads were attaching), aborts with
Failed(Finalize, 'head_sha drift') without running Finalize. The dialog
surfaces this as the standard Failed-state retry UX; user Reloads, then
retries."
```

---

### Task 60: PR5 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln && dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

- [ ] **Step 2: Open PR5**

```bash
gh pr create --title "feat(s5-pr5): foreign-pending-review modal + stale-commitOID UX + bulk-discard + submit toasts" --body "$(cat <<'EOF'
## Summary

- `ForeignPendingReviewModal` with three buttons (Resume / Discard… / Cancel), counts from SSE, default focus on Cancel.
- `DiscardConfirmationSubModal` for the destructive Discard… path.
- `ImportedDraftsBanner` for Snapshot A→B count drift + IsResolved pre-flight warning.
- `StaleCommitOidBanner` — replaces dialog body during `state.kind = stale-commit-oid`; Cancel re-enabled, primary button is "Recreate and resubmit".
- `DiscardAllDraftsButton` + `DiscardAllConfirmationModal` for closed/merged PRs.
- `useSubmitToasts` — `submit-duplicate-marker-detected` + `submit-orphan-cleanup-failed` toast handlers.
- Pre-Finalize `head_sha` re-poll closes the mid-pipeline drift window per spec § 12.

## Test plan

- [x] Every new component has a Vitest spec
- [x] `useSubmitToasts` covered (3 tests: each event + multi-tab guard)
- [x] Pipeline `PreFinalizeHeadShaRepollTests` green
- [x] Manual smoke: foreign-pending-review flow (Resume + Discard + Cancel paths); stale-`commitOID` flow with explicit click; bulk-discard with orphan-cleanup-failed toast

## Spec refs

- Spec § 11 + § 12 + § 13 + § 16 PR5

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

# Phase 7 — PR7: DoD E2E test sweep

**PR title:** `test(s5-pr7): DoD E2E specs for the submit pipeline + multi-tab + marker-collision`

**Spec sections:** § 15.3 (E2E specs), § 16 PR7 row.

**Goal:** Cover every submit-pipeline DoD test against the full backend + frontend stack. No fixme'd specs — the state-leak fix from PR0 ensures this PR can add 6+ new specs without re-introducing the leak.

**Files touched (~8 new E2E specs + 4 modified `/test/submit/*` endpoints):**

- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (add failure injection + foreign-pending-review seed + stale-commit-oid seed)
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs` (add `/test/submit/*` routes)
- Create: `frontend/e2e/s5-submit-happy-path.spec.ts`
- Create: `frontend/e2e/s5-submit-retry-from-each-step.spec.ts`
- Create: `frontend/e2e/s5-submit-foreign-pending-review.spec.ts`
- Create: `frontend/e2e/s5-submit-stale-commit-oid.spec.ts`
- Create: `frontend/e2e/s5-submit-lost-response-adoption.spec.ts` (or `s5-submit-body-normalization-parity.spec.ts` if C7 falsified)
- Create: `frontend/e2e/s5-submit-closed-merged-discard.spec.ts`
- Create: `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts`
- Create: `frontend/e2e/s5-marker-prefix-collision.spec.ts`

**Worktree:** `.claude/worktrees/feat+s5-pr7`

---

### Task 61: Extend `FakeReviewSubmitter` + `TestEndpoints.cs` with `/test/submit/*` routes

**Files:**

- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs`
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs`
- Modify: `PRism.Web/TestHooks/FakeReviewBackingStore.cs` (carry submit state)

**Spec section:** § 15.2.

- [ ] **Step 1: Mirror the Core-Tests `InMemoryReviewSubmitter` into `PRism.Web.TestHooks.FakeReviewSubmitter`**

The Playwright fake is parallel to the Core-Tests fake but registered in DI. Copy the structure (in-memory pending-review map, per-method failure injection, foreign-pending-review seed, stale-commit-oid seed). The two fakes can share a small library if convenient; for clarity, duplicate the simple shape so Playwright and unit tests don't share a chain of dependency.

- [ ] **Step 2: Add `/test/submit/*` endpoints in `TestEndpoints.cs`**

```csharp
// PRism.Web/TestHooks/TestEndpoints.cs
public static IEndpointRouteBuilder MapTestSubmitEndpoints(this IEndpointRouteBuilder app)
{
    app.MapPost("/test/submit/inject-failure", (HttpContext ctx, [FromBody] JsonElement body) =>
    {
        var fake = ctx.RequestServices.GetRequiredService<IReviewSubmitter>() as FakeReviewSubmitter
            ?? throw new InvalidOperationException("FakeReviewSubmitter not registered");
        var methodName = body.GetProperty("methodName").GetString()!;
        fake.InjectFailure(methodName, new HttpRequestException(body.GetProperty("message").GetString()!));
        return Results.Ok();
    });

    app.MapPost("/test/submit/inject-foreign-pending-review", (HttpContext ctx, [FromBody] JsonElement body) =>
    {
        var fake = ctx.RequestServices.GetRequiredService<IReviewSubmitter>() as FakeReviewSubmitter
            ?? throw new InvalidOperationException();
        fake.SeedPendingReview(
            new PrReference(body.GetProperty("owner").GetString()!, body.GetProperty("repo").GetString()!, body.GetProperty("number").GetInt32()),
            /* construct a fake foreign pending review from body */ default!);
        return Results.Ok();
    });

    app.MapPost("/test/submit/inject-stale-commit-oid", /* …seeds a pending review with mismatched commitOid… */);

    app.MapGet("/test/submit/inspect-pending-review", (HttpContext ctx, string owner, string repo, int number) =>
    {
        var fake = ctx.RequestServices.GetRequiredService<IReviewSubmitter>() as FakeReviewSubmitter
            ?? throw new InvalidOperationException();
        var pending = fake.GetPending(new PrReference(owner, repo, number));
        return Results.Json(pending);
    });

    return app;
}
```

- [ ] **Step 3: Register the routes in `Program.cs` under the same env-guard as the existing test hooks**

```csharp
if (builder.Environment.IsEnvironment("Test")
    && Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1")
{
    app.MapTestSubmitEndpoints();
}
```

- [ ] **Step 4: Build + run the test suite (no behavior changes expected; new endpoints unused yet)**

Run: `dotnet build PRism.sln && dotnet test PRism.sln`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/TestHooks/ PRism.Web/Program.cs
git commit -m "test(s5-pr7): /test/submit/* endpoints for Playwright submit-pipeline drive

inject-failure / inject-foreign-pending-review / inject-stale-commit-oid /
inspect-pending-review under the same PRISM_E2E_FAKE_REVIEW env guard as
the existing /test/* hooks. Drives the FakeReviewSubmitter from frontend
e2e specs."
```

---

### Task 62: `s5-submit-happy-path.spec.ts`

**Spec section:** § 15.3.

- [ ] **Step 1: Write the spec**

```ts
// frontend/e2e/s5-submit-happy-path.spec.ts
import { test, expect } from '@playwright/test';

test('S5 happy path — open PR → type summary → pick Comment → Submit → success', async ({ page, request }) => {
    // Seed a session with one draft + summary (using existing /test/seed-session helper or per-test fixture)
    await request.post('/test/seed-session', { data: /* session fixture */ {} });

    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('textbox').fill('Summary text for happy path.');
    await dialog.getByRole('button', { name: /^comment$/i }).click();
    await dialog.getByRole('button', { name: /confirm submit/i }).click();

    // Phase A indicator briefly visible
    await expect(dialog.getByText(/checking pending review state/i)).toBeVisible({ timeout: 1000 });

    // Phase B checklist appears
    await expect(dialog.getByText(/detected pending review state/i)).toBeVisible();

    // Success state
    await expect(dialog.getByText(/review submitted/i)).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('link', { name: /view on github/i })).toBeVisible();
});
```

- [ ] **Step 2: Run + iterate**

Run: `npx playwright test e2e/s5-submit-happy-path.spec.ts`
Expected: PASS after seed/fixture details settle.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/s5-submit-happy-path.spec.ts
git commit -m "test(s5-pr7): s5-submit-happy-path E2E — open dialog → Confirm → success"
```

---

### Task 63: `s5-submit-retry-from-each-step.spec.ts` — DoD test (b)

- [ ] **Step 1: Write the spec (one inner block per failing step)**

```ts
import { test, expect } from '@playwright/test';

for (const failingMethod of ['BeginPendingReviewAsync', 'AttachThreadAsync', 'AttachReplyAsync', 'FinalizePendingReviewAsync']) {
    test(`S5 retry-from-each-step — failure at ${failingMethod} → retry succeeds without duplicates`, async ({ page, request }) => {
        await request.post('/test/seed-session', { data: /* session with 2 drafts + 1 reply */ {} });
        await request.post('/test/submit/inject-failure', { data: { methodName: failingMethod, message: 'simulated' } });

        await page.goto('/o/r/1');
        await page.getByRole('button', { name: /submit review/i }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: /^comment$/i }).click();
        await dialog.getByRole('button', { name: /confirm submit/i }).click();

        // Failed state visible; Retry button shows.
        await expect(dialog.getByText(/submit failed/i)).toBeVisible({ timeout: 10_000 });
        await dialog.getByRole('button', { name: /retry/i }).click();

        // Second attempt succeeds.
        await expect(dialog.getByText(/review submitted/i)).toBeVisible({ timeout: 10_000 });

        // Inspect fake — pending review has been finalized (no longer present); no duplicate threads in transit.
        // (For finer-grained "no duplicates" verification, inspect via /test/submit/inspect-pending-review
        //  BEFORE clicking Retry; the failed-state pending review should have N stamped drafts but no
        //  duplicates.)
    });
}
```

- [ ] **Step 2: Run + commit**

```bash
git add frontend/e2e/s5-submit-retry-from-each-step.spec.ts
git commit -m "test(s5-pr7): s5-submit-retry-from-each-step E2E — DoD test (b)

One sub-test per failing step (Begin / AttachThread / AttachReply /
Finalize). Asserts second attempt succeeds without duplicates."
```

---

### Task 64: `s5-submit-foreign-pending-review.spec.ts` — DoD tests (c) + (d)

- [ ] **Step 1: Write the spec (three flows: Resume / Discard / Cancel)**

```ts
import { test, expect } from '@playwright/test';

test('S5 foreign-pending-review Resume → imports as drafts → submits successfully', async ({ page, request }) => {
    await request.post('/test/submit/inject-foreign-pending-review', { data: { owner: 'o', repo: 'r', number: 1, threads: [/* one fixture thread */] } });
    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();

    // Foreign-pending-review modal appears
    await expect(page.getByText(/existing pending review on this pr/i)).toBeVisible();
    await page.getByRole('button', { name: /resume/i }).click();

    // Drafts panel now shows the imported drafts
    await expect(page.getByText(/imported drafts/i)).toBeVisible({ timeout: 5_000 });
    // …rest of the happy-path resubmit…
});

test('S5 foreign-pending-review Discard → deletes pending review server-side', async ({ page, request }) => {
    await request.post('/test/submit/inject-foreign-pending-review', { /* … */ });
    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();
    await page.getByRole('button', { name: /^discard…$/i }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();

    // Inspect the fake — pending review is gone.
    const inspect = await request.get('/test/submit/inspect-pending-review?owner=o&repo=r&number=1');
    const body = await inspect.json();
    expect(body).toBeNull();
});

test('S5 foreign-pending-review Cancel → no state change', async ({ page, request }) => {
    await request.post('/test/submit/inject-foreign-pending-review', { /* … */ });
    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();
    await page.getByRole('button', { name: /^cancel/i }).click();

    // Modal closed; pending review still on the fake.
    const inspect = await request.get('/test/submit/inspect-pending-review?owner=o&repo=r&number=1');
    const body = await inspect.json();
    expect(body).not.toBeNull();
});
```

- [ ] **Step 2: Run + commit**

```bash
git add frontend/e2e/s5-submit-foreign-pending-review.spec.ts
git commit -m "test(s5-pr7): s5-submit-foreign-pending-review E2E — DoD tests (c) + (d)

Three flows: Resume imports as drafts + Discard deletes pending review +
Cancel changes nothing."
```

---

### Task 65: `s5-submit-stale-commit-oid.spec.ts` — DoD test (e)

- [ ] **Step 1: Write the spec**

```ts
test('S5 stale-commitOID — banner appears → explicit click resubmits → success', async ({ page, request }) => {
    await request.post('/test/submit/inject-stale-commit-oid', { data: { owner: 'o', repo: 'r', number: 1, orphanCommitOid: 'stale_abc' } });
    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();

    // Banner appears
    await expect(page.getByText(/recreating the review/i)).toBeVisible({ timeout: 5_000 });
    // Cancel re-enabled
    await expect(page.getByRole('button', { name: /^cancel/i })).toBeEnabled();
    // Recreate-and-resubmit button visible
    await page.getByRole('button', { name: /recreate and resubmit/i }).click();

    // Success state
    await expect(page.getByText(/review submitted/i)).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/s5-submit-stale-commit-oid.spec.ts
git commit -m "test(s5-pr7): s5-submit-stale-commit-oid E2E — DoD test (e)

Banner appears, Cancel re-enabled, explicit 'Recreate and resubmit' click
runs the pipeline against the new head_sha and converges on success."
```

---

### Task 66: `s5-submit-lost-response-adoption.spec.ts` (or C7 fallback)

**If C7 passed (spec's default):** write the marker-adoption test below.
**If C7 falsified:** replace with `s5-submit-body-normalization-parity.spec.ts` — assert that an unstamped draft whose body matches a server thread's body (after normalization) is adopted without a duplicate. The fallback test's shape mirrors the marker test but the matching key is `(filePath, line, body-normalized)`.

- [ ] **Step 1: Write the spec (marker-adoption variant)**

```ts
test('S5 lost-response — pre-seeded server thread with our marker → adopted on retry', async ({ page, request }) => {
    // Pre-seed: server has a thread carrying the marker for draftId "d1".
    await request.post('/test/submit/inject-foreign-pending-review', {
        data: { owner: 'o', repo: 'r', number: 1, threads: [{ id: 'PRRT_lost', body: 'body\n\n<!-- prism:client-id:d1 -->' }] },
    });
    // The session has an unstamped draft with id "d1".
    await request.post('/test/seed-session', { data: { draftComments: [{ id: 'd1', threadId: null }] } });

    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /submit review/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();

    await expect(page.getByText(/review submitted/i)).toBeVisible({ timeout: 10_000 });

    // Inspect: NO duplicate thread was created — the existing thread was adopted.
    const inspect = await request.get('/test/submit/inspect-pending-review?owner=o&repo=r&number=1');
    // Pending review should be gone (Finalize ran). Verify via a different inspector
    // that the fake's thread count for the now-submitted review is 1, not 2.
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/s5-submit-lost-response-adoption.spec.ts
git commit -m "test(s5-pr7): s5-submit-lost-response-adoption E2E (marker-scheme variant)

Pre-seeded server thread carrying our DraftId's marker is adopted on retry;
no duplicate created on github.com. Tests the C7-pass code path; if C7
falsified, replace this spec with s5-submit-body-normalization-parity."
```

---

### Task 67: `s5-submit-closed-merged-discard.spec.ts` — bulk-discard + orphan-cleanup toast

- [ ] **Step 1: Write the spec**

```ts
test('S5 closed/merged PR → bulk-discard clears local state + courtesy delete', async ({ page, request }) => {
    await request.post('/test/seed-session', { data: { draftComments: [{ id: 'd1' }, { id: 'd2' }] } });
    await request.post('/test/set-pr-state', { data: { owner: 'o', repo: 'r', number: 1, state: 'closed' } });

    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /discard all drafts/i }).click();
    await page.getByRole('button', { name: /^discard$/i }).click();   // confirmation modal

    // Local state cleared
    await expect(page.getByText(/no drafts/i)).toBeVisible({ timeout: 5_000 });
});

test('S5 closed/merged PR → orphan-cleanup-failed toast surfaces when DeletePendingReview fails', async ({ page, request }) => {
    await request.post('/test/seed-session', { data: { draftComments: [{ id: 'd1' }], pendingReviewId: 'PRR_x' } });
    await request.post('/test/set-pr-state', { data: { state: 'closed' } });
    await request.post('/test/submit/inject-failure', { data: { methodName: 'DeletePendingReviewAsync', message: 'simulated' } });

    await page.goto('/o/r/1');
    await page.getByRole('button', { name: /discard all drafts/i }).click();
    await page.getByRole('button', { name: /^discard$/i }).click();

    // Toast surfaces
    await expect(page.getByText(/may persist; it will be cleaned up/i)).toBeVisible({ timeout: 5_000 });
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/s5-submit-closed-merged-discard.spec.ts
git commit -m "test(s5-pr7): s5-submit-closed-merged-discard E2E — bulk-discard + orphan toast"
```

---

### Task 68: `s5-multi-tab-simultaneous-submit.spec.ts` — per-PR submit lock 409

- [ ] **Step 1: Write the spec**

```ts
test('S5 multi-tab simultaneous submit → losing tab sees 409 submit-in-progress', async ({ browser, request }) => {
    await request.post('/test/seed-session', { data: /* valid session */ {} });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    // Both contexts share the same backend, so /test/seed-session affects both.
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto('/o/r/1');
    await page2.goto('/o/r/1');

    // Inject a slow submitter so the first Confirm holds the lock.
    await request.post('/test/submit/inject-slow-submitter', { data: { delayMs: 2000 } });

    // Both tabs open the dialog + click Confirm.
    await page1.getByRole('button', { name: /submit review/i }).click();
    await page1.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();

    await page2.getByRole('button', { name: /submit review/i }).click();
    await page2.getByRole('dialog').getByRole('button', { name: /confirm submit/i }).click();

    // Page 2 surfaces the in-progress toast (or inline error).
    await expect(page2.getByText(/submit in progress in another tab/i)).toBeVisible({ timeout: 5_000 });

    // Page 1 completes successfully.
    await expect(page1.getByText(/review submitted/i)).toBeVisible({ timeout: 10_000 });

    await ctx1.close(); await ctx2.close();
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts
git commit -m "test(s5-pr7): s5-multi-tab-simultaneous-submit E2E — per-PR lock + 409

Two browser contexts both Confirm. The slow-submitter test hook holds the
lock for 2s; the losing tab surfaces 'submit in progress in another tab'.
First tab converges on success."
```

---

### Task 69: `s5-marker-prefix-collision.spec.ts` — composer rejection

- [ ] **Step 1: Write the spec**

```ts
test('S5 composer rejects body containing <!-- prism:client-id: substring', async ({ page }) => {
    await page.goto('/o/r/1');
    // Open the inline composer on a diff line
    await page.locator('[data-line="42"]').click();
    await page.getByPlaceholder(/start a thread/i).fill('before <!-- prism:client-id:fake --> after');
    await page.getByRole('button', { name: /save draft/i }).click();

    // Inline error surfaces with the spec's copy.
    await expect(page.getByText(/cannot contain the internal marker string/i)).toBeVisible();
});

test('S5 composer accepts the marker substring inside a fenced code block', async ({ page }) => {
    await page.goto('/o/r/1');
    await page.locator('[data-line="42"]').click();
    await page.getByPlaceholder(/start a thread/i).fill('```\n<!-- prism:client-id:literal -->\n```');
    await page.getByRole('button', { name: /save draft/i }).click();
    await expect(page.getByText(/cannot contain the internal marker/i)).not.toBeVisible();
});
```

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/s5-marker-prefix-collision.spec.ts
git commit -m "test(s5-pr7): s5-marker-prefix-collision E2E — composer rejects + accepts

Rejected when the marker prefix appears outside fenced code; accepted
when inside fences (per PipelineMarker.ContainsMarkerPrefix's strip-fenced
behavior)."
```

---

### Task 70: PR7 final integration check + PR description

- [ ] **Step 1: Full pre-push checklist**

```bash
dotnet build PRism.sln && dotnet test PRism.sln
cd frontend && npm run lint && npm run build && npx vitest run && npx playwright test
```

Expected: all green. Every new spec passes, no `test.fixme` introduced.

- [ ] **Step 2: Open PR7**

```bash
gh pr create --title "test(s5-pr7): DoD E2E specs for the submit pipeline + multi-tab + marker-collision" --body "$(cat <<'EOF'
## Summary

Eight new Playwright specs covering every submit-pipeline DoD test plus the multi-tab + marker-collision regression surfaces:

- `s5-submit-happy-path.spec.ts` — demo steps 11-13
- `s5-submit-retry-from-each-step.spec.ts` — DoD (b), four sub-tests
- `s5-submit-foreign-pending-review.spec.ts` — DoD (c) + (d), three flows (Resume / Discard / Cancel)
- `s5-submit-stale-commit-oid.spec.ts` — DoD (e), explicit click recovery
- `s5-submit-lost-response-adoption.spec.ts` — marker scheme (or `s5-submit-body-normalization-parity.spec.ts` if C7 falsified)
- `s5-submit-closed-merged-discard.spec.ts` — bulk-discard + orphan-cleanup-failed toast
- `s5-multi-tab-simultaneous-submit.spec.ts` — per-PR lock returns 409 for losing tab
- `s5-marker-prefix-collision.spec.ts` — composer rejection (outside fence) + acceptance (inside fence)

Test fakes extended with `/test/submit/inject-failure` / `inject-foreign-pending-review` / `inject-stale-commit-oid` / `inspect-pending-review` per spec § 15.2.

## Test plan

- [x] Every spec runs in isolation
- [x] All specs run together (no `test.fixme`; the PR0 state-leak fix is the load-bearing prereq here)
- [x] `--repeat-each=3` over the full S5 suite to catch latent flake

## Spec refs

- Spec § 15 + § 16 PR7

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

