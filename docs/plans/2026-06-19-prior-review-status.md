# Viewer Prior-Review Status (PR detail, Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the viewer's latest submitted review (state + relative time + stale-vs-head) on the PR-detail review-action button, sourced from the existing GraphQL detail fetch.

**Architecture:** Backend adds a `viewer{login}` field + a `reviews(last:100)` connection to the existing PR-detail GraphQL query; a new `GitHubPrParser.ParseViewerReview` selects the viewer's latest effective review (max `submittedAt`, excluding `DISMISSED`/`PENDING`) and ships a `ViewerReview { State, SubmittedAt, CommitSha? }` on `PrDetailDto`. Frontend folds it into the existing `ReviewActionButton`: fill reflects the submitted verdict, a caption underneath shows "You reviewed · {ago}" + an "out of date" flag; the same control still changes the review.

**Tech Stack:** C# / .NET 10, System.Text.Json (GraphQL parsing), xUnit + FluentAssertions; React + TypeScript + Vitest, CSS Modules.

## Global Constraints

- Spec: `docs/specs/2026-06-19-prior-review-status-design.md`. Source issue #512. **Gated B1** — the plan and the visual result both return to the owner.
- Wire enum vocabulary: kebab-case via the already-registered `JsonStringEnumConverter(KebabCaseJsonNamingPolicy)` on `JsonSerializerOptionsFactory.Api`. `ReviewState` → `approved` / `changes-requested` / `commented`. **Output-only**; no custom converter or allowlist (#318's inbound concern does not apply).
- Selection mirrors #367: max `submittedAt` among the viewer's submitted reviews; **exclude `DISMISSED`** and `PENDING`. **Decoupled from staleness** — do NOT require a commit; `CommitSha` is nullable.
- Staleness is a **boolean** ("out of date"), computed frontend-side; **no commit count** in Slice 1 (the loaded commit list is `TimelineCapHit`-capped and a count could be silently wrong).
- `GitHubPrParser` is `internal static`, test-visible via `InternalsVisibleTo` (`PRism.GitHub.Tests`, `PRism.GitHub.Tests.Integration`).
- Reuse the existing `formatAge` (`frontend/src/utils/relativeTime.ts`) for relative time — do NOT write a new formatter.
- `deriveFace` stays pure (no `Date.now()`): it returns structured caption data; `ReviewActionButton.tsx` composes the time string with `formatAge`.
- Out of scope (do not build): inbox marker, commit count, review-summary-in-conversation, multi-review history, self-review submit gating.
- Local pre-push checklist per `.ai/docs/development-process.md` before the PR.

---

## File Structure

**Backend**
- `PRism.Core.Contracts/ReviewState.cs` — NEW enum.
- `PRism.Core.Contracts/ViewerReview.cs` — NEW record.
- `PRism.Core.Contracts/PrDetailDto.cs` — MODIFY: append `ViewerReview? ViewerReview`.
- `PRism.GitHub/GitHubPrParser.cs` — MODIFY: add `ParseViewerReview` + `MapReviewState`.
- `PRism.GitHub/GitHubReviewService.cs` — MODIFY: query (add `viewer{login}` + `reviews(...)`); `GetPrDetailAsync` resolves viewer login + calls parser + passes to DTO.
- `PRism.Web/TestHooks/FakePrReader.cs` — MODIFY: pass `ViewerReview: null` to the constructor.

**Backend tests**
- `tests/PRism.Core.Tests/Contracts/ReviewStateSerializationTests.cs` — NEW (kebab probe).
- `tests/PRism.GitHub.Tests/ParseViewerReviewTests.cs` — NEW.
- `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` — MODIFY: `ExpectedPrDetail`.
- `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs` — MODIFY: add `"viewer"`.
- `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs` (or sibling) — MODIFY/ADD: ViewerReview populated.

**Frontend**
- `frontend/src/api/types.ts` — MODIFY: `ReviewState`, `ViewerReview`, `PrDetailDto.viewerReview`.
- `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts` — MODIFY: inputs, face fields, `PRIOR_VERDICT_LABEL`, `STATE_FILL`, precedence, `change` action.
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.tsx` — MODIFY: wrapper + caption + aria; handle `change`.
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.module.css` — MODIFY: `.wrap`, `.caption`, `.captionStale`.
- `frontend/src/components/PrDetail/PrHeader.tsx` — MODIFY: prop + compute stale + pass down.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — MODIFY: pass `viewerReview={data?.viewerReview}`.

**Frontend tests**
- `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts` — MODIFY.
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx` — MODIFY.

---

## Task 1: Backend contracts — ReviewState, ViewerReview, DTO field, construction sites

**Files:**
- Create: `PRism.Core.Contracts/ReviewState.cs`, `PRism.Core.Contracts/ViewerReview.cs`
- Modify: `PRism.Core.Contracts/PrDetailDto.cs`, `PRism.GitHub/GitHubReviewService.cs:140-147`, `PRism.Web/TestHooks/FakePrReader.cs:57-64`
- Test: `tests/PRism.Core.Tests/Contracts/ReviewStateSerializationTests.cs`

**Interfaces:**
- Produces: `enum ReviewState { Approved, ChangesRequested, Commented }`; `record ViewerReview(ReviewState State, DateTimeOffset SubmittedAt, string? CommitSha)`; `PrDetailDto` gains trailing `ViewerReview? ViewerReview`.

- [ ] **Step 1: Write the failing serialization test**

Create `tests/PRism.Core.Tests/Contracts/ReviewStateSerializationTests.cs`:
```csharp
using System.Text.Json;
using PRism.Core.Contracts;
using PRism.Core.Json;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public class ReviewStateSerializationTests
{
    [Theory]
    [InlineData(ReviewState.Approved, "\"approved\"")]
    [InlineData(ReviewState.ChangesRequested, "\"changes-requested\"")]
    [InlineData(ReviewState.Commented, "\"commented\"")]
    public void ReviewState_serializes_kebab_on_the_api_options(ReviewState state, string expected)
        => Assert.Equal(expected, JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Api));
}
```

- [ ] **Step 2: Run it — expect compile failure (ReviewState undefined)**

Run: `dotnet test tests/PRism.Core.Tests --filter ReviewStateSerializationTests`
Expected: build error — `ReviewState` does not exist.

- [ ] **Step 3: Create the enum and record**

`PRism.Core.Contracts/ReviewState.cs`:
```csharp
namespace PRism.Core.Contracts;

// Viewer's submitted-review verdict. Serialized kebab-case (approved / changes-requested /
// commented) by the JsonStringEnumConverter(KebabCaseJsonNamingPolicy) on
// JsonSerializerOptionsFactory.Api. Output-only — DISMISSED/PENDING are never surfaced
// (excluded at selection), so they are not enum members.
public enum ReviewState
{
    Approved,
    ChangesRequested,
    Commented,
}
```

`PRism.Core.Contracts/ViewerReview.cs`:
```csharp
namespace PRism.Core.Contracts;

// The viewer's latest effective submitted review on a PR. Null on PrDetailDto = the viewer
// has no effective review. CommitSha is nullable: a review may carry no commit association,
// in which case staleness is unknown (the frontend shows no stale flag).
public sealed record ViewerReview(ReviewState State, DateTimeOffset SubmittedAt, string? CommitSha);
```

- [ ] **Step 4: Append the DTO field**

Modify `PRism.Core.Contracts/PrDetailDto.cs` — add the trailing parameter:
```csharp
public sealed record PrDetailDto(
    Pr Pr,
    ClusteringQuality ClusteringQuality,
    IReadOnlyList<IterationDto>? Iterations,
    IReadOnlyList<CommitDto> Commits,
    IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments,
    bool TimelineCapHit,
    ViewerReview? ViewerReview);
```

- [ ] **Step 5: Fix the two construction sites**

`PRism.GitHub/GitHubReviewService.cs:140-147` — add the trailing arg (real value lands in Task 3; placeholder `null` keeps it compiling now):
```csharp
        return new PrDetailDto(
            pr,
            ClusteringQuality: ClusteringQuality.Low,
            Iterations: null,
            Commits: Array.Empty<CommitDto>(),
            RootComments: rootComments,
            ReviewComments: reviewComments,
            TimelineCapHit: timelineCapHit,
            ViewerReview: null);
```

`PRism.Web/TestHooks/FakePrReader.cs:57-64` — add the trailing arg:
```csharp
            var detail = new PrDetailDto(
                Pr: pr,
                ClusteringQuality: ClusteringQuality.Ok,
                Iterations: _store.Iterations.ToList(),
                Commits: _store.Commits.ToList(),
                RootComments: Array.Empty<IssueCommentDto>(),
                ReviewComments: Array.Empty<ReviewThreadDto>(),
                TimelineCapHit: false,
                ViewerReview: null);
```

- [ ] **Step 6: Run the test — expect PASS**

Run: `dotnet test tests/PRism.Core.Tests --filter ReviewStateSerializationTests`
Expected: PASS (3 cases). If other projects fail to build, search for any remaining `new PrDetailDto(` and add `ViewerReview: null`.

- [ ] **Step 7: Commit**
```bash
git add PRism.Core.Contracts/ReviewState.cs PRism.Core.Contracts/ViewerReview.cs PRism.Core.Contracts/PrDetailDto.cs PRism.GitHub/GitHubReviewService.cs PRism.Web/TestHooks/FakePrReader.cs tests/PRism.Core.Tests/Contracts/ReviewStateSerializationTests.cs
git commit -m "feat(pr-detail): add ViewerReview contract + ReviewState enum (#512)"
```

---

## Task 2: `GitHubPrParser.ParseViewerReview` — selection logic

**Files:**
- Modify: `PRism.GitHub/GitHubPrParser.cs`
- Test: `tests/PRism.GitHub.Tests/ParseViewerReviewTests.cs`

**Interfaces:**
- Consumes: `ReviewState`, `ViewerReview` (Task 1).
- Produces: `internal static ViewerReview? GitHubPrParser.ParseViewerReview(JsonElement pull, string? viewerLogin)` — reads `pull.reviews.nodes`; selects the viewer's max-`submittedAt` review among `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`; `CommitSha` from `commit.oid` or null.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.GitHub.Tests/ParseViewerReviewTests.cs`:
```csharp
using System.Text.Json;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests;

public class ParseViewerReviewTests
{
    private static JsonElement Pull(string reviewsJson)
        => JsonDocument.Parse($"{{\"reviews\":{{\"nodes\":{reviewsJson}}}}}").RootElement;

    private static string Review(string login, string state, string? submittedAt, string? oid)
    {
        var sa = submittedAt is null ? "null" : $"\"{submittedAt}\"";
        var commit = oid is null ? "null" : $"{{\"oid\":\"{oid}\"}}";
        return $"{{\"author\":{{\"login\":\"{login}\"}},\"state\":\"{state}\",\"submittedAt\":{sa},\"commit\":{commit}}}";
    }

    [Fact]
    public void Selects_viewer_latest_submitted_by_max_submittedAt()
    {
        var pull = Pull($"[{Review("me", "COMMENTED", "2026-01-01T00:00:00Z", "old")}," +
                        $"{Review("me", "APPROVED", "2026-02-01T00:00:00Z", "newsha")}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.NotNull(r);
        Assert.Equal(ReviewState.Approved, r!.State);
        Assert.Equal("newsha", r.CommitSha);
        Assert.Equal(DateTimeOffset.Parse("2026-02-01T00:00:00Z"), r.SubmittedAt);
    }

    [Theory]
    [InlineData("APPROVED", ReviewState.Approved)]
    [InlineData("CHANGES_REQUESTED", ReviewState.ChangesRequested)]
    [InlineData("COMMENTED", ReviewState.Commented)]
    public void Maps_each_state(string wire, ReviewState expected)
    {
        var pull = Pull($"[{Review("me", wire, "2026-01-01T00:00:00Z", "x")}]");
        Assert.Equal(expected, GitHubPrParser.ParseViewerReview(pull, "me")!.State);
    }

    [Fact]
    public void Excludes_dismissed_and_pending_and_falls_back_to_effective()
    {
        var pull = Pull($"[{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}," +
                        $"{Review("me", "DISMISSED", "2026-03-01T00:00:00Z", "b")}," +
                        $"{Review("me", "PENDING", null, null)}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.Equal(ReviewState.Approved, r!.State); // dismissed (later) + pending excluded
    }

    [Fact]
    public void Ignores_other_users()
    {
        var pull = Pull($"[{Review("someone-else", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Null(GitHubPrParser.ParseViewerReview(pull, "me"));
    }

    [Fact]
    public void Selects_review_with_null_commit_as_null_CommitSha()
    {
        var pull = Pull($"[{Review("me", "COMMENTED", "2026-01-01T00:00:00Z", null)}]");
        var r = GitHubPrParser.ParseViewerReview(pull, "me");
        Assert.NotNull(r);
        Assert.Null(r!.CommitSha);
    }

    [Fact]
    public void Returns_null_when_viewerLogin_null_or_no_reviews()
    {
        var pull = Pull($"[{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Null(GitHubPrParser.ParseViewerReview(pull, null));
        Assert.Null(GitHubPrParser.ParseViewerReview(JsonDocument.Parse("{}").RootElement, "me"));
    }

    [Fact]
    public void Skips_malformed_node_without_throwing()
    {
        var pull = Pull($"[{{\"author\":42}},{Review("me", "APPROVED", "2026-01-01T00:00:00Z", "a")}]");
        Assert.Equal(ReviewState.Approved, GitHubPrParser.ParseViewerReview(pull, "me")!.State);
    }
}
```

- [ ] **Step 2: Run — expect failure (ParseViewerReview undefined)**

Run: `dotnet test tests/PRism.GitHub.Tests --filter ParseViewerReviewTests`
Expected: build error — `ParseViewerReview` does not exist.

- [ ] **Step 3: Implement the parser**

In `PRism.GitHub/GitHubPrParser.cs` add `using PRism.GitHub.Inbox;` (for `InboxJsonGuard`) and these methods inside the class:
```csharp
    // Viewer's latest effective submitted review (spec #512). Selection mirrors #367 (max
    // submittedAt among the viewer's submitted reviews) but is DECOUPLED from staleness:
    // DISMISSED/PENDING are excluded (MapReviewState → null), commit.oid is NOT required —
    // a review with no commit is still selected with CommitSha = null (staleness unknown).
    // viewerLogin is resolved by the caller from data.viewer.login (a sibling of
    // data.repository, unreachable from `pull` = data.repository.pullRequest).
    internal static ViewerReview? ParseViewerReview(JsonElement pull, string? viewerLogin)
    {
        if (string.IsNullOrEmpty(viewerLogin)) return null;
        if (!pull.TryGetProperty("reviews", out var reviews) ||
            !reviews.TryGetProperty("nodes", out var nodes) ||
            nodes.ValueKind != JsonValueKind.Array)
            return null;

        ReviewState? bestState = null;
        DateTimeOffset? bestAt = null;
        string? bestCommit = null;

        foreach (var review in nodes.EnumerateArray())
        {
            try
            {
                var login = review.TryGetProperty("author", out var a) && a.ValueKind == JsonValueKind.Object
                    && a.TryGetProperty("login", out var l) ? l.GetString() : null;
                if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;

                if (!review.TryGetProperty("state", out var st) || st.ValueKind != JsonValueKind.String) continue;
                var state = MapReviewState(st.GetString());
                if (state is null) continue; // DISMISSED / PENDING / unknown → excluded

                // submittedAt is JSON null for PENDING; gate on String-kind so a null is a clean
                // skip, not a GetDateTimeOffset() throw (mirrors GitHubAwaitingAuthorFilter).
                if (!review.TryGetProperty("submittedAt", out var sa) ||
                    sa.ValueKind != JsonValueKind.String) continue;
                var submittedAt = sa.GetDateTimeOffset();

                if (bestAt is null || submittedAt > bestAt.Value)
                {
                    bestAt = submittedAt;
                    bestState = state;
                    var oid = review.TryGetProperty("commit", out var c) && c.ValueKind == JsonValueKind.Object
                        && c.TryGetProperty("oid", out var o) ? o.GetString() : null;
                    bestCommit = string.IsNullOrEmpty(oid) ? null : oid;
                }
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                // one malformed review node is skipped, not the whole parse
            }
        }

        return bestState is null || bestAt is null
            ? null
            : new ViewerReview(bestState.Value, bestAt.Value, bestCommit);
    }

    private static ReviewState? MapReviewState(string? wire) => wire switch
    {
        "APPROVED" => ReviewState.Approved,
        "CHANGES_REQUESTED" => ReviewState.ChangesRequested,
        "COMMENTED" => ReviewState.Commented,
        _ => null, // DISMISSED, PENDING, or unknown → excluded from selection
    };
```

- [ ] **Step 4: Run — expect PASS**

Run: `dotnet test tests/PRism.GitHub.Tests --filter ParseViewerReviewTests`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**
```bash
git add PRism.GitHub/GitHubPrParser.cs tests/PRism.GitHub.Tests/ParseViewerReviewTests.cs
git commit -m "feat(pr-detail): ParseViewerReview selects viewer's latest effective review (#512)"
```

---

## Task 3: GraphQL query + wiring + frozen-query/allowlist updates

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (query const + `GetPrDetailAsync` wiring)
- Modify: `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (`ExpectedPrDetail`)
- Modify: `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs` (add `"viewer"`)
- Test: add a case to `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs`; add a GetPrDetailAsync ViewerReview test (sibling of existing PrDetail parsing tests).

**Interfaces:**
- Consumes: `ParseViewerReview` (Task 2), `PrDetailDto.ViewerReview` (Task 1).

- [ ] **Step 1: Update the byte-identity test FIRST (it is the failing test)**

In `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs`, change `ExpectedPrDetail` to add `viewer{login} ` after the opening `{` and the `reviews(last:100){...}` block after the `reviewThreads` block:
```csharp
    private const string ExpectedPrDetail =
        "query($owner:String!,$repo:String!,$number:Int!){" +
        "viewer{login} " +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
        "reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}" +
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
        "pageInfo{hasNextPage endCursor} nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}}" +
        "}}}";
```

- [ ] **Step 2: Run — expect FAIL (production query not yet updated)**

Run: `dotnet test tests/PRism.GitHub.Tests --filter PrDetailGraphQLQuery_is_byte_identical`
Expected: FAIL — strings differ.

- [ ] **Step 3: Update the production query to match**

In `PRism.GitHub/GitHubReviewService.cs`, edit `PrDetailGraphQLQuery` identically (add `"viewer{login} "` after the opening brace line, and the `"reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}"` line after the `reviewThreads` block):
```csharp
    internal const string PrDetailGraphQLQuery = "query($owner:String!,$repo:String!,$number:Int!){" +
        "viewer{login} " +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
        "reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}" +
        TimelineItemsArgs + "{pageInfo{hasNextPage endCursor} " + TimelineNodes + "}" +
        "}}}";
```

- [ ] **Step 4: Run — expect PASS**

Run: `dotnet test tests/PRism.GitHub.Tests --filter PrDetailGraphQLQuery_is_byte_identical`
Expected: PASS.

- [ ] **Step 5: Write a failing GetPrDetailAsync ViewerReview test**

Add to the existing PR-detail parsing test class (e.g. `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs` — mirror its existing harness that feeds a canned GraphQL body and calls `GetPrDetailAsync`). The new fact asserts ViewerReview is populated from `data.viewer.login` + `reviews`:
```csharp
    [Fact]
    public async Task GetPrDetailAsync_populates_ViewerReview_from_viewer_and_reviews()
    {
        // Arrange a canned GraphQL response with viewer + a viewer review.
        // (Use the class's existing helper that stubs the HTTP body; the body must include
        //  data.viewer.login and data.repository.pullRequest.reviews.nodes.)
        const string body = """
        {"data":{"viewer":{"login":"me"},"repository":{"pullRequest":{
          "title":"t","body":"","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE",
          "mergeStateStatus":"CLEAN","headRefName":"h","baseRefName":"b",
          "headRefOid":"HEAD","baseRefOid":"B","author":{"login":"a"},
          "createdAt":"2026-01-01T00:00:00Z","changedFiles":1,
          "reviews":{"nodes":[{"author":{"login":"me"},"state":"APPROVED",
            "submittedAt":"2026-02-01T00:00:00Z","commit":{"oid":"REVSHA"}}]}
        }}}}
        """;
        var svc = NewService(new GraphQLPlusRestHandler { GraphQLBody = body });
        var detail = await svc.GetPrDetailAsync(new PrReference("o", "r", 1), default);

        Assert.NotNull(detail!.ViewerReview);
        Assert.Equal(ReviewState.Approved, detail.ViewerReview!.State);
        Assert.Equal("REVSHA", detail.ViewerReview.CommitSha);
    }
```
> Harness is real: `GitHubReviewServicePrDetailTests` already has `GraphQLPlusRestHandler { GraphQLBody }` + a `NewService(handler)` helper (→ `GitHubReviewServiceFactory.Create`). Prefer copying its existing `PrDetailGraphQLBody` literal and inserting the `viewer` + `reviews` nodes over the trimmed body above, so `ParsePr` sees every field it reads.

- [ ] **Step 6: Run — expect FAIL (ViewerReview still null)**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GetPrDetailAsync_populates_ViewerReview`
Expected: FAIL — `detail.ViewerReview` is null.

- [ ] **Step 7: Wire `GetPrDetailAsync`**

In `PRism.GitHub/GitHubReviewService.cs` `GetPrDetailAsync`, after `var reviewComments = GitHubPrParser.ParseReviewThreads(pull);` resolve the viewer login from the root and parse, then pass to the DTO:
```csharp
        // viewer is a sibling of repository (data.viewer.login), NOT under pull — resolve it
        // from the root and hand it to the parser (mirrors #367's passed-login pattern).
        var viewerLogin = TryGetPath(doc.RootElement, out var viewerLoginEl, "data", "viewer", "login")
            && viewerLoginEl.ValueKind == JsonValueKind.String ? viewerLoginEl.GetString() : null;
        var viewerReview = GitHubPrParser.ParseViewerReview(pull, viewerLogin);
```
And change the `return new PrDetailDto(...)` trailing arg from `ViewerReview: null` to `ViewerReview: viewerReview`.

- [ ] **Step 8: Run — expect PASS**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GetPrDetailAsync_populates_ViewerReview`
Expected: PASS.

- [ ] **Step 9: Update the shape-drift strip allowlist**

In `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs`, add `"viewer"` to the container group of `AllowedFieldNames` so the response-shape differ can walk into the new top-level object:
```csharp
        "data", "repository", "pullRequest", "viewer", "comments", "reviews", "reviewThreads", "commits",
```
> `author`/`login` stay stripped (PII) — `reviews.nodes[].{state,submittedAt,commit.oid}` are already allowlisted, so the reviews shape is covered; the query-string shape is fully guarded by the byte-identity test above. The live fixture (`pr19-graphql-response.json`) re-capture requires a PAT (`PRISM_FROZEN_PR_CAPTURE_FIXTURE=1`) and is an owner/CI step — note it in the PR; the integration shape-drift test is PAT-gated and does not block the unit suite.

- [ ] **Step 10: Run the full GitHub test project**

Run: `dotnet test tests/PRism.GitHub.Tests`
Expected: PASS (byte-identity + ParseViewerReview + GetPrDetail).

- [ ] **Step 11: Commit**
```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs
git commit -m "feat(pr-detail): fetch viewer review via GraphQL + wire onto PrDetailDto (#512)"
```

---

## Task 4: Frontend types

**Files:**
- Modify: `frontend/src/api/types.ts`

**Interfaces:**
- Produces: `type ReviewState = 'approved' | 'changes-requested' | 'commented'`; `interface ViewerReview { state: ReviewState; submittedAt: string; commitSha: string | null }`; `PrDetailDto.viewerReview?: ViewerReview | null`.

- [ ] **Step 1: Add the types**

In `frontend/src/api/types.ts`, near `DraftVerdict`, add:
```ts
export type ReviewState = 'approved' | 'changes-requested' | 'commented';
export interface ViewerReview {
  state: ReviewState;
  submittedAt: string;
  commitSha: string | null;
}
```
And add to the `PrDetailDto` interface (after `timelineCapHit`):
```ts
  viewerReview?: ViewerReview | null;
```

- [ ] **Step 2: Typecheck**

Run (from `frontend/`): `npx tsc -b --noEmit` (or the repo's typecheck script).
Expected: no new errors.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/api/types.ts
git commit -m "feat(pr-detail): add ViewerReview/ReviewState wire types (#512)"
```

---

## Task 5: `reviewActionState.ts` — inputs, precedence, caption data

**Files:**
- Modify: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`

**Interfaces:**
- Consumes: `ViewerReview`, `ReviewState` (Task 4).
- Produces: `ReviewActionInputs` gains `viewerReview: ViewerReview | null` and `submittedReviewStale: boolean`. `ReviewActionFill` gains nothing (reuses approve/request-changes/comment). `ReviewActionFace.mainAction` gains `'change'`. `ReviewActionFace` gains `caption: ReviewActionCaption | null` where `interface ReviewActionCaption { mode: 'reviewed' | 'was'; priorState: ReviewState; submittedAt: string; stale: boolean }`. Exports `PRIOR_VERDICT_LABEL: Record<ReviewState, string>`.

- [ ] **Step 1: Write the failing tests**

In `reviewActionState.test.ts`, extend the `inputs(...)` helper defaults with `viewerReview: null, submittedReviewStale: false`, then add:
```ts
import { deriveFace, PRIOR_VERDICT_LABEL } from './reviewActionState';
import type { ViewerReview } from '../../../api/types';

const reviewed = (over: Partial<ViewerReview> = {}): ViewerReview =>
  ({ state: 'approved', submittedAt: '2026-02-01T00:00:00Z', commitSha: 'sha', ...over });

describe('deriveFace — submitted review status', () => {
  it('shows submitted verdict when no draft (fill + past-tense label + change action)', () => {
    const f = deriveFace(inputs({}, { viewerReview: reviewed() }));
    expect(f.fill).toBe('approve');
    expect(f.label).toBe('Approved');
    expect(f.mainAction).toBe('change');
    expect(f.mainDisabled).toBe(false);
    expect(f.caption).toEqual({ mode: 'reviewed', priorState: 'approved', submittedAt: '2026-02-01T00:00:00Z', stale: false });
  });

  it('maps changes-requested and commented', () => {
    expect(deriveFace(inputs({}, { viewerReview: reviewed({ state: 'changes-requested' }) })).fill).toBe('request-changes');
    expect(deriveFace(inputs({}, { viewerReview: reviewed({ state: 'changes-requested' }) })).label).toBe('Changes requested');
    expect(deriveFace(inputs({}, { viewerReview: reviewed({ state: 'commented' }) })).fill).toBe('comment');
  });

  it('flags stale in the caption', () => {
    const f = deriveFace(inputs({}, { viewerReview: reviewed(), submittedReviewStale: true }));
    expect(f.caption).toMatchObject({ mode: 'reviewed', stale: true });
  });

  it('draft wins the face; prior review demotes to a "was" caption', () => {
    const f = deriveFace(inputs({ draftVerdict: 'request-changes' }, { viewerReview: reviewed() }));
    expect(f.fill).toBe('request-changes');
    expect(f.label).toBe('Request changes'); // action label, not past-tense
    expect(f.pending).toBe(false);
    expect(f.caption).toEqual({ mode: 'was', priorState: 'approved', submittedAt: '2026-02-01T00:00:00Z', stale: false });
  });

  it('no submitted review and no draft → Submit review, no caption', () => {
    const f = deriveFace(inputs());
    expect(f.label).toBe('Submit review');
    expect(f.caption).toBeNull();
  });

  it('PRIOR_VERDICT_LABEL is past-tense', () => {
    expect(PRIOR_VERDICT_LABEL).toEqual({ approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run (from `frontend/`): `./node_modules/.bin/vitest run src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`
Expected: FAIL — `caption`/`PRIOR_VERDICT_LABEL`/`'change'` not present.

- [ ] **Step 3: Implement**

In `reviewActionState.ts`:

a) Imports + interface additions:
```ts
import type { DraftVerdict, ReviewSessionDto, ReviewState, ValidatorResult, ViewerReview } from '../../../api/types';
```
Add to `ReviewActionInputs`:
```ts
  viewerReview: ViewerReview | null;
  submittedReviewStale: boolean;
```
Add the caption type + extend the face:
```ts
export interface ReviewActionCaption {
  mode: 'reviewed' | 'was';
  priorState: ReviewState;
  submittedAt: string;
  stale: boolean;
}
```
In `ReviewActionFace`: change `mainAction` to `'submit' | 'resume' | 'none' | 'change'` and add `caption: ReviewActionCaption | null;`.

b) Label/fill maps (after `VERDICT_LABEL`):
```ts
export const PRIOR_VERDICT_LABEL: Record<ReviewState, string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  commented: 'Commented',
};
const STATE_FILL: Record<ReviewState, ReviewActionFill> = {
  approved: 'approve',
  'changes-requested': 'request-changes',
  commented: 'comment',
};
```

c) In `deriveFace`, compute the submitted-review precedence + caption. Replace the existing `fill`/`label`/`mainAction` derivation with submitted-aware versions (draft still wins):
```ts
  const { session, prState, viewerReview, submittedReviewStale } = i;
  const isClosedOrMerged = prState !== 'open';
  const verdict = session.draftVerdict;
  const pending = session.pendingReviewId !== null;
  const hasSubmitted = viewerReview !== null;

  // Caption: a draft-over-prior demotes the prior verdict to "was"; otherwise an idle
  // submitted review reads "reviewed". No caption when there is no submitted review.
  const caption: ReviewActionCaption | null = !hasSubmitted
    ? null
    : verdict || pending
      ? { mode: 'was', priorState: viewerReview!.state, submittedAt: viewerReview!.submittedAt, stale: submittedReviewStale }
      : { mode: 'reviewed', priorState: viewerReview!.state, submittedAt: viewerReview!.submittedAt, stale: submittedReviewStale };

  // Fill precedence: closed/merged → secondary; draft verdict wins; else submitted verdict; else accent.
  const fill: ReviewActionFill = isClosedOrMerged
    ? 'secondary'
    : verdict
      ? verdict
      : hasSubmitted && !pending
        ? STATE_FILL[viewerReview!.state]
        : 'accent';

  const label = isClosedOrMerged
    ? 'Drafts'
    : verdict
      ? VERDICT_LABEL[verdict]
      : pending
        ? 'Resume review'
        : hasSubmitted
          ? PRIOR_VERDICT_LABEL[viewerReview!.state]
          : 'Submit review';
```
Then extend `mainAction`: when open, not pending, no draft verdict, but a submitted review exists, the main button opens the verdict menu to change the review:
```ts
  const mainAction: ReviewActionFace['mainAction'] = isClosedOrMerged
    ? 'none'
    : pending
      ? 'resume'
      : verdict
        ? 'submit'
        : hasSubmitted
          ? 'change'   // status face; click opens the menu to start a new/updated review
          : 'submit';
```
Adjust the submit-reason gating to only run for the real submit path (`mainAction === 'submit'`) — it already does (`mainAction === 'submit' ? submitDisabledReason(...) : null`); `'change'` yields `null`. With `rawReason` null for `change`, `mainDisabled = isClosedOrMerged || frozen || submitReason !== null` is `false` (open, not frozen). Add `caption` to the returned object.

- [ ] **Step 4: Run — expect PASS**

Run: `./node_modules/.bin/vitest run src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`
Expected: PASS (new + existing tests). If existing tests broke on the `inputs()` helper, ensure its defaults include `viewerReview: null, submittedReviewStale: false`.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts
git commit -m "feat(pr-detail): deriveFace surfaces submitted review (fill, label, caption) (#512)"
```

---

## Task 6: `ReviewActionButton.tsx` + CSS — caption render + a11y + change action

**Files:**
- Modify: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.tsx`
- Modify: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.module.css`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`

**Interfaces:**
- Consumes: `face.caption`, `face.mainAction === 'change'`, `PRIOR_VERDICT_LABEL` (Task 5), `formatAge` (`utils/relativeTime`).

- [ ] **Step 1: Write the failing tests**

In `ReviewActionButton.test.tsx`, extend the `props()` helper defaults with `viewerReview: null, submittedReviewStale: false`, then add:
```ts
// inline the same ViewerReview helper as Task 5 (do not import across test files):
const reviewed = (over: Partial<ViewerReview> = {}): ViewerReview =>
  ({ state: 'approved', submittedAt: '2026-02-01T00:00:00Z', commitSha: 'sha', ...over });

it('renders the reviewed caption with relative time', () => {
  render(<ReviewActionButton {...props({ viewerReview: { state: 'approved', submittedAt: new Date(Date.now() - 2*86400000).toISOString(), commitSha: 'x' } })} />);
  expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/You reviewed · 2d ago/);
});

it('appends "out of date" when stale', () => {
  render(<ReviewActionButton {...props({ viewerReview: { state: 'approved', submittedAt: new Date().toISOString(), commitSha: 'old' }, submittedReviewStale: true })} />);
  expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/out of date/);
});

it('demotes prior verdict to "was" while drafting', () => {
  render(<ReviewActionButton {...props({ session: { ...session(), draftVerdict: 'request-changes' }, viewerReview: { state: 'approved', submittedAt: new Date().toISOString(), commitSha: 'x' } })} />);
  expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/was Approved/);
});

it('submitted-status main button opens the menu (change)', async () => {
  render(<ReviewActionButton {...props({ viewerReview: { state: 'approved', submittedAt: new Date().toISOString(), commitSha: 'x' } })} />);
  const main = screen.getByTestId('review-action-main');
  expect(main).not.toBeDisabled();
  await userEvent.click(main);
  expect(screen.getByRole('menu')).toBeInTheDocument();
});

it('exposes the submitted status to screen readers via aria-label', () => {
  render(<ReviewActionButton {...props({ viewerReview: { state: 'approved', submittedAt: new Date().toISOString(), commitSha: 'x' } })} />);
  expect(screen.getByTestId('review-action-main')).toHaveAttribute('aria-label', expect.stringMatching(/you reviewed/i));
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `./node_modules/.bin/vitest run src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`
Expected: FAIL — no caption element / aria-label / menu-on-main.

- [ ] **Step 3: Implement the component changes**

In `ReviewActionButton.tsx`:

a) Import helpers:
```ts
import { formatAge } from '../../../utils/relativeTime';
import { deriveFace, deriveMenu, PRIOR_VERDICT_LABEL, type ReviewActionInputs } from './reviewActionState';
```

b) Build the caption text + aria from `face.caption`:
```ts
  const caption = face.caption;
  const captionText = caption
    ? caption.mode === 'was'
      ? `was ${PRIOR_VERDICT_LABEL[caption.priorState]} · ${formatAge(caption.submittedAt)}`
      : `You reviewed · ${formatAge(caption.submittedAt)}${caption.stale ? ' · out of date' : ''}`
    : null;
  // SR label only for the idle "reviewed" status (the draft "was" caption is supplementary).
  const mainAriaLabel = caption?.mode === 'reviewed' ? `${face.label} — ${captionText}` : undefined;
```

c) Wrap `.root` in a column wrapper and render the caption beneath; add `aria-label` to the main button. The `onMainClick` already routes any non-submit/non-resume action (now including `'change'`) to `setMenuOpen`, so no change there. Render:
```tsx
  return (
    <div className={styles.wrap} data-testid="review-action-wrap">
      <div className={styles.root} data-testid="review-action">
        <button
          type="button"
          data-testid="review-action-main"
          className={`${styles.main} ${styles[`fill-${face.fill}`]}`}
          disabled={mainInteractiveDisabled}
          aria-disabled={mainInteractiveDisabled}
          aria-label={mainAriaLabel}
          title={face.mainDisabledReason ?? face.pendingTooltip ?? undefined}
          onClick={mainInteractiveDisabled ? undefined : onMainClick}
        >
          {/* …existing reconfirm + label spans unchanged… */}
        </button>
        {/* …existing chevron button + menu unchanged… */}
      </div>
      {captionText && (
        <span
          className={`${styles.caption}${caption?.stale ? ` ${styles.captionStale}` : ''}`}
          data-testid="review-action-caption"
        >
          {captionText}
        </span>
      )}
    </div>
  );
```
> Note: the menu stays a child of `.root` (its `position: absolute` anchors to `.root`, which keeps `position: relative`). The wrapper only stacks `.root` + caption.

- [ ] **Step 4: Add CSS**

In `ReviewActionButton.module.css`:
```css
.wrap {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}
.caption {
  font-size: var(--text-2xs);
  color: var(--text-3);
  white-space: nowrap;
}
.captionStale {
  color: var(--warning-fg);
}
```
(`.root` keeps `position: relative; display: inline-flex;` — unchanged.)

- [ ] **Step 5: Run — expect PASS**

Run: `./node_modules/.bin/vitest run src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**
```bash
git add frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.tsx frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.module.css frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx
git commit -m "feat(pr-detail): ReviewActionButton renders submitted-review caption + a11y (#512)"
```

---

## Task 7: Thread `viewerReview` through PrHeader + PrDetailView

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: add a case to `frontend/src/components/PrDetail/PrHeader.test.tsx` (or `PrHeader.actions.test.tsx`)

**Interfaces:**
- Consumes: `PrDetailDto.viewerReview` (Task 4), `ReviewActionButton` inputs (Tasks 5-6).

- [ ] **Step 1: Write the failing PrHeader test**

In `PrHeader.test.tsx`, render `PrHeader` with a `viewerReview` prop on an open PR and a `currentHeadSha` that differs from the review's `commitSha`; assert the caption shows "out of date":
```ts
it('passes viewerReview to the action button and computes staleness', () => {
  renderHeader({
    prState: 'open',
    session: null,
    currentHeadSha: 'HEAD2',
    viewerReview: { state: 'approved', submittedAt: new Date().toISOString(), commitSha: 'HEAD1' },
  });
  expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/You reviewed/);
  expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/out of date/);
});
```
> Mirror the existing `renderHeader(extra: Partial<React.ComponentProps<typeof PrHeader>>)` helper in that test file (it already takes a prop-bag; `viewerReview` becomes valid once Task 7 Step 3 adds the prop).

- [ ] **Step 2: Run — expect FAIL**

Run: `./node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: FAIL — `viewerReview` not a prop / caption absent.

- [ ] **Step 3: Implement PrHeader**

In `PrHeader.tsx`:
a) Add to `PrHeaderProps`:
```ts
  viewerReview?: ViewerReview | null;
```
(import `ViewerReview` from `../../api/types`.)

b) Compute staleness near the render and pass both to `ReviewActionButton` (the JSX call ~lines 497-513):
```tsx
        const submittedReviewStale =
          viewerReview?.commitSha != null && viewerReview.commitSha !== currentHeadSha;
```
```tsx
        <ReviewActionButton
          session={session ?? EMPTY_SESSION}
          sessionLoaded={session !== null}
          prState={prState}
          headShaDrift={headShaDrift}
          validatorResults={validatorResults}
          inSubmitFlow={inSubmitFlow}
          dialogOpen={dialogOpen}
          viewerReview={viewerReview ?? null}
          submittedReviewStale={submittedReviewStale}
          onPatchVerdict={patchVerdict}
          /* …rest unchanged… */
        />
```

- [ ] **Step 4: Pass it from PrDetailView**

In `PrDetailView.tsx` `<PrHeader … />` (~lines 326-354) add:
```tsx
          viewerReview={data?.viewerReview}
```

- [ ] **Step 5: Run — expect PASS**

Run: `./node_modules/.bin/vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrHeader.test.tsx
git commit -m "feat(pr-detail): thread viewerReview through PrHeader/PrDetailView (#512)"
```

---

## Task 8: Full verification + visual proof

- [ ] **Step 1: Backend suite**

Run: `dotnet test` (solution) — or at minimum `tests/PRism.Core.Tests`, `tests/PRism.GitHub.Tests`, `tests/PRism.Web.Tests`.
Expected: green. (The PAT-gated integration shape-drift test may be skipped without a token — note the fixture-recapture step in the PR.)

- [ ] **Step 2: Frontend suite + lint + typecheck**

Run (from `frontend/`): `./node_modules/.bin/vitest run` ; the repo's `eslint`/`prettier` checks ; `npx tsc -b --noEmit`.
Expected: green / clean.

- [ ] **Step 3: Capture the B1 visual proof**

Run the app and open a PR you've reviewed (use the desktop/dev harness per `.ai/docs/parallel-agent-testing.md`). Screenshot the four states in both themes: never-reviewed (accent "Submit review"), reviewed-current (green "Approved" + "You reviewed · …"), reviewed-stale (+ "· out of date"), and changing (draft fill + "was Approved · …"). These are the B1 gate artifacts for the owner.

- [ ] **Step 4: Run `/simplify` then the pre-push checklist**

Run `/simplify` (quality pass) and the repo pre-push checklist verbatim (`.ai/docs/development-process.md`).

- [ ] **Step 5: Commit any simplify/verification fixes**
```bash
git add -A && git commit -m "chore(pr-detail): simplify pass + verification (#512)"
```

---

## Self-Review

**Spec coverage:**
- AC1 (state + relative time on the control) → Tasks 5-7 (fill + label + "You reviewed · {ago}" caption, aria-label).
- AC2 (stale indicator; none when commit unknown) → Task 5 caption.stale + Task 7 `submittedReviewStale` (null commitSha → false).
- AC3 (draft wins face, prior → "was") → Task 5 precedence + Task 6 caption render.
- AC4 (sourced from existing fetch, #367-style, dismissed-excluded, decoupled from staleness) → Tasks 2-3.
- Backend DTO / construction sites / loader-`with` → Task 1 + Task 3.
- a11y (SR label, no glyph-only signal) → Task 6 (text-only "out of date"; aria-label).
- Frozen-query + allowlist → Task 3.
- #318 output-only kebab → Task 1 probe.

**Placeholder scan:** none. Task 3 Step 5 now names the real harness (`NewService(new GraphQLPlusRestHandler { GraphQLBody = body })`); all steps carry complete code.

**Type consistency:** `ReviewState` values (`approved`/`changes-requested`/`commented`) consistent across Task 1 (enum→kebab), Task 4 (TS union), Task 5 (`STATE_FILL`/`PRIOR_VERDICT_LABEL`). `mainAction` `'change'` defined in Task 5, consumed in Task 6 (falls into the existing `else → setMenuOpen` branch; `mainInteractiveDisabled` stays false because `mainDisabled` is false for `change`). `caption` shape identical in Task 5 (produced) and Task 6 (consumed). `submittedReviewStale` is computed in Task 7 (PrHeader) and is part of `ReviewActionInputs` consumed by `deriveFace` (Tasks 5-6); the Task 5 `inputs()` test helper supplies it as a pre-computed boolean (default `false`), mirroring the existing `headShaDrift` pattern.

**Plan deviations from the spec (documented):**
- Spec §3 said the caption lives by reflowing `.root` to `flex-direction: column`. Corrected: `.root` holds the split button (main+chevron) as a row, so the caption goes in a NEW `.wrap` column around `.root` (Task 6). Same visual result (Treatment A).
- Spec §3 said "mainAction unchanged." Added `mainAction: 'change'` for the submitted-no-draft state so the green status button stays clickable ("change via the same button"); leaving it `'submit'` would render a disabled-looking green button. No submit-pipeline/enable-rule change — `'change'` only opens the existing verdict menu. **Flag at the plan gate.**
