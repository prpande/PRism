---
date: 2026-05-11
topic: s5-submit-pipeline
---

# S5 — Submit pipeline (design)

**Slice.** S5 in [`../roadmap.md`](../roadmap.md). Highest-risk, highest-test-coverage slice of the PoC. When S5 ships, [`../spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § "The PoC demo" passes end-to-end (steps 1–13) and the unchecked submit-dependent DoD checkboxes close.

**Brainstorm output of:** `ce-brainstorm` session 2026-05-11 with the user. The handoff input enumerating dangling threads from S0–S4 (architectural-readiness items gated to S5, pre-existing deferrals, verification gates) was a conversational input — its content is folded into the relevant sections of this spec and the deferrals sidecar (§ 19), so no separate handoff file is preserved.

**Implementation cycle.** This document is the design (spec). The implementation plan is at [`../plans/2026-05-11-s5-submit-pipeline.md`](../plans/2026-05-11-s5-submit-pipeline.md); implementation starts after this spec passes human review *and* the C6 / C7 empirical gates (§ 2) clear.

**Reference axes.** Spec refs use `spec/0X-name.md § N`. Roadmap refs use `roadmap.md`. ADR refs use `specs/2026-05-06-architectural-readiness-design.md § ADR-S5-N`. S4 refs use `specs/2026-05-09-s4-drafts-and-composer-design.md § N`.

---

## Summary

S5 lands the resumable GraphQL pending-review submit pipeline behind a new stepwise `IReviewSubmitter` capability seam, surfaces step-by-step progress to the user via the existing SSE channel, and lights up the verdict picker, the submit confirmation dialog, the AI validator placeholder card, and the Ask AI button (which surfaces a static "coming in v2" empty state — the originally-planned interactive drawer is cut per § 14.2). Lost-response idempotency anchors on a server-stamped thread / comment ID per draft, with an HTML-comment client-ID marker as the one-shot adoption key on retry.

---

## Problem Frame

After S4, drafts persist locally, classification fires on Reload, and the verdict picker exists but is disabled. The Submit Review button stays disabled regardless of state. The PoC's wedge claim — *reviewer-atomic submit* — is unfulfilled: a user can compose a complete review locally, but cannot publish it to github.com without leaving the tool. Every other DoD-mandated test that depends on submit (retry-from-each-step, foreign-pending-review prompt, stale-`commitOID` recreate, lost-response marker, closed/merged-then-reopen drafts) is also blocked. S5 closes that gap.

The risk shape is asymmetric: most failures here are silently-wrong rather than loudly-broken. A retry that produces duplicate threads on github.com is silent reviewer-text loss; a foreign pending review adopted without prompt is silent submission of forgotten content; a stale-`commitOID` finalize is approving code the reviewer hasn't seen. The pipeline is built around explicit user adjudication and server-issued idempotency keys precisely because the failure modes don't announce themselves.

---

## 1. Goals & non-goals

### 1.1 Goals

The slice ships the demo: *steps 11–13 of the PoC demo end-to-end on a real github.com PR, with retry semantics that converge under every failure mode the DoD enumerates*. Concretely:

1. **Architectural prerequisites** (PR0, lands first):
   - **ADR-S5-1**: split `IReviewService` (10 methods) into `IReviewAuth` / `IPrDiscovery` / `IPrReader` / `IReviewSubmitter`. Pure refactor; tests against fakes split alongside the interfaces.
   - **Empirical gate runs**: C6 (`AddPullRequestReviewThreadInput` parameter shape) and C7 (HTML-comment marker round-trip durability) — see § 2.
   - **Playwright multi-spec state-leak fix** — root-cause, not another `test.fixme`. See § 2.3.

2. **`IReviewSubmitter` capability seam** (PR1): seven methods covering pending-review begin / attach / reply-attach / finalize / delete-review / delete-thread / find-own. `GitHubReviewService.Submit.cs` implements against real GraphQL. See § 4.

3. **`SubmitPipeline` state machine** (PR2): resumable, step-granular, idempotency-key-based retry. Lives in `PRism.Core/Submit/Pipeline/` per Convention-1. Tests against an `IReviewSubmitter` fake at step granularity. See § 5.

4. **Schema migration v3 → v4** (PR1 or PR2): `DraftComment.ThreadId: string?` additive field. Empty-body migration step; the version bump is the visibility, not the data transform. See § 6.

5. **Backend endpoints** (PR3): `POST /api/pr/{ref}/submit`, `GET /api/pr/{ref}/pending-review-snapshot`, new `submit-progress` SSE event. See § 7.

6. **Submit dialog** (PR4): textarea + live preview + counts + verdict picker + validator section + Confirm/Cancel; `useSubmit` hook; Submit Review button enable-rule logic per spec § 6 rules (a)–(f). See § 8 / § 9.

7. **Verdict picker** (PR4): enabled state — segmented control, three options, mirrored between header and dialog. See § 10.

8. **Foreign-pending-review modal + stale-`commitOID` retry UX + closed/merged bulk-discard** (PR5). See § 11 / § 12 / § 13.

9. **AI placeholder slot** (PR6 — folded into PR4 if scope permits): pre-submit validator card (frontend-side stub data, matching S0–S4 precedent). The originally-planned Ask AI drawer is cut to a static "coming in v2" empty state to avoid the interactive-feeling-but-dead chat surface that would mislead the N=3 validation cohort — see § 14 and § 17 #16.

10. **DoD test sweep** (PR7): every submit-pipeline test the DoD enumerates, plus the closed/merged tests, plus the C7 fallback if the empirical gate falsifies. See § 15.

### 1.2 Non-goals (deferred)

| Item | Defer to | Why |
|---|---|---|
| Real `IPreSubmitValidator` AI implementation | v2 (P0+) | PoC: `NoopPreSubmitValidator` registered; placeholder is frontend-side stub. |
| Real `IPrChatService` chat backend | v2 (P2-2) | PoC: Ask AI button surfaces a static "coming in v2" empty state; no backend touchpoint. |
| Interactive Ask AI drawer with pre-baked conversation seed | v2 (P2-2) | Originally scoped for S5 PR6; cut after doc-review surfaced the validation-cohort risk that an interactive-looking-but-dead chat surface would land as "tool feels half-done" in the N=3 trial. The button + empty-state container preserves the seam structurally. |
| Lazy-upgrade machinery for chat sessions | v2 (P2-2) | Forcing lazy-upgrade into PoC scope would inflate S5 by weeks. |
| `IPrDetailLoader.GetFiles()` rename/delete map wiring | S6 polish or standalone PR | Originally proposed as part of S5 PR1 in an earlier draft; doc-review surfaced that the existing reconciliation matrix already produces `Stale` for unmapped renames and deletions, so the wiring is an accuracy improvement (re-anchoring renamed-file drafts as `Moved` instead of `Stale`) rather than a submit-pipeline correctness requirement. Closes S4 deferral 7 when it lands. |
| File-viewed graph-walk semantics (S3 deferral 4) | S6 polish | Parallel to submit; own DTO + frontend compute surface. Not on the demo or DoD critical path. |
| Shiki syntax highlighting in DiffPane (S3 PR8 deferral) | S6 polish | Visual-only polish; no submit-pipeline coupling. |
| Multi-line / range comments (S4 deferral) | Post-S5 standalone OR P4 backlog | Reconciliation matrix doubles in dimensionality; expanding before single-line is dogfooded is premature. |
| Multi-account / multi-host scaffold | S6 PR0 (separately spec'd) | Storage-only variant; tracked under [`2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md). |
| `markAllRead` authorization tightening (S4 deferral 6) | Later cleanup | S5's submit endpoint adopts the same broader-than-spec pattern; tightening both endpoints together. |
| `IActivePrCache.HighestIssueCommentId` plumbing (S4 deferral 4) | Indefinite | Submit head-shift gate (rule f) compares `head_sha` only; no per-issue-comment id needed. |
| Discard-failure consolidated toast / inline-error system (S4 deferral 8) | S6 polish | S5 uses a one-time toast (consistent with the existing best-effort wording); consolidated system inherits cheaper later. |
| File-fetch concurrency cap (S4 deferral 9) | Indefinite | Submit fan-out is sequential by design. Reload-time cap stays deferred until dogfooding shows >5s reload on 50-draft PRs. |
| Generic merger walker for `useDraftSession` arrays (S4 deferral 10) | Until needed | S5 doesn't add a third user-edited array. |
| Dangling-reply detection (parent thread deleted after successful reply submit) | Accepted edge | Spec § 6 marks this an acceptable failure mode; surface deferred to a future P4 polish item. |
| ADR-S5-2 partial-class split of `GitHubReviewService` | Mid-S5 (optional) | Not load-bearing; do it during PR1 if `GitHubReviewService.cs` becomes unwieldy. |

---

## 2. Pre-implementation verification gates

These gates run as the **first PR0 work items**, before any submit-pipeline code lands. The spec ships against the *expected* outcome of each; the fallback is documented for the implementer if the gate falsifies.

### 2.1 C6 — `AddPullRequestReviewThreadInput` parameter shape

**Status.** Pending (per [`../spec/00-verification-notes.md § C6`](../spec/00-verification-notes.md#c6)). ~2-minute curl.

**Test.** Run `gh api graphql -f query='{ __type(name: "AddPullRequestReviewThreadInput") { inputFields { name description isDeprecated } } }'`. Confirm `pullRequestReviewId` is a current field (not removed; `isDeprecated: false` preferred but `isDeprecated: true` with no replacement also OK as long as the field still functions).

**Spec ships against.** `pullRequestReviewId` (matches spec § 6 step 2 wording).

**Fallback.** If `pullRequestReviewId` has been removed in favor of `pullRequestId` (pending-review implicit), update § 4's `AttachThreadAsync` signature to take `pullRequestId` instead, and update § 5 step 2 wording accordingly. Document the schema-drift in [`../spec/00-verification-notes.md § C6`](../spec/00-verification-notes.md#c6) status update.

### 2.2 C7 — HTML-comment marker durability

**Status.** Pending (per [`../spec/00-verification-notes.md § C7`](../spec/00-verification-notes.md#c7)). ~few hours with a test PR on a sandbox repo.

**Test.** Submit three threads via `addPullRequestReviewThread` against a pending review on a sandbox PR, with these body shapes:

1. Marker as the only content: `<!-- prism:client-id:c7-test-1 -->`
2. Marker as a footer after a normal user body: `Some review comment.\n\n<!-- prism:client-id:c7-test-2 -->`
3. Marker after a fenced code block, marker outside the fence: <code>```ts\nconst x = 1;\n```\n\n&lt;!-- prism:client-id:c7-test-3 --&gt;</code>

For each, query the pending review's threads (`pullRequest.reviews(states: PENDING).first(1).threads`) and check that the returned `body` field contains the literal marker substring.

**Spec ships against.** All three marker substrings preserved verbatim. The marker scheme stands as written; § 4 and § 5 reference it as the canonical lost-response idempotency key.

**Fallback.** If the marker is stripped in any case where it shouldn't be, fall back to **option (a) client-side body normalization parity**: the matcher compares `(filePath, line, body)` after applying the same normalization steps GitHub applies (line-ending → `\n`, NFC Unicode, trim trailing whitespace, decode HTML entities). The matcher implementation lands in `PRism.Core/Submit/Pipeline/` alongside `SubmitPipeline.cs`.

**Caveat — fallback is not a wording change.** Marker scheme: each draft has a globally-unique `DraftId`; marker match is 1:1 even when two drafts have identical `(filePath, line, body)`. Parity matcher: the match key has no per-draft uniqueness, so two unstamped drafts with identical target line + body match the same server thread (possible if the user duplicated a comment, or Reload moved one draft to the same line as another). The fallback must add a tiebreaker before adopting — recommend createdAt order with first-match-wins plus a pre-submit dedupe step that surfaces a warning if two unstamped drafts collide on the parity key. The duplicate-thread defense from § 5.2 step 3's multi-match handling still applies. Estimated additional cost if C7 falsifies: ~1 day for the parity matcher, the tiebreaker, the dedupe-warn step, and tests. Update § 5.2 step 3 wording, and PR7's DoD test sweep replaces the marker-durability test with a parity-matcher-with-dedupe test.

### 2.3a C9 — `submitPullRequestReview` accepts a Comment-verdict review with no attached threads

**Status.** Pending. ~30 minutes with a sandbox PR.

**Test.** Create a pending review on a sandbox PR via `addPullRequestReview` (no event). Do NOT call `addPullRequestReviewThread` (zero threads attached). Call `submitPullRequestReview` with `event: COMMENT`. Confirm the call succeeds and a Comment-verdict review with body-only appears on github.com.

**Why this is gated.** Spec § 5.2 step 5 ("Empty-pipeline finalize") and Submit Review button rule (e) jointly enable a path where verdict = Comment + non-empty summary + zero drafts/replies submits successfully. GitHub's documented constraint historically required at least one comment on a Comment-verdict review. If the constraint still applies, the empty-pipeline path 422s, leaving an orphan pending review and a stuck-state UX (rule (e) blocks retry; the user has no path forward without the closed/merged bulk-discard).

**Spec ships against.** GraphQL accepts the Comment-only-with-body finalize.

**Fallback.** If GraphQL rejects the empty-threads finalize, two options:
- (a) `BeginPendingReviewAsync` injects the summary as a `threads[]` argument so the review carries content from the start (one synthetic thread tied to the summary; rendered alongside the verdict). Spec § 4 / § 5.2 step 2 add a "summary-only path uses synthetic-thread variant" branch.
- (b) The summary-only path uses the legacy REST `POST /pulls/{n}/reviews` endpoint, which accepts `body + event` with no `comments[]`. Spec § 4 adds a `SubmitSummaryOnlyReviewAsync` method bypassing the pending-review pipeline. Two code paths but each is simple.

Implementer chooses based on which option fits the existing GraphQL builder/HttpClient surface in `PRism.GitHub` more cleanly. Default recommendation: (b) (smaller surface area; the pending-review pipeline already has cognitive load).

### 2.3 Playwright multi-spec state-leak

**Status.** Pending. S4 PR7 left three E2E specs as `test.fixme` due to a documented state-leak between specs in the same Playwright run (S4 deferrals entry 2026-05-11 (d)). Hypothesis: stale-write race against in-flight `PUT /api/pr/{ref}/draft`.

**Why root-cause now, not after S5.** The submit pipeline writes `state.json` many times per submit (every step transition stamps a draft / reply ID). The leak hypothesis is exactly the failure mode S5 amplifies. Adding more `test.fixme` suites in S5 PR7 would compound the test-debt while S5 is the slice that most needs the suite isolated.

**Test sequence.**
1. Reproduce the leak deterministically with a minimal repro spec pair.
2. Identify whether the race is in `AppStateStore._gate` ordering, in the SSE event-publication ordering (S4 design § 4.5 names this an explicit ordering contract), or in Playwright's per-spec `state.json` reset.
3. Fix at the lowest-impact layer (preferring test-infra fix over backend change if the contract is sound).
4. Un-`fixme` the three S4 specs as part of PR0; assert green.

If root-cause turns out to be larger than a PR0 fix can carry (>1 day of refactor), escalate to the user before continuing — the PR0 sequencing constraint trades against not blocking S5 entirely on a tangential infrastructure rework.

---

## 3. ADR-S5-1: `IReviewService` capability split (PR0)

Per [`2026-05-06-architectural-readiness-design.md § ADR-S5-1`](2026-05-06-architectural-readiness-design.md). Pure refactor; no behavior change.

```csharp
namespace PRism.Core;

public interface IReviewAuth
{
    Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct);
}

public interface IPrDiscovery
{
    Task<InboxSection[]> GetInboxAsync(CancellationToken ct);
    bool TryParsePrUrl(string url, out PrReference? reference);
}

public interface IPrReader
{
    Task<Pr> GetPrAsync(PrReference reference, CancellationToken ct);
    Task<PrIteration[]> GetIterationsAsync(PrReference reference, CancellationToken ct);
    Task<FileChange[]> GetDiffAsync(PrReference reference, string fromSha, string toSha, CancellationToken ct);
    Task<ExistingComment[]> GetCommentsAsync(PrReference reference, CancellationToken ct);
    Task<PrDetailDto?> GetPrDetailAsync(PrReference reference, CancellationToken ct);
    Task<DiffDto> GetDiffAsync(PrReference reference, DiffRangeRequest range, CancellationToken ct);
    Task<ClusteringInput> GetTimelineAsync(PrReference reference, CancellationToken ct);
    Task<FileContentResult> GetFileContentAsync(PrReference reference, string path, string sha, CancellationToken ct);
    Task<ActivePrPollSnapshot> PollActivePrAsync(PrReference reference, CancellationToken ct);
    Task<CommitInfo?> GetCommitAsync(PrReference reference, string sha, CancellationToken ct);
}

public interface IReviewSubmitter { /* see § 4 */ }
```

The legacy `SubmitReviewAsync(PrReference, DraftReview, CancellationToken)` stub on `IReviewService` is **retired** as part of the split — it has zero non-test callers and was retained only for the capability-split landing.

**Implementations all stay on `GitHubReviewService`** (or its partial classes per ADR-S5-2 if that lands). DI registration in `PRism.Web/Composition/ServiceCollectionExtensions.cs` registers `GitHubReviewService` against all four interfaces.

**Fakes split alongside.** `tests/PRism.Web.Tests/Fakes/FakeReviewService.cs` becomes four fakes (`FakeReviewAuth`, `FakePrDiscovery`, `FakePrReader`, `FakeReviewSubmitter`). The Playwright `/test/*` env-guarded fake (`PRISM_E2E_FAKE_REVIEW=1`) splits the same way.

---

## 4. `IReviewSubmitter` capability seam (PR1)

Seven methods covering the GraphQL pending-review pipeline. Method shapes are at the contract level; implementer chooses Octokit GraphQL builder vs raw `HttpClient` per `PRism.GitHub` conventions. (PR1 reuses the adapter's existing GraphQL transport — `PostGraphQLAsync` + `HostUrlResolver.GraphQlEndpoint` + `GitHubGraphQLException` — wrapped in a stricter mutation error check.)

```csharp
namespace PRism.Core;

public interface IReviewSubmitter
{
    // Step 1 — create pending review (event omitted → stays pending)
    Task<BeginPendingReviewResult> BeginPendingReviewAsync(
        PrReference reference,
        string commitOid,
        string summaryBody,
        CancellationToken ct);

    // Step 2 — attach a single new thread to the pending review
    Task<AttachThreadResult> AttachThreadAsync(
        PrReference reference,
        string pendingReviewId,
        DraftThreadRequest draft,
        CancellationToken ct);

    // Step 3 — attach a single reply to an existing thread on the pending review
    Task<AttachReplyResult> AttachReplyAsync(
        PrReference reference,
        string pendingReviewId,
        string parentThreadId,
        string replyBody,
        CancellationToken ct);

    // Step 4 — finalize: submit the pending review with a verdict event
    Task FinalizePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        SubmitEvent verdict,
        CancellationToken ct);

    // Discard path — delete the whole pending review
    Task DeletePendingReviewAsync(
        PrReference reference,
        string pendingReviewId,
        CancellationToken ct);

    // Best-effort cleanup of a single duplicate thread under the multi-marker-match defense (§ 5.2 step 3):
    // when more than one server thread carries the same draft's marker, the pipeline adopts the earliest
    // and asks to delete the rest. (Doc-review R16 — landed in PR1 so the interface is stable for PR2.)
    Task DeletePendingReviewThreadAsync(
        PrReference reference,
        string pullRequestReviewThreadId,
        CancellationToken ct);

    // Detection: returns the user's pending review on this PR (if any), with attached threads + replies
    // Drives the foreign-pending-review prompt and the lost-response adoption step
    Task<OwnPendingReviewSnapshot?> FindOwnPendingReviewAsync(
        PrReference reference,
        CancellationToken ct);
}

public sealed record DraftThreadRequest(
    string DraftId,           // SubmitPipeline injects the marker; adapter never sees user-visible body
    string BodyMarkdown,      // already includes the <!-- prism:client-id:<DraftId> --> footer
    string FilePath,
    int LineNumber,
    string Side,
    // Reserved for multi-line / range comments — both fields stay null in PoC scope.
    // Multi-line is deferred to a focused later slice or P4 (see deferrals sidecar
    // "[Defer] Multi-line / range comments"). PR1 wires `null` into the pipeline call
    // sites; PR1 implementer should NOT plumb these through from the composer or
    // attempt to populate them from existing draft state.
    int? StartLine = null,
    string? StartSide = null);

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
    string Side,                // GraphQL diffSide; needed to reconstruct DraftComment on Resume
    string OriginalCommitOid,   // GraphQL originalCommit.oid; populates DraftComment.AnchoredSha on Resume
    string OriginalLineContent, // populates DraftComment.AnchoredLineContent on Resume; derived from PullRequestReviewThread.line + the file content at originalCommit
    bool IsResolved,            // GraphQL PullRequestReviewThread.isResolved; surfaces a "Resolved on github.com" badge on Resume
    string BodyMarkdown,        // raw body returned by GraphQL (marker preserved if C7 holds)
    IReadOnlyList<PendingReviewCommentSnapshot> Comments);

public sealed record PendingReviewCommentSnapshot(
    string CommentId,
    string BodyMarkdown);

public enum SubmitEvent { Approve, RequestChanges, Comment }
```

**Marker injection lives in `SubmitPipeline`, not in user-visible code.** `BodyMarkdown` on `DraftThreadRequest` is the already-formatted body — pipeline appends `\n\n<!-- prism:client-id:<DraftId> -->` before constructing the request, with unclosed-fence detection re-closing the user's body before appending. Same for replies (the analog request type carries `ReplyId` and the same marker construction). Body-cap accounting (GitHub's ~65k-char limit) includes the marker.

**Marker-collision defense at composer save time.** If a user body literally contains the substring `<!-- prism:client-id:` (deliberately or accidentally — e.g., a draft about the marker scheme itself, or a copy-pasted earlier draft body), the lost-response adoption step (§ 5.2 step 3) could misidentify that draft as already-attached or could match a foreign draft id. The composer's `PUT /draft` endpoint rejects bodies containing the marker prefix substring outside fenced code blocks with a structured 400 (`{ code: "marker-prefix-collision" }`); the inline composer surfaces the validation error: *"Comment body cannot contain the internal marker string `<!-- prism:client-id:`"*. The rejection is the path of least surprise; HMAC-of-DraftId nonce alternatives add cryptographic complexity for a problem the rejection solves cleanly.

**Why a single thread per call rather than batched.** Step 2 of spec § 6 is fan-out per draft. The state machine's resumability requires per-thread idempotency (each `AttachThreadAsync` either succeeds and stamps `draft.threadId`, or fails and the next retry re-tries that draft). Batching would push ordering and partial-failure handling into `IReviewSubmitter`, breaking the "step machine in `PRism.Core`" boundary.

---

## 5. `SubmitPipeline` state machine (PR2)

Lives in `PRism.Core/Submit/Pipeline/` per Convention-1. Mirrors the layout of `PRism.Core/Reconciliation/Pipeline/` from S4: a single public entry-point class with `internal sealed` step classes, fully unit-testable against `IReviewSubmitter` fakes without booting `WebApplicationFactory`.

### 5.1 Entry point

```csharp
namespace PRism.Core.Submit.Pipeline;

public sealed class SubmitPipeline
{
    public async Task<SubmitOutcome> SubmitAsync(
        PrReference reference,
        ReviewSessionState session,
        SubmitEvent verdict,
        string currentHeadSha,
        IProgress<SubmitProgressEvent> progress,
        CancellationToken ct)
    { /* orchestrates Steps 1–5 below */ }
}

public abstract record SubmitOutcome
{
    public sealed record Success(string PullRequestReviewId) : SubmitOutcome;
    public sealed record Failed(SubmitStep FailedStep, string ErrorMessage, ReviewSessionState NewSession) : SubmitOutcome;
    public sealed record ForeignPendingReviewPromptRequired(OwnPendingReviewSnapshot Snapshot) : SubmitOutcome;
    public sealed record StaleCommitOidRecreating(string OrphanReviewId, string OrphanCommitOid) : SubmitOutcome;
}

public enum SubmitStep
{
    DetectExistingPendingReview,
    BeginPendingReview,
    AttachThreads,
    AttachReplies,
    Finalize,
}

public sealed record SubmitProgressEvent(SubmitStep Step, SubmitStepStatus Status, int Done, int Total);
public enum SubmitStepStatus { Started, Succeeded, Failed }
```

`IProgress<SubmitProgressEvent>` is the bridge to the SSE event surface; the endpoint layer (§ 7) wraps an `IProgress` impl that publishes `submit-progress` SSE events. The pipeline core never references SSE directly.

### 5.2 Steps

The pipeline is a five-step state machine. Steps consult `session.PendingReviewId`, `session.PendingReviewCommitOid`, and per-draft `ThreadId` / `ReplyCommentId` to decide what's already done vs what needs to run.

**Step 1 — Detect existing pending review.** Call `FindOwnPendingReviewAsync(reference)`. Three outcomes per spec § 6 step 1:

- **Match by ID** — returned snapshot's `PullRequestReviewId` equals `session.PendingReviewId`. `commitOID` matches `currentHeadSha`. Skip to Step 3 (threads). If `commitOID` differs, jump to **stale-commitOID branch** below.
- **Other pending review exists** — snapshot returned, but ID doesn't match `session.PendingReviewId` (or `PendingReviewId` is null). Return `ForeignPendingReviewPromptRequired(snapshot)`. The endpoint (§ 7) surfaces the modal; the user's choice (Resume / Discard / Cancel) drives the next call to `SubmitAsync` with adjusted session state. **TOCTOU defense (§ 11) is enforced by the endpoint layer**, not the pipeline.
- **No pending review** — proceed to Step 2.

**Stale-commitOID branch.** When the matched pending review's `commitOID` differs from `currentHeadSha`:
1. Emit `SubmitProgressEvent(DetectExistingPendingReview, Started, 0, 0)` so the dialog banner can surface "Recreating review against new head sha…" before the destructive call.
2. Call `DeletePendingReviewAsync(reference, session.PendingReviewId)`.
3. Return `SubmitOutcome.StaleCommitOidRecreating(...)` with the orphan IDs. The session in the returned outcome has `PendingReviewId = null`, `PendingReviewCommitOid = null`, and **every draft's `ThreadId` cleared and every reply's `ReplyCommentId` cleared** (per spec § 6 "Stale `commitOID` on retry" policy).
4. The endpoint persists the cleared session via `AppStateStore`, then the user re-confirms in the dialog (the banner showed what just happened) and submit re-runs from Step 1 with no pending review.

The reconciliation-against-new-head step is the user's responsibility via the standard Reload flow before re-submitting — the dialog's Submit Review button is rule-(f) blocked if `head_sha` drift hasn't been Reloaded against. If somehow drift exists at submit time anyway, the endpoint forces a Reload-equivalent reconciliation pass before re-running the pipeline.

**Step 2 — Begin pending review.** Only runs if no pending review exists. Call `BeginPendingReviewAsync(reference, currentHeadSha, session.DraftSummaryMarkdown ?? "")`. Stamp `PendingReviewId` and `PendingReviewCommitOid` in the returned session immediately (caller persists). Emit `SubmitProgressEvent(BeginPendingReview, Succeeded, 1, 1)`.

**Body of step 1 is always an explicit string, never null/omitted** — consistency rule from spec § 6 step 1 (never reopened by S5; inherited from C1 verification).

**Step 3 — Attach threads** (skipped if `session.DraftComments` is empty). For each `DraftComment` (excluding `DraftStatus.Stale` — submit is rule-(b) blocked, so they should never reach here):

- **If `draft.ThreadId` is set** — verify the thread still exists on the pending review by checking the snapshot from Step 1 (or re-fetching via `FindOwnPendingReviewAsync` if Step 1 was skipped). If present, skip this draft (already attached on a prior attempt). If absent (the user resolved/deleted the thread on github.com between attempts), recreate it via `AttachThreadAsync` and re-stamp `draft.ThreadId`.
- **If `draft.ThreadId` is null** — first run the **lost-response adoption check**: scan the snapshot's threads, parsing the `<!-- prism:client-id:<id> -->` marker out of each `BodyMarkdown`. **Match cardinality matters**:
  - **Single match** — adopt the server's `PullRequestReviewThreadId` into `draft.ThreadId` and skip the `AttachThreadAsync` call.
  - **Multi-match** — GitHub's GraphQL pending-review listing is not strictly read-your-writes consistent; under a lost-response window followed by a retry that wrote a duplicate (because the original was not yet visible in the listing), the snapshot can return *N > 1* threads carrying the same marker. Adopt the **earliest** (lowest `createdAt`) into `draft.ThreadId` and immediately call `deletePullRequestReviewThread` on the others before proceeding. Treat the cleanup as best-effort — log failures and emit a `submit-duplicate-marker-detected` SSE event so the user is aware of the orphan; do not block submit on the cleanup result. Without this defense, the pipeline would Finalize a review with duplicate threads on github.com — exactly the failure mode the marker scheme exists to prevent.
  - **No match** — call `AttachThreadAsync` (with marker injected per § 4) and stamp `draft.ThreadId` from the response.
  
  **Persist after every stamp** — the pipeline re-enters `AppStateStore.UpdateAsync` after each successful per-draft call so a process kill mid-pipeline preserves what's already been attached.

Emit `SubmitProgressEvent(AttachThreads, Started, 0, totalDrafts)` at start, then `(AttachThreads, Succeeded, doneCount, totalDrafts)` after each draft. On failure, `(AttachThreads, Failed, doneCount, totalDrafts)` and return `SubmitOutcome.Failed(AttachThreads, ...)`.

**Step 4 — Attach replies** (skipped if `session.DraftReplies` is empty). Same logic for `DraftReply`:

- **If `reply.ReplyCommentId` is set** — verify the reply comment still exists (the snapshot from Step 1 enumerates per-thread comments; check there). Skip if present; recreate via `AttachReplyAsync` if absent.
- **If `reply.ReplyCommentId` is null** — same marker-adoption check against the snapshot's per-thread comments. If no match, call `AttachReplyAsync` and stamp `reply.ReplyCommentId`. Persist after every stamp.
- **Foreign-author thread deletion mid-retry** — if `AttachReplyAsync` returns 404/422 because `reply.ParentThreadId` no longer exists on the pending review (the parent thread's author deleted it between submit attempts on github.com), demote the reply to `DraftStatus.Stale` with reason "parent thread deleted." Submit blocks (rule (b) catches it); user resolves via discard or rewrite as a new top-level thread. Return `SubmitOutcome.Failed(AttachReplies, "parent thread deleted", session)`.

Same `SubmitProgressEvent` emission cadence as Step 3.

**Step 5 — Finalize.** Call `FinalizePendingReviewAsync(reference, session.PendingReviewId, verdict)`. On success: clear `PendingReviewId`, `PendingReviewCommitOid`, every draft, every reply, `DraftSummaryMarkdown`, `DraftVerdict`, `DraftVerdictStatus` from the session via `AppStateStore.UpdateAsync`. Emit `SubmitProgressEvent(Finalize, Succeeded, 1, 1)`. Return `SubmitOutcome.Success(pullRequestReviewId)`.

**Publication-vs-`_gate` ordering** — the pipeline calls `AppStateStore.UpdateAsync` to clear state inside the gate; `DraftSubmitted` and `StateChanged` are published **outside** `_gate` after `UpdateAsync` returns, per the contract pinned in [`2026-05-09-s4-drafts-and-composer-design.md § 4.5`](2026-05-09-s4-drafts-and-composer-design.md). The endpoint layer (§ 7.1) is the natural publication site: the pipeline returns `SubmitOutcome.Success` and the endpoint publishes both events before returning the HTTP response. Putting publication inside `_gate` would deadlock v2 subscribers whose handlers re-enter `UpdateAsync` (e.g., AI cache invalidation handlers per [`../spec/04-ai-seam-architecture.md`](../spec/04-ai-seam-architecture.md) § event-bus); the S4 design explicitly warns against this. S5 is the first slice where `DraftSubmitted` has a producer, so the ordering note lands here.

**Empty-pipeline finalize** — when `DraftComments` is empty and `DraftReplies` is empty (e.g., empty-PR case with verdict = Comment + summary only), Steps 3 and 4 are skipped entirely; Step 5 runs against the pending review with no attached threads. The Submit Review button enable rule (e) catches the no-content case before the pipeline ever runs (verdict = Comment + no content of any kind → button disabled), so Step 5 only sees an explicit user choice to submit a "Comment with summary, no inline content."

### 5.3 Idempotency contract

The pipeline's resumability rests on three invariants:

1. **`session.PendingReviewId` is the outer idempotency key.** As long as it's set, retry resumes from Step 1's "Match by ID" outcome.
2. **Per-draft `ThreadId` / per-reply `ReplyCommentId` are inner idempotency keys.** Once stamped, retry's verify step is the source of truth; the marker is unused.
3. **The marker is the one-shot adoption key** for unstamped drafts on the *first* retry after a lost-response window. After the marker matches once and stamps `ThreadId`, the marker is no longer consulted for that draft. Multi-match (N>1 threads carrying the same marker) is handled by Step 3's match-cardinality defense — adopt earliest, delete others — to defend against GitHub's pending-review-listing eventual-consistency window.

All three invariants persist to `state.json` immediately after each mutation. A process kill between any two persists is recoverable from the persisted state.

### 5.4 Tests (TDD, written first)

Per the project's test-first commitment, every behavior in § 5.2 lands as a failing test before its implementation. Test fixtures live in `tests/PRism.Core.Tests/Submit/Pipeline/`:

- `EmptyPipelineFinalizeTests.cs` — DoD test (a). Empty `DraftComments` + empty `DraftReplies` + non-empty summary → only Steps 1, 2, 5 run; Steps 3 and 4 skipped.
- `RetryFromEachStepTests.cs` — DoD test (b). One test per step (Begin / AttachThreads partial / AttachReplies partial / Finalize). Each injects an `IReviewSubmitter` fake that fails at the named step on first call, succeeds on second; asserts the second call's session converges on success without duplicate threads / replies.
- `LostResponseAdoptionTests.cs` — DoD test for the marker. Fake's `FindOwnPendingReviewAsync` returns a snapshot whose threads carry markers matching unstamped drafts; pipeline skips `AttachThreadAsync` for those drafts and stamps `ThreadId` from the snapshot.
- `ForeignPendingReviewTests.cs` — DoD tests (c) and (d). Resume / Discard branches.
- `StaleCommitOidRetryTests.cs` — DoD test (e). Snapshot's `commitOID` differs from `currentHeadSha`; pipeline emits `StaleCommitOidRecreating`, deletes orphan, clears stamps.
- `ForeignAuthorThreadDeletedTests.cs` — DoD test (f). Step 4's `AttachReplyAsync` returns 404; reply demoted to `Stale`.

If C7 falsifies, an additional `BodyNormalizationParityTests.cs` lands instead of (or alongside) the lost-response marker test.

---

## 6. Schema migration v3 → v4 (PR1 or PR2)

`DraftComment.ThreadId: string?` is added as an additive field. `DraftReply.ReplyCommentId` already exists from S4 (declared ahead per S4 design § 2.1).

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
    string? ThreadId);  // S5 v4
```

**Why a v4 migration step rather than a silent additive field.** Per spec § 4.5's "schema-versioned migration" framing and the S4 design § 2.1 wrap-rename precedent, every persistent-state shape change crosses a version boundary. Reading "additive optional field on an existing record is non-breaking" as an excuse to skip the migration would normalize silent drift — exactly what the user's "document plan deviations visibly" rule defends against.

The migration step body is empty (no per-session transform — `null` is the correct default for existing `DraftComment` entries that pre-date the field). The version bump is the visibility:

```csharp
// PRism.Core/State/Migrations/AppStateMigrations.cs (add alongside MigrateV1ToV2 / MigrateV2ToV3)
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

**Note on shape.** The migration framework operates on `Func<JsonObject, JsonObject>` per the S4 PR1 implementation at `PRism.Core/State/AppStateStore.cs:20` — migrations transform the raw JSON tree before it deserializes into typed records, not the typed records themselves. (This is why the AppState-to-AppState `with`-expression sketch that appeared in earlier doc-review drafts would not compile against the shipped framework; see the deferrals sidecar Risk R1.) Wired into `AppStateStore.MigrationSteps[]` as the V3→V4 entry:

```csharp
// PRism.Core/State/AppStateStore.cs
private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
    new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
    {
        (2, AppStateMigrations.MigrateV1ToV2),
        (3, AppStateMigrations.MigrateV2ToV3),
        (4, AppStateMigrations.MigrateV3ToV4),  // S5 PR2
    };
```

**Tests** — `MigrateV3ToV4_BumpsVersionWithoutDataChange` in `tests/PRism.Core.Tests/State/MigrationStepTests.cs`. Plus the existing `failing-migration-leaves-vN.bak-intact` test from S4 covers the failure path generically.

---

## 7. Backend endpoints (PR3)

### 7.1 `POST /api/pr/{ref}/submit`

Body: `{ verdict: "Approve" | "RequestChanges" | "Comment" }`. The session's draft comments / replies / summary are read from `state.json` — the body carries only the user's explicit verdict choice from the dialog.

**Authorization.** Same broader-than-spec pattern as `markAllRead` (`cache.IsSubscribed(prRef)` — any cookieSessionId subscribed to this PR ref). Tightening to subscriber-ownership is a separate cleanup that hardens both endpoints together (S4 deferral 6 explicit). PoC threat model per spec § 6.2 accepts the broader pattern.

**Per-PR submit lock.** Endpoint acquires a per-`prRef` `SemaphoreSlim` (registered as singleton-keyed-by-prRef in DI; held only for the duration of a single `SubmitAsync` call). Concurrent submit attempts on the same prRef return `409 Conflict` with `{ code: "submit-in-progress" }`. **The lock MUST NOT be `AppStateStore._gate`** — putting submit-pipeline serialization on the global state-store gate would block every other PR's draft writes for the duration of any one PR's submit (10–30s); it would also re-introduce the publication-vs-_gate ordering hazard the § 5.2 step 5 paragraph above defends against. The submit lock is a separate, narrower primitive scoped to one PR's submit pipeline.

This defends against the multi-tab simultaneous-submit collision: two PRism tabs open on the same PR both share `state.json` so both observe `PendingReviewId == null` initially. Without the lock, both tabs' pipelines call `BeginPendingReviewAsync`; GitHub's "one pending review per user per PR" constraint serializes — one wins, the other gets back the existing pending review ID OR an error. The losing tab's session has stale or null `PendingReviewId`; on retry `FindOwnPendingReviewAsync` returns a pending review whose ID doesn't match the losing tab's session, triggering a `ForeignPendingReviewPromptRequired` outcome — but against the user's OWN content from the other tab. The modal's "from {timestamp}" framing biases the user toward Discard. Per-PR lock prevents the second tab's pipeline from ever starting; the second tab sees `409 submit-in-progress` and surfaces "Submit in progress in another tab — please wait" inline. The cross-tab presence banner from S4 reflects the same state.

**Body size cap.** Extend the pre-routing `UseWhen` predicate in `PRism.Web/Program.cs` (the same middleware that currently caps `/api/events/subscriptions`, `/api/pr/{ref}/draft`, `/api/pr/{ref}/reload` — see the comment block at `PRism.Web/Program.cs:99–142`) to also match `POST /api/pr/{ref}/submit`. The endpoint's body is a one-field discriminator, so it inherits the existing 16 KiB cap rather than getting a separate primitive — the unified branch keeps the cap defense single-sited. `[RequestSizeLimit]` attribute or endpoint filter would NOT enforce pre-binding for minimal APIs (the comment in `Program.cs` documents why; `IHttpMaxRequestBodySizeFeature` is read-only by the time route filters run), so the pre-routing middleware is the only correct site.

**Response.** `200 OK` with `{ outcome: "started" }` — the actual progress flows over SSE; the response just confirms the pipeline started. On 4xx (rule-violation, e.g., stale drafts present): structured error body with `code` discriminator (`stale-drafts` / `verdict-needs-reconfirm` / `head-sha-drift` / `validator-blocking` / `no-content`).

**Pipeline dispatch.** Endpoint resolves `SubmitPipeline` from DI, constructs an `IProgress<SubmitProgressEvent>` impl that publishes `submit-progress` SSE events, calls `SubmitAsync`. The pipeline's `SubmitOutcome` drives the next response:

- `Success` → publish `DraftSubmitted` typed event + `StateChanged` umbrella event.
- `Failed` → no state mutation beyond what the pipeline's per-step persists already did. Final `submit-progress` SSE event has `Status: Failed` and the failed step / error message.
- `ForeignPendingReviewPromptRequired` → publish a `submit-foreign-pending-review` SSE event with the snapshot. Frontend opens the modal (§ 11). The modal's outcome drives a follow-up endpoint call (Resume / Discard each have their own endpoint per § 11).
- `StaleCommitOidRecreating` → publish a `submit-stale-commit-oid` SSE event. Frontend renders the in-dialog banner (§ 12); user re-confirms in the dialog and submit re-fires.

### 7.2 `POST /api/pr/{ref}/submit/foreign-pending-review/resume`

Body: `{ pullRequestReviewId: string }` — must match the snapshot ID returned in the most recent `submit-foreign-pending-review` SSE event for this PR.

**TOCTOU defense.** Endpoint re-fetches the user's current pending review (`Snapshot B`) via `IReviewSubmitter.FindOwnPendingReviewAsync` before acting. If the snapshot ID has changed (a different pending review exists) or the snapshot is now absent (the orphan was submitted/deleted on github.com), respond `409 Conflict` with `{ code: "pending-review-state-changed" }`. Frontend shows the toast: *"Your pending review state changed during the prompt. Please retry submit."*

**On TOCTOU pass.** Import each thread from `Snapshot B` as a `DraftComment` into `state.json.draftComments` (with `Status: Draft`, `ThreadId` already stamped from the snapshot, plus `IsResolved` carried as a per-draft display badge so the Drafts panel shows "Resolved on github.com" on previously-resolved threads — see § 11.1). Each thread's reply chain imports as `DraftReply` entries with `ReplyCommentId` stamped. Persist; publish `StateChanged`. The endpoint's 200 response body carries the full `Snapshot B` payload (thread bodies + reply bodies + counts) so the frontend can render the imported drafts immediately without waiting for the SSE round-trip. **Snapshot A → Snapshot B body staleness** — content that the user saw in the original modal (built from Snapshot A in the SSE event) may differ from Snapshot B if github.com was mutated during the prompt delay. Frontend surfaces a one-line note above the imported drafts when `Snapshot A.threadCount != Snapshot B.threadCount`: *"The pending review changed during the prompt — N thread(s) imported (you saw M in the prompt)."*

Client receives the new draft state via the standard SSE channel and renders them in the reconciliation panel for per-draft adjudication. The user can edit / discard before re-clicking Submit; threads the user discards from the panel call the existing `PUT /draft` discard path, which fires `deletePullRequestReviewThread` if `ThreadId` is set.

### 7.2a TOCTOU 409 frontend handling

On 409 from `/foreign-pending-review/resume` or `/foreign-pending-review/discard` with `code: "pending-review-state-changed"`, the foreign-pending-review modal closes and `useSubmit` resets to `idle`. The toast (per § 7.2) surfaces. The user is returned to the PR view; clicking Submit Review again re-runs the pipeline from Step 1, which re-detects whether a foreign pending review exists and re-triggers the modal if so (now reflecting the current github.com state) or proceeds normally if the conflict has resolved. `useSubmit.SubmitState` does not need a dedicated `toctou-conflict` kind — `idle + toast` is sufficient since the user's recovery path is just "retry submit."

### 7.3 `POST /api/pr/{ref}/submit/foreign-pending-review/discard`

Body: `{ pullRequestReviewId: string }`.

**TOCTOU defense.** Same Snapshot B re-fetch as Resume. On pass, calls `DeletePendingReviewAsync(reference, snapshotB.PullRequestReviewId)`. Clears `state.json.pendingReviewId` and `pendingReviewCommitOid`. Publishes `StateChanged`.

**Confirmation modal lives in the frontend** (§ 11). Endpoint trusts the client's two-click confirmation as the user-intent gate; PoC scope.

### 7.4 `submit-progress` SSE event

Payload: `{ prRef, step: "DetectExistingPendingReview" | "BeginPendingReview" | "AttachThreads" | "AttachReplies" | "Finalize", status: "Started" | "Succeeded" | "Failed", done: number, total: number, errorMessage?: string }`.

**No per-draft IDs in the payload.** This is the explicit threat-model defense against the S4 deferral 12 SSE-leak concern — the same broader-than-spec subscription pattern means subscribed tabs receive each other's events; carrying draft IDs would re-introduce the leak. Step name + counts are sufficient for the dialog UI.

The event is per-PR (subscriptions are per-PR per the S3 design). Multi-tab implication: if two tabs are subscribed to the same PR and one submits, the other tab also sees the progress events. That's an acceptable transparency property; both tabs reflect the in-flight state.

### 7.5 `submit-foreign-pending-review` and `submit-stale-commit-oid` SSE events

`submit-foreign-pending-review` payload: `{ prRef, pullRequestReviewId: string, commitOid: string, createdAt: string, threadCount: number, replyCount: number }`. **No thread or reply bodies in the SSE payload** — the same threat-model defense the `submit-progress` event applies (§ 7.4): the per-PR fanout means subscribed tabs receive each other's events, and broadcasting raw thread bodies across tabs unnecessarily widens the data surface. Counts + IDs are sufficient to drive the modal copy in § 11 ("It contains N thread(s) and M reply(ies)"). The full `Snapshot B` payload (with bodies) is returned to the user only when they explicitly click Resume — via the `POST /foreign-pending-review/resume` 200 response (§ 7.2). Discard never receives bodies. Multi-tab: only the tab that initiated the submit acts on the modal; other tabs ignore (they're not in the submit-flow state).

`submit-stale-commit-oid` payload: `{ prRef, orphanCommitOid: string }`. **No `orphanReviewId` in the payload** — same defense; the orphan ID is consumed server-side only. Same multi-tab semantics.

`submit-orphan-cleanup-failed` payload: `{ prRef }`. **No `pendingReviewId`** — the toast copy (§ 13.2 step 4) does not need the ID, and broadcasting it widens the data surface unnecessarily. Server-side logging of the ID for debugging is subject to `SensitiveFieldScrubber` (which should add `pendingReviewId` / `threadId` / `replyCommentId` to its blocked-fields list before PR3 lands; see § 18.2).

Frontend reconciler in subscribed-but-not-active tabs treats all four submit-* events as informational — refreshes the local cache via the standard `state-changed` path that fires alongside.

---

## 8. Submit confirmation dialog (PR4)

### 8.1 Layout

Single-column, scrollable body, sticky Confirm/Cancel footer. Responsive widths per the breakpoint table in § 8.5. Vertical scroll within the dialog body when the summary textarea grows past 400px or when the validator results section + counts block exceeds available height.

**Dialog body order (top-down):**
1. Verdict picker (segmented control, three options — see § 10)
2. Validator results section (`IPreSubmitValidator` output; empty in PoC unless `aiPreview: true` — see § 14.1)
3. PR-level summary textarea + live preview (side-by-side at ≥ 900px; stacked below textarea at narrower widths)
4. Counts block: *"This review will create N new thread(s) and M reply(ies)."* Render `0` explicitly when applicable.
5. Submit-progress checklist — collapsed/hidden until Confirm fires; expands inline once the pipeline starts. Each step is a row with status icon (pending / in-progress / done / failed) + count text per `submit-progress` SSE events.

**Sticky footer:** *Cancel* (left) | *Confirm Submit* (right, primary). Footer stays fixed at dialog bottom even when body scrolls.

**Default focus:** summary textarea.

**Esc behavior:** Esc does NOT auto-dismiss. The user must explicitly click Cancel. Rationale: the textarea may carry a long in-progress summary; an accidental Esc that drops the dialog (even with auto-save preserving the summary) loses the user's submit-flow context. Esc instead **focuses the Cancel button** so a deliberate Esc-then-Enter can dismiss. ARIA: when Esc fires the focus-shift, announce *"Esc moved focus to Cancel — press Enter to close, or click anywhere in the dialog to continue editing"* via an `aria-live="polite"` status region so screen-reader users know the focus shifted but no destructive action ran.

**FocusTrap:** standard React focus-trap pattern; tab cycles within the dialog. The dialog uses the existing `<Modal>` component contract (`aria-modal="true"`, `aria-labelledby` on the title, focus restoration on close).

### 8.1a Information architecture — verdict-first vs counts-first

The current order leads with the verdict picker (configuration) before the counts block + validator results (information that informs the verdict). This is a deliberate IA choice — most reviewers arrive at the dialog with a verdict already in mind from the review session, and the picker is affirmation, not decision. An alternate IA leading with counts/validator before verdict would respect "show evidence before asking for decision" but inverts the typical reviewer flow.

**Status:** Resolved 2026-05-11 — verdict-first per user decision during this spec's brainstorm + doc-review cycle. Recorded in § 18.1 "Resolved" subsection. If the call ever needs reopening, swap items 1↔3 in the dialog body order above and update PR4 accordingly.

### 8.2 PR-level summary textarea

Per spec § 6 PR-level summary: textarea + live preview, debounced auto-save to `draftSummaryMarkdown` on every keystroke (250 ms). Persists across dialog Cancel/reopen. Cleared on successful submit.

**Rendering pipeline:** same `react-markdown` + `remark-gfm` + Shiki + Mermaid pipeline as the inline composer preview and existing-comment rendering. **No fourth rendering path** is introduced.

### 8.3 Submit-progress checklist (during pipeline run)

Once Confirm fires, the dialog body collapses to:

1. Header: *"Submitting your review…"* (turns to *"Review submitted."* on success or *"Submit failed at step X."* on failure)
2. Checklist of pipeline steps, rendered in two phases to avoid flashing the full 5-step UI for an outcome that exits before any thread is attached:

   **Phase A — Step 1 in flight (no checklist).** From Confirm until the SSE event for `BeginPendingReview: Succeeded` arrives, the dialog body shows a single neutral indicator: *"Checking pending review state…"* (one row, ⏳ icon, `aria-live="polite"`). Step 1 (`DetectExistingPendingReview`) can exit early into the foreign-pending-review modal (`ForeignPendingReviewPromptRequired` outcome — § 5.2 step 1) or into the stale-`commitOID` button state (`StaleCommitOidRecreating` outcome — § 12); in both cases the dialog closes / transitions before any threads are attached. Rendering the full 5-step pending checklist during Phase A would imply "we started attaching threads" for an outcome that means "we haven't attached anything yet."

   **Phase B — Step 2 stamped (full checklist).** Once `BeginPendingReview` succeeds and `PendingReviewId` is stamped, the dialog body re-renders to the full 5-row checklist with steps 1 and 2 already marked ✓:
   - ✓ *Detected pending review state*
   - ✓ *Created pending review*
   - ⏳ *Attach threads*
   - ⏳ *Attach replies*
   - ⏳ *Finalize*

   Subsequent SSE events advance the in-progress / completed rows per `submit-progress` payloads. The checklist container carries `aria-live="polite"` so screen readers announce each step transition without interrupting the Confirm action announcement.

   Example mid-run state:
   - ✓ *Detected pending review state*
   - ✓ *Created pending review*
   - ✓ *Attached 3 of 3 threads*
   - ⏳ *Attaching reply 1 of 2…*
   - ✗ *Submit failed*

   On retry into a session with `PendingReviewId` already stamped (resume-from-mid-pipeline), the checklist enters Phase B immediately on Confirm — Step 1 + Step 2 are pre-marked ✓ from session state without waiting for SSE confirmation, since the IDs prove they previously succeeded.
3. Footer changes:
   - During run: Cancel disabled (hard commitment per spec § 6 — the pipeline cannot be cancelled mid-flight). Confirm replaced with a non-actionable spinner.
   - On success: Cancel disappears; Confirm replaced with *"View on GitHub →"* (links to the submitted review URL) + *Close* button.
   - On failure: Cancel re-enabled (closes dialog without aborting server-side state — drafts and `pendingReviewId` persist). Confirm replaced with *Retry* (re-fires `POST /submit` with the same verdict; pipeline resumes from where it left off).

**Verdict picker frozen during pipeline run.** From Confirm through either Success or permanent Failure, the verdict picker in both the dialog and the header is `aria-disabled="true"` and visually desaturated. The verdict is fixed at the value selected when Confirm was clicked. On Success the picker resets to unselected (cleared with the session state). On Failure + Retry the picker retains the last-confirmed value and stays disabled for the duration of the retry. This matches the Cancel-disabled rationale and prevents a mid-banner verdict change from being inadvertently submitted on the auto-retry path's stale-`commitOID` recovery (§ 12).

**Why the dialog stays open on failure rather than closing with a banner.** The submit-progress checklist is the user's source of truth for what already happened; closing the dialog and replacing it with a banner-then-reopen creates an extra click and loses checklist state. Stay-open + Retry is the path of least friction.

### 8.4 `useSubmit` hook (frontend)

```ts
// frontend/src/hooks/useSubmit.ts
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'in-flight', steps: SubmitProgressStep[] }
  | { kind: 'success', pullRequestReviewId: string }
  | { kind: 'failed', failedStep: SubmitStep, errorMessage: string, steps: SubmitProgressStep[] }
  | { kind: 'foreign-pending-review-prompt', snapshot: OwnPendingReviewSnapshot }
  // The pipeline detected stale-commitOID server-side, deleted the orphan, and cleared
  // session stamps — but has NOT attached any threads. The dialog footer must show:
  //   - Cancel re-enabled (the user may walk away; nothing on github.com to commit yet)
  //   - "Recreate and resubmit" primary button (NOT the in-flight spinner used by 'in-flight')
  //   - Banner copy from § 12
  // Distinct from 'in-flight' specifically because Cancel is enabled and the action is
  // explicit-click, not pending. See § 12 for the full lifecycle.
  // Field is `orphanCommitOid` to match the `submit-stale-commit-oid` SSE payload (§ 7.5),
  // which carries only the commit OID — the orphan review ID is consumed server-side.
  | { kind: 'stale-commit-oid', orphanCommitOid: string };

export function useSubmit(prRef: string): {
  state: SubmitState;
  submit(verdict: Verdict): Promise<void>;
  retry(): Promise<void>;
  resumeForeignPendingReview(reviewId: string): Promise<void>;
  discardForeignPendingReview(reviewId: string): Promise<void>;
  reset(): void;
};
```

Subscribes to the existing SSE channel for `submit-progress`, `submit-foreign-pending-review`, `submit-stale-commit-oid`, `submit-orphan-cleanup-failed`, `submit-duplicate-marker-detected` event types. Maps each into `SubmitState` transitions. Reset clears local state without touching the server. **Multi-tab guard** — `useSubmit` only transitions out of `idle` when its own `submit()` / `retry()` call has returned `200 OK`; SSE events arriving from a foreign tab's submit are ignored at the state-machine level (the dialog's lifecycle is local to the tab that opened it). The cross-tab presence banner from S4 is the surface where foreign in-flight submits surface to other tabs ("Submit in progress in another tab").

### 8.5 Responsive breakpoint table

All S5 dialog/modal/drawer surfaces share the breakpoints below; CSS lives in the existing component-level stylesheets:

| Surface | ≥ 1280px | 900–1279px | < 900px |
|---|---|---|---|
| Submit dialog (§ 8) | 720px wide, centered | 720px wide, centered | full-width minus 32px gutter |
| Foreign-pending-review modal (§ 11) | 480px wide, centered | 480px wide, centered | full-width minus 32px gutter |
| Bulk-discard confirmation modal (§ 13.1) | 480px wide, centered | 480px wide, centered | full-width minus 32px gutter |
| Discard confirmation sub-modal (§ 11.2) | 480px wide, centered | 480px wide, centered | full-width minus 32px gutter |
| Ask AI button + empty-state container (§ 14.2) | inline header button (no overlay) | inline header button (no overlay) | inline header button (no overlay) |

The original drawer breakpoint (480px overlay ≥ 1280px / full-width below) is moot now that the drawer is cut to a static empty state (§ 14.2).

---

## 9. Submit Review button (PR4)

**Placement.** Header bar, replacing the disabled S0–S4 affordance. Same primary-button vocabulary as the rest of the header — no separate cluster.

**Enable rules (per spec § 6 button-disabled list — restated for completeness, no changes to spec rules a–f):**

- **(a)** Disabled when no verdict AND `DraftComments` empty AND `DraftReplies` empty AND `DraftSummaryMarkdown` empty/whitespace.
- **(b)** Disabled when any draft has `Status == Stale`.
- **(c)** Disabled when `DraftVerdictStatus == NeedsReconfirm`.
- **(d)** Disabled when `IPreSubmitValidator` returns blocking errors (PoC: noop returns none; `aiPreview: true` placeholder returns canned results — see § 14.1).
- **(e)** Disabled when verdict = `Comment` AND `DraftComments` empty AND `DraftReplies` empty AND `DraftSummaryMarkdown` empty/whitespace.
- **(f)** Disabled when most-recent active-PR poll observed `head_sha != lastViewedHeadSha` (banner up). Compares head_sha only; no per-issue-comment-id needed (S4 deferral 4 stays deferred).

**Hover tooltip** on disabled state surfaces the specific reason per spec § 6 wording. Click on disabled button focuses the relevant blocker (banner / Drafts tab / verdict picker).

---

## 10. Verdict picker — enabled state (PR4)

**Affordance.** Segmented control with three options: *Approve* / *Request changes* / *Comment*. Visually distinct from button clusters (rounded pill with three slots, the selected slot filled with the option's color). No "no verdict" sentinel — picker is unselected by default; spec § 6 dialog default-to-Comment handles the "user submitted without picking" case.

**Two surfaces, one source of truth.** The picker exists in both the header and the Submit dialog. Both bind to the same `draftVerdict` field on `ReviewSessionState`. Setting the picker in the header reflects in the dialog (and vice versa). When the dialog opens, the dialog's picker shows the header's current value — including the *needs-reconfirm* badge if `DraftVerdictStatus == NeedsReconfirm` (per spec § 5 "Verdict re-confirmation").

**Verdict-clear (revert from selected to no-verdict).** Spec § 6 implicitly supports this — the user can change their mind. Currently broken: `ReviewSessionPatch.DraftVerdict` deserializes `null` as "field absent" and 400s the request. Fix: **switch the patch wire-shape to JsonElement-based parsing** (S4 deferral 5 option (b)) so present-but-null distinguishes from absent.

```csharp
// PRism.Web/Endpoints/PrDraftEndpoint.cs (sketch)
// Patch wire shape moves from typed record to JsonElement-based parsing
// so present-null distinguishes from absent across all current and future patch fields.
public sealed class ReviewSessionPatchParser
{
    public static ReviewSessionPatchOperation Parse(JsonElement body)
    {
        // Iterate body's enumerable properties; each present property is one operation.
        // Present-null sets the field to null; absent leaves it unchanged.
        // Validation: exactly one operation per request (matches existing single-op-per-patch contract).
    }
}
```

This is a generalizable fix — it also benefits `DraftSummaryMarkdown` clear and any future nullable patch field. Lands in PR3 alongside the submit endpoint (same backend PR; small surface).

---

## 11. Foreign-pending-review modal (PR5)

Triggered when the submit endpoint returns `SubmitOutcome.ForeignPendingReviewPromptRequired`. The frontend modal:

**Modal copy** (per spec § 6 step 1, restated): *"You have a pending review on this PR from {createdAt humanized}. It contains {threadCount} thread(s) and {replyCount} reply(ies). Resume it (you'll see the contents before submit), discard it and start fresh, or cancel?"* Counts come from the `submit-foreign-pending-review` SSE payload (§ 7.5); thread/reply bodies are NOT in the payload (security defense) and arrive in the Resume endpoint's 200 response if the user picks Resume.

**Buttons:** *Resume* / *Discard…* / *Cancel*.

**Accessibility.** Uses the existing `<Modal>` component. `defaultFocus="cancel"` (the user must explicitly click Resume or Discard; default focus on Cancel means an accidental Enter does not trigger the destructive path). `disableEscDismiss=false` (Esc closes to Cancel semantics). FocusTrap active within the modal. Aligns with the existing discard-saved-draft modal precedent.

### 11.1 Resume path

Single click on Resume calls `POST /api/pr/{ref}/submit/foreign-pending-review/resume` with `{ pullRequestReviewId: snapshot.PullRequestReviewId }`. Endpoint runs the TOCTOU re-fetch (§ 7.2). On pass, threads import as `DraftStatus.Draft` entries into `draftComments` (with `ThreadId` stamped) and reply chains import as `DraftReply` entries (with `ReplyCommentId` stamped). The endpoint's 200 response carries the full Snapshot B payload so the frontend can render imported drafts immediately. The frontend's standard reconciliation panel renders them; the user adjudicates per-draft (Edit / Delete / Keep) before re-clicking Submit.

**Resolved-on-github.com badge.** Snapshot B's `PendingReviewThreadSnapshot.IsResolved` (per § 4) is carried into the imported draft as a per-draft display badge: *"Resolved on github.com"*. The reconciliation panel shows the badge so the user knows the original thread was already resolved before they decide to re-publish it as part of this submit. Without the badge, importing as `DraftStatus.Draft` would silently strip the resolved-context (the user authored the resolution months ago and forgot). If any imported thread carries `IsResolved=true`, the frontend surfaces a one-time pre-flight confirmation banner above the imported drafts: *"N imported thread(s) were resolved on github.com. Submitting will re-publish them. Edit or Discard the resolved threads first if you don't want to re-publish them."*

**Why `Draft` status not `Moved` or `Stale`.** The threads come from a pending review the user (likely) authored earlier — they're not coming through the reconcile-on-Reload path, so the matrix's classifications don't apply. `Draft` is the honest classification: "user content, not yet submitted, awaiting adjudication." If the user wants to re-anchor or discard, the standard Drafts tab affordances apply.

**Snapshot A → Snapshot B count staleness.** Content the user saw in the original modal (counts from Snapshot A in the SSE event — see § 7.5) may differ from Snapshot B if github.com was mutated during the prompt delay. The frontend computes the staleness check entirely client-side: it retains the counts from the `submit-foreign-pending-review` SSE event (Snapshot A) and compares them against the counts in the `/foreign-pending-review/resume` 200 response (Snapshot B, full payload). When `Snapshot A.threadCount != Snapshot B.threadCount` or `Snapshot A.replyCount != Snapshot B.replyCount`, it surfaces a one-line note above the imported drafts: *"The pending review changed during the prompt — N thread(s) / R reply(ies) imported (you saw M / S in the prompt)."* Per-thread body-level staleness (same count, different content) is **not** detected in PoC scope — doing so would require carrying per-thread body hashes through the SSE event, and the count-mismatch heuristic captures the dominant case (someone added or removed a thread). Body-level changes within the same thread set are accepted silently; the user's adjudication panel still gives them the chance to edit or discard before re-publishing. (Logged as a residual risk in the deferrals sidecar.)

### 11.2 Discard path

Click on *Discard…* opens a confirmation sub-modal: *"Delete the pending review on github.com? Its {N} thread(s) and {M} reply(ies) will be permanently removed. This cannot be undone."* Buttons: *Delete* (destructive, red) / *Cancel*. The sub-modal uses the existing `<Modal>` component with `defaultFocus="cancel"` (destructive precedent: an accidental Enter does not trigger the Delete) and `disableEscDismiss=false`.

On *Delete* confirmation, calls `POST /api/pr/{ref}/submit/foreign-pending-review/discard`. Endpoint runs TOCTOU re-fetch and then the `DeletePendingReviewAsync` call.

**Why a confirmation modal rather than one-click discard.** Discard is destructive (deletes content on github.com that the user may have written intentionally). One-click is a footgun.

### 11.3 Cancel path

*Cancel* closes the modal, no server-side state change. The dialog itself stays open on the original Submit Review screen so the user can re-decide. No endpoint call required; no SSE event published.

**Cancel-button copy** in the modal: *"Cancel — your local drafts and the pending review on GitHub are unchanged."* Inline reassurance avoids the "did anything happen?" ambiguity.

### 11.4 TOCTOU 409 handling (frontend)

On 409 from `/foreign-pending-review/resume` or `/foreign-pending-review/discard` with `code: "pending-review-state-changed"`, the modal closes and `useSubmit` resets to `idle`. The toast (per § 7.2) surfaces. The user is returned to the PR view; clicking Submit Review again re-runs the pipeline from Step 1, which re-detects whether a foreign pending review exists and re-triggers the modal if so (now reflecting the current github.com state) or proceeds normally if the conflict has resolved. `useSubmit.SubmitState` does not need a dedicated `toctou-conflict` kind — `idle + toast` is sufficient since the user's recovery path is just "retry submit."

---

## 12. Stale-`commitOID` retry UX (PR5)

When the pipeline emits `SubmitOutcome.StaleCommitOidRecreating`, the frontend shows an in-dialog banner before continuing:

**Banner copy:** *"The PR's head commit changed since this pending review was started. Recreating the review against the new head sha {currentHeadSha[0..7]}. Your drafts are preserved and will be re-attached."*

**Behavior.** The banner appears in the dialog body (above the verdict picker, below the dialog title). The banner stays visible **until the user explicitly clicks** *"Recreate and resubmit"* (primary) or *"Cancel"* (secondary, returns to pre-Confirm dialog state). The `state.json` already has the cleared `PendingReviewId` / `PendingReviewCommitOid` / draft `ThreadId` / reply `ReplyCommentId` from the pipeline's `StaleCommitOidRecreating` outcome — that part already happened server-side; the user is consenting to the *resubmit*, not the recreation.

**Dialog state during the banner.** `useSubmit.state.kind === 'stale-commit-oid'` (per § 8.4). This kind is deliberately *not* `in-flight` because the user-facing affordance differs: Cancel is **re-enabled**, the primary button text is *"Recreate and resubmit"* (not a spinner), and Confirm-level click lands the user back in Phase B of § 8.3 once the resubmit fires. The footer wiring during the `stale-commit-oid` kind:

- **Cancel** — enabled. Closes the dialog and returns the user to the PR view; `useSubmit.state` resets to `idle`. No server-side action needed (the orphan was already deleted; session stamps are already cleared). The user can walk away and resume later — the next Submit Review click runs Step 1 cleanly.
- **Recreate and resubmit** — primary. Calls `useSubmit.retry()`, which fires `POST /api/pr/{ref}/submit` with the same verdict. `useSubmit.state` transitions to `in-flight`; § 8.3 Phase A re-engages until Step 2 stamps the new `PendingReviewId`. From Step 3 onward, Cancel is permanently disabled per § 8.3.

**Why explicit click rather than auto-retry.** Approving code the reviewer hasn't seen is the spec's stated worst-case failure mode (Problem Frame). An auto-retry timed at 2 seconds is shorter than typical AFK windows (Slack ping, coworker question); a user who looks away for 3 seconds returns to find their verdict has been re-anchored to a new head sha they have not viewed. The "explicit-consent surrogate" framing the earlier draft used does not survive contact with realistic user attention patterns. The explicit click is the only consent shape that actually behaves as consent.

**Pre-Finalize head_sha re-poll.** After the user clicks "Recreate and resubmit" but before Step 5 runs, the pipeline performs one final `head_sha` poll. If drift occurred during the in-progress pipeline (the author pushed again while the new pending review's threads were being attached), the pipeline aborts back to rule (f) — surfaces the standard `head_sha drift` blocker; the user sees the Reload banner and must Reload before submitting. This closes the "shifted under us mid-pipeline" residual window the explicit-button defense alone doesn't cover.

**If the user has not yet Reloaded against the new head** (e.g., the pipeline detected the stale-`commitOID` server-side without an intervening Reload click on the frontend), the banner copy gains a second sentence: *"Click Reload first to re-classify your drafts against the new diff."* The footer wiring is identical to the standard `stale-commit-oid` kind above except *"Recreate and resubmit"* is **disabled** with tooltip: *"Reload the PR first to re-classify drafts against the new diff."* (Cancel remains enabled.) This consistency with § 8.3's "Cancel disabled during pipeline run" rule is precisely the point of the `stale-commit-oid` kind being separate from `in-flight`: Cancel is only permanently disabled in Phase B step 3+ of the pipeline (threads being attached); the stale-`commitOID` recreation has not yet attached anything (only the orphan delete + state clear has run, both of which are reversible by the user re-deciding to walk away).

---

## 13. Closed/merged PR bulk-discard (PR5)

Per spec § 5 "Drafts on a closed or merged PR" — S4 ships only the read-only banner + composer suppression; S5 ships the full bulk-discard flow.

### 13.1 "Discard all drafts" button

Renders as `btn btn-danger btn-sm` to the **left** of the disabled Submit Review button within the existing `pr-actions` cluster, so the read order is `[Discard all drafts | Submit Review (disabled)]`. Visible only when the PR is closed/merged AND the session has at least one draft / reply / non-empty summary / `pendingReviewId`. The Verdict button is **hidden** (not just disabled) when the PR is closed/merged — no verdict can be set on a closed PR, so showing it as disabled adds noise. At narrow widths (< 600px), the button label shortens to *"Discard"* (the count is in the confirmation modal).

Click opens a confirmation modal listing the draft count: *"Discard {N} draft(s) and {M} reply(ies) on this closed PR? This cannot be undone."* Buttons: *Discard* (destructive) / *Cancel*. Modal uses the existing `<Modal>` component with `defaultFocus="cancel"`.

### 13.2 Endpoint and sequence

`POST /api/pr/{ref}/drafts/discard-all` (new endpoint). Body cap: extend the same pre-routing `UseWhen` predicate in `PRism.Web/Program.cs:99–142` to match this path; body is empty in practice so it inherits the existing 16 KiB cap (rationale identical to § 7.1's note — `[RequestSizeLimit]` doesn't fire pre-binding for minimal APIs). The endpoint:

1. Reads `pendingReviewId` from session state. Captures it locally.
2. Clears all session state via `AppStateStore.UpdateAsync`: `DraftComments = []`, `DraftReplies = []`, `DraftSummaryMarkdown = null`, `DraftVerdict = null`, `PendingReviewId = null`, `PendingReviewCommitOid = null`. Publishes `StateChanged`.
3. **If `pendingReviewId` was set**, fires `IReviewSubmitter.DeletePendingReviewAsync(reference, pendingReviewId)` as a courtesy cleanup. The result is logged but **not awaited as a blocker** — the local clear has already succeeded; the remote call is best-effort.
4. On remote-call failure (network error, 404, etc.), publishes a `submit-orphan-cleanup-failed` SSE event with `{ prRef }`. The `pendingReviewId` is **not** in the SSE payload (same threat-model defense as `submit-progress` — broadcast across subscribed tabs unnecessarily widens the data surface; the toast doesn't need the ID). Server-side logging may include the `pendingReviewId` for debugging, gated through `SensitiveFieldScrubber` (which should add `pendingReviewId` / `threadId` / `replyCommentId` to its blocked-fields list before PR3 lands; see § 18.2).

Frontend renders a one-time toast on `submit-orphan-cleanup-failed`: *"Local drafts cleared. The pending review on GitHub may persist; it will be cleaned up on the next successful submit on this PR."* Toast pattern is the simple existing one (no consolidated toast/inline-error system; that's S6 polish per S4 deferral 8).

### 13.3 Authorization

Same broader-than-spec pattern as `markAllRead` and `submit` — `cache.IsSubscribed(prRef)`. PoC scope.

---

## 14. AI placeholder slots (PR6)

### 14.1 Pre-submit validator card

**Slot location.** Inside the Submit dialog body, between the verdict picker and the PR-level summary textarea (per § 8.1 dialog body order).

**Default behavior.** PoC ships `NoopPreSubmitValidator` registered in DI (returns empty `ValidationResult[]`). The slot renders `null` when the array is empty. Submit Review button rule (d) is therefore false in default PoC.

**`aiPreview: true` behavior.** The slot consumes canned data **frontend-side**, matching the S0–S4 precedent for AI placeholders (S3's AI summary card, file-focus dots — frontend stub data, not backend-served). No `IPreSubmitValidator.ValidateAsync` call is made. Backend interface and Noop impl stay as-is.

**Canned content for the demo.** A single `Suggestion`-severity validation: *"3 inline threads on the same file (`src/Foo.cs`) — consider consolidating?"*

**Styling pattern.** Card uses `className="ai-validator-card ai-tint"`, mirroring the AiSummaryCard's `ai-tint` class so the validator card and the Overview-tab AI summary share visual language. Severity badge renders as a chip via the existing `chip-status-*` vocabulary (`chip-status-suggestion` for `Suggestion`, `chip-status-concern` for `Concern`, `chip-status-blocking` for `Blocking`). The *Show me* link renders as `<button disabled aria-disabled="true">` (not an anchor) with `cursor: default` in placeholder mode — keeps it out of the tab order as a dead link while preserving the slot for v2's real navigation.

**Validation timing in the dialog.** Renders on dialog open (canned data is static, so no async call). Production blocking-on-Confirm semantics (where validators run synchronously to the Confirm click and block submit if any return `Blocking` severity) ship in v2 — the v2 P2 implementation will call `IPreSubmitValidator.ValidateAsync` from the endpoint layer (§ 7.1) before Step 1, returning a 422 with the validator results if any are `Blocking`.

### 14.2 Ask AI button (static empty state)

**Originally scoped as an interactive drawer; cut after doc-review.** The earlier draft of this section described a right-side 480px drawer with a pre-baked "AI is typing…" conversation surface. Doc-review surfaced that an interactive-looking-but-disabled chat UI sets up exactly the wrong expectation for the N=3 external validation cohort: a tester who flips `aiPreview: true` to see what's there hits a chat surface that looks real, types into the disabled input, and reads the "Chat coming in v2" tooltip as "tool feels half-done." The S0–S4 placeholder precedent the earlier draft invoked is not analogous — prior placeholders (chips, badges, summary card, focus dots) are *display* surfaces; an input bar with "AI is typing…" is an *interactive* affordance that withdraws itself. The drawer is cut to a static empty state to avoid the validation-gate footgun. (The architectural seam is preserved by the button + container; v2's real chat slots into the same button without testers having seen a fake version first.)

**Slot location.** *"Ask AI"* button in the PR header (no overlay, no drawer).

**Default behavior.** Button hidden when `aiPreview: false`. No backend touchpoint at all.

**`aiPreview: true` behavior.** Click the button → an inline empty-state container appears below the PR header with the copy:

> **Ask AI — coming in v2**
>
> v2 will let you ask questions about this PR's changes, with the assistant grounded in the diff and the conversation. The PoC ships the seam — the architectural slot — without the chat surface itself, to avoid setting up an interaction the tool can't deliver yet.

The container has a single Close (✕) button. No chat input bar, no message bubbles, no "AI is typing…" indicator, no disabled-but-realistic affordance. Capability flag `ai.chat` stays `false` in `/api/capabilities`; the button visibility is gated on `aiPreview` directly.

**`aiPreview: true` behavior (zero-decision path).** Empty state. No further user-visible behavior. The button + empty state preserves the seam structurally so v2's `IPrChatService` lazy-upgrade path slots into the same button affordance without restructuring the React tree — but no fake-feeling chat is ever rendered.

---

## 15. Test infrastructure

### 15.1 Fakes split alongside `IReviewService`

Per § 3, the four capability sub-interfaces each get their own fake. Existing test classes that injected `FakeReviewService` migrate to inject only the sub-interface(s) they need. Most tests touch one or two sub-interfaces; the migration is straightforward.

**`FakeReviewSubmitter`** (new) implements the seven methods on `IReviewSubmitter`. Carries an in-memory `Dictionary<string, FakePendingReview>` keyed by `pullRequestReviewId`. Each `FakePendingReview` carries threads, replies, `commitOID`. Configurable failure injection per method (e.g., "fail on the second `AttachThreadAsync` call with a network error"). The pipeline state-machine tests (§ 5.4) are the primary consumer.

### 15.2 Playwright fake (`PRISM_E2E_FAKE_REVIEW=1`)

S4 PR7 added the env-guarded `/test/*` endpoints + `FakeReviewService` for E2E. S5 extends:

- `FakeReviewSubmitter` registered when env var is set.
- `/test/submit/inject-failure` endpoint — sets the next-call failure mode for the fake submitter.
- `/test/submit/inject-foreign-pending-review` endpoint — pre-populates a foreign pending review for the next `FindOwnPendingReview` call.
- `/test/submit/inject-stale-commit-oid` endpoint — pre-populates a pending review whose `commitOID` differs from the PR's current head.
- `/test/submit/inspect-pending-review` endpoint — read-only inspection of the fake's in-memory pending-review state, for assertions.

### 15.3 E2E specs (DoD coverage)

New Playwright specs in `frontend/e2e/`:

- `s5-submit-happy-path.spec.ts` — the demo flow steps 11–13 against the fake submitter. Asserts the dialog opens, the user types a summary, picks a verdict, confirms, sees the progress checklist advance, sees the success state.
- `s5-submit-retry-from-each-step.spec.ts` — DoD test (b). Uses `/test/submit/inject-failure` to fail at each step in turn; asserts retry resumes correctly.
- `s5-submit-foreign-pending-review.spec.ts` — DoD tests (c) and (d). Both Resume and Discard paths.
- `s5-submit-stale-commit-oid.spec.ts` — DoD test (e). Banner appears, retry succeeds.
- `s5-submit-lost-response-adoption.spec.ts` — Asserts unstamped drafts adopt server-side thread IDs via marker matching.
- `s5-submit-closed-merged-discard.spec.ts` — Closed PR with drafts; bulk-discard clears local state; orphan-cleanup-failed toast surfaces when the fake is configured to fail the courtesy delete.

If C7 falsifies, replace `s5-submit-lost-response-adoption.spec.ts` with `s5-submit-body-normalization-parity.spec.ts` covering the fallback matcher.

**State-leak fix is a prerequisite** (§ 2.3). All new E2E specs must run cleanly in the same Playwright run as the existing S4 specs (no `test.fixme`).

---

## 16. Slice cut

Strawman cut, adjustable during `ce-plan`. PR0 is the only firm sequencing constraint — every other PR's order can shift if it doesn't break dependencies.

| PR | Scope | Tests landing here |
|---|---|---|
| **PR0** | ADR-S5-1 capability split (pure refactor); C6 + C7 + C9 empirical-gate runs (results recorded in [`../spec/00-verification-notes.md`](../spec/00-verification-notes.md)); Playwright multi-spec state-leak root-cause + fix; un-`fixme` of S4 PR7's three deferred specs. **PR0a/PR0b split is a planning-time call** (see § 18.2) — if the state-leak fix is genuinely independent and the schedule benefits, split into PR0a (capability split + empirical gates) and PR0b (state-leak fix). | Existing tests stay green. New: re-classed fake tests. |
| **PR1** | `IReviewSubmitter` six-method surface (§ 4); `GitHubReviewService.Submit.cs` against real GraphQL using empirical-gate-confirmed parameter shapes; ADR-S5-2 partial-class split if `GitHubReviewService.cs` becomes unwieldy. **No PRism-side state machine yet.** **No `IPrDetailLoader.GetFiles()` wiring** — that work is deferred to S6 polish per § 1.2 non-goals (the existing reconciliation matrix already produces `Stale` for unmapped renames; the wiring is an accuracy improvement, not a submit-pipeline correctness requirement). | `GitHubReviewService.Submit` integration tests hitting a sandbox PR (skipped in CI; runnable locally). |
| **PR2** | `SubmitPipeline` state machine in `PRism.Core/Submit/Pipeline/` (§ 5); marker injection; lost-response adoption with multi-match defense (§ 5.2 step 3); v3→v4 migration. | All six pipeline state-machine unit tests (§ 5.4) plus a multi-marker-match test. Schema migration test. |
| **PR3** | Backend endpoints (§ 7): `POST /submit` (with per-PR submit lock per § 7.1), `POST /submit/foreign-pending-review/resume`, `POST /submit/foreign-pending-review/discard`, `POST /drafts/discard-all`. Composer marker-prefix collision rejection (§ 4) on the existing `PUT /draft` endpoint. SSE event types (`submit-progress`, `submit-foreign-pending-review`, `submit-stale-commit-oid`, `submit-orphan-cleanup-failed`, `submit-duplicate-marker-detected`). Verdict-clear patch-shape fix (§ 10). `SensitiveFieldScrubber` blocked-fields list extended with `pendingReviewId` / `threadId` / `replyCommentId`. | Endpoint contract tests; SSE event publication tests; per-PR submit lock concurrency test. |
| **PR4** | Frontend Submit dialog (§ 8 + § 8.5 responsive table); `useSubmit` hook with multi-tab guard (§ 8.4); Submit Review button enable rules (§ 9); verdict picker enabled state with frozen-during-pipeline behavior (§ 10 + § 8.3). | Component tests for dialog + button; hook tests against a mocked SSE stream including foreign-tab event ignore-list. |
| **PR5** | Foreign-pending-review modal with a11y + IsResolved badge + Snapshot-A/B body-staleness note (§ 11); TOCTOU 409 frontend handling (§ 11.4); stale-`commitOID` retry with explicit-button consent + pre-Finalize head_sha re-poll + not-Reloaded UX (§ 12); closed/merged bulk-discard UX with concrete button placement (§ 13); submit-progress / submit-failure inline UI; `submit-duplicate-marker-detected` event handling (one-time toast). | Component tests for modal flow + banners + IsResolved badge rendering. |
| **PR6** | AI placeholder slot wiring (§ 14): pre-submit validator card under `aiPreview: true` only. Ask AI button + static empty-state container (§ 14.2). **No interactive drawer** — the originally-planned drawer is cut to avoid the validation-cohort UX footgun. **PR6 may fold into PR4** if scope permits — the validator card is naturally part of the dialog, and the Ask AI button + empty state is a small header addition; combining cuts the slice from 8 PRs to 7. Planning decides. | Component tests for placeholder rendering + capability gating. |
| **PR7** | DoD test sweep (§ 15.3): all six E2E specs; closed/merged tests; C7-fallback test if applicable; multi-tab simultaneous-submit test (asserts the per-PR submit lock returns 409 for the losing tab); marker-prefix-collision composer-rejection test. | Every DoD-mandated submit-pipeline test asserted against the full backend + frontend stack. |

---

## 17. Key decisions

Decisions captured during the brainstorm and folded into the spec body above. Numbering is reference-only; spec sections are the source of truth.

1. **Stepwise `IReviewSubmitter`** (§ 4) — seven methods, not a composite single-call. Step-granular fakes for the resumable retry tests; state machine lives in `PRism.Core` per Convention-1.
2. **Submit-progress over SSE** (§ 7.4) — payload is step name + counts only (no per-draft IDs); reuses existing channel infrastructure; threat-model defense for S4 deferral 12.
3. **V4 migration step for `DraftComment.ThreadId`** (§ 6) — visible version bump with empty transform body, not silent additive field. Matches user's "document plan deviations visibly" preference and spec § 4.5's schema-versioned framing.
4. **Verdict-clear patch wire-shape via JsonElement parsing** (§ 10) — option (b) from S4 deferral 5; generalizable to any future nullable patch field.
5. **Submit endpoint authorization stays broader-than-spec** (§ 7.1) — same pattern as `markAllRead`. Tightening both endpoints together is a separate cleanup; PoC scope per spec § 6.2.
6. **Submit-time fan-out is sequential** (§ 4 / § 5) — easier idempotency, makes step-by-step SSE events legible. No file-fetch-style concurrency cap.
7. **Marker injection in `SubmitPipeline`, not user-visible code** (§ 4) — body-cap accounting includes the marker; unclosed-fence detection re-closes the user's body before appending.
8. **PR-level summary lives in the dialog, not the header** (§ 8.2) — auto-saved across Cancel/reopen; cleared on success. No fourth markdown rendering pipeline.
9. **Esc does not auto-dismiss** (§ 8.1) — focuses Cancel instead; protects against accidental loss of in-progress submit-flow context.
10. **Cancel during pipeline run is disabled** (§ 8.3) — hard commitment per spec § 6; cancellation mid-flight isn't safe.
11. **Submit failure UX: dialog stays open with checklist + Retry** (§ 8.3) — no banner-and-reopen friction; the checklist is the source of truth for what already happened.
12. **Foreign-pending-review Discard requires confirmation modal** (§ 11.2) — destructive on github.com.
13. **Foreign-pending-review Resume imports as `Draft` status** (§ 11.1) — honest classification; the user adjudicates via the standard Drafts tab.
14. **Stale-`commitOID`-retry banner is gated on explicit user click**, not 2-second auto-retry (§ 12). Earlier draft had a 2-second auto-fire as the "consent surrogate"; revised after doc-review surfaced that 2 seconds is shorter than typical AFK windows (Slack ping, coworker question), so a user who looks away for 3 seconds returns to find their verdict re-anchored to a new head sha they have not viewed — the spec's named worst-case failure mode. The fix is the explicit "Recreate and resubmit" button; pre-Finalize head_sha re-poll closes the residual mid-pipeline drift window.
15. **AI validator placeholder renders frontend-side canned data** (§ 14.1) — matches S0–S4 precedent; backend stays Noop.
16. **Ask AI drawer is cut to a static empty state** (§ 14.2) — the original interactive drawer with pre-baked conversation seed was cut after doc-review surfaced the validation-cohort UX risk that an interactive-looking-but-disabled chat surface would land as "tool feels half-done" in the N=3 trial. The button + empty-state container preserves the architectural seam (v2's real chat slots into the same button affordance) without testers seeing a fake version first. PR6 shrinks correspondingly and may fold into PR4.
17. **Validator timing: render on dialog open in PoC** (§ 14.1) — production blocking-on-Confirm ships in v2.
18. **Submit Review button uses primary-button vocabulary in the header** (§ 9) — replaces disabled state in place, no separate cluster.
19. **Verdict picker is a segmented control** (§ 10) — three slots, mirrored between header and dialog.
20. **`IPrDetailLoader.GetFiles()` rename/delete wiring is deferred to S6 polish** — earlier draft had it landing in S5 PR1 alongside submit work; revised after doc-review surfaced that the existing reconciliation matrix already produces `Stale` for unmapped renames and deletions (per § 5 reconciliation), so the wiring is an accuracy improvement (re-anchors renamed-file drafts as `Moved` instead of `Stale`) rather than a submit-pipeline correctness requirement. Closes S4 deferral 7 when it lands, but doesn't block S5.
21. **Playwright multi-spec state-leak gets root-caused before S5's specs land** (§ 2.3) — no more `test.fixme` suites in S5.
22. **Slice cut is 8 PRs** (§ 16) — PR6's validator-card-only scope (after the Ask-AI drawer cut) is small enough that the plan folds it into PR4; PR0 is pre-split into PR0a (capability split + C6/C7/C9 gates) + PR0b (Playwright state-leak fix). Net deliverables: PR0a, PR0b, PR1, PR2, PR3, PR4, PR5, PR7. PR0a → PR1 sequencing is the only firm constraint; PR0b runs parallel, off the demo critical path.
23. **Lost-response retry includes multi-marker-match defense** (§ 5.2 step 3, § 5.3) — earlier draft assumed singular match; revised after doc-review surfaced the GitHub eventual-consistency window that can produce duplicate markers. Adopt earliest by `createdAt` and best-effort delete the others; emit `submit-duplicate-marker-detected` SSE event so the user is aware.
24. **Per-PR submit lock prevents multi-tab collision** (§ 7.1) — earlier draft had no defense against two tabs both clicking Submit; revised after doc-review surfaced that the losing tab would mis-trigger the foreign-pending-review prompt against its own content. Lock is a separate primitive from `AppStateStore._gate` to avoid the publication-vs-_gate ordering hazard.
25. **`DraftSubmitted` publication is outside `_gate`** (§ 5.2 step 5) — restated from the S4 design § 4.5 ordering contract since S5 is the first slice with a producer. Endpoint publishes both `DraftSubmitted` and `StateChanged` after `AppStateStore.UpdateAsync` returns.
26. **Foreign-pending-review SSE payload carries counts only, not bodies** (§ 7.5) — the `submit-progress` threat-model defense (no per-draft IDs) extends to all submit-* events; bodies arrive only in the Resume endpoint's 200 response when the user explicitly opts in. Same defense applies to `submit-stale-commit-oid` (no `orphanReviewId`) and `submit-orphan-cleanup-failed` (no `pendingReviewId`).
27. **Snapshot B carries `IsResolved` per imported thread** (§ 4 / § 11.1) — without this, foreign-pending-review Resume strips the github.com Resolved status from imported threads and the user submits previously-resolved content as if it were fresh. Resolved badge surfaces in the Drafts panel + pre-flight confirmation banner if any imported thread is resolved.
28. **Marker-prefix collision rejected at composer save time** (§ 4) — defends against user bodies that contain the literal `<!-- prism:client-id:` substring (deliberately or accidentally) confusing the lost-response adoption matcher. Composer surfaces a structured 400 with inline error text.
29. **Empty-pipeline finalize empirical gate (C9) added** (§ 2.3a) — earlier draft assumed GraphQL accepts a Comment-verdict review with no attached threads. C9 verifies; documented fallback uses the legacy REST endpoint (or a synthetic-thread variant) if the assumption fails.
30. **C7 fallback (parity matcher) is not just a "wording change"** (§ 2.2) — earlier draft framed the fallback as a § 5 step 3 wording update; revised after doc-review surfaced that the parity matcher has different idempotency semantics (cannot disambiguate two drafts with identical filePath+line+body) and needs a tiebreaker + pre-submit dedupe step. Estimated additional cost named explicitly.

---

## 18. Outstanding questions

### 18.1 Resolve before planning

- **(none open)** — every product / scope decision in this spec is pinned. The empirical gates in § 18.3 (C6 / C7 / C9) are objective, not user-judgment, decisions; their fallback paths are documented.

**Resolved during this spec's brainstorm + doc-review cycle:**

- **2026-05-11 — Submit dialog information architecture: verdict-first.** Doc-review surfaced a defensible alternate IA leading with counts + validator before verdict ("show evidence before asking for decision"); user picked verdict-first because most reviewers arrive with a verdict in mind from the review session. If the call needs to be reopened, swap items 1↔3 in § 8.1 dialog body order before PR4 starts — small spec edit, larger downstream impact on PR4 component shape. See § 8.1a for the rationale.

### 18.2 Deferred to planning (`ce-plan` answers from codebase exploration)

- **[Affects PR0][Process]** PR0a/PR0b split — bundle ADR-S5-1 capability split + C6/C7/C9 empirical gates + Playwright state-leak fix into one PR (PR0), or split state-leak into PR0b that can land in parallel with PR1? Doc-review flagged that the state-leak fix has zero dependency on the capability split and on the empirical gates, so the bundling is sequencing-by-convention. The escalation valve in § 2.3 ("if root-cause exceeds 1 day, escalate") makes the worst-case manageable, but the cleanest split keeps unrelated risk profiles separate. ce-plan picks based on whether the state-leak hypothesis converges on a same-day fix during PR0 scoping.
- **[Affects PR1][Technical]** Octokit's GraphQL helper vs raw `HttpClient` for `GitHubReviewService.Submit.cs`. PR1 implementer picks based on existing GraphQL usage in `PRism.GitHub` (none today; either is greenfield).
- **[Affects PR2][Technical]** Per-step persistence boundary inside `SubmitPipeline` — does each successful per-thread `AttachThreadAsync` call `AppStateStore.UpdateAsync` directly, or does the pipeline accumulate updates and persist at step-boundary granularity? Spec says "persist after every stamp" (§ 5.2 step 3); plan refines to specific control-flow.
- **[Affects PR3][Technical]** The `submit-progress` SSE event's payload shape — whether the `step` field uses C# enum names (`"AttachThreads"`) or kebab-case (`"attach-threads"`). Existing SSE events use camelCase property names; the kebab-vs-PascalCase choice for enum values is a small consistency call.
- **[Affects PR3][Lands in PR3]** `SensitiveFieldScrubber` blocked-fields extension — add `pendingReviewId`, `threadId`, `replyCommentId` to `BlockedFieldNames`. Lands as part of PR3's scope per § 16 (the row says "scrubber extension"); listed here as a planning concern only because the field-name list and the call-site sweep need ce-plan's codebase tour to enumerate. Currently the scrubber blocks `subscriberId`, `pat`, `token`. The submit pipeline introduces the first call sites where these new fields could appear in structured logs.
- **[Affects PR4][Technical]** Submit dialog component placement — top-level modal vs portal vs inline. PoC has no portal pattern yet; modal pattern is established (`<Modal>`). Plan picks per existing component conventions; the dialog's 720px width + scrollable body may want React.createPortal to avoid PrHeader-mounted clipping.
- **[Affects PR5][Technical]** Confirmation sub-modal for Resume — should it block before the TOCTOU re-fetch, or after? Spec is silent; the safer default is "after" (re-fetch first, modal asks "found N threads to import — continue?"), but this adds a round-trip. Plan decides.

### 18.3 Empirical gates (block PR1)

- **[Affects PR1][Empirical]** C6 — `AddPullRequestReviewThreadInput` parameter shape (§ 2.1). Run before PR1.
- **[Affects PR2][Empirical]** C7 — HTML-comment marker durability (§ 2.2). Run before PR1 (so PR1 can choose between marker scheme and normalization fallback). Determines whether PR2 ships marker-based adoption or normalization-parity matcher.
- **[Affects PR1][Empirical]** C9 — `submitPullRequestReview` accepts a Comment-verdict review with no attached threads (§ 2.3a). Run before PR1. Determines whether the empty-pipeline finalize ships as written or via the legacy REST fallback.

---

## 19. Cross-references

- Spec authority: [`../spec/03-poc-features.md`](../spec/03-poc-features.md) § 5 *Drafts on a closed or merged PR*, § 6 *Submit flow*; [`../spec/04-ai-seam-architecture.md`](../spec/04-ai-seam-architecture.md) § AI validator results section + `IPreSubmitValidator` interface.
- DoD: [`../spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) § *Definition of done*.
- Verification gates: [`../spec/00-verification-notes.md`](../spec/00-verification-notes.md) § C1, C6, C7.
- Architectural readiness: [`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) § ADR-S5-1, ADR-S5-2, Convention-1.
- Prior slice deferrals: [`2026-05-06-s3-pr-detail-read-deferrals.md`](2026-05-06-s3-pr-detail-read-deferrals.md), [`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md).
- This slice's deferrals sidecar: [`2026-05-11-s5-submit-pipeline-deferrals.md`](2026-05-11-s5-submit-pipeline-deferrals.md) — records brainstorm-time deferrals (S6 / v2 / planning targets), doc-review FYI observations, and forward-looking residual risks for the implementer.
- Roadmap: [`../roadmap.md`](../roadmap.md) § S5 row.
