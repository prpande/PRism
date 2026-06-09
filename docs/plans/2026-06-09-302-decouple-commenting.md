# Decouple commenting from review submission — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer post a single inline comment or thread reply to a PR immediately, without submitting an atomic review — alongside the unchanged pending-review flow.

**Architecture:** A second write path for comment bodies. Inline new-thread comments use REST `POST /pulls/{n}/comments`; replies use GraphQL `addPullRequestReviewThreadReply` **without** a `pullRequestReviewId` (which posts immediately — confirmed in `GitHubReviewService.Submit.cs:115-116`), reusing the draft's own `ParentThreadId`. Post-now routes *through* the local draft session (stage → post → stamp-then-delete), mirroring the PR-root-comment path. The GraphQL atomic-submit pipeline is untouched. Idempotency is stamp-then-delete (`PostedCommentId`/`PostedBodySnapshot`); the rare crash-before-stamp double-post window is accepted (deferred follow-up). UI adds a `Comment` button beside the existing draft-`Save` button (relabelled `Add to review`), with GitHub-style mutual exclusion against an in-progress review and a post-now-only composer on merged/closed PRs.

**Tech Stack:** .NET (minimal-API endpoints, xUnit), React + Vite + TypeScript (vitest, RTL), Playwright e2e. GitHub REST `POST /pulls/{n}/comments` + GraphQL `addPullRequestReviewThreadReply`.

**Spec:** `docs/specs/2026-06-09-302-decouple-commenting-design.md`. **Gated** (B1 visual + B2 risk-surface) — human reviewed spec and plan before this executes.

**Worktree:** `D:/src/PRism-302-decouple-commenting` (branch `feature/302-decouple-commenting`). All commands run from there.

> **Revision note:** this plan was revised after a `ce-doc-review` pass (4 personas) that caught a stale-`draftId`-after-flush bug, a mutual-exclusion flicker, a fragile body-match de-dup, a build-order break, and surfaced the GraphQL reply mechanism that dissolves the client-supplied-id risk. Disposition table at § end.

---

## Key mechanisms (read first)

- **Discriminate by draft kind, not a client flag.** `POST …/comment/post` takes only `{ draftId }`. The endpoint resolves it: in `DraftComments` → inline REST post; else in `DraftReplies` → reply GraphQL post; else `400 no-draft`. No client-supplied reply target (dissolves the foreign-id risk).
- **`flush()` returns the assigned id.** `useComposerAutoSave.flush()` becomes `Promise<string | null>` so post-now can post a brand-new draft whose id was assigned *during* the flush (the captured `draftId` prop is stale until the next render).
- **Mutual-exclusion suppression is synchronous and global.** A `postingInProgress` ref-count in `useDraftSession` (set *before* `flush()`, cleared in `finally`) forces `computeAnyOtherDraftsStaged` to `false` for the post's duration — so the transient post-now draft never flickers other open composers into "review in progress". (Safe because post-now is only reachable when no *other* drafts are staged.)
- **Optimistic de-dup keys on `databaseId`.** The endpoint returns the created comment's numeric id; the optimistic placeholder carries it; the refetched real comment carries `databaseId` (Task 1). De-dup matches on id, with a normalized body-match only as a transient fallback before the id is known.

---

## File Structure

**Backend (create):** `PRism.GitHub/GitHubReviewService.ReviewComments.cs` (REST inline + GraphQL reply submitter methods); `PRism.Web/Endpoints/PrCommentEndpoints.cs`; `PRism.Core/Submit/ReviewCommentRequest.cs`.

**Backend (modify):** `PRism.Core/IReviewSubmitter.cs`; `PRism.Core/Submit/SubmitResults.cs`; `PRism.Core/State/AppState.cs` (`DraftReply` fields); `PRism.Core/Events/SubmitBusEvents.cs`; `PRism.GitHub/GitHubReviewService.cs` (query + `ParseReviewThreads` `databaseId`); `PRism.Core.Contracts/ReviewThreadDto.cs`; `PRism.Web/Program.cs`; the 4 `IReviewSubmitter` fakes + `ContractShapeTests`.

**Frontend (create):** `frontend/src/api/comment.ts`.

**Frontend (modify):** `frontend/src/api/types.ts`; `frontend/src/hooks/useComposerAutoSave.ts` (flush returns id); `frontend/src/hooks/useDraftSession.ts`; `InlineCommentComposer.tsx`; `ReplyComposer.tsx`; `CollapsedComposerAffordance.tsx`; `ExistingCommentWidget.tsx`; `FilesTab.tsx`.

---

## Phase A — Backend write path

### Task 1: Surface `databaseId` on review-thread comments (for optimistic de-dup)

Thread comments fetch only the opaque node `id`. Add `databaseId` so a just-posted comment can be correlated to the one that re-appears on refetch (optimistic de-dup, Task 11). *Not* used as a reply target — replies use `ParentThreadId` via GraphQL.

**Files:** Modify `PRism.GitHub/GitHubReviewService.cs:43` (query), `:1108-1122` (`ParseReviewThreads`); `PRism.Core.Contracts/ReviewThreadDto.cs:18-24`; `frontend/src/api/types.ts:203-210`. Test: `tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs`.

- [ ] **Step 1: Failing test** — `tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs`:

```csharp
using System.Text.Json;
using Xunit;
namespace PRism.GitHub.Tests;

public class ParseReviewThreadsDatabaseIdTests
{
    [Fact]
    public void ParseReviewThreads_reads_databaseId_onto_comment_dto()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_1","path":"a.cs","line":3,"isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_1","databaseId":4242,
            "author":{"login":"octocat","avatarUrl":"http://x/y"},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null}]}}]}}
        """;
        using var doc = JsonDocument.Parse(json);
        var threads = GitHubReviewService.ParseReviewThreads(doc.RootElement);
        var comment = Assert.Single(Assert.Single(threads).Comments);
        Assert.Equal(4242L, comment.DatabaseId);
    }
}
```

Make `ParseReviewThreads` `internal static` (was `private static`, `GitHubReviewService.cs:1089`) and add `<InternalsVisibleTo Include="PRism.GitHub.Tests" />` to `PRism.GitHub.csproj` (currently only `PRism.GitHub.Tests.Integration` is listed — verify and add the unit-test entry).

- [ ] **Step 2: Run → fails.** `dotnet test tests/PRism.GitHub.Tests --filter ParseReviewThreads_reads_databaseId_onto_comment_dto` → FAIL (no `DatabaseId`).

- [ ] **Step 3: Add `DatabaseId` to the DTO** — `PRism.Core.Contracts/ReviewThreadDto.cs`, append to `ReviewCommentDto`:

```csharp
    string? AvatarUrl = null,
    long? DatabaseId = null);   // #302 — REST numeric id, used to de-dup optimistic vs refetched comments
```

- [ ] **Step 4: Query + parse** — `PRism.GitHub/GitHubReviewService.cs`. Query line 43:

```csharp
"comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
```

In the comment loop of `ParseReviewThreads` (after `var cid = …`):

```csharp
                    long? cDbId = cn.TryGetProperty("databaseId", out var dbEl) && dbEl.ValueKind == JsonValueKind.Number
                        ? dbEl.GetInt64() : null;
```

and pass to the ctor:

```csharp
                    comments.Add(new ReviewCommentDto(cid, cauthor, cts, cbody, edited, cavatar, cDbId));
```

- [ ] **Step 5: Run → passes.** `dotnet test tests/PRism.GitHub.Tests --filter ParseReviewThreads_reads_databaseId_onto_comment_dto` → PASS.

- [ ] **Step 6: Frontend type** — `frontend/src/api/types.ts:203-210`, add to `ReviewCommentDto`:

```ts
  editedAt: string | null;
  databaseId?: number | null;   // #302 — REST numeric id for optimistic de-dup
}
```

- [ ] **Step 7: Typecheck + commit.** `cd frontend && npm run build` → clean.
```bash
git add PRism.Core.Contracts/ReviewThreadDto.cs PRism.GitHub/GitHubReviewService.cs PRism.GitHub/PRism.GitHub.csproj tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs frontend/src/api/types.ts
git commit -m "feat(#302): surface review-comment databaseId for optimistic de-dup"
```

---

### Task 2: Result + request contracts

**Files:** Modify `PRism.Core/Submit/SubmitResults.cs` (after line 47); Create `PRism.Core/Submit/ReviewCommentRequest.cs`.

- [ ] **Step 1: `CreatedReviewCommentResult`** — `SubmitResults.cs`:

```csharp
// #302 — returned by CreateReviewCommentAsync (REST id) and CreateReviewCommentReplyAsync (GraphQL
// databaseId). long Id is the numeric review-comment id; feeds DraftComment/DraftReply.PostedCommentId
// and the frontend databaseId de-dup. Mirrors CreatedIssueCommentResult.
public sealed record CreatedReviewCommentResult(long Id, DateTimeOffset CreatedAt);
```

- [ ] **Step 2: Request record** — `PRism.Core/Submit/ReviewCommentRequest.cs`:

```csharp
namespace PRism.Core.Submit;

// #302 — a single NEW inline review comment posted directly (REST POST /pulls/{n}/comments). Side is
// the GitHub REST value ("LEFT" | "RIGHT"); the endpoint upper-cases DraftComment.Side before building.
public sealed record ReviewCommentRequest(
    string CommitOid,
    string FilePath,
    int LineNumber,
    string Side,
    string BodyMarkdown);
```

- [ ] **Step 3: Build + commit.** `dotnet build PRism.Core` → clean.
```bash
git add PRism.Core/Submit/SubmitResults.cs PRism.Core/Submit/ReviewCommentRequest.cs
git commit -m "feat(#302): CreatedReviewCommentResult + ReviewCommentRequest"
```

---

### Task 3: `IReviewSubmitter` methods (REST inline + GraphQL reply) + adapter + fakes + contract test

**Files:** Modify `PRism.Core/IReviewSubmitter.cs`; Create `PRism.GitHub/GitHubReviewService.ReviewComments.cs`; Modify `tests/PRism.Core.Tests/Submit/ContractShapeTests.cs:41-58`; the 4 fakes.

- [ ] **Step 1: Verify current count, then update the contract test (red).** First confirm the live count is 8: `dotnet test tests/PRism.Core.Tests --filter IReviewSubmitter_HasEightMethods` → PASS (8). Then rename → `IReviewSubmitter_HasTenMethods`, bump to 10, add two asserts (`CreateReviewCommentAsync`, `CreateReviewCommentReplyAsync`), and fix the class XML-doc ("eight" → "ten").

- [ ] **Step 2: Run → fails.** `dotnet test tests/PRism.Core.Tests --filter IReviewSubmitter_HasTenMethods` → FAIL.

- [ ] **Step 3: Add interface methods** — `PRism.Core/IReviewSubmitter.cs`, after line 69:

```csharp
    // #302 — post a single NEW inline review comment directly (REST POST /pulls/{n}/comments),
    // bypassing the pending-review pipeline. Publishes immediately.
    Task<CreatedReviewCommentResult> CreateReviewCommentAsync(
        PrReference reference, ReviewCommentRequest request, CancellationToken ct);

    // #302 — post a single reply to an existing review thread directly, via GraphQL
    // addPullRequestReviewThreadReply WITHOUT a pullRequestReviewId (omitting it posts immediately —
    // see GitHubReviewService.Submit.cs:115-116). Uses the draft's own ParentThreadId.
    Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(
        PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct);
```

- [ ] **Step 4: Implement on the GitHub adapter** — `PRism.GitHub/GitHubReviewService.ReviewComments.cs`:

```csharp
using System.Net;
using System.Text;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Submit;

namespace PRism.GitHub;

// #302 — single-comment write path. Inline = REST POST /pulls/{n}/comments (mirrors IssueComments.cs).
// Reply = GraphQL addPullRequestReviewThreadReply with NO pullRequestReviewId (posts immediately).
public sealed partial class GitHubReviewService
{
    public async Task<CreatedReviewCommentResult> CreateReviewCommentAsync(
        PrReference reference, ReviewCommentRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(request);

        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/comments";
        var payload = JsonSerializer.Serialize(new
        {
            body = request.BodyMarkdown,
            commit_id = request.CommitOid,
            path = request.FilePath,
            line = request.LineNumber,
            side = request.Side,
        });

        using var http = _httpFactory.CreateClient("github");
        using var resp = await SendGitHubAsync(http, HttpMethod.Post, url, ct,
            content: new StringContent(payload, Encoding.UTF8, "application/json")).ConfigureAwait(false);

        if (!resp.IsSuccessStatusCode)
        {
            string errorBody = string.Empty;
            try { errorBody = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { throw; }
#pragma warning disable CA1031
            catch (Exception) { }
#pragma warning restore CA1031
            throw new HttpRequestException(
                $"GitHub review comment POST HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(errorBody, 512)}",
                inner: null, statusCode: resp.StatusCode);
        }

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64() : throw new HttpRequestException("review comment response missing 'id'.", inner: null, statusCode: HttpStatusCode.OK);
        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset() : throw new HttpRequestException("review comment response missing 'created_at'.", inner: null, statusCode: HttpStatusCode.OK);
        return new CreatedReviewCommentResult(id, createdAt);
    }

    public async Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(
        PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentException.ThrowIfNullOrEmpty(parentThreadId);
        ArgumentNullException.ThrowIfNull(bodyMarkdown);

        // No pullRequestReviewId → the reply posts immediately (GitHubReviewService.Submit.cs:115-116).
        const string mutation = """
            mutation($threadId: ID!, $body: String!) {
              addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
                comment { databaseId createdAt }
              }
            }
            """;
        var data = await PostSubmitGraphQLAsync(mutation, new { threadId = parentThreadId, body = bodyMarkdown }, ct).ConfigureAwait(false);
        if (!TryGetPath(data, out var dbEl, "addPullRequestReviewThreadReply", "comment", "databaseId")
            || dbEl.ValueKind != JsonValueKind.Number)
            throw new GitHubGraphQLException("addPullRequestReviewThreadReply response missing comment.databaseId.");
        var createdAt = TryGetPath(data, out var caEl, "addPullRequestReviewThreadReply", "comment", "createdAt") && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset() : default;
        return new CreatedReviewCommentResult(dbEl.GetInt64(), createdAt);
    }
}
```

> `PostSubmitGraphQLAsync`, `TryGetPath`, `GitHubGraphQLException`, `Truncate`, `SendGitHubAsync`, `_httpFactory` all exist (`GitHubReviewService.Submit.cs`, `.cs:750`). Confirm `TryGetPath` arity matches (it's used at `Submit.cs:135`).

- [ ] **Step 5: Stub the 3 unit-test fakes + compile-stub the e2e fake.** Add to `InMemoryReviewSubmitter`, `TestReviewSubmitter` (`SubmitEndpointFakes.cs`), `PrDetailFakeReviewService`:

```csharp
    public Task<CreatedReviewCommentResult> CreateReviewCommentAsync(PrReference reference, ReviewCommentRequest request, CancellationToken ct)
        => throw new NotImplementedException();
    public Task<CreatedReviewCommentResult> CreateReviewCommentReplyAsync(PrReference reference, string parentThreadId, string bodyMarkdown, CancellationToken ct)
        => throw new NotImplementedException();
```

`PRism.Web/TestHooks/FakeReviewSubmitter.cs` gets the same throwing stubs now; Task 12 gives it real in-memory behavior.

- [ ] **Step 6: Build + contract test (green).** `dotnet build` then `dotnet test tests/PRism.Core.Tests --filter IReviewSubmitter_HasTenMethods` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add PRism.Core/IReviewSubmitter.cs PRism.GitHub/GitHubReviewService.ReviewComments.cs tests/PRism.Core.Tests/Submit/ContractShapeTests.cs tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs tests/PRism.Web.Tests/TestHelpers/SubmitEndpointFakes.cs tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs PRism.Web/TestHooks/FakeReviewSubmitter.cs
git commit -m "feat(#302): IReviewSubmitter single inline (REST) + reply (GraphQL) methods"
```

---

### Task 4: `DraftReply` idempotency fields (persisted schema)

**Files:** Modify `PRism.Core/State/AppState.cs:78-84`. Test: round-trip.

- [ ] **Step 1: Failing round-trip test** (match the neighbouring AppState test's `JsonSerializerOptions` symbol):

```csharp
[Fact]
public void DraftReply_posted_fields_round_trip_and_default_null()
{
    var reply = new DraftReply("r1", "PRRT_1", null, "body", DraftStatus.Draft, false);
    Assert.Null(reply.PostedCommentId);
    Assert.Null(reply.PostedBodySnapshot);
    var stamped = reply with { PostedCommentId = 99L, PostedBodySnapshot = "body" };
    var json = JsonSerializer.Serialize(stamped, AppStateJson.Options);
    var back = JsonSerializer.Deserialize<DraftReply>(json, AppStateJson.Options)!;
    Assert.Equal(99L, back.PostedCommentId);
    Assert.Equal("body", back.PostedBodySnapshot);
}
```

- [ ] **Step 2: Run → fails.** `dotnet test tests/PRism.Core.Tests --filter DraftReply_posted_fields_round_trip_and_default_null` → FAIL.

- [ ] **Step 3: Add fields** — `AppState.cs`:

```csharp
public sealed record DraftReply(
    string Id, string ParentThreadId, string? ReplyCommentId, string BodyMarkdown,
    DraftStatus Status, bool IsOverriddenStale,
    long? PostedCommentId = null,        // #302 — stamped (= databaseId) after a successful post-now reply
    string? PostedBodySnapshot = null);  // #302 — body at post time, for idempotent re-post detection
```

- [ ] **Step 4: Run → passes + old-state lenient read.** `dotnet test tests/PRism.Core.Tests --filter "DraftReply_posted_fields_round_trip_and_default_null"` → PASS. Then `dotnet test tests/PRism.Core.Tests --filter AppState` → PASS (additive read; `Version` stays 7 per the `DraftComment` V7 precedent).

- [ ] **Step 5: Commit.**
```bash
git add PRism.Core/State/AppState.cs tests/PRism.Core.Tests/State/
git commit -m "feat(#302): DraftReply PostedCommentId/PostedBodySnapshot (additive schema)"
```

---

### Task 5: `SingleCommentPostedBusEvent`

**Files:** Modify `PRism.Core/Events/SubmitBusEvents.cs` (after `RootCommentPostedBusEvent`).

- [ ] **Step 1: Add the event**

```csharp
// #302 — published when a single inline comment or reply is posted directly (not via a review).
public sealed record SingleCommentPostedBusEvent(PrReference PrRef, long ReviewCommentId) : IReviewEvent;
```

- [ ] **Step 2: Build + commit.** `dotnet build PRism.Core` → clean.
```bash
git add PRism.Core/Events/SubmitBusEvents.cs
git commit -m "feat(#302): SingleCommentPostedBusEvent"
```

---

### Task 6: `PrCommentEndpoints` — POST …/comment/post

Mirrors `PrRootCommentEndpoints` (auth, lock, stamp-then-delete, sanitized errors). **Discriminates by draft kind** (no client flag). **Returns the created id** (`200 { postedCommentId }`) so the frontend can de-dup the optimistic placeholder. Defensive `AnchoredSha` empty-guard. Static `LoggerMessage.Define` (precedent style).

**Files:** Create `PRism.Web/Endpoints/PrCommentEndpoints.cs`; Modify `PRism.Web/Program.cs:320`. Test: `tests/PRism.Web.Tests/Endpoints/PrCommentEndpointTests.cs`.

- [ ] **Step 1: Failing endpoint tests** (model on `PrRootCommentEndpointTests.cs`):

```
1. Inline post: not-yet-posted DraftComment → CreateReviewCommentAsync once, PostedCommentId stamped,
   draft deleted, 200 { postedCommentId }.
2. Reply post: not-yet-posted DraftReply → CreateReviewCommentReplyAsync(parentThreadId,…) once,
   PostedCommentId stamped, draft deleted, 200.
3. Idempotent re-post (PostedCommentId set, snapshot == body) → no GitHub call, draft deleted, 200.
4. Body-mismatch (snapshot != body) → 409 PostMismatchErrorDto.
5. Cross-session draftId (belongs to PR-B, hit for PR-A) → 400 no-draft, no GitHub call. (Security-3.)
6. Empty AnchoredSha on inline draft → 400 missing-anchor, no GitHub call (defensive; F6 guard).
7. Unauthorized (not subscribed) → 401.
8. GitHub 5xx → 502 sanitized (no raw upstream body leaked).
```

Extend `TestReviewSubmitter` (in `SubmitEndpointFakes.cs`) to record `CreateReviewComment*` calls + an injectable failure.

- [ ] **Step 2: Run → fails.** `dotnet test tests/PRism.Web.Tests --filter PrCommentEndpoint` → FAIL (404).

- [ ] **Step 3: Implement** — `PRism.Web/Endpoints/PrCommentEndpoints.cs`:

```csharp
using System.Text.Json;
using PRism.Core;
using PRism.Core.Events;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

// #302 — POST /api/pr/{ref}/comment/post. Posts a single inline comment or reply directly (no review).
// Discriminates by draft KIND. Mirrors PrRootCommentEndpoints: IsSubscribed authz, per-PR lock,
// stamp-then-delete idempotency, sanitized errors, body-cap. Returns 200 { postedCommentId } so the
// frontend can de-dup the optimistic placeholder against the refetched comment.
internal static class PrCommentEndpoints
{
    private static readonly string[] FieldsTouched = { "draft-comments", "draft-replies" };
    private static readonly Action<ILogger, string, Exception?> s_commentPostFailed =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0, "CommentPostFailed"),
            "POST /comment/post failed with a GitHub error for {SessionKey}");

    internal sealed record PostCommentPayload(string DraftId);
    internal sealed record PostCommentOkDto(long PostedCommentId);

    public static IEndpointRouteBuilder MapPrCommentEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/comment/post", PostCommentAsync);
        return app;
    }

    private static async Task<IResult> PostCommentAsync(
        string owner, string repo, int number, PostCommentPayload payload,
        IAppStateStore stateStore, IActivePrCache activePrCache, IReviewSubmitter submitter,
        IReviewEventBus bus, SubmitLockRegistry lockRegistry, ILoggerFactory loggerFactory, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(payload);
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before posting a comment."),
                statusCode: StatusCodes.Status401Unauthorized);

#pragma warning disable CA2000
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit or post is already in flight for this PR."),
                statusCode: StatusCodes.Status409Conflict);
        try
        {
            var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session)) return NoDraft();

            // Discriminate by draft KIND, scoped to THIS session (Security-3).
            var inline = session.DraftComments.FirstOrDefault(d => d.Id == payload.DraftId);
            if (inline is { }) return await PostInlineAsync(prRef, sessionKey, inline, stateStore, submitter, bus, loggerFactory, ct).ConfigureAwait(false);
            var reply = session.DraftReplies.FirstOrDefault(r => r.Id == payload.DraftId);
            if (reply is { }) return await PostReplyAsync(prRef, sessionKey, reply, stateStore, submitter, bus, loggerFactory, ct).ConfigureAwait(false);
            return NoDraft();
        }
        finally { await handle.DisposeAsync().ConfigureAwait(false); }
    }

    private static async Task<IResult> PostInlineAsync(
        PrReference prRef, string sessionKey, DraftComment draft, IAppStateStore store,
        IReviewSubmitter submitter, IReviewEventBus bus, ILoggerFactory lf, CancellationToken ct)
    {
        if (draft.FilePath is null || draft.LineNumber is null) return NoDraft();
        if (draft.PostedCommentId is { } posted)
            return await AlreadyPostedAsync(store, sessionKey, draft.Id, draft.BodyMarkdown, draft.PostedBodySnapshot, posted, prRef, bus, isReply: false, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(draft.AnchoredSha))
            return Results.Json(new SubmitErrorDto("missing-anchor", "This draft has no commit anchor; reopen the composer and try again."), statusCode: StatusCodes.Status400BadRequest);
        if (draft.BodyMarkdown.Length > PipelineMarker.GitHubReviewBodyMaxChars) return BodyTooLarge();

        var request = new ReviewCommentRequest(draft.AnchoredSha, draft.FilePath, draft.LineNumber.Value,
            (draft.Side ?? "right").ToUpperInvariant(), draft.BodyMarkdown);
        CreatedReviewCommentResult created;
        try { created = await submitter.CreateReviewCommentAsync(prRef, request, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch (HttpRequestException hre) { return GitHubError(hre, lf, sessionKey); }
#pragma warning disable CA1031
        catch (Exception ex) { return GitHubError(ex, lf, sessionKey); }
#pragma warning restore CA1031

        await StampThenDeleteComment(store, sessionKey, draft.Id, created.Id, draft.BodyMarkdown, ct).ConfigureAwait(false);
        Publish(bus, prRef, created.Id);
        return Results.Json(new PostCommentOkDto(created.Id));
    }

    private static async Task<IResult> PostReplyAsync(
        PrReference prRef, string sessionKey, DraftReply draft, IAppStateStore store,
        IReviewSubmitter submitter, IReviewEventBus bus, ILoggerFactory lf, CancellationToken ct)
    {
        if (draft.PostedCommentId is { } posted)
            return await AlreadyPostedAsync(store, sessionKey, draft.Id, draft.BodyMarkdown, draft.PostedBodySnapshot, posted, prRef, bus, isReply: true, ct).ConfigureAwait(false);
        if (draft.BodyMarkdown.Length > PipelineMarker.GitHubReviewBodyMaxChars) return BodyTooLarge();

        CreatedReviewCommentResult created;
        try { created = await submitter.CreateReviewCommentReplyAsync(prRef, draft.ParentThreadId, draft.BodyMarkdown, ct).ConfigureAwait(false); }
        catch (OperationCanceledException) { throw; }
        catch (HttpRequestException hre) { return GitHubError(hre, lf, sessionKey); }
#pragma warning disable CA1031
        catch (Exception ex) { return GitHubError(ex, lf, sessionKey); }
#pragma warning restore CA1031

        await StampThenDeleteReply(store, sessionKey, draft.Id, created.Id, draft.BodyMarkdown, ct).ConfigureAwait(false);
        Publish(bus, prRef, created.Id);
        return Results.Json(new PostCommentOkDto(created.Id));
    }

    private static void Publish(IReviewEventBus bus, PrReference prRef, long id)
    {
        bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
        bus.Publish(new SingleCommentPostedBusEvent(prRef, id));
    }

    private static IResult NoDraft() => Results.Json(new SubmitErrorDto("no-draft", "No matching draft for this PR."), statusCode: StatusCodes.Status400BadRequest);
    private static IResult BodyTooLarge() => Results.Json(new SubmitErrorDto("body-too-large", $"The comment body exceeds the GitHub limit of {PipelineMarker.GitHubReviewBodyMaxChars} characters."), statusCode: StatusCodes.Status400BadRequest);

    private static IResult GitHubError(Exception ex, ILoggerFactory lf, string sessionKey)
    {
        s_commentPostFailed(lf.CreateLogger(typeof(PrCommentEndpoints).FullName!), sessionKey, ex);
        var (code, message) = (ex as HttpRequestException)?.StatusCode switch
        {
            System.Net.HttpStatusCode.Forbidden => ("github-forbidden", "GitHub rejected the request (forbidden). Check your token's permissions."),
            System.Net.HttpStatusCode.Unauthorized => ("github-unauthorized", "GitHub authentication failed. Reconnect your account."),
            System.Net.HttpStatusCode.UnprocessableEntity => ("github-validation-error", "GitHub rejected the request as invalid."),
            _ => ("github-network-error", "Couldn't reach GitHub. Try again."),
        };
        return Results.Json(new SubmitErrorDto(code, message), statusCode: StatusCodes.Status502BadGateway);
    }

    private static async Task<IResult> AlreadyPostedAsync(IAppStateStore store, string sessionKey, string draftId,
        string body, string? snapshot, long postedId, PrReference prRef, IReviewEventBus bus, bool isReply, CancellationToken ct)
    {
        if (!string.Equals(snapshot, body, StringComparison.Ordinal))
            return Results.Json(new PostMismatchErrorDto("already-posted-body-mismatch",
                "The draft body was edited after it was first posted. Discard the local draft or edit the comment on github.com.", postedId),
                statusCode: StatusCodes.Status409Conflict);
        if (isReply) await DeleteReply(store, sessionKey, draftId, ct).ConfigureAwait(false);
        else await DeleteComment(store, sessionKey, draftId, ct).ConfigureAwait(false);
        bus.Publish(new StateChanged(prRef, FieldsTouched, SourceTabId: null));
        return Results.Json(new PostCommentOkDto(postedId));
    }

    private static Task StampThenDeleteComment(IAppStateStore store, string sessionKey, string draftId, long postedId, string body, CancellationToken ct) =>
        TwoStep(store, sessionKey, ct,
            s => s with { DraftComments = s.DraftComments.Select(d => d.Id == draftId ? d with { PostedCommentId = postedId, PostedBodySnapshot = body } : d).ToList() },
            s => s with { DraftComments = s.DraftComments.Where(d => d.Id != draftId).ToList() });
    private static Task StampThenDeleteReply(IAppStateStore store, string sessionKey, string draftId, long postedId, string body, CancellationToken ct) =>
        TwoStep(store, sessionKey, ct,
            s => s with { DraftReplies = s.DraftReplies.Select(r => r.Id == draftId ? r with { PostedCommentId = postedId, PostedBodySnapshot = body } : r).ToList() },
            s => s with { DraftReplies = s.DraftReplies.Where(r => r.Id != draftId).ToList() });

    private static async Task TwoStep(IAppStateStore store, string sessionKey, CancellationToken ct,
        Func<ReviewSessionState, ReviewSessionState> stamp, Func<ReviewSessionState, ReviewSessionState> delete)
    {
        await store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? WithSession(state, sessionKey, stamp(s)) : state, ct).ConfigureAwait(false);
        await store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? WithSession(state, sessionKey, delete(s)) : state, ct).ConfigureAwait(false);
    }
    private static Task DeleteComment(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? WithSession(state, sessionKey, s with { DraftComments = s.DraftComments.Where(d => d.Id != draftId).ToList() }) : state, ct);
    private static Task DeleteReply(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state => state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? WithSession(state, sessionKey, s with { DraftReplies = s.DraftReplies.Where(r => r.Id != draftId).ToList() }) : state, ct);

    private static AppState WithSession(AppState state, string sessionKey, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = session };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }
}
```

> Confirm `using`s against `PrRootCommentEndpoints.cs`. `PostMismatchErrorDto`/`SubmitErrorDto` are `internal` in this namespace (reused).

- [ ] **Step 4: Register** — `PRism.Web/Program.cs` after line 320: `app.MapPrCommentEndpoints();`

- [ ] **Step 5: Run → passes.** `dotnet test tests/PRism.Web.Tests --filter PrCommentEndpoint` → PASS (all 8).

- [ ] **Step 6: Commit.**
```bash
git add PRism.Web/Endpoints/PrCommentEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrCommentEndpointTests.cs tests/PRism.Web.Tests/TestHelpers/SubmitEndpointFakes.cs
git commit -m "feat(#302): POST /comment/post (kind-discriminated, returns id, stamp-then-delete)"
```

---

## Phase B — Frontend write path + UI

### Task 7: `api/comment.ts` client

**Files:** Create `frontend/src/api/comment.ts`. Test: `frontend/__tests__/api/comment.test.ts`.

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postComment } from '../../src/api/comment';
import { apiClient, ApiError } from '../../src/api/client';

vi.mock('../../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../../src/api/client')>();
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});
const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('postComment', () => {
  beforeEach(() => vi.clearAllMocks());
  it('posts and returns ok with postedCommentId', async () => {
    (apiClient.post as any).mockResolvedValue({ postedCommentId: 4242 });
    const res = await postComment(prRef, 'draft-1');
    expect(apiClient.post).toHaveBeenCalledWith('/api/pr/o/r/1/comment/post', { draftId: 'draft-1' }, expect.anything());
    expect(res).toEqual({ ok: true, postedCommentId: 4242 });
  });
  it('maps an ApiError to a no-throw failure union', async () => {
    (apiClient.post as any).mockRejectedValue(new ApiError(502, null, { code: 'github-network-error', message: "Couldn't reach GitHub. Try again." }));
    const res = await postComment(prRef, 'draft-1');
    expect(res).toMatchObject({ ok: false, status: 502, code: 'github-network-error' });
  });
});
```

> `ApiError` is `new ApiError(status, requestId, body)` (`client.ts:8`) — 3 args; the payload goes in the **third** slot.

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/api/comment.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `frontend/src/api/comment.ts`:

```ts
import type { PrReference } from './types';
import { apiClient, ApiError } from './client';

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

export type PostCommentResult =
  | { ok: true; postedCommentId: number }
  | { ok: false; status: number; code: string; message: string; postedCommentId?: number };

// Single endpoint; the backend discriminates inline vs reply by draft kind.
export async function postComment(prRef: PrReference, draftId: string): Promise<PostCommentResult> {
  try {
    const res = await apiClient.post<{ postedCommentId: number }>(`${prPath(prRef)}/comment/post`, { draftId }, { headers: {} });
    return { ok: true, postedCommentId: res.postedCommentId };
  } catch (e) {
    if (e instanceof ApiError) {
      const payload = (e.body ?? {}) as { code?: string; message?: string; postedCommentId?: number };
      return { ok: false, status: e.status, code: payload.code ?? 'unknown', message: payload.message ?? 'Failed to post the comment.', postedCommentId: payload.postedCommentId };
    }
    return { ok: false, status: 0, code: 'network', message: 'Network error.' };
  }
}
```

> `apiClient` already attaches the tab-id header on every call (`client.ts:57`); no manual header needed. Confirm `ApiError.body`/`.status` property names against `client.ts:8-12`.

- [ ] **Step 4: Run → passes.** `cd frontend && npx vitest run __tests__/api/comment.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.** `cd frontend && npm run build` → clean.
```bash
git add frontend/src/api/comment.ts frontend/__tests__/api/comment.test.ts
git commit -m "feat(#302): api/comment.ts postComment (single endpoint, returns id)"
```

---

### Task 8: `flush()` returns the assigned id + draft-session posting suppression

Two small shared-state changes the composer post-now flow depends on: `flush()` returning the (possibly just-assigned) draft id, and a global `postingInProgress` suppressor for mutual exclusion.

**Files:** Modify `frontend/src/hooks/useComposerAutoSave.ts` (flush return type); `frontend/src/hooks/useDraftSession.ts`. Tests: `frontend/__tests__/useDraftSession.staged.test.tsx`.

- [ ] **Step 1: Failing test** (the pure selector + suppression):

```ts
import { describe, it, expect } from 'vitest';
import { computeAnyOtherDraftsStaged } from '../src/hooks/useDraftSession';
const c = (id: string) => ({ id, filePath: 'a', lineNumber: 1, side: 'right', anchoredSha: 's', anchoredLineContent: '', bodyMarkdown: 'x', status: 'draft', isOverriddenStale: false, postedCommentId: null });
const r = (id: string) => ({ id, parentThreadId: 't', replyCommentId: null, bodyMarkdown: 'x', status: 'draft', isOverriddenStale: false });

describe('computeAnyOtherDraftsStaged', () => {
  it('false when the only draft is the composer’s own', () => expect(computeAnyOtherDraftsStaged([c('mine')], [], 'mine', false)).toBe(false));
  it('true when another draft is staged', () => expect(computeAnyOtherDraftsStaged([c('mine'), c('other')], [], 'mine', false)).toBe(true));
  it('false during a post-in-flight (global suppression)', () => expect(computeAnyOtherDraftsStaged([c('mine'), c('other')], [], 'mine', true)).toBe(false));
  it('counts replies too', () => expect(computeAnyOtherDraftsStaged([], [r('reply1')], null, false)).toBe(true));
});
```

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/useDraftSession.staged.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** In `useDraftSession.ts`:

```ts
import type { DraftCommentDto, DraftReplyDto } from '../api/types';

// Are there OTHER staged drafts besides this composer's own? During a post-now (postingInProgress),
// suppress entirely: by D3 post-now is only reachable when no other real drafts are staged, so the
// only draft present mid-post is the transient one — never flicker other composers. (#302 D3 + F3/F5.)
export function computeAnyOtherDraftsStaged(
  comments: DraftCommentDto[], replies: DraftReplyDto[], ownDraftId: string | null, postingInProgress: boolean,
): boolean {
  if (postingInProgress) return false;
  return comments.some((d) => d.id !== ownDraftId) || replies.some((r) => r.id !== ownDraftId);
}
```

Add ref-counted suppression to the hook + expose it:

```ts
const postingCountRef = useRef(0);
const [postingInProgress, setPostingInProgress] = useState(false);
const beginPosting = useCallback(() => { postingCountRef.current += 1; setPostingInProgress(true); }, []);
const endPosting = useCallback(() => { postingCountRef.current = Math.max(0, postingCountRef.current - 1); setPostingInProgress(postingCountRef.current > 0); }, []);
```

Add to `UseDraftSessionResult` + the returned object: `postingInProgress: boolean; beginPosting: () => void; endPosting: () => void;`.

In `useComposerAutoSave.ts`, change `flush` to return the id. The hook already tracks `draftIdRef` (`:66,107`); make `flush()` resolve to `draftIdRef.current`:

```ts
const flush = useCallback(async (): Promise<string | null> => {
  await performSave(/* existing args */);
  return draftIdRef.current;
}, [/* existing deps */]);
```

Update the `useComposerAutoSave` return type (`{ badge, flush }`) to `flush: () => Promise<string | null>`. Existing callers that `await flush()` and ignore the result keep working.

- [ ] **Step 4: Run → passes.** `cd frontend && npx vitest run __tests__/useDraftSession.staged.test.tsx` → PASS.

- [ ] **Step 5: Typecheck + commit.** `cd frontend && npm run build` → clean.
```bash
git add frontend/src/hooks/useDraftSession.ts frontend/src/hooks/useComposerAutoSave.ts frontend/__tests__/useDraftSession.staged.test.tsx
git commit -m "feat(#302): flush() returns draft id + posting-in-progress mutual-exclusion suppression"
```

---

### Task 9: InlineCommentComposer — `Add to review` + `Comment` + post-now

**Files:** Modify `InlineCommentComposer.tsx` (+ composer CSS). Test: `frontend/__tests__/InlineCommentComposer.postNow.test.tsx`.

- [ ] **Step 1: Failing tests:**

```
1. Open PR, anyOtherDraftsStaged=false: both "Add to review" and "Comment" render.
2. anyOtherDraftsStaged=true: "Comment" disabled w/ the mutual-exclusion tooltip; draft button reads "Add review comment".
3. prState='merged': only "Comment" + the merged sub-label; no "Add to review".
4. Click "Comment": beginPosting() called, then flush() resolves an id, then postComment(prRef, id) called,
   then onPosted(id) fired, then onClose(); endPosting() in finally.
5. postComment fails: error banner shown, composer stays open (no onClose), body intact, endPosting() called.
```

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/InlineCommentComposer.postNow.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** Add **optional** props (so the FilesTab call-site compiles before/after Task 11):

```ts
  anyOtherDraftsStaged?: boolean;            // default false
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number) => void;
```

Post-now handler (the F2 fix — use the id flush returns, not the stale prop):

```tsx
const [postError, setPostError] = useState<string | null>(null);
const [posting, setPosting] = useState(false);

const handlePostNow = async () => {
  if (saveDisabled || posting) return;
  setPostError(null);
  setPosting(true);
  props.beginPosting?.();                       // synchronous, BEFORE flush → no flicker (F3)
  try {
    const id = (await flush()) ?? draftId;       // id assigned during flush; prop is stale (F2)
    if (!id) { setPostError('Could not save the draft. Try again.'); return; }
    const res = await postComment(props.prRef, id);
    if (res.ok) { props.onPosted?.(res.postedCommentId); props.onClose(); }
    else { setPostError(res.message); }
  } finally { setPosting(false); props.endPosting?.(); }
};
```

Footer label/disable logic + JSX (replace the single Save button, lines 301-310):

```tsx
const reviewInProgress = props.anyOtherDraftsStaged ?? false;
const isMerged = prState !== 'open';
const addLabel = reviewInProgress ? 'Add review comment' : 'Add to review';
const postNowDisabled = saveDisabled || posting || reviewInProgress;
const postNowTooltip = reviewInProgress
  ? 'You have a review in progress — submit or discard it to post a single comment.'
  : saveTooltip;
```

```tsx
{!isMerged && (
  <button type="button" className="composer-save" aria-disabled={saveDisabled} title={saveTooltip} onClick={handleSaveClick} disabled={readOnly}>
    {addLabel}
  </button>
)}
<button type="button" className="composer-post-now" aria-disabled={postNowDisabled} title={postNowTooltip} onClick={handlePostNow} disabled={readOnly || postNowDisabled}>
  {posting ? 'Posting…' : 'Comment'}
</button>
{isMerged && <span className="composer-merged-note">PR is merged — comments post immediately</span>}
{postError && <div className="composer-error" role="alert">{postError}</div>}
```

Focus on success (Design-6): `onClose()` collapses the composer; `onPosted` (Task 11) renders the optimistic comment; focus returns to the collapsed affordance (`CollapsedComposerAffordance` already renders a focusable button at the line). On failure the composer stays and focus remains in the textarea. No extra focus call needed; assert focus in the RTL test (step 1, case 5 keeps focus in textarea).

- [ ] **Step 4: Run → passes.** `cd frontend && npx vitest run __tests__/InlineCommentComposer.postNow.test.tsx` → PASS. Then **`cd frontend && npm run build`** (tsc -b) → clean (props are optional, so the unmodified FilesTab call-site still typechecks).

- [ ] **Step 5: Style** — add `.composer-post-now` (primary/filled), `.composer-merged-note`, `.composer-error` (reuse #287 inline-error treatment) to the composer CSS.

- [ ] **Step 6: Commit.**
```bash
git add frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx frontend/__tests__/InlineCommentComposer.postNow.test.tsx frontend/src/components/PrDetail/Composer/*.css
git commit -m "feat(#302): inline composer post-now Comment button + mutual exclusion"
```

---

### Task 10: ReplyComposer — same footer + post-now (reply path)

Identical structure to Task 9. No `inReplyToCommentId` (the backend uses the draft's `ParentThreadId`); no reload-to-reply fallback. A reply can be staged (`Add to review`) or posted now; on merged, only `Comment`.

**Files:** Modify `ReplyComposer.tsx`. Test: `frontend/__tests__/ReplyComposer.postNow.test.tsx`.

- [ ] **Step 1: Failing tests** — same five rows as Task 9 (the post action is `postComment(prRef, id)` — the backend resolves it as a reply by kind).

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/ReplyComposer.postNow.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** Add the same optional props as Task 9 (`anyOtherDraftsStaged?`, `beginPosting?`, `endPosting?`, `onPosted?`). `handlePostNow` is identical to Task 9. Footer JSX is identical to Task 9 (the `{!isMerged && (<Add-to-review button/>)}`, the `Comment` button, the merged note, the error banner) — a reply has the same two-path footer.

- [ ] **Step 4: Run → passes + build.** `cd frontend && npx vitest run __tests__/ReplyComposer.postNow.test.tsx` → PASS; `npm run build` → clean.

- [ ] **Step 5: Commit.**
```bash
git add frontend/src/components/PrDetail/Composer/ReplyComposer.tsx frontend/__tests__/ReplyComposer.postNow.test.tsx
git commit -m "feat(#302): reply composer post-now (ParentThreadId, no client reply id)"
```

---

### Task 11: Optimistic inline render + FilesTab wiring (de-dup by databaseId)

On post-now success the comment appears in the thread instantly (D5), de-duped against the refetched real comment by `databaseId` (Adversarial-S3 / F4 fix). FilesTab owns the optimistic store and passes the post-now props into the composers.

**Files:** Modify `FilesTab.tsx`, `ExistingCommentWidget.tsx`. Test: `frontend/__tests__/ExistingCommentWidget.optimistic.test.tsx`.

- [ ] **Step 1: Failing test:**

```
Given a thread, when an optimistic comment {postedCommentId: 4242, body} is supplied for that threadId,
ExistingCommentWidget renders an extra dimmed "Posting…" CommentCard. When thread.comments later contains
a comment with databaseId === 4242, the optimistic copy is NOT double-rendered (de-dup by databaseId).
A second optimistic with an as-yet-unknown id falls back to a normalized body match.
```

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/ExistingCommentWidget.optimistic.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** In `FilesTab`:

```tsx
interface OptimisticComment { clientId: string; threadId: string | null; anchor?: InlineAnchor; body: string; author: string; postedCommentId?: number; }
const [optimistic, setOptimistic] = useState<OptimisticComment[]>([]);
const meLogin = prDetail.viewer?.login ?? 'you';   // confirm viewer field name; fallback 'you'
```

Inline `onPosted(postedCommentId)` pushes `{ clientId, threadId: null, anchor: activeAnchor, body, author: meLogin, postedCommentId }` then `void draftSession.refetch()`. Reply `onPosted` pushes with `threadId = parentThreadId`. After refetch resolves, drop any optimistic entry whose `postedCommentId` now appears in the refetched data (by `databaseId`).

Compute `anyOtherDraftsStaged` per composer via the Task 8 selector and pass post-now props. The inline composer wiring (`renderComposerForLine`, FilesTab:329-349) gains:

```tsx
  anyOtherDraftsStaged={computeAnyOtherDraftsStaged(draftSession.session?.draftComments ?? [], draftSession.session?.draftReplies ?? [], composerDraftId, draftSession.postingInProgress)}
  beginPosting={draftSession.beginPosting}
  endPosting={draftSession.endPosting}
  onPosted={(id) => { /* push inline optimistic + refetch */ }}
```

`replyContext` (FilesTab:366-383) gains `beginPosting`, `endPosting`, a `computeStaged(ownId)` helper, and `onReplyPosted(threadId, id, body)`; `ExistingCommentWidgetReplyContext` (which already carries `prState`) is extended with these + `optimisticByThread: OptimisticComment[]`.

In `ExistingCommentWidget`, after the `thread.comments.map(...)` (lines 83-98), render optimistic cards for this `threadId`, de-duped by id (fallback normalized body):

```tsx
{optimisticForThisThread
  .filter((o) => !thread.comments.some((c) =>
    (o.postedCommentId != null && c.databaseId === o.postedCommentId) ||
    (o.postedCommentId == null && c.body.trim() === o.body.trim())))
  .map((o) => (
    <CommentCard key={o.clientId} author={o.author} createdAt={new Date().toISOString()} body={o.body}
      density="compact" className="comment-card--posting" data-testid="inline-comment-card-optimistic" />
  ))}
```

For a brand-new inline thread (threadId null), render its optimistic card at the line (FilesTab keeps a small "new-thread optimistic" slot near `renderComposerForLine`); it clears on refetch when the new thread appears.

> Largest task. Acceptable to split in execution: **11a** wire post-now props + `anyOtherDraftsStaged` through FilesTab/replyContext (composers go live, comments appear via refetch only); **11b** add the optimistic placeholder + de-dup. Each still TDD. If 11b proves heavy, the spec's D5 "appears instantly" can be satisfied minimally by 11a (refetch, ~300–800ms) — but D5 is the owner's brainstorm choice, so default to shipping 11b.

- [ ] **Step 4: Run → passes.** `cd frontend && npx vitest run __tests__/ExistingCommentWidget.optimistic.test.tsx __tests__/InlineCommentComposer.postNow.test.tsx __tests__/ReplyComposer.postNow.test.tsx` → PASS.

- [ ] **Step 5: Typecheck + commit.** `cd frontend && npm run build` → clean.
```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/__tests__/ExistingCommentWidget.optimistic.test.tsx
git commit -m "feat(#302): optimistic inline render (de-dup by databaseId) + post-now wiring"
```

---

### Task 12: `prState` into the affordance + merged composer + real e2e fake

**Files:** Modify `CollapsedComposerAffordance.tsx`, `ExistingCommentWidget.tsx`, `PRism.Web/TestHooks/FakeReviewSubmitter.cs`. Test: `frontend/__tests__/CollapsedComposerAffordance.test.tsx`.

- [ ] **Step 1: Failing test** — affordance accepts + forwards `prState`; stays enabled on merged (disabled only by `readOnly`).

- [ ] **Step 2: Run → fails.** `cd frontend && npx vitest run __tests__/CollapsedComposerAffordance.test.tsx` → FAIL (new prop).

- [ ] **Step 3: Add `prState`** — `CollapsedComposerAffordance.tsx`:

```tsx
export interface CollapsedComposerAffordanceProps {
  label: string; ariaLabel: string; hasDraft?: boolean; readOnly?: boolean;
  prState?: 'open' | 'closed' | 'merged';   // #302 — forwarded so the opened composer is post-now-only on merged
  onOpen: () => void;
}
```

`disabled={readOnly}` stays (merge does not disable opening). `prState` is **already available** in `ExistingCommentWidgetReplyContext` (it carries `prState`), so pass `prState={replyContext.prState}` where the affordance is rendered (`ExistingCommentWidget.tsx:106`). No new threading needed (Scope-4 audit: confirmed available).

- [ ] **Step 4: Real e2e fake** — `PRism.Web/TestHooks/FakeReviewSubmitter.cs`: replace the Task-3 throwing stubs with in-memory behavior mirroring `CreateIssueCommentAsync` (lines 203-221): append to `_reviewCommentsCreated`, honour `InjectFailure`, return `CreatedReviewCommentResult(_nextId++, …)`; add `SnapshotReviewComments()`.

- [ ] **Step 5: Run + build.** `cd frontend && npx vitest run __tests__/CollapsedComposerAffordance.test.tsx` → PASS; `dotnet build PRism.Web` → clean.

- [ ] **Step 6: Commit.**
```bash
git add frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/__tests__/CollapsedComposerAffordance.test.tsx PRism.Web/TestHooks/FakeReviewSubmitter.cs
git commit -m "feat(#302): prState into affordance + in-memory e2e review-comment fake"
```

---

## Phase C — e2e

### Task 13: Playwright e2e

**Files:** Create `frontend/e2e/pr-detail-single-comment.spec.ts`. Reuse the `PRISM_E2E_FAKE_REVIEW=1` harness (Task 12 fake).

- [ ] **Step 1: Write specs:** (1) inline post-now → comment appears, no review submitted (fake recorded a review-comment, not `submitPullRequestReview`); (2) reply post-now → reply appears; (3) stage a draft then another composer's `Comment` is disabled + the staged-draft button reads `Add review comment`; (4) merged PR → only `Comment` + merged note; (5) atomic review flow still works.

- [ ] **Step 2: Run.** `cd frontend && npx playwright test pr-detail-single-comment` (dev server on the parallel-agent `(port, dataDir)` per `.ai/docs/parallel-agent-testing.md`). → PASS after Tasks 1–12.

- [ ] **Step 3: Commit.**
```bash
git add frontend/e2e/pr-detail-single-comment.spec.ts
git commit -m "test(#302): e2e single-comment post, reply, mutual-exclusion, merged"
```

---

## Final verification (before PR)

- [ ] **Backend full suite:** `dotnet test` — all green.
- [ ] **Frontend unit:** `cd frontend && npx vitest run` — all green.
- [ ] **Frontend typecheck + build:** `cd frontend && npm run build` (`tsc -b`, NOT `tsc --noEmit`) — clean.
- [ ] **e2e:** `cd frontend && npx playwright test` — green.
- [ ] **Secrets scan** over the diff (behavioral-guidelines §6).
- [ ] **S1 verification (gated premise):** confirm a **new inline thread** post succeeds on a *merged* PR (head/merge commit, line in the final diff). If GitHub 422s, apply spec § 7 fallback (suppress new-thread post-now on merged; keep reply + PR-root; hint to the Conversation tab). Record in `## Proof`.
- [ ] **B1 visual:** screenshots of the three composer states + the optimistic `Posting…` state, for the owner's visual assert.

---

## Self-Review (plan vs. spec)

**Spec coverage:** inline single comment (Tasks 2,3,6,9,11,13) ✓; reply (Tasks 3 GraphQL,6,10,11,13) ✓; atomic unchanged (no pipeline edits; Task 13 case 5) ✓; two paths distinct + relabel (Tasks 9,10) ✓; idempotency + accepted window (Task 6 cases 3-4) ✓; merged composer (Tasks 9,10,12; S1 in Final) ✓; mutual exclusion + global suppression (Task 8 + 9/10) ✓; optimistic render + de-dup by databaseId (Tasks 1,11) ✓; session-scoped + kind-discriminated lookup (Task 6 cases 5-6) ✓; schema additive (Task 4) ✓; contract/fakes (Task 3) ✓; error table (Task 6 + 9/10 banner) ✓; tooltip/discard/merged-note/focus (Task 9) ✓.

**Placeholder scan:** no TBD/TODO; real code per code-step. Task 11's optional execution split is TDD-bounded, not a placeholder.

**Type consistency:** `CreatedReviewCommentResult(long Id, DateTimeOffset)`; `CreateReviewCommentReplyAsync(reference, parentThreadId, body, ct)`; `postComment(prRef, draftId) → { ok, postedCommentId }`; `computeAnyOtherDraftsStaged(comments, replies, ownDraftId, postingInProgress)`; `beginPosting`/`endPosting`; `flush(): Promise<string|null>`; `DatabaseId`/`databaseId`. ✓

**Out-of-scope honored:** no marker/reconciliation, no `PostAttempted`, no PR-root change, no atomic-pipeline edits, no edit/delete, no client-supplied reply id. ✓

---

## `ce-doc-review` disposition (plan, 1 pass, 2026-06-09 — 4 personas)

**Applied — bugs:**
- *Adversarial-F2 / stale `draftId` after flush* → `flush()` returns the id; `handlePostNow` uses it (Task 8 + 9). **Applied.**
- *Adversarial-F3 / markPosting-after-flush flicker* → synchronous global `postingInProgress` suppression set before flush (Task 8 + 9). **Applied.**
- *Adversarial-F4 / Scope-1 / body-match de-dup* → endpoint returns the created id; optimistic keyed on `databaseId` with normalized-body fallback (Tasks 6,7,11). **Applied.**
- *Adversarial-F5 / reply target spoofing* → reply via GraphQL `addPullRequestReviewThreadReply` (no client id, uses `ParentThreadId`); endpoint discriminates by draft kind (Tasks 3,6). **Applied (design improvement).**
- *Feasibility-1 / `ApiError` 2-arg ctor* → 3-arg `(status, requestId, body)` in the test (Task 7). **Applied.**
- *Coherence-1 / Feasibility-2 / required props break build* → post-now props made optional with defaults + `npm run build` gate added to Tasks 9/10 (Task 9 Step 4). **Applied.**

**Applied — clarity/consistency:**
- *Coherence-3 / Task 10 footer ambiguity* → spelled out (identical two-path footer) (Task 10). **Applied.**
- *Coherence-2 / focus-on-success* → success closes composer + focus to the collapsed affordance; failure keeps textarea focus; asserted in RTL (Task 9). **Applied.**
- *Scope-3 / inline-logger* → static `LoggerMessage.Define` (precedent) (Task 6). **Applied.**
- *Finding-8 / verify count before bumping* → Task 3 Step 1 verifies 8 first. **Applied.**
- *Coherence-4 / Task 12 prState audit* → confirmed `prState` already on `ExistingCommentWidgetReplyContext`; noted, no threading needed (Task 12). **Applied.**
- *Adversarial-F6 / empty `commit_id`* → **not a blocker** (`FilesTab.openComposerAt:268` stamps `anchoredSha = prDetail.pr.headSha`); defensive `400 missing-anchor` guard added anyway (Task 6 case 6). **Applied (guard).**

**Acknowledged (no change):**
- *Adversarial-F1 / stamp-then-delete ordering* — attack failed; ordering is crash-safe (matches root-comment precedent). **Acknowledged.**
- *Scope-7 / optimistic vs refetch* — D5 "appears instantly" is the owner's brainstorm choice; kept optimistic with the corrected de-dup. Task 11 notes the refetch-only fallback if the owner reconsiders at the gate. **Acknowledged.**
- *Side normalization, REST payloads, symbol resolution (Feasibility confirmations)* — verified correct. **Acknowledged.**
