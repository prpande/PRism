---
date: 2026-06-01
type: feat
status: draft
origin: brainstorm session 2026-06-01
slice: post-S6 submit-lifecycle gaps
deferrals: docs/specs/2026-06-01-pr-root-post-and-submit-discard-deferrals.md
---

# PR-root Post path + discard own pending review

## 1. Goal

Close two related submit-lifecycle gaps that surfaced together in dogfooding:

1. **No way to send a PR-level conversation comment without going through Submit review.** The `PrRootReplyComposer` creates a draft (anchor `kind: 'pr-root'`, file/line/sha all null), but `SubmitPipeline.AttachThreads` rejects PR-root drafts with `SubmitFailedException("draft … has no diff anchor")` at `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:284-292`. The user has typed something, saved a draft, and has no destination for it.
2. **No way to discard an own pending review.** When a prior Submit attempt left a pending review on GitHub (e.g., the issue 1 failure, or any other mid-pipeline error), there is no UI surface to clear it. The pipeline already has the discard primitive (`IReviewSubmitter.DeletePendingReviewAsync` is used at `SubmitPipeline.cs:88` for the stale-commitOID branch) and `ClearPendingReviewStamps` at `SubmitPipeline.cs:603-612`, but they are not user-driven. Foreign pending reviews **can** be discarded via `/submit/foreign-pending-review/discard`; own pending reviews cannot.

This spec closes the open S5 deferral at `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:383-388` (**Defer — PR-root drafts are not submittable via the pending-review pipeline**) by adopting its revisit-when trigger: "Dogfooding surfaces users actually creating PR-root drafts and expecting them to submit, OR a follow-up adds 'merge PR-root drafts into the review summary on submit' to the spec." Both conditions are now true.

## 2. Scope

**In scope.**

- A new "Post" terminal action on `PrRootReplyComposer` that sends the PR-root draft as a standalone GitHub issue comment via the issue-comments REST API (independent of the review pipeline).
- Unification of `ReviewSessionState.DraftSummaryMarkdown` with the PR-root `DraftComment` — one canonical "PR-level body" slot, lifted via state migration V6 → V7.
- A new `PrRootBodyEditor` shared component (textarea + autosave + readOnly + closed-banner gates) consumed by both `PrRootReplyComposer` (wrapped with Discard/Post/Preview/AI affordances) and `SubmitDialog` (wrapped with the inline-edit toggle described in § 4.8). Single source of truth for the body-editing primitive.
- Submit-pipeline change so the PR-root draft body becomes `review.body` when the user clicks Submit. The `FilePath is null` throw is removed and PR-root drafts are filtered out of the AttachThreads loop.
- A new `POST /api/pr/{owner}/{repo}/{number}/submit/discard` endpoint that signals any in-flight pipeline, awaits release, deletes the GitHub-side pending review, and runs `ClearPendingReviewStamps`. Idempotent.
- A new `SubmitCancellationRegistry` DI singleton (parallel to `SubmitLockRegistry`) that lets the discard endpoint cancel an in-flight pipeline at the next CancellationToken-aware boundary.
- Two UI surfaces for discard: the `SubmitDialog` footer (when one is open) and a `PrHeader` pill (when one is not). One shared confirmation modal.
- Test endpoints to force the new failure paths deterministically in Playwright.

**Out of scope.**

- "Add single comment" for inline drafts (GitHub's per-thread non-review-bound post). Inline drafts continue to require Submit review.
- Editing or deleting an already-posted PR-root comment from inside PRism — Posted comments are owned by GitHub; edit on GitHub if needed. This is a deliberate positioning choice: **PRism is a draft authoring tool; posted content is GitHub-owned and managed there.** Future "PRism can do X to a posted comment" asks reach back to this statement.
- Re-posting the same draft after Post failure-then-success (idempotency stamp covers the success-then-stuck-delete path; no other path needs idempotency tokens).
- Recovering from a `submit/discard` 502 by leaving the pending review half-cleared. The endpoint must keep both sides consistent (either both clean or both stamped).
- Multi-account / multi-host changes. The new endpoints inherit `cache.IsSubscribed(prRef)` auth from S6.

## 3. Background

Two PRism artifacts already exist that this design will reconcile:

- **`ReviewSessionState.DraftSummaryMarkdown`** (`PRism.Core/State/AppState.cs:55`) — a single string. Edited in the SubmitDialog summary textarea (`frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx:72,92`). Passed to `IReviewSubmitter.BeginPendingReviewAsync(...summaryBody, ct)` at `SubmitPipeline.cs:173` as `review.body`.
- **PR-root `DraftComment`** — a `DraftComment` row with `FilePath`, `LineNumber`, `AnchoredSha`, and `AnchoredLineContent` all null, and `Side: "pr"` (the marker value). Created by the `newPrRootDraftComment` patch at `PrDraftEndpoints.cs:271-285`. Composed in `PrRootReplyComposer` on the Overview tab. Today the submit pipeline cannot ship it; rule (e) of `SubmitAsync` at `PrSubmitEndpoints.cs:117-122` lets it through the gate (because `DraftComments.Count > 0`), but the pipeline throws at `AttachThreads`.

These two artifacts model the same intent — "the body of this PR-level message" — in two different fields with two different destinations and two different editors. The unification in § 4 collapses them.

The S5 deferral at `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:383-388` predicted exactly the symptom: "Dogfooding surfaces users actually creating PR-root drafts and expecting them to submit."

## 4. Design — PR-level body unification and Post path

### 4.1 Data model

**Drop `ReviewSessionState.DraftSummaryMarkdown`.** The field is removed from `AppState.cs:55`. State version bumps V6 → V7.

**The PR-root `DraftComment` becomes the canonical PR-level body.** No structural change to `DraftComment` (the existing anchor-null + `Side: "pr"` shape is already the PR-root form). At most one PR-root draft per PR — the composer reliably enforces this via `existingPrRootDraft` hydration in `PrRootConversation.tsx:73-80`, but the backend `newPrRootDraftComment` patch at `PrDraftEndpoints.cs:271-285` does **not** enforce uniqueness today; it always appends. The spec adds backend enforcement via a new branch in the patch handler: when a PR-root draft already exists in the session, `newPrRootDraftComment` becomes an upsert that updates the existing draft's `BodyMarkdown` rather than creating a duplicate row. This makes the invariant self-defending and matches what the composer expects.

**Add `PostedCommentId: long?`** as a new trailing-default field on `DraftComment`:

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
    string? ThreadId = null,
    long? PostedCommentId = null);  // V7 — REST databaseId of the issue comment, stamped by
                                    // /root-comment/post on success. Matches IssueCommentDto.Id
                                    // (also long) so a frontend correlation lookup is trivial.
```

The trailing-default placement matches the `ThreadId` precedent at `AppState.cs:73`. Pre-V7 entries deserialize to `PostedCommentId = null` without migration touching them.

`PostedCommentId` is meaningful only on PR-root drafts. Inline drafts leave it null (no path stamps it). The field is not removed by `ClearPendingReviewStamps` — Posted comments are not part of the review and survive a submit-discard. The type is `long` (matches `IssueCommentDto.Id` at `PRism.Core.Contracts/IssueCommentDto.cs:3-7`); the `node_id` (string) returned by GitHub's REST endpoint is intentionally not stored — `Id` is sufficient for any "is this the comment I just posted?" correlation.

**Upsert race.** Backend `newPrRootDraftComment` upsert (described above) executes inside `AppStateStore.UpdateAsync`, which is serialized by `_gate`. Two simultaneous PUT /draft calls cannot both observe "no existing PR-root draft" — the first commits, the second sees the existing row and routes through the update branch. The plan must include a focused test exercising racing newPrRootDraftComment calls asserting "exactly one row persisted."

### 4.2 State migration V6 → V7

`AppStateMigrations.MigrateV6ToV7` performs a lossless lift:

**Iteration shape.** Iterate **every account** under `accounts.*.reviews.sessions.*` (mirrors the V5→V6 multi-account loop at `AppStateMigrations.cs:126`). The single-account shorthand "accounts.<accountId>.reviews.sessions.<sessionKey>" is convenience prose — the actual loop is over all accounts.

**Partial-rollback discriminator** (precedent: V4→V5 lines 54-72, V5→V6 lines 110-150). Before doing any lift, if any session has BOTH a non-empty `draftSummaryMarkdown` AND a PR-root draft (`side == "pr"`, `filePath == null`) carrying a non-null `postedCommentId`, throw `JsonException` so the state file is quarantined and `AppStateStore` falls back to `AppState.Default`. The combination would indicate a V7+-file rolled back into V6 then re-upgraded with stale content; silent lift in that case would destroy data.

Otherwise, for each session:

1. Read `draftSummaryMarkdown`. If null or empty after trim, skip to step 5.
2. Find PR-root `DraftComment` entries (`draftComments` rows with `"side": "pr"` and `"filePath": null`).
3. **Collapse multiple pre-V7 PR-root drafts** (defensive — the composer hydrates from `find` so duplicates are typically shadowed; this branch protects against test-endpoint-induced multiples). If more than one exists, sort by id, prepend each non-survivor's body to the survivor's body with an explicit visible marker so the user recognizes the merge: `"<!-- migrated from previously-shadowed draft " + nonSurvivor.id + " -->\n\n" + nonSurvivor.body + "\n\n" + ... + survivor.body`. Drop the non-survivor rows. The HTML-comment marker preserves boundaries and renders invisibly in Markdown.
4. **Lift the summary.** If a PR-root draft exists (after the collapse), append the migrated summary to its `bodyMarkdown` with a blank-line separator: `existing + "\n\n" + summary`. Otherwise, synthesize a new PR-root draft with: `"id": "<Guid.NewGuid().ToString()>"`, `"filePath": null`, `"lineNumber": null`, `"side": "pr"`, `"anchoredSha": null`, `"anchoredLineContent": null`, `"bodyMarkdown": "<summary>"`, `"status": "Draft"`, `"isOverriddenStale": false`, `"threadId": null`, `"postedCommentId": null`. **JSON literal casing:** `"side"` is exactly `"pr"` (matches `newPrRootDraftComment` at `PrDraftEndpoints.cs:277`); `"status"` is PascalCase `"Draft"` (matches the `[JsonStringEnumConverter]` round-trip — verified by `AppStateRoundTripTests`). The migration writes JSON wire form, not C# enum values.
5. Delete the `draftSummaryMarkdown` key from the session JSON.

The append-and-collapse strategy is lossless. A user with both a non-empty summary and a non-empty PR-root draft pre-V7 ends up with one canonical body containing both — they can edit afterward.

**Rollback story.** A V7 state file fed to a V6 binary fails `AppStateStore.LoadAsync` with `UnsupportedStateVersionException(7)` — the existing quarantine path. Per the precedent set by V4→V5/V5→V6, this is the only supported downgrade behavior: the on-disk state is preserved untouched, the V6 binary starts from `AppState.Default`. Users who downgrade lose in-session drafts; release notes call this out.

Migrate is a pure `JsonObject → JsonObject` transform, matching the V3→V4 / V5→V6 precedent. Same testing pattern: golden V6 fixtures with each non-empty input shape (summary-only / PR-root-only / both-present / both-empty).

### 4.3 New endpoint — `POST /api/pr/{owner}/{repo}/{number}/root-comment/post`

**Request.** No body.

**Concurrency.** Acquires the same per-PR `SubmitLockRegistry` slot that Submit uses. While a Submit pipeline is in flight for this PR, Post returns 409 `submit-in-progress`. While Post is in flight, Submit also returns 409 with the same code. This is intentional: the two paths share the PR-level body and can't safely race for it (the body could be deleted by Post mid-Submit, or vice versa).

**Behavior.** Once the lock is acquired:

1. Load the session via `IAppStateStore.LoadAsync`. If no session exists, return 400 `no-session`.
2. Locate the PR-root draft (`side == "pr"`, `FilePath == null`). If none exists, return 400 `no-root-draft`.
3. If the draft's `PostedCommentId != null` (already-shipped path): compare the current draft body to the body that was previously posted (see the next paragraph). If different, return 409 `already-posted-body-mismatch` with the previous comment id so the frontend can show a recovery affordance. If identical (or the previous-body snapshot is unavailable for a legacy reason), skip the GitHub call and proceed to step 6.
4. Validate body cap. The body must not exceed `PipelineMarker.GitHubReviewBodyMaxChars` (= 65,536). See "Body-cap reconciliation" below — this check is defense-in-depth, not the primary gate. If exceeded, return 400 `body-too-large`.
5. Call `IReviewSubmitter.CreateIssueCommentAsync(prRef, body, ct)` → `CreatedIssueCommentResult(long Id, DateTimeOffset CreatedAt)`. The method is added to the existing `IReviewSubmitter` interface (the boundary for GitHub-write capability; new top-level interface is not warranted for one method). Implementation lives in `GitHubReviewService` (REST transport — `POST /repos/{owner}/{repo}/issues/{number}/comments`); the rest of `IReviewSubmitter` is GraphQL, but issue comments don't have a GraphQL mutation equivalent in the version GitHub ships today. On any GitHub-side error (4xx, 5xx, or network failure), return 502 with a typed error code from a bounded set: `github-forbidden` (403), `github-validation-error` (422), `github-rate-limited` (429), `github-server-error` (5xx), `github-network-error` (no response). The raw GitHub HTTP status integer is **not** echoed in the response body — only the typed code, mapped server-side — to avoid leaking scope/repo-visibility detail. Internal logging captures the full GitHub response for debugging. Draft is preserved; the caller retries. On success: stamp `PostedCommentId` AND `PostedBodySnapshot` (a copy of the body at post-time, see below) via an overlay `UpdateAsync` (same pattern as `StampDraftThreadIdOverlay` at `SubmitPipeline.cs:583-587`).
6. Delete the PR-root draft from the session (overlay `UpdateAsync` removes the row from `DraftComments`).
7. Publish a `StateChangedBusEvent` with `FieldsTouched: ["draft-comments"]` and a new `RootCommentPostedBusEvent { PrRef, IssueCommentId }` so the SSE projection re-fetches `PrDetail.RootComments` and `PrRootConversation` renders the new comment immediately.
8. Return 204.

**Posted-body snapshot — closing the edit-after-post race.** The autosave-vs-Post race (an in-flight `updateDraftComment` PUT racing the POST) and the external-edit-after-stamp race (PostedCommentId stamped, server crash, body edited locally before retry) both have the same root cause: the draft body at retry time may differ from what was already shipped to GitHub. The fix is two-layered:

- **Snapshot stamping** — at step 5, persist `PostedBodySnapshot: string?` alongside `PostedCommentId`. A new trailing-default field on `DraftComment`. Pre-V7 entries are null; post-Post it equals the body shipped to GitHub at that instant.
- **Body-mismatch detection** — at step 3, if `PostedBodySnapshot != current bodyMarkdown`, return 409 `already-posted-body-mismatch` with the previous comment id. The frontend renders a recovery banner: "This comment was already posted on {createdAt}. Your edits since then have not been shipped. Open on GitHub to edit, or discard the draft."

**Composer-side flush** (closes the autosave-vs-Post timing race). Before issuing POST, `PrRootReplyComposer`'s Post handler `await`s `flush()` from `useComposerAutoSave` so any pending debounced `updateDraftComment` lands before the POST is sent. Mirrors the existing Ctrl+Enter flow at `PrRootReplyComposer.tsx:141-149`. The textarea is set to `readOnly=true` during `postInFlight` to prevent new keystrokes (and cancel any in-flight debounce via the existing autosave teardown).

**Auth.** `cache.IsSubscribed(prRef)`. No HEAD-SHA gate (issue comments are not commit-anchored).

**Body-cap reconciliation.** The middleware predicate at `Program.cs:188-198` caps mutating routes at 16 KiB. `PUT /draft` (which authored the body) is in that list. So the **binding** body-cap on PR-root drafts is 16 KiB at write time, not 65,536 at post time — a draft body bigger than 16 KiB never reaches the database. The 65,536 check in step 4 is therefore defensive (state files hand-edited to over-cap, future migrations). The plan adds `/api/pr/{owner}/{repo}/{number}/root-comment/post` and `/api/pr/{owner}/{repo}/{number}/submit/discard` to the middleware predicate as defense-in-depth even though both are no-body POSTs today; a future body-carrying variant would inherit the cap.

**Idempotency.** With the snapshot-mismatch gate from step 3, idempotency is now: same body → 204 (deleted draft); different body → 409 with recovery info. Cross-tab races resolve via the same stamp combined with the `SubmitLockRegistry` slot — only the lock-acquiring tab gets to POST; the second tab observes the stamp and either becomes the no-op delete (matching body, rare) or the mismatch 409 (different body).

### 4.4 New endpoint — `POST /api/pr/{owner}/{repo}/{number}/submit/discard`

**Request.** No body.

**Behavior.**

1. Look up the per-PR `CancellationTokenSource` in `SubmitCancellationRegistry`. If present, call `Cancel()` on it. (Idempotent — a CTS already canceled is a no-op.)
2. Try to acquire `SubmitLockRegistry.TryAcquireAsync(prRef, timeout: 30s, ct)`. If acquisition fails, return 504 `pipeline-cancellation-timeout`. **Stamps are not cleared on timeout** — retry is correct. The 30s bound exceeds typical GitHub round-trips; if the pipeline is hung beyond this on a flaky network, the user retries.
3. **Re-fetch the GitHub-side pending review** (TOCTOU defense — mirrors `DiscardForeignPendingReviewAsync` at `PrSubmitEndpoints.cs:356-358`). Call `IReviewSubmitter.FindOwnPendingReviewAsync(prRef, ct)`. The local stamp and GitHub may now disagree because (a) cancellation may have aborted the persist-after-Begin overlay leaving GitHub-stamped but local-unstamped, or (b) a teammate may have deleted the pending review out-of-band. Two paths:
   - **GitHub has a pending review** (own or otherwise — the call returns a snapshot): call `IReviewSubmitter.DeletePendingReviewAsync(prRef, snapshot.PullRequestReviewId, ct)`. On 404 (review already gone between the find and the delete), treat as success and proceed to step 4. On 5xx, release the lock, return 502 `github-delete-failed`; stamps remain stamped for retry.
   - **GitHub has no pending review**: proceed directly to step 4 (the local stamp, if any, is orphaned; we still clear it).
4. Run `SessionOverlays.ClearPendingReviewStamps(state, sessionKey)` — a shared helper extracted from `SubmitPipeline.cs:603`. Nulls `PendingReviewId`, `PendingReviewCommitOid`, every `DraftComment.ThreadId`, every `DraftReply.ReplyCommentId`. **Does not touch `PostedCommentId` or `PostedBodySnapshot`.** Per-key partition logic from § 4.6 preserves the PR-root draft body.
5. Release the lock.
6. Publish `StateChangedBusEvent` with `FieldsTouched: ["pending-review", "draft-comments", "draft-replies"]`. Note: if step 3 took the "no pending review on GitHub" branch AND the local stamp was already null, this StateChanged is a no-op for the frontend but is still emitted (one source of truth for the discard-completed signal — frontend will re-fetch and observe stable state).
7. Return 204.

**Idempotent no-op.** If no lock is held and `PendingReviewId == null` and GitHub has no pending review, step 3 + 4 + 6 still execute (re-fetch + best-effort clear + signal) and return 204. The lock acquisition and re-fetch are cheap; running them unconditionally simplifies reasoning and handles the "stuck-state escape" case (local stamps were corrupted, GitHub state is clean — the discard endpoint can clean the local state without needing a `?force=true` parameter).

**Auth.** `cache.IsSubscribed(prRef)`.

**Concurrency.** Two simultaneous discard requests both signal CTS (cheap), both wait on the lock; whichever acquires runs the delete; the other observes the cleared state and returns 204 no-op. Safe.

**OperationCanceledException handling.** When the discard endpoint signals the in-flight pipeline's CTS, the pipeline throws OCE at its next `_submitter.*` call. The pipeline's `SubmitAsync` is updated to catch OCE explicitly and return a new `SubmitOutcome.Cancelled` outcome (rather than letting OCE escape). The submit endpoint at `PrSubmitEndpoints.cs:198-225` adds a `case SubmitOutcome.Cancelled:` branch that publishes no SSE event (the discard endpoint owns the user-facing signal) and logs at Information level (not Error) — distinguishes "user asked us to stop" from "pipeline threw outside its outcome contract."

### 4.5 New primitive — `SubmitCancellationRegistry`

A DI singleton parallel to `SubmitLockRegistry`. Located at `PRism.Web/Submit/SubmitCancellationRegistry.cs`.

**Lifecycle ownership lives at the endpoint, not in `SubmitPipeline`.** A prior version of this spec registered the CTS inside `SubmitPipeline.SubmitAsync` — that left a millisecond window between the endpoint's `SubmitLockRegistry.TryAcquireAsync` returning and the pipeline entering `SubmitAsync` in which a Discard request would find no CTS to cancel and wait the full 30s timeout. Corrected: the submit endpoint creates the linked CTS, registers it with `SubmitCancellationRegistry`, and passes the linked token through to `SubmitPipeline.SubmitAsync` as the `ct` parameter. Registration disposal happens in the endpoint's `finally` alongside the lock release. The pipeline doesn't need to know about the registry at all.

```csharp
internal sealed class SubmitCancellationRegistry
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _ctsByPrRef =
        new(StringComparer.Ordinal);

    // Called by SubmitPipeline.SubmitAsync at entry, after the lock is acquired.
    // Returns a disposable that removes the CTS entry from the registry on dispose.
    // The pipeline holds it inside a `using` block so disposal happens automatically
    // in the finally path, even on OperationCanceledException or process exit.
    public IDisposable Register(PrReference reference, CancellationTokenSource cts)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(cts);
        var key = reference.ToString();
        // AddOrUpdate semantics: if an entry already exists for this prRef (rare —
        // would indicate a stuck pipeline missed its finally cleanup), the new CTS
        // replaces it. The orphaned old CTS is harmless; nothing references it.
        _ctsByPrRef[key] = cts;
        return new RegistrationHandle(this, key, cts);
    }

    // Called by the discard endpoint. Idempotent: no entry → no-op; canceled CTS →
    // re-cancel is also no-op.
    public void RequestCancel(PrReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        if (_ctsByPrRef.TryGetValue(reference.ToString(), out var cts))
        {
            try { cts.Cancel(); } catch (ObjectDisposedException) { /* race vs pipeline finally */ }
        }
    }

    private sealed class RegistrationHandle : IDisposable
    {
        private readonly SubmitCancellationRegistry _owner;
        private readonly string _key;
        private readonly CancellationTokenSource _cts;
        private int _disposed;

        public RegistrationHandle(SubmitCancellationRegistry owner, string key, CancellationTokenSource cts)
        { _owner = owner; _key = key; _cts = cts; }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                // Only remove the entry if it still points to the same CTS — defends
                // against a stale Register/Dispose pair stomping a newer registration.
                _owner._ctsByPrRef.TryRemove(new KeyValuePair<string, CancellationTokenSource>(_key, _cts));
            }
        }
    }
}
```

Behavior:

- `Register` stores the CTS keyed by `prRef.ToString()`. Returns an `IDisposable` that removes the entry on dispose (the pipeline calls `Dispose()` in its `finally` block).
- `RequestCancel` looks up the CTS and calls `Cancel()`. Idempotent.
- The dictionary never evicts beyond per-disposal cleanup. Bounded by realistic usage (a handful of PRs per session), same stance as `SubmitLockRegistry`.

The CTS that gets registered is the pipeline's *linked* CTS (linked from `appLifetime.ApplicationStopping` and the request's `ct`). When the discard endpoint cancels it, the next `_submitter.*` call in the pipeline throws `OperationCanceledException` at its `ct` check; the pipeline propagates the exception up, the lock releases via `await using`, the registry removes the entry.

**Pipeline change at `SubmitPipeline.SubmitAsync`:** none. The pipeline already accepts a `ct` through every step; the endpoint now passes a linked CT instead of `appLifetime.ApplicationStopping` directly.

**Endpoint change at `PrSubmitEndpoints.SubmitAsync` (around line 150-225):**

```csharp
await using var lockHandle = await lockRegistry.TryAcquireAsync(reference, ...);
if (lockHandle is null) { ... return 409; }

using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(appLifetime.ApplicationStopping);
using var registration = cancellationRegistry.Register(reference, linkedCts);

// fire-and-forget Task.Run uses linkedCts.Token instead of pipelineCt; on cancel the pipeline
// throws OCE → caught by the new SubmitOutcome.Cancelled case.
```

**Stomp-defense invariant.** `Register` uses `TryAdd` (not `AddOrUpdate`): if a prior entry already exists for this prRef, Register throws — this would indicate a stuck pipeline missed its finally cleanup, which is a logic bug worth surfacing rather than silently shadowing. The disposal `TryRemove` continues to use the key+value check from § 4.5 so a late dispose can't stomp a fresh registration.

### 4.6 SubmitPipeline change — AttachThreads partition + PR-root draft consumption

`StepAttachThreadsAsync` is modified to filter PR-root drafts out of the iteration:

```csharp
var drafts = session.DraftComments
    .Where(d => d.Status != DraftStatus.Stale)
    .Where(d => d.FilePath is not null && d.LineNumber is not null)  // <-- new line; PR-root drafts skipped
    .ToList();
```

The throw block at `SubmitPipeline.cs:284-292` is **deleted** — unreachable after the filter.

**`summaryBody` source.** Post-V7 the pipeline reads the PR-root body via a private helper:

```csharp
static string ExtractPrRootBody(ReviewSessionState s) =>
    s.DraftComments.SingleOrDefault(d => d.FilePath is null && d.LineNumber is null)
        ?.BodyMarkdown ?? "";
```

Called once at step 1 (Begin) — passed to `BeginPendingReviewAsync(..., summaryBody, ct)`. If no PR-root draft exists, `summaryBody` is the empty string (matches the current `IReviewSubmitter` contract).

**PR-root draft consumption on success (resolves the prior open question).** The PR-root draft IS consumed by a successful Submit — mirrors how inline drafts are consumed (their `ThreadId` stamp survives but the body is shipped). Avoids the double-publish trap (the user typing in the PR-root composer, clicking Submit, getting their text shipped as review.body, then later clicking Post and shipping the same text again as a standalone comment).

Implementation: `ClearSubmittedSession` at `SubmitPipeline.cs:616-630` is updated to partition `DraftComments`. Drafts where `Status == Stale && !IsOverriddenStale` are preserved as today (the existing exception). Drafts where `FilePath is null && LineNumber is null` AND `PostedCommentId is null` (the live PR-root draft that contributed to `review.body`) are removed by the same successful-submit pathway. Drafts where `PostedCommentId is not null` (already-posted, not yet cleaned up by the Post endpoint for some reason) survive — they belong to the Post lifecycle, not the Submit lifecycle. Inline drafts (`FilePath` non-null) follow today's wipe-all behavior.

```csharp
DraftComments = cur.DraftComments
    .Where(d => (d.Status == DraftStatus.Stale && !d.IsOverriddenStale)
             || (d.PostedCommentId is not null))
    .ToList();
```

The existing `SuccessClearsSession*` tests are updated to assert: PR-root drafts disappear post-Submit; Posted-but-not-cleaned drafts survive.

**Shared `ClearPendingReviewStamps` helper.** Extract `SubmitPipeline.ClearPendingReviewStamps` (currently `private static` at `:603-612`) into a new `PRism.Core.State.SessionOverlays` static class. Both the pipeline (cancellation cleanup, stale-commitOID branch) and the new discard endpoint call it from there. Existing pipeline tests that exercise the helper indirectly remain green; new unit tests cover the helper directly.

### 4.7 Composer changes — `PrRootReplyComposer`

**Action bar** (was: Preview / Discard / Save):

- **Preview** — unchanged.
- **Discard** — unchanged.
- **Post** — new. Replaces Save.
- Autosave continues to run in the background after `COMPOSER_CREATE_THRESHOLD` chars. The Save button is removed; closing the composer without Posting leaves the draft persisted, and reopening hydrates it via the existing `existingPrRootDraft` path.

**Keybindings:**

- Ctrl+Enter: Post (was: Save + close).
- Escape: Discard with confirmation (unchanged).
- Ctrl+Shift+P: Preview toggle (unchanged).

**Post button states.** Label and tooltip table (pin exact copy in the plan):

| Condition | Label | Disabled | Tooltip |
|---|---|---|---|
| `bodyEmpty` | "Post" | yes | "Type something to post." |
| `belowCreateThreshold` (under `COMPOSER_CREATE_THRESHOLD`) | "Post" | yes | `` `Type at least ${COMPOSER_CREATE_THRESHOLD} characters to post.` `` |
| `readOnly` (cross-tab ownership) | "Post" | yes | "Another tab is editing this PR." |
| `postInFlight` | "Posting…" (with spinner glyph) | yes | "" |
| Normal | "Post" | no | "" |

Textarea is `readOnly=true` whenever the existing `readOnly` flag is set OR `postInFlight` is true. Closing the composer mid-`postInFlight` is blocked (Escape no-ops; Discard button is also disabled). Allowing close mid-`postInFlight` would orphan the response handler.

**Post failure surface** (Q3-B from the brainstorm):

A new dedicated error row sits between the textarea and the action bar. Shape:

```
<div role="alert" data-testid="post-error" className={styles.postError}>
  Couldn't post to GitHub: {message}. <button>Retry</button>
</div>
```

The error is cleared on:

- Successful retry.
- Any keystroke in the textarea.
- Composer close.

**Post success path:**

1. `await flush()` — drain any pending debounced autosave.
2. Button enters `postInFlight` state (disabled, "Posting…" label, spinner). Textarea readOnly.
3. POST `/api/pr/.../root-comment/post`.
4. On 204: optimistic UX — render an inline "Posted ✓" badge in place of the action bar for ~600ms while the SSE-refetch lands, then close the composer. `PrRootConversation` re-renders the comments list with the new comment included. (Without the optimistic badge there's a 1-2s window where the composer closes but no new comment is visible, which reads as "did it work?".)
5. On 4xx with code `already-posted-body-mismatch`: render a dedicated recovery banner above the action bar — "This comment was already posted on {createdAt}. Your edits since then haven't been shipped. [Open on GitHub] [Discard local edits]." No close-on-success; user explicitly resolves.
6. On other 4xx/5xx: error row populated with the typed code's message ("Couldn't post to GitHub: {message}. [Retry]"), button re-enabled, textarea writable again. Draft preserved.

### 4.8 SubmitDialog + sibling frontend consumer changes

**Backend cleanup outside SubmitDialog.** The wire-shape change to drop `draftSummaryMarkdown` from `ReviewSessionDto` (`api/types.ts`) touches every consumer. Migration sites:

- `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx:23,44` — `hasSummary` check becomes "PR-root draft present + body non-empty."
- `frontend/src/components/PrDetail/SubmitButton.tsx:43-46` (`isEmptyContent`) — `noSummary` clause collapses; the check becomes `noDrafts && noReplies` (note: `noDrafts` already includes the PR-root draft per `DraftComments.Count == 0`).
- `frontend/src/components/PrDetail/PrHeader.tsx:46` — default fixture's `draftSummaryMarkdown` field removed.
- `frontend/src/api/types.ts` — drop the field from `ReviewSessionDto`; drop `'draftSummaryMarkdown'` from the patch-kind union.
- `frontend/src/api/draft.ts` — drop the `'draftSummaryMarkdown'` case in the patch builder.
- `frontend/__tests__/*.tsx` — every test that constructs a `ReviewSessionDto` with `draftSummaryMarkdown` (sweep via `Grep` and update).
- Backend symmetry: `PrDraftEndpoints.cs:245-251` — remove the `case "draftSummaryMarkdown"` patch handler. `ScalarKinds` array at `:42` loses the field. `PrSubmitEndpoints.cs:31` — `SubmittedFields` constant drops `"draft-summary"`. `SubmitPipeline.cs:625` — `ClearSubmittedSession`'s `DraftSummaryMarkdown = null` line is removed (the field doesn't exist anymore).

**Tab-vs-binary upgrade compatibility.** If a user has the V6 SPA open in a browser tab and reloads after a V7 backend upgrade, a stale tab may still send `"draftSummaryMarkdown"` patches. Backend behavior: `PrDraftEndpoints.HandlePatch` returns `PatchOutcome.PatchShapeInvalid` (`HTTP 400` with the existing error envelope) for unknown patch kinds. The frontend's existing handle-error flow surfaces this — user is prompted to reload. No special "silently translate to PR-root-draft" compat layer; the simplicity is worth a one-time reload.

**Summary textarea removed.** Lines 72-93 of `SubmitDialog.tsx` (the `setSummary` state, the `useEffect` hydration, the textarea, the wire-up to the backend) are removed.

**Replaced with a read-only preview + inline-edit toggle** (pulled into this PR from § 9 Q5):

- **Default view** is the read-only Markdown render of the PR-root draft body (if one exists) or a muted "No PR-level body — click Edit to add one" placeholder.
- **"Edit" toggle** above the preview switches to the new `PrRootBodyEditor` shared component (see § 4.11), bound to the same PR-root `DraftComment` the Overview-tab composer edits. Autosave runs the same `updateDraftComment` patch on debounce (creates the draft via `newPrRootDraftComment` if none exists yet). Toggle label becomes "Done" while editing; clicking "Done" returns to the preview without closing the dialog.
- **Cross-surface lock.** Opening the SubmitDialog's edit mode calls `registerOpenComposer(draftId)` the same way `PrRootReplyComposer` does. If the user has the Overview-tab composer already open in the same tab, the SubmitDialog edit toggle is disabled with a "Editing in the Reply composer — close it to edit here" tooltip. Cross-tab ownership (`readOnly` flag from the cross-tab stamp) disables the toggle uniformly. The reverse case — Overview composer disabled while SubmitDialog edit mode is active — uses the same registry, so only one editor surface can hold the draft at a time within a tab.
- **Mode persistence.** The edit-vs-preview toggle state resets when the SubmitDialog opens (always opens in preview). Closing the dialog with edits in progress autosaves and exits; no "unsaved changes" prompt (autosave covers it).
- **Footer Submit button** remains gated by the existing `submitDisabledReason` rules. When the dialog is in edit mode and the body is below `COMPOSER_CREATE_THRESHOLD`, the body is treated as empty for `isEmptyContent` purposes (matches the create-threshold gate the composer enforces).

Implementation:

```tsx
const [editing, setEditing] = useState(false);
const cantEditReason = useCantEditRootBodyReason({ prRef, readOnly, openComposerDraftId });
// reasons: 'editing-in-overview-composer' (intra-tab conflict),
//          'editing-in-other-tab' (readOnly from cross-tab stamp), null otherwise.

<section className={styles.prRootBodyEditorWrap} aria-label="PR-level body">
  <header className={styles.prRootBodyHeader}>
    <h3>PR-level body</h3>
    {!editing && (
      <button
        type="button"
        className="composer-preview-toggle"
        disabled={cantEditReason !== null}
        title={
          cantEditReason === 'editing-in-overview-composer'
            ? 'Editing in the Reply composer — close it to edit here'
            : cantEditReason === 'editing-in-other-tab'
              ? 'Another tab is editing this PR.'
              : ''
        }
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
    )}
    {editing && (
      <button type="button" className="composer-preview-toggle" onClick={() => setEditing(false)}>
        Done
      </button>
    )}
  </header>

  {editing ? (
    <PrRootBodyEditor
      prRef={prRef}
      prState={prState}
      draftId={prRootDraft?.id ?? null}
      onDraftIdChange={setLocalDraftId}
      registerOpenComposer={registerOpenComposer}
      initialBody={prRootDraft?.bodyMarkdown ?? ''}
      readOnly={readOnly}
    />
  ) : prRootDraft && prRootDraft.bodyMarkdown.trim().length > 0 ? (
    <MarkdownRenderer source={prRootDraft.bodyMarkdown} />
  ) : (
    <p className={`${styles.noPrRootBody} muted`}>
      No PR-level body — click Edit to add one.
    </p>
  )}
</section>
```

`useCantEditRootBodyReason` is a small new hook that reads the cross-tab `openComposerDraftId` registry (the same registry `registerOpenComposer` writes to inside `useComposerAutoSave`) to determine if the Overview-tab composer is currently holding the draft. Returns `'editing-in-overview-composer'` when the registry has an entry for this PR's PR-root draft that did NOT come from the SubmitDialog itself. The hook is also used by `PrRootReplyComposer` to disable its open state when SubmitDialog has the editor active — symmetric.

**Discard button in the footer.** When `session.PendingReviewId !== null` OR the submit lock is held for this PR (derived from the `/api/submit/in-flight` poll + the SSE-driven `pending-review` field touch), render a leftmost **Discard** button in the dialog footer. Secondary style (matches `DiscardAllDraftsButton`'s visual treatment). Click → confirmation modal → endpoint.

**Dialog state sequencing during Discard.** Clicking Discard while a Submit pipeline is mid-progress:

1. Click → confirmation modal opens **over** the SubmitDialog (SubmitDialog stays mounted underneath, progress indicator continues).
2. User confirms → modal shows in-flight spinner; the discard endpoint is called.
3. The SubmitDialog's progress indicator labels itself "Cancelling…" while the modal is in-flight (a single `discardInFlight` flag in `useSubmit` drives both surfaces).
4. On 204 → modal closes, SubmitDialog closes, header pill disappears, optimistic toast "Pending review discarded" surfaces.
5. On 502/504 → modal renders inline error row with a Retry affordance. Both SubmitDialog and modal remain open until success or user cancels the modal.

Closing the SubmitDialog mid-`discardInFlight` is blocked (matches the `postInFlight` rule in § 4.7).

The submit-disabled rule (e) at `PrSubmitEndpoints.cs:117-122` is unchanged — its condition `DraftComments.Count == 0 && DraftReplies.Count == 0 && summary empty` still holds post-V7 (PR-root drafts count as DraftComments today; the `&& summary empty` clause is dropped because the field is gone). After the field drop, rule (e) reduces to `DraftComments.Count == 0 && DraftReplies.Count == 0`.

### 4.9 PrHeader pill

**Visibility mechanism.** The "is the SubmitDialog open?" predicate is sourced from a new field on the existing `useSubmit` hook (`submitDialogOpen: boolean`). The hook already manages submit-dialog lifecycle adjacent state. `PrHeader` consumes this via the same hook subscription it already uses for `submitInFlight`. No new context, no new global atom.

When `session.PendingReviewId !== null` AND `!submitDialogOpen`, render a pill next to the existing Submit button:

```tsx
<button
  type="button"
  className={styles.pendingReviewPill}
  data-testid="pending-review-pill"
  onClick={openDiscardConfirmation}
>
  Pending review on GitHub · Discard
</button>
```

Visual treatment matches the existing `SubmitInProgressBadge` (small pill, warning color from `tokens.css`).

### 4.10 Confirmation modal

A new component `DiscardPendingReviewConfirmationModal` (shape mirrors `DiscardAllConfirmationModal`):

```
┌─────────────────────────────────────────────┐
│ Discard pending review on GitHub?           │
│                                             │
│ • The pending review on GitHub will be      │
│   deleted, along with its threads.          │
│ • Your PRism drafts and replies will be     │
│   unstamped, ready to submit fresh.         │
│                                             │
│                       [Cancel] [Discard]    │
└─────────────────────────────────────────────┘
```

- `defaultFocus="cancel"` (matches `DiscardAllConfirmationModal`).
- Esc closes (matches platform convention) — unless `discardInFlight` is true.
- Discard button kicks off the endpoint call.

**State transitions:**

| State | Discard button | Cancel button | Body |
|---|---|---|---|
| Normal | "Discard" (destructive style), enabled | "Cancel", enabled | bullets above |
| `discardInFlight` | "Discarding…" with spinner, disabled | hidden | bullets above |
| Failure | "Retry" (destructive style), enabled | "Close", enabled | bullets above + error row: "Couldn't discard: {message}. [Retry]" |

Used by both surfaces (`SubmitDialog` footer button and `PrHeader` pill).

### 4.11 New shared component — `PrRootBodyEditor`

Extracted from `PrRootReplyComposer`'s textarea + autosave subsystem. The composer becomes a thin wrapper around `PrRootBodyEditor` plus the Discard/Post/Preview/AI affordances; the SubmitDialog inline-edit mode also uses `PrRootBodyEditor` without the surrounding action bar.

**Component file.** `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx` (sibling to `PrRootReplyComposer.tsx`).

**Props.**

```ts
interface PrRootBodyEditorProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string) => () => void;
  readOnly?: boolean;
  // Optional callback so wrappers (PrRootReplyComposer) can plumb
  // useComposerAutoSave's flush/badge out to their action bar.
  onAutosaveControl?: (control: { flush: () => Promise<void>; badge: ComposerBadge }) => void;
}
```

**Responsibilities.**

- Renders the textarea + closed-banner gate (`closedBanner` from `prState !== 'open'`).
- Owns the autosave wiring via `useComposerAutoSave` with anchor `{ kind: 'pr-root' as const }`.
- Handles the recovery modal ("PR reply draft deleted elsewhere") because that's a draft-lifecycle concern, not a composer-action concern.
- Respects `readOnly` (textarea + autosave disabled).
- Exposes flush/badge via `onAutosaveControl` so a wrapper can drive its own action bar without re-running autosave.

**Composer migration.** `PrRootReplyComposer.tsx`:

- The textarea, `useComposerAutoSave` invocation, and recovery modal move into `PrRootBodyEditor`.
- The composer keeps Discard / Post / Preview / AI affordances and the discard-confirm modal.
- The composer's `flush()` calls come through the `onAutosaveControl` callback.

**Tests.** Move the existing `PrRootReplyComposer.test.tsx` autosave-and-recovery assertions to a new `PrRootBodyEditor.test.tsx`; the composer's test file keeps the Discard/Post action assertions.

## 5. Frontend — useSubmit and api/submit changes

### 5.1 New api wrapper — `api/rootComment.ts`

```ts
export interface PostRootCommentResult {
  ok: true;
}
export interface PostRootCommentError {
  ok: false;
  code:
    | 'no-session' | 'no-root-draft' | 'body-too-large'
    | 'submit-in-progress'  // 409: lock held by submit or another post
    | 'already-posted-body-mismatch'  // 409: stamp + snapshot disagree with current body
    | 'github-forbidden' | 'github-validation-error' | 'github-rate-limited'
    | 'github-server-error' | 'github-network-error';
  message: string;
  // present iff code === 'already-posted-body-mismatch'
  postedCommentId?: number;
  postedAt?: string;
}

export async function postRootComment(
  prRef: PrReference,
): Promise<PostRootCommentResult | PostRootCommentError> {
  const resp = await apiClient.post(
    `/api/pr/${encode(prRef)}/root-comment/post`,
    undefined,
  );
  if (resp.ok) return { ok: true };
  // Map server error envelope { code, message } to the typed PostRootCommentError.
  return mapError(resp);
}
```

### 5.2 New `api/submit.ts` method — `discardOwnPendingReview`

Mirrors `discardForeignPendingReview` (already in `api/submit.ts`). Same error envelope shape.

### 5.3 `useSubmit` extension

A new `discardOwnPendingReview` callback exposed alongside the existing submit callback. The hook owns the in-flight state for both the submit and the discard so the UI can present mutually-exclusive spinners.

## 6. SSE / events

One new bus event and SSE projection wire-record:

- `RootCommentPostedBusEvent { PrRef, IssueCommentId }` — new record in `PRism.Core/Events/SubmitBusEvents.cs` alongside the existing `SubmitForeignPendingReviewBusEvent` etc. Emitted by the Post endpoint on success.
- `RootCommentPostedSseEvent { issueCommentId }` wire-record in `PRism.Web/Sse/SseEventProjection.cs`, with `Subscribe<RootCommentPostedBusEvent>` wired in the same file.
- Frontend consumer: a new `stream.on('root-comment-posted', …)` listener in `frontend/src/hooks/usePrDetail.ts` (the seam that already owns PR-detail re-fetches). Triggers a re-fetch of `PrDetail.RootComments`, which causes `PrRootConversation` to render the new comment.
- No new event for discard — the existing `StateChanged` with the touched fields list is sufficient; the frontend already re-fetches on `pending-review` field touch via the same hook.

## 7. Test surfaces

### 7.1 New test endpoint — `/test/root-comment/force-failure`

```csharp
app.MapPost("/test/root-comment/force-failure",
    (ForceRootCommentFailureRequest body, IServiceProvider sp) =>
    {
        if (string.IsNullOrEmpty(body.Phase))
            return Results.Problem(type: "/test/missing-params", statusCode: 422);
        if (sp.GetService<IReviewSubmitter>() is not FakeReviewSubmitter fake)
            return Results.Problem(type: "/test/submitter-missing", statusCode: 500);
        fake.RegisterRootCommentForceFailure(body.Phase);
        return Results.NoContent();
    });
```

`CreateIssueCommentAsync` lives on `IReviewSubmitter` (§ 4.3); `FakeReviewSubmitter` (`PRism.Web/TestHooks/FakeReviewSubmitter.cs`) gains the implementation and the force-failure registry.

Allowed phases: `github-create` (force `CreateIssueCommentAsync` to throw), `post-stamp` (force the overlay-update to throw between the GitHub success and the local delete — exercises the idempotency-replay path).

### 7.2 Existing hooks extended for in-flight cancellation tests

`/test/submit/hold` synthetically acquires a `SubmitLockRegistry` slot without invoking the pipeline — it can't exercise CTS cancellation. To exercise the discard-in-flight cancellation path, extend the `FakeReviewSubmitter` Begin-delay primitive (already exists as `_beginDelayMs` per memory `project_pr72_s6_pr4_shipped`) with a new test endpoint:

```csharp
app.MapPost("/test/submit/begin-delay",
    (BeginDelayRequest body, IServiceProvider sp) =>
    {
        if (sp.GetService<IReviewSubmitter>() is not FakeReviewSubmitter fake)
            return Results.Problem(type: "/test/submitter-missing", statusCode: 500);
        fake.SetBeginDelayMs(body.DelayMs);
        return Results.NoContent();
    });
```

Playwright scenario: set begin-delay to 5000 → click Submit (pipeline registers CTS, acquires lock, blocks inside Begin) → click Discard → pipeline's CT trips → Begin returns OCE → lock releases → discard runs DELETE + ClearPendingReviewStamps → assert pending review cleared. The `/test/submit/hold` primitive remains useful for the `/api/submit/in-flight` poll assertion path; the new begin-delay primitive covers the cancellation handshake.

### 7.3 Playwright specs to add

`frontend/e2e/parity-baselines.spec.ts`:

- `pr-detail-overview` baseline recaptured with PR-root draft body and Post button visible (existing baseline expected to drift).

`frontend/e2e/submit-discard.spec.ts` (new):

- Post happy path (compose → Post → comment appears).
- Post failure surface (force-failure phase=`github-create` → error row → retry).
- Already-shipped retry (force-failure phase=`post-stamp` → re-open composer → second Post succeeds with no duplicate).
- Discard idle pending review (PrHeader pill → confirm → pill disappears).
- Discard in-flight pipeline (hold → Discard in dialog → release-hold → pending review cleared).

`frontend/e2e/submit-dialog.spec.ts` (new or existing — plan picks):

- Negative assertion: the legacy SubmitDialog summary textarea no longer renders.
- Positive assertion: when a PR-root draft exists, the body preview renders inside the dialog.
- Inline-edit toggle happy path: open dialog → click Edit → type → autosave → click Done → preview re-renders with the new body → close dialog → reopen → still in preview mode.
- Intra-tab cross-surface lock: open Reply composer on Overview tab → open SubmitDialog → Edit toggle is disabled with the "editing in the Reply composer" tooltip; close composer → toggle re-enables.
- Cross-tab read-only lock: simulate `readOnly=true` from cross-tab stamp → Edit toggle disabled with the "Another tab is editing this PR" tooltip.

## 8. Migration plan

Single state migration V6 → V7 per § 4.2. The migration is purely a transformation of the on-disk state file; there is no wire-shape concern because PRism ships as a single binary (the frontend has no notion of state versions).

The wire-shape **does** change: `ReviewSessionDto.draftSummaryMarkdown` is removed from the API and `DraftCommentDto.postedCommentId` is added. The frontend lands in the same PR that introduces V7, so V6 frontend never talks to V7 backend.

The migration is exercised by:

1. `AppStateMigrationsTests.MigrateV6ToV7_*` unit cases (golden V6 → V7 fixtures): summary-only, PR-root-only, both-present, both-empty, multiple sessions, non-default account, defensive collapse of multiple PR-root drafts in one session, **partial-rollback discriminator throws** (a session with `draftSummaryMarkdown` set AND a PR-root draft with `postedCommentId` set).
2. End-to-end smoke: start fresh V6 state via a fixture, restart with V7 binary, assert PR-root draft contains the lifted summary.

**`AppStateStore.CurrentVersion` and `AppState.Default`.** Both updated to 7 in the same commit that introduces `MigrateV6ToV7`. The bump must land atomically — `AppState.Default` carrying a version lower than `CurrentVersion` would write malformed state files (the existing round-trip tests catch this).

## 9. Open questions for writing-plans

These do not block spec acceptance but need explicit answers in the plan.

1. **Foreign-pending-review-resume body loss.** `ResumeForeignPendingReviewAsync` at `PrSubmitEndpoints.cs:273-303` imports foreign threads but drops the foreign review's `body` field. Post-V7 the user has no path to recover that body (the PR-root draft is empty post-import; the SubmitDialog read-only preview says "No PR-level body"). The plan should consider whether to synthesize a PR-root DraftComment from the imported foreign body. Treated as a deferral candidate in the sidecar; not blocking.
2. **PR state at Post time.** A closed/merged PR accepts issue comments via REST. The composer's existing `closedBanner` is purely informational. Plan should confirm we surface no extra warning.
3. **Multi-host migration sample.** The V6→V7 fixture set must include a non-default-account variant (mirrors V4→V5 / V5→V6 multi-account loop). Plan should name the exact fixture filenames so reviewers can spot-check coverage.
4. **AppState.Default version bump.** `AppState.cs` carries a `Default` static (currently `Version: 6`). Plan must update to `Version: 7` in the same commit that introduces the migration, with assertions in `AppStateRoundTripTests`.

## 10. Acceptance criteria

A reviewer-walkthrough on a fresh main branch should be able to:

1. Open a PR detail page.
2. Click Reply in the PR-root conversation.
3. Type a body. Observe the autosave badge ticking.
4. Click Post. Observe the "Posting…" state, then the optimistic "Posted ✓" badge, then composer closes; the new comment appears under the conversation list within seconds.
5. Click Reply again, type a new body, leave it as a draft (close composer without posting). Refresh the page. Observe the draft has persisted; reopening Reply hydrates it.
6. Click Submit review. Open the dialog. Observe the PR-root body shown as a read-only preview with an Edit toggle. Click Edit, modify the body, click Done — preview re-renders with the new body. Pick a verdict, hit Submit. Observe the pipeline completing. Reopen the Reply composer on the Overview tab — the PR-root draft is gone (consumed as `review.body`).
7. Force a Submit failure (e.g., remove network mid-flight). Observe a pending review remaining on GitHub via the Pending-review pill in `PrHeader`. Click Discard. Confirm. Observe the pill disappearing and the pending review removed from GitHub.
8. Start a Submit (with `/test/submit/begin-delay` set), immediately click Discard from the dialog footer. Observe progress indicator switching to "Cancelling…", then the dialog closing, the pending review on GitHub removed.
9. Provoke a stuck local stamp (e.g., kill the process between Begin success and stamp persist). Restart. Observe the pill shows "Pending review on GitHub" but GitHub side has the review (or doesn't). Click Discard. Observe the endpoint's re-fetch path: GitHub state is reconciled and local stamps cleared without `?force=true`.
10. Inspect the V6 state file before upgrade — confirm `draftSummaryMarkdown` is populated. Launch the V7 binary. Confirm the field is gone and the PR-root draft body contains the lifted text.
11. Force a Post failure (force-failure phase=`github-create`) and observe the error row populated with the typed code's message. Retry; observe success.
12. Force a stamp-without-delete state (force-failure phase=`post-stamp`). Re-open the composer with an edited body. Click Post. Observe the `already-posted-body-mismatch` recovery banner.

## 11. References

- S5 deferral: `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md:383-388`
- Existing pipeline: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (665 lines)
- Existing submit endpoints: `PRism.Web/Endpoints/PrSubmitEndpoints.cs`
- Existing submit lock: `PRism.Web/Submit/SubmitLockRegistry.cs`
- Existing foreign-pending-review discard: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (`DiscardForeignPendingReviewAsync`)
- Existing PR-root composer: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
- Existing SubmitDialog: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx`
- Existing state migrations: `PRism.Core/State/Migrations/AppStateMigrations.cs`
- Test-endpoint precedent: `PRism.Web/TestHooks/TestEndpoints.cs` (force-failure pattern from PR #100)
