# Cross-tab stamp poisoning fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the submit-gate bypass class identified in [PR #55 deferrals § "Cross-tab stamp poisoning"](../specs/2026-05-11-s5-submit-pipeline-deferrals.md#defer-cross-tab-stamp-poisoning-f3-from-ce-code-review) by partitioning `LastViewedHeadSha` per-tab inside `ReviewSessionState`, keyed by `X-PRism-Tab-Id`.

**Architecture:** Promote `LastViewedHeadSha` into a per-tab `TabStamp` map (`TabStamps: IReadOnlyDictionary<string, TabStamp>`) inside `ReviewSessionState`; `LastSeenCommentId` stays session-flat as a monotone high-water (preserves the inbox unread badge). V5→V6 schema migration drops legacy `last-viewed-head-sha` keys; cap N=8 with LRU-by-`StampedAtUtc`. Submit gate, mark-viewed, reload, reconciliation pipeline, markAllRead, the `/test/mark-pr-viewed` hook, the inbox projection, and the FE error/banner copy all get wired through.

**Tech Stack:** .NET 10 minimal API (`PRism.Web` / `PRism.Core` / `PRism.GitHub`), React 18 + Vite + TS frontend, Playwright e2e, xUnit BE tests + Vitest FE tests.

**Spec:** [`docs/specs/2026-05-18-cross-tab-stamp-poisoning-design.md`](../specs/2026-05-18-cross-tab-stamp-poisoning-design.md).
**Deferrals sidecar:** [`docs/specs/2026-05-18-cross-tab-stamp-poisoning-deferrals.md`](../specs/2026-05-18-cross-tab-stamp-poisoning-deferrals.md).
**Worktree:** `D:/src/prism-cross-tab-stamp` (branch `feat/cross-tab-stamp`).

---

## Phase 1 — Schema + types

Foundation. Once this phase lands, the new `TabStamps` field exists, V6 migration runs, and every position-constructor site compiles against the new shape.

### Task 1: Add `TabStamp` record and reshape `ReviewSessionState`

**Files:**
- Modify: `PRism.Core/State/AppState.cs:47-57`
- Test: `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`

- [ ] **Step 1: Write the failing round-trip test**

In `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`, add:

```csharp
[Fact]
public void TabStamps_round_trips_through_state_serializer()
{
    var stamp = new TabStamp(HeadSha: "abc123", StampedAtUtc: new DateTime(2026, 5, 18, 14, 23, 45, DateTimeKind.Utc));
    var session = new ReviewSessionState(
        TabStamps: new Dictionary<string, TabStamp> { ["tab-A"] = stamp },
        LastSeenCommentId: "999",
        PendingReviewId: null,
        PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: null,
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    var json = JsonSerializer.Serialize(session, JsonSerializerOptionsFactory.Storage);
    var deserialized = JsonSerializer.Deserialize<ReviewSessionState>(json, JsonSerializerOptionsFactory.Storage)!;

    Assert.Single(deserialized.TabStamps);
    Assert.True(deserialized.TabStamps.ContainsKey("tab-A"));
    Assert.Equal("abc123", deserialized.TabStamps["tab-A"].HeadSha);
    Assert.Equal(stamp.StampedAtUtc, deserialized.TabStamps["tab-A"].StampedAtUtc);
    Assert.Equal("999", deserialized.LastSeenCommentId);
}
```

- [ ] **Step 2: Run test to verify it fails**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "TabStamps_round_trips_through_state_serializer"
```

Expected: BUILD ERROR — `TabStamp` not defined; `ReviewSessionState` constructor signature mismatch.

- [ ] **Step 3: Reshape `ReviewSessionState` + add `TabStamp`**

In `PRism.Core/State/AppState.cs`, replace lines 47-57 (the `ReviewSessionState` record) with:

```csharp
public sealed record ReviewSessionState(
    IReadOnlyDictionary<string, TabStamp> TabStamps,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    string? DraftSummaryMarkdown,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);

public sealed record TabStamp(
    string HeadSha,
    DateTime StampedAtUtc);
```

The `LastViewedHeadSha` field is gone. `TabStamps` is the new first positional argument.

- [ ] **Step 4: Run the round-trip test to verify it passes (after Task 2 fixes the call sites)**

The test stays red until Task 2 is done — that's expected. Don't try to make this test pass in isolation; the build error at every call site is the signal to proceed to Task 2.

- [ ] **Step 5: Do not commit yet**

Hold the commit until Task 2's call-site sweep lands together. Otherwise the repository is in a non-compiling state.

---

### Task 2: Update all positional `ReviewSessionState` constructions

**Files (all in this task — sweep):**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs:110, 169`
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs:571-578` (`NewEmptySession`)
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs:160-170`
- Modify: `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTestHelpers.cs:25-49`
- Modify: `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTypesTests.cs:22`
- Modify: `tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs:53` (assertion rewrite, see step below)
- Modify: all reconciliation tests that build `ReviewSessionState` directly — find via `grep -r "new ReviewSessionState(" tests/`

- [ ] **Step 1: Find every positional constructor site**

```
git -C D:/src/prism-cross-tab-stamp grep -n "new ReviewSessionState("
```

Expected: ~15 hits across production + tests. Treat the grep output as the worklist.

- [ ] **Step 2: At each site, swap the first positional argument**

Old shape (was second positional):
```csharp
new ReviewSessionState(null, null, null, null, new Dictionary<string, string>(), …)
//                     ^^^ LastViewedHeadSha
```

New shape:
```csharp
new ReviewSessionState(new Dictionary<string, TabStamp>(), null, null, null, new Dictionary<string, string>(), …)
//                     ^^^ TabStamps                       ^^^ LastSeenCommentId
```

Or with named arguments (preferred for clarity):

```csharp
new ReviewSessionState(
    TabStamps: new Dictionary<string, TabStamp>(),
    LastSeenCommentId: null,
    PendingReviewId: null,
    PendingReviewCommitOid: null,
    ViewedFiles: new Dictionary<string, string>(),
    DraftComments: new List<DraftComment>(),
    DraftReplies: new List<DraftReply>(),
    DraftSummaryMarkdown: null,
    DraftVerdict: null,
    DraftVerdictStatus: DraftVerdictStatus.Draft);
```

`NewEmptySession()` at `PrDraftEndpoints.cs:571-578` already uses named args — just swap the field.

- [ ] **Step 3: Rewrite `SuccessClearsSessionTests.cs:53`**

The existing assertion:
```csharp
Assert.Equal("head1", persisted.LastViewedHeadSha);
```

becomes:
```csharp
Assert.True(persisted.TabStamps.ContainsKey("tab-X"));
Assert.Equal("head1", persisted.TabStamps["tab-X"].HeadSha);
```

Test setup must seed `TabStamps: new Dictionary<string, TabStamp> { ["tab-X"] = new TabStamp("head1", DateTime.UtcNow) }` instead of `LastViewedHeadSha: "head1"`.

- [ ] **Step 4: Verify build**

```
dotnet build PRism.sln
```

Expected: 0 errors. Warnings are OK to fix in passing but not required.

- [ ] **Step 5: Run the round-trip test from Task 1**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "TabStamps_round_trips_through_state_serializer"
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1 + Task 2 together**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/State/AppState.cs PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/Endpoints/PrDraftEndpoints.cs PRism.Web/TestHooks/TestEndpoints.cs tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(state): reshape ReviewSessionState — TabStamps replaces LastViewedHeadSha"
```

---

### Task 3: V5→V6 migration step

**Files:**
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs`
- Modify: `PRism.Core/State/AppStateStore.cs` (CurrentVersion bump + MigrationSteps add + EnsureCurrentShape extension)
- Create: `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs`

- [ ] **Step 1: Write the failing migration tests**

Create `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State.Migrations;

public class AppStateMigrationsV5ToV6Tests
{
    [Fact]
    public void Migrates_legacy_session_to_empty_tab_map_and_preserves_last_seen_comment_id()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": {
            "default": {
              "reviews": {
                "sessions": {
                  "owner/repo/1": {
                    "last-viewed-head-sha": "abc",
                    "last-seen-comment-id": "999"
                  }
                }
              }
            }
          }
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        Assert.Null(session["last-viewed-head-sha"]);
        Assert.NotNull(session["tab-stamps"]);
        Assert.Empty((JsonObject)session["tab-stamps"]!);
        Assert.Equal("999", session["last-seen-comment-id"]!.GetValue<string>());
        Assert.Equal(6, root["version"]!.GetValue<int>());
    }

    [Fact]
    public void Idempotent_on_v6_file()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": { "tab-stamps": {}, "last-seen-comment-id": "42" }
          }}}}
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var session = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!;
        Assert.Empty((JsonObject)session["tab-stamps"]!);
        Assert.Equal("42", session["last-seen-comment-id"]!.GetValue<string>());
        Assert.Equal(6, root["version"]!.GetValue<int>());
    }

    [Fact]
    public void Throws_on_partial_rollback_session_with_both_legacy_and_tab_stamps_keys()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": {
              "last-viewed-head-sha": "abc",
              "tab-stamps": { "tab-A": { "head-sha": "def", "stamped-at-utc": "2026-05-18T00:00:00Z" } }
            }
          }}}}
        }
        """)!.AsObject();

        var ex = Assert.Throws<JsonException>(() => AppStateMigrations.MigrateV5ToV6(root));
        Assert.Contains("partial rollback", ex.Message);
    }

    [Fact]
    public void Empty_accounts_object_is_noop()
    {
        var root = JsonNode.Parse("""
        { "version": 5, "accounts": {} }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        Assert.Equal(6, root["version"]!.GetValue<int>());
    }

    [Fact]
    public void Session_with_existing_tab_stamps_only_passes_through()
    {
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "accounts": { "default": { "reviews": { "sessions": {
            "owner/repo/1": {
              "tab-stamps": { "tab-A": { "head-sha": "def", "stamped-at-utc": "2026-05-18T00:00:00Z" } }
            }
          }}}}
        }
        """)!.AsObject();

        AppStateMigrations.MigrateV5ToV6(root);

        var stamps = (JsonObject)root["accounts"]!["default"]!["reviews"]!["sessions"]!["owner/repo/1"]!["tab-stamps"]!;
        Assert.Single(stamps);
        Assert.Equal("def", stamps["tab-A"]!["head-sha"]!.GetValue<string>());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "AppStateMigrationsV5ToV6Tests"
```

Expected: BUILD ERROR — `MigrateV5ToV6` doesn't exist.

- [ ] **Step 3: Implement `MigrateV5ToV6`**

Append to `PRism.Core/State/Migrations/AppStateMigrations.cs`:

```csharp
public static JsonObject MigrateV5ToV6(JsonObject root)
{
    if (root["accounts"] is not JsonObject accounts)
    {
        root["version"] = 6;
        return root;
    }

    foreach (var (_, accountNode) in accounts)
    {
        var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) continue;

        foreach (var (_, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;

            var hasLegacy = session["last-viewed-head-sha"] is not null;
            var hasNew = session["tab-stamps"] is JsonObject;

            if (hasLegacy && hasNew)
                throw new System.Text.Json.JsonException(
                    "state.json session has both legacy last-viewed-head-sha AND a tab-stamps key. " +
                    "This indicates a partial rollback from a future version or a hand-edit gone wrong. " +
                    "Quarantining and re-Setup is safer than guessing which set wins.");

            session.Remove("last-viewed-head-sha");
            if (!hasNew) session["tab-stamps"] = new JsonObject();
        }
    }

    root["version"] = 6;
    return root;
}
```

- [ ] **Step 4: Wire into `AppStateStore`**

In `PRism.Core/State/AppStateStore.cs`:

- Line 11: change `private const int CurrentVersion = 5;` to `private const int CurrentVersion = 6;`
- Around line 27: append `(6, AppStateMigrations.MigrateV5ToV6),  // S6+1 — per-tab LastViewedHeadSha` to the `MigrationSteps` initializer.

Extend `EnsureCurrentShape` (after the existing `accounts.default.reviews.sessions` backfill block) to backfill missing `tab-stamps`:

```csharp
if (defaultObj["reviews"] is JsonObject reviewsObj &&
    reviewsObj["sessions"] is JsonObject sessionsObj)
{
    foreach (var (_, sessionNode) in sessionsObj)
    {
        if (sessionNode is JsonObject session && session["tab-stamps"] is null)
            session["tab-stamps"] = new JsonObject();
    }
}
```

- [ ] **Step 5: Run all migration tests + the existing chain test**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "Migration"
```

Expected: PASS (V5→V6 tests + the existing V1→V5 chain tests still pass with the new CurrentVersion=6).

- [ ] **Step 6: Extend `MigrationChainTests` for V1→V6**

In `tests/PRism.Core.Tests/State/MigrationChainTests.cs`, find the longest existing chain test (V1→V5 today). Add a new test that starts at V1 and asserts V6 shape. The chain runs through all five migration steps sequentially via `AppStateStore`'s load path.

- [ ] **Step 7: Run all tests**

```
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj
```

Expected: PASS.

- [ ] **Step 8: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/State/Migrations/AppStateMigrations.cs PRism.Core/State/AppStateStore.cs tests/PRism.Core.Tests/State/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(state): V5→V6 migration drops LastViewedHeadSha, seeds tab-stamps"
```

---

## Phase 2 — Write sites

mark-viewed, reload, test-hook, and markAllRead all write to the new `TabStamps` (or in markAllRead's case, gain the monotone guard).

### Task 4: mark-viewed writes `TabStamps[tabId]` + monotone `LastSeenCommentId`

**Files:**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs:89-131`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`

- [ ] **Step 1: Write the failing happy-path test**

In `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`:

```csharp
[Fact]
public async Task MarkViewed_writes_tab_stamp_under_caller_tab_id()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"42" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    var state = await ctx.StateStore.LoadAsync(default);
    var session = state.Reviews.Sessions["owner/repo/1"];
    Assert.True(session.TabStamps.ContainsKey("tab-A"));
    Assert.Equal("abc123", session.TabStamps["tab-A"].HeadSha);
    Assert.Equal("42", session.LastSeenCommentId);
}
```

If `PrDetailEndpointsTestContext` doesn't expose a header-on-POST helper, add one in the test-helpers file (search `tests/PRism.Web.Tests/TestHelpers/` for the closest existing pattern).

- [ ] **Step 2: Run test to verify it fails**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkViewed_writes_tab_stamp_under_caller_tab_id"
```

Expected: FAIL — endpoint either ignores the header or writes to `LastViewedHeadSha` (which doesn't exist post-Phase 1, so this is a compile error first).

- [ ] **Step 3: Replace the mark-viewed handler**

In `PRism.Web/Endpoints/PrDetailEndpoints.cs:89-131`, swap the route handler:

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/mark-viewed",
    async (string owner, string repo, int number,
           MarkViewedRequest body,
           HttpContext httpContext,
           PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
    {
        if (stateStore.IsReadOnlyMode)
            return Results.Problem(type: "/state/read-only", statusCode: 423);

        var tabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();
        if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
            return Results.Problem(type: "/viewed/tab-id-missing", statusCode: 422);

        var prRef = new PrReference(owner, repo, number);
        var snapshot = loader.TryGetCachedSnapshot(prRef);
        if (snapshot is null)
            return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
        if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
            return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

        var key = $"{owner}/{repo}/{number}";
        try
        {
            await stateStore.UpdateAsync(state =>
            {
                var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? NewEmptySession();

                var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
                tabStamps[tabId] = new TabStamp(body.HeadSha, DateTime.UtcNow);
                if (tabStamps.Count > 8)
                {
                    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
                    tabStamps.Remove(oldest);
                }

                var newSeen = MonotonicMaxCommentId(session.LastSeenCommentId, body.MaxCommentId);

                var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = session with { TabStamps = tabStamps, LastSeenCommentId = newSeen };
                return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
            }, ct).ConfigureAwait(false);
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
        {
            return Results.Problem(type: "/state/read-only", statusCode: 423);
        }

        return Results.NoContent();
    }).WithMetadata(new RequestSizeLimitAttribute(16384));
```

`NewEmptySession()` — for now define inline in the class (lift from `PrDraftEndpoints.NewEmptySession` or duplicate). Phase 6 task 18 unifies the helper.

Add inside the class (anywhere the existing helpers live):

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();

private static string? MonotonicMaxCommentId(string? current, string? incoming)
{
    if (!long.TryParse(incoming, out var inc)) return current;
    if (!long.TryParse(current, out var cur)) return incoming;
    return inc > cur ? incoming : current;
}

private static ReviewSessionState NewEmptySession() =>
    new(
        TabStamps: new Dictionary<string, TabStamp>(),
        LastSeenCommentId: null,
        PendingReviewId: null,
        PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: new List<DraftComment>(),
        DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: null,
        DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);
```

Add `using System.Text.RegularExpressions;` at the top of the file. `PrDetailEndpoints` is already `internal static partial class` so `[GeneratedRegex]` works directly.

- [ ] **Step 4: Run test to verify it passes**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkViewed_writes_tab_stamp_under_caller_tab_id"
```

Expected: PASS.

- [ ] **Step 5: Add the remaining mark-viewed scenarios**

Append to `PrDetailEndpointsTests.cs`:

```csharp
[Fact]
public async Task MarkViewed_returns_422_when_tab_id_header_missing()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Theory]
[InlineData("../../etc/passwd")]
[InlineData("tab with space")]
[InlineData("")]
public async Task MarkViewed_rejects_invalid_tab_id_header(string tabId)
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task MarkViewed_rejects_tab_id_over_64_chars()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");
    var tooLong = new string('a', 65);

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tooLong });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task MarkViewed_evicts_oldest_stamp_at_cap_N_8()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    // Seed 8 stamps with ascending StampedAtUtc.
    await ctx.StateStore.UpdateAsync(state =>
    {
        var session = NewEmptySessionLikeProduction();
        var stamps = new Dictionary<string, TabStamp>();
        for (int i = 0; i < 8; i++)
            stamps[$"tab-{i}"] = new TabStamp($"sha-{i}", new DateTime(2026, 5, 18, 0, 0, i, DateTimeKind.Utc));
        session = session with { TabStamps = stamps };
        var sessions = new Dictionary<string, ReviewSessionState> { ["owner/repo/1"] = session };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }, default);

    // 9th tab mark-viewed.
    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-NEW" });

    Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    var state = await ctx.StateStore.LoadAsync(default);
    var stamps = state.Reviews.Sessions["owner/repo/1"].TabStamps;
    Assert.Equal(8, stamps.Count);
    Assert.True(stamps.ContainsKey("tab-NEW"));
    Assert.False(stamps.ContainsKey("tab-0"));  // oldest evicted
}

[Fact]
public async Task MarkViewed_re_stamp_from_existing_tab_updates_in_place()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"10" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });
    await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"20" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    var state = await ctx.StateStore.LoadAsync(default);
    Assert.Single(state.Reviews.Sessions["owner/repo/1"].TabStamps);
    Assert.Equal("20", state.Reviews.Sessions["owner/repo/1"].LastSeenCommentId);
}

[Fact]
public async Task MarkViewed_monotone_lastSeenCommentId_does_not_rewind()
{
    using var ctx = new PrDetailEndpointsTestContext();
    ctx.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"999" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });
    await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"50" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-B" });

    var state = await ctx.StateStore.LoadAsync(default);
    Assert.Equal("999", state.Reviews.Sessions["owner/repo/1"].LastSeenCommentId);
}
```

- [ ] **Step 6: Run all mark-viewed tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkViewed"
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrDetailEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs
git -C D:/src/prism-cross-tab-stamp commit -m "feat(mark-viewed): write per-tab TabStamps with N=8 LRU + monotone LastSeenCommentId"
```

---

### Task 5: reload writes `TabStamps[tabId]`

**Files:**
- Modify: `PRism.Web/Endpoints/PrReloadEndpoints.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointsTests.cs` (or create if absent)

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public async Task Reload_writes_tab_stamp_under_caller_tab_id()
{
    using var ctx = new PrReloadEndpointsTestContext();
    ctx.SeedSessionWithDrafts("owner", "repo", 1);

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/reload",
        new { headSha = "newhead0000000000000000000000000000000000" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-X" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await ctx.StateStore.LoadAsync(default);
    var stamps = state.Reviews.Sessions["owner/repo/1"].TabStamps;
    Assert.True(stamps.ContainsKey("tab-X"));
    Assert.Equal("newhead0000000000000000000000000000000000", stamps["tab-X"].HeadSha);
}

[Fact]
public async Task Reload_returns_422_when_tab_id_header_missing()
{
    using var ctx = new PrReloadEndpointsTestContext();
    ctx.SeedSessionWithDrafts("owner", "repo", 1);

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/reload",
        new { headSha = "newhead0000000000000000000000000000000000" });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}
```

- [ ] **Step 2: Run tests to verify failure**

```
dotnet test tests/PRism.Web.Tests/ --filter "Reload"
```

Expected: FAIL — the endpoint either ignores the header or doesn't validate it.

- [ ] **Step 3: Add `partial` to `PrReloadEndpoints`**

`PRism.Web/Endpoints/PrReloadEndpoints.cs:13`:

Change `internal static class PrReloadEndpoints` to `internal static partial class PrReloadEndpoints`.

- [ ] **Step 4: Add tab-id allowlist regex + validation**

After the existing `Sha40` / `Sha64` static fields:

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

In `PostReload`, after the existing `sourceTabId` read at line 63, add:

```csharp
if (string.IsNullOrEmpty(sourceTabId) || !TabIdAllowlistRegex().IsMatch(sourceTabId))
    return Results.UnprocessableEntity(new { error = "tab-id-missing" });
```

- [ ] **Step 5: Replace the Phase-2 apply block to write `TabStamps` instead of `LastViewedHeadSha`**

Lines 156-162, the `updated = current with { ... }` block becomes:

```csharp
var tabStamps = current.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
tabStamps[sourceTabId] = new TabStamp(request.HeadSha, DateTime.UtcNow);
if (tabStamps.Count > 8)
{
    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
    tabStamps.Remove(oldest);
}

var updated = current with
{
    DraftComments = updatedDrafts,
    DraftReplies = updatedReplies,
    DraftVerdictStatus = newVerdictStatus,
    TabStamps = tabStamps,
};
```

- [ ] **Step 6: Run reload tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "Reload"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrReloadEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrReloadEndpointsTests.cs
git -C D:/src/prism-cross-tab-stamp commit -m "feat(reload): write per-tab TabStamps + 422 tab-id-missing"
```

---

### Task 6: `/test/mark-pr-viewed` hook accepts `tabId`

**Files:**
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs:149-176`
- Modify: `tests/PRism.Web.Tests/TestHooks/...` (find the existing hook test file via grep)

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public async Task TestMarkPrViewed_writes_tab_stamp_under_provided_tab_id()
{
    using var ctx = new TestEndpointsContext();

    var resp = await ctx.Client.PostAsJsonAsync(
        "/test/mark-pr-viewed",
        new { owner = "owner", repo = "repo", number = 1, headSha = "abc123", tabId = "tab-X" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await ctx.StateStore.LoadAsync(default);
    Assert.True(state.Reviews.Sessions["owner/repo/1"].TabStamps.ContainsKey("tab-X"));
}

[Fact]
public async Task TestMarkPrViewed_rejects_missing_tab_id()
{
    using var ctx = new TestEndpointsContext();
    var resp = await ctx.Client.PostAsJsonAsync(
        "/test/mark-pr-viewed",
        new { owner = "owner", repo = "repo", number = 1, headSha = "abc123" });
    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}
```

- [ ] **Step 2: Run tests to verify failure**

```
dotnet test tests/PRism.Web.Tests/ --filter "TestMarkPrViewed"
```

Expected: FAIL — hook doesn't accept tabId.

- [ ] **Step 3: Reshape the hook**

In `PRism.Web/TestHooks/TestEndpoints.cs:149-176`:

Change the request record:

```csharp
internal sealed record MarkPrViewedRequest(string Owner, string Repo, int Number, string HeadSha, string TabId);
```

Inside the route handler, after the existing parameter validation:

```csharp
if (string.IsNullOrEmpty(body.TabId) ||
    !System.Text.RegularExpressions.Regex.IsMatch(body.TabId, @"^[a-zA-Z0-9_-]{1,64}$"))
    return Results.UnprocessableEntity(new { error = "tab-id-missing" });
```

In the `UpdateAsync` transform, replace the `LastViewedHeadSha = body.HeadSha` assignment with:

```csharp
var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
tabStamps[body.TabId] = new TabStamp(body.HeadSha, DateTime.UtcNow);
if (tabStamps.Count > 8)
{
    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
    tabStamps.Remove(oldest);
}
session = session with { TabStamps = tabStamps };
```

- [ ] **Step 4: Run tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "TestMarkPrViewed"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/TestHooks/TestEndpoints.cs tests/PRism.Web.Tests/TestHooks/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(test-hook): /test/mark-pr-viewed accepts tabId for V6 per-tab stamping"
```

---

### Task 7: markAllRead gains `MonotonicMaxCommentId` guard

**Files:**
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs:355-373`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointsTests.cs`

- [ ] **Step 1: Write the failing monotone test**

```csharp
[Fact]
public async Task MarkAllRead_monotone_does_not_rewind_last_seen_comment_id()
{
    using var ctx = new PrDraftEndpointsTestContext();
    await ctx.SeedSession("owner", "repo", 1, lastSeenCommentId: "999");

    var resp = await ctx.Client.PatchAsJsonAsync(
        "/api/pr/owner/repo/1/draft",
        new { markAllRead = true, lastSeenCommentId = "500" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.True(resp.IsSuccessStatusCode);
    var state = await ctx.StateStore.LoadAsync(default);
    Assert.Equal("999", state.Reviews.Sessions["owner/repo/1"].LastSeenCommentId);
}
```

(The exact patch wire shape depends on `ReviewSessionPatch`'s `markAllRead` operation. Use whatever the existing markAllRead-patch tests use for invocation; assert the post-state `LastSeenCommentId`.)

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — last-writer-wins regresses 999 → 500.

- [ ] **Step 3: Lift `MonotonicMaxCommentId` to a shared helper**

Create `PRism.Core/State/MonotonicCommentId.cs`:

```csharp
namespace PRism.Core.State;

internal static class MonotonicCommentId
{
    /// <summary>
    /// Numeric monotone-max of two stringified comment IDs. Unparseable strings are
    /// treated as "no signal" — the parseable side wins; both unparseable returns current.
    /// Preserves the inbox unread-badge's monotone high-water invariant across the
    /// two writers (mark-viewed and markAllRead) without coupling them by file.
    /// </summary>
    internal static string? Max(string? current, string? incoming)
    {
        if (!long.TryParse(incoming, out var inc)) return current;
        if (!long.TryParse(current, out var cur)) return incoming;
        return inc > cur ? incoming : current;
    }
}
```

Update `PrDetailEndpoints.cs` to use `MonotonicCommentId.Max` (delete the local `MonotonicMaxCommentId` helper from Task 4).

- [ ] **Step 4: Apply the guard inside the markAllRead handler**

Find the markAllRead patch handler in `PrDraftEndpoints.cs:355-373`. Replace:

```csharp
session = session with { LastSeenCommentId = newId };
```

with:

```csharp
session = session with { LastSeenCommentId = MonotonicCommentId.Max(session.LastSeenCommentId, newId) };
```

- [ ] **Step 5: Run tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkAllRead"
```

Expected: PASS.

- [ ] **Step 6: Add coverage for the lifted helper**

Create `tests/PRism.Core.Tests/State/MonotonicCommentIdTests.cs`:

```csharp
public class MonotonicCommentIdTests
{
    [Theory]
    [InlineData("999", "500", "999")]
    [InlineData("500", "999", "999")]
    [InlineData(null, "100", "100")]
    [InlineData("100", null, "100")]
    [InlineData(null, null, null)]
    [InlineData("garbage", "100", "100")]
    [InlineData("100", "garbage", "100")]
    [InlineData("garbage", "garbage", "garbage")]
    public void Max_preserves_monotone_high_water(string? current, string? incoming, string? expected)
    {
        Assert.Equal(expected, MonotonicCommentId.Max(current, incoming));
    }
}
```

- [ ] **Step 7: Run all state tests**

```
dotnet test tests/PRism.Core.Tests/ --filter "MonotonicCommentId"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/State/MonotonicCommentId.cs PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/Endpoints/PrDraftEndpoints.cs tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(markAllRead): monotone LastSeenCommentId via shared MonotonicCommentId.Max"
```

---

## Phase 3 — Submit gate

The bypass-closing change. Touches one endpoint + new error code + FE switch arm.

### Task 8: `PrSubmitEndpoints` becomes `partial` + new LoggerMessage

**Files:**
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs`

- [ ] **Step 1: Add `partial` keyword**

Line 23: `internal static class PrSubmitEndpoints` → `internal static partial class PrSubmitEndpoints`.

- [ ] **Step 2: Add the new LoggerMessage delegate**

Near the existing `s_headShaNotStamped` (around line 47):

```csharp
private static readonly Action<ILogger, string, Exception?> s_tabIdMissing =
    LoggerMessage.Define<string>(LogLevel.Warning, new EventId(4, "SubmitRejectedTabIdMissing"),
        "POST /submit rejected for {SessionKey}: X-PRism-Tab-Id header is missing or fails allowlist. " +
        "The frontend must always send this header; see frontend/src/api/draft.ts:TAB_ID_HEADER.");
```

- [ ] **Step 3: Update the `s_headShaNotStamped` message string**

Replace the existing format string at lines 47-49 with:

```csharp
"POST /submit rejected for {SessionKey}: session.TabStamps has no entry for the caller's tab. " +
"The frontend must call POST /api/pr/{{ref}}/mark-viewed when PR detail loads; see PrDetailEndpoints.MarkViewed."
```

- [ ] **Step 4: Add the allowlist regex**

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

Add `using System.Text.RegularExpressions;` at the top.

- [ ] **Step 5: Build**

```
dotnet build PRism.sln
```

Expected: 0 errors. Logger delegate is defined but not yet referenced.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrSubmitEndpoints.cs
git -C D:/src/prism-cross-tab-stamp commit -m "refactor(submit): partial class + new s_tabIdMissing logger + allowlist regex"
```

---

### Task 9: Submit-gate rule (f) reads `TabStamps[tabId]`

**Files:**
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:113-144`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`

- [ ] **Step 1: Write the two-tab bypass test (the named regression)**

```csharp
[Fact]
public async Task Submit_rejects_caller_tab_without_own_stamp_even_if_other_tab_stamped_current_head()
{
    using var ctx = new PrSubmitEndpointsTestContext();
    ctx.SeedActivePrPoll("owner", "repo", 1, currentHeadSha: "shaB");
    await ctx.StateStore.UpdateAsync(state =>
    {
        var session = NewEmptySessionLikeProduction();
        session = session with
        {
            TabStamps = new Dictionary<string, TabStamp>
            {
                ["tab-A"] = new TabStamp("shaB", DateTime.UtcNow)
            },
            DraftSummaryMarkdown = "lgtm",
        };
        return state.WithDefaultReviews(state.Reviews with
        {
            Sessions = new Dictionary<string, ReviewSessionState> { ["owner/repo/1"] = session }
        });
    }, default);

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-B" });

    Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    Assert.Equal("head-sha-not-stamped", body!.Code);
}
```

- [ ] **Step 2: Run to verify it fails (currently passes only because all sessions are pre-Phase-2 unstamped)**

Expected: Either compile error (`LastViewedHeadSha` still referenced) or wrong status code.

- [ ] **Step 3: Replace rule (f) in `SubmitAsync`**

In `PRism.Web/Endpoints/PrSubmitEndpoints.cs`, add `HttpContext httpContext` to the parameter list. Replace lines 113-144 with the spec § 5.3 code:

```csharp
// Authorization: IsSubscribed(prRef) already gates this endpoint at the top, so the
// rule (f) error-code differential is NOT reachable by unauthenticated probes.
//
// Rule (f) — per-tab. The 422 tab-id-missing branch is split from the 400
// head-sha-not-stamped branch because recoveries differ: missing header is a FE
// wire-up regression (Reload doesn't fix), missing map entry is "Reload the PR".
var tabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();
if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
{
    s_tabIdMissing(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
    return Results.Json(new SubmitErrorDto("tab-id-missing",
        "Internal error: missing tab identifier. Refresh the browser tab and retry."),
        statusCode: StatusCodes.Status422UnprocessableEntity);
}

if (!session.TabStamps.TryGetValue(tabId, out var stamp))
{
    s_headShaNotStamped(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
    return Results.Json(new SubmitErrorDto("head-sha-not-stamped",
        "PR detail has not been marked viewed yet. Reload the PR and try again."),
        statusCode: StatusCodes.Status400BadRequest);
}

var pollSnapshot = activePrCache.GetCurrent(prRef);
if (pollSnapshot is not null && !string.Equals(pollSnapshot.HeadSha, stamp.HeadSha, StringComparison.Ordinal))
{
    s_headShaDrift(loggerFactory.CreateLogger(LoggerCategory), sessionKey, stamp.HeadSha, pollSnapshot.HeadSha, null);
    return Results.Json(new SubmitErrorDto("head-sha-drift",
        "Reload the PR before submitting."),
        statusCode: StatusCodes.Status400BadRequest);
}
```

Replace line 144 (`var headSha = session.LastViewedHeadSha;`) with:

```csharp
var headSha = stamp.HeadSha;
```

- [ ] **Step 4: Add the remaining submit-gate scenarios**

Append to `PrSubmitEndpointsTests.cs`:

```csharp
[Fact]
public async Task Submit_returns_422_when_tab_id_header_missing()
{
    using var ctx = new PrSubmitEndpointsTestContext();
    await ctx.SeedSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    Assert.Equal("tab-id-missing", body!.Code);
}

[Theory]
[InlineData("../../etc/passwd")]
[InlineData("tab with space")]
public async Task Submit_returns_422_on_invalid_tab_id(string tabId)
{
    using var ctx = new PrSubmitEndpointsTestContext();
    await ctx.SeedSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task Submit_happy_path_single_tab()
{
    using var ctx = new PrSubmitEndpointsTestContext();
    ctx.SeedActivePrPoll("owner", "repo", 1, currentHeadSha: "shaA");
    await ctx.SeedSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.True(resp.IsSuccessStatusCode);
    // Further pipeline assertions per the existing happy-path test.
}

[Fact]
public async Task Submit_returns_400_head_sha_drift_when_poll_observes_different_head()
{
    using var ctx = new PrSubmitEndpointsTestContext();
    ctx.SeedActivePrPoll("owner", "repo", 1, currentHeadSha: "shaB");
    await ctx.SeedSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await ctx.Client.PostAsJsonAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        headers: new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    Assert.Equal("head-sha-drift", body!.Code);
}
```

- [ ] **Step 5: Run all submit tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "Submit"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs
git -C D:/src/prism-cross-tab-stamp commit -m "feat(submit): rule (f) reads TabStamps[tabId] + distinct error codes"
```

---

## Phase 4 — Reconciliation pipeline

Required `callerTabId` + three-branch `headShifted` + verdict-reconcile second site.

### Task 10: `ReconcileAsync` signature gains required `callerTabId`

**Files:**
- Modify: `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs`
- Modify: `PRism.Web/Endpoints/PrReloadEndpoints.cs:91-93` (caller)
- Modify: `tests/PRism.Core.Tests/Reconciliation/*.cs` (every test that calls `ReconcileAsync`)

- [ ] **Step 1: Write the failing per-tab headShifted test**

Add to `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs` (or a new `HeadShiftedPerTabTests.cs`):

```csharp
[Fact]
public async Task HeadShifted_true_when_caller_tab_has_prior_stamp_at_different_head()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>
        {
            ["tab-X"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-1))
        },
        DraftComments = new List<DraftComment>
        {
            new("d1", "Foo.cs", 10, "RIGHT", "sha-A", "line", "body", DraftStatus.Stale, IsOverriddenStale: true)
        }
    };
    var pipeline = new DraftReconciliationPipeline();
    var result = await pipeline.ReconcileAsync(session, "sha-B", callerTabId: "tab-X", new FakeFileContentSource(), default);
    // Override clears.
    Assert.False(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);
}

[Fact]
public async Task HeadShifted_false_when_caller_tab_missing_and_no_other_stamps()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>(),  // empty
        DraftComments = new List<DraftComment>
        {
            new("d1", "Foo.cs", 10, "RIGHT", "sha-A", "line", "body", DraftStatus.Stale, IsOverriddenStale: true)
        }
    };
    var pipeline = new DraftReconciliationPipeline();
    var result = await pipeline.ReconcileAsync(session, "sha-B", callerTabId: "tab-Y", new FakeFileContentSource(), default);
    Assert.True(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);  // preserved
}

[Fact]
public async Task HeadShifted_true_via_session_level_fallback_when_caller_tab_missing()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>
        {
            ["tab-A"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-1)),
            ["tab-B"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-2)),
        },
        DraftComments = new List<DraftComment>
        {
            new("d1", "Foo.cs", 10, "RIGHT", "sha-A", "line", "body", DraftStatus.Stale, IsOverriddenStale: true)
        }
    };
    var pipeline = new DraftReconciliationPipeline();
    var result = await pipeline.ReconcileAsync(session, "sha-B", callerTabId: "tab-X-evicted", new FakeFileContentSource(), default);
    Assert.False(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);  // session-level shift detected
}

[Fact]
public async Task HeadShifted_false_via_session_level_fallback_when_all_stamps_at_new_head()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>
        {
            ["tab-A"] = new TabStamp("sha-B", DateTime.UtcNow.AddMinutes(-1)),
            ["tab-B"] = new TabStamp("sha-B", DateTime.UtcNow.AddMinutes(-2)),
        },
        DraftComments = new List<DraftComment>
        {
            new("d1", "Foo.cs", 10, "RIGHT", "sha-A", "line", "body", DraftStatus.Stale, IsOverriddenStale: true)
        }
    };
    var pipeline = new DraftReconciliationPipeline();
    var result = await pipeline.ReconcileAsync(session, "sha-B", callerTabId: "tab-X-new", new FakeFileContentSource(), default);
    Assert.True(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);  // no shift — session already at sha-B
}
```

- [ ] **Step 2: Run tests to verify failure**

```
dotnet test tests/PRism.Core.Tests/ --filter "HeadShifted"
```

Expected: BUILD ERROR — `ReconcileAsync` doesn't have `callerTabId`.

- [ ] **Step 3: Reshape `ReconcileAsync` signature**

In `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs:12-18`:

```csharp
public async Task<ReconciliationResult> ReconcileAsync(
    ReviewSessionState session,
    string newHeadSha,
    string callerTabId,                                       // new — REQUIRED
    IFileContentSource fileSource,
    CancellationToken ct,
    IReadOnlyDictionary<string, string>? renames = null,
    IReadOnlySet<string>? deletedPaths = null)
{
    ArgumentNullException.ThrowIfNull(session);
    ArgumentException.ThrowIfNullOrEmpty(newHeadSha);
    ArgumentException.ThrowIfNullOrEmpty(callerTabId);
    ArgumentNullException.ThrowIfNull(fileSource);

    // ... existing renames/deletedPaths defaults ...

    // Per-tab head shift, with session-level fallback for the LRU-eviction case.
    bool headShifted;
    if (session.TabStamps.TryGetValue(callerTabId, out var priorStamp))
    {
        headShifted = priorStamp.HeadSha != newHeadSha;
    }
    else if (session.TabStamps.Count == 0)
    {
        headShifted = false;
    }
    else
    {
        headShifted = session.TabStamps.Values.Any(s => s.HeadSha != newHeadSha);
    }

    if (headShifted) { /* existing override-clear block, unchanged */ }
```

- [ ] **Step 4: Update the verdict-reconcile site at line ~216**

Find the existing `verdictHeadShifted` derivation (search the file for `LastViewedHeadSha`). Replace with the same three-branch shape as above (or refactor to reuse the `headShifted` local from line 33 if the logic is identical).

- [ ] **Step 5: Update the caller in `PrReloadEndpoints.cs:91-93`**

```csharp
var result = await pipeline.ReconcileAsync(
    session, request.HeadSha, sourceTabId!, fileSource, ct,
    renames: null, deletedPaths: null).ConfigureAwait(false);
```

(`sourceTabId` is non-null after the 422 gate from Task 5; the `!` asserts that.)

- [ ] **Step 6: Update every test caller**

```
git -C D:/src/prism-cross-tab-stamp grep -nl "pipeline.ReconcileAsync(" tests/
```

For each hit, add `callerTabId: "tab-test"` as the third positional argument (after `newHeadSha`). Most reconciliation tests don't exercise the per-tab branch, so any tab id works; use `"tab-test"` consistently.

- [ ] **Step 7: Run all reconciliation tests**

```
dotnet test tests/PRism.Core.Tests/ --filter "Reconciliation"
```

Expected: PASS (including the four new HeadShifted tests).

- [ ] **Step 8: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs PRism.Web/Endpoints/PrReloadEndpoints.cs tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(reconcile): ReconcileAsync requires callerTabId + three-branch headShifted"
```

---

## Phase 5 — Inbox projection

### Task 11: Inbox projects most-recent stamp + keeps session-flat `LastSeenCommentId`

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:244-247`
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

- [ ] **Step 1: Write the failing projection test**

```csharp
[Fact]
public void InboxProjection_lastViewedHeadSha_is_most_recent_TabStamp_HeadSha()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>
        {
            ["tab-old"] = new TabStamp("sha-old", new DateTime(2026, 5, 1, 0, 0, 0, DateTimeKind.Utc)),
            ["tab-new"] = new TabStamp("sha-new", new DateTime(2026, 5, 18, 0, 0, 0, DateTimeKind.Utc)),
        },
        LastSeenCommentId = "999",
    };

    // Invoke the projection (signature depends on the orchestrator's existing API surface).
    var item = InboxItemMapper.FromSession(session, /* other args */);

    Assert.Equal("sha-new", item.LastViewedHeadSha);
    Assert.Equal(999L, item.LastSeenCommentId);
}

[Fact]
public void InboxProjection_lastViewedHeadSha_is_null_when_no_tab_stamped()
{
    var session = NewEmptySessionLikeProduction() with
    {
        TabStamps = new Dictionary<string, TabStamp>(),
        LastSeenCommentId = null,
    };

    var item = InboxItemMapper.FromSession(session, /* other args */);

    Assert.Null(item.LastViewedHeadSha);
    Assert.Null(item.LastSeenCommentId);
}
```

- [ ] **Step 2: Run tests to verify failure**

```
dotnet test tests/PRism.Core.Tests/ --filter "InboxProjection"
```

Expected: BUILD ERROR or wrong value.

- [ ] **Step 3: Update the orchestrator's session-to-DTO projection**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (around lines 244-247 — the existing `session.LastViewedHeadSha` / `session.LastSeenCommentId` reads), replace with:

```csharp
var mostRecent = session.TabStamps
    .Values
    .OrderByDescending(s => s.StampedAtUtc)
    .FirstOrDefault();

inboxItem = inboxItem with
{
    LastViewedHeadSha = mostRecent?.HeadSha,
    LastSeenCommentId = session.LastSeenCommentId is { } id && long.TryParse(id, out var parsed) ? parsed : null,
};
```

(The exact site shape depends on the orchestrator's existing init pattern. Match the existing style.)

- [ ] **Step 4: Run tests**

```
dotnet test tests/PRism.Core.Tests/ --filter "Inbox"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(inbox): project most-recent TabStamp.HeadSha; LastSeenCommentId stays session-flat"
```

---

## Phase 6 — Frontend

### Task 12: `tab-id-missing` arm for submit error

**Files:**
- Modify: `frontend/src/api/submit.ts`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:159-204`
- Modify: `frontend/__tests__/PrHeader.test.tsx`

- [ ] **Step 1: Add `'tab-id-missing'` to `KNOWN_SUBMIT_ERROR_CODES`**

In `frontend/src/api/submit.ts`, find the `KNOWN_SUBMIT_ERROR_CODES` const. Add `'tab-id-missing'` as a new entry.

- [ ] **Step 2: Write failing test for the new switch arm**

In `frontend/__tests__/PrHeader.test.tsx`:

```tsx
test('surfaces tab-id-missing as refresh-tab copy', () => {
  const submitError = { code: 'tab-id-missing', message: 'whatever' };
  // Invoke whatever utility produces the toast copy, e.g.:
  const copy = submitErrorMessage(submitError as any);
  expect(copy).toContain('Refresh the browser tab');
});
```

- [ ] **Step 3: Run test to verify failure**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test -- PrHeader
```

Expected: FAIL — switch doesn't recognize the new code.

- [ ] **Step 4: Add the switch arm**

In `frontend/src/components/PrDetail/PrHeader.tsx:159-204`, inside the `submitErrorMessage` switch:

```tsx
case 'tab-id-missing':
  return 'Internal error: missing tab identifier. Refresh the browser tab and retry.';
```

- [ ] **Step 5: Run tests**

```
npm run test -- PrHeader
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/api/submit.ts frontend/src/components/PrDetail/PrHeader.tsx frontend/__tests__/PrHeader.test.tsx
git -C D:/src/prism-cross-tab-stamp commit -m "feat(fe): tab-id-missing submit error → refresh-tab copy"
```

---

### Task 13: useReconcile arm for reload 422 `tab-id-missing`

**Files:**
- Modify: `frontend/src/api/draft.ts` (`PostReloadResult` union + `postReload` body discriminator)
- Modify: `frontend/src/hooks/useReconcile.ts` (state machine arm + banner constant)
- Modify: `frontend/__tests__/useReconcile.test.tsx`

- [ ] **Step 1: Write failing test for the reload 422 arm**

In `frontend/__tests__/useReconcile.test.tsx`:

```tsx
test('reload 422 tab-id-missing surfaces refresh-tab banner with no auto-retry', async () => {
  // Mock postReload to return 422 tab-id-missing
  // Render useReconcile
  // Assert banner == BANNER_TAB_ID_MISSING
  // Assert no second fetch occurred (no auto-retry)
});
```

(Concrete shape depends on the existing useReconcile test patterns — match them.)

- [ ] **Step 2: Run test to verify failure**

Expected: FAIL — useReconcile doesn't have the arm.

- [ ] **Step 3: Extend `PostReloadResult`**

In `frontend/src/api/draft.ts:158-164`:

```ts
export type PostReloadResult =
  | { ok: true }
  | { ok: false; status: 409; kind: ReloadConflictKind; body: unknown }
  | { ok: false; status: 422; kind: 'tab-id-missing'; body: unknown }
  | { ok: false; status: 0; kind: 'network'; body: unknown }
  | { ok: false; status: number; kind: 'other'; body: unknown };
```

In `postReload` (around lines 166-191), add a 422 branch:

```ts
if (e instanceof ApiError) {
  if (e.status === 409) {
    return { ok: false, status: 409, kind: parseReloadConflictKind(e.body), body: e.body };
  }
  if (e.status === 422 && hasErrorField(e.body, 'tab-id-missing')) {
    return { ok: false, status: 422, kind: 'tab-id-missing', body: e.body };
  }
  return { ok: false, status: e.status, kind: 'other', body: e.body };
}
```

Add helper `hasErrorField` if it doesn't exist:

```ts
function hasErrorField(body: unknown, value: string): boolean {
  return typeof body === 'object' && body !== null && 'error' in body
    && (body as { error: unknown }).error === value;
}
```

- [ ] **Step 4: Add the useReconcile arm**

In `frontend/src/hooks/useReconcile.ts`, add a new banner constant:

```ts
export const BANNER_TAB_ID_MISSING = "Couldn't reload — refresh the browser tab and retry.";
```

In the reload result handler, add:

```ts
if (result.ok === false && result.status === 422 && result.kind === 'tab-id-missing') {
  setBanner(BANNER_TAB_ID_MISSING);
  // Do NOT auto-retry.
  return;
}
```

- [ ] **Step 5: Run tests**

```
npm run test -- useReconcile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/api/draft.ts frontend/src/hooks/useReconcile.ts frontend/__tests__/useReconcile.test.tsx
git -C D:/src/prism-cross-tab-stamp commit -m "feat(fe): useReconcile arm for reload 422 tab-id-missing (no auto-retry)"
```

---

### Task 14: Tab-id mutability invariant comment + markViewed comment block update

**Files:**
- Modify: `frontend/src/api/draft.ts:5-12`
- Modify: `frontend/src/api/markViewed.ts:18-23`

- [ ] **Step 1: Add invariant comment to `_tabId`**

In `frontend/src/api/draft.ts`, replace the comment block at lines 5-7 with:

```ts
// Per-launch tab id used by SSE multi-tab consistency and the per-tab submit gate
// (PrSubmitEndpoints rule (f)). crypto.randomUUID() is available in jsdom v22+ and
// every browser the PoC targets.
//
// INVARIANT: _tabId is set-once for the page lifetime of a tab. The BE submit gate
// depends on each tab's _tabId being stable across the tab's lifetime — if production
// code resets it, a tab could re-stamp under a new id and then submit under the old
// id, re-introducing the cross-tab bypass class this slice exists to close.
//
// __resetTabIdForTest is the ONLY legal mutator and is invoked from test setup only.
// A production caller that needs a fresh tab id must open a new browser tab.
let _tabId: string | null = null;
```

- [ ] **Step 2: Update the markViewed.ts comment block**

In `frontend/src/api/markViewed.ts`, replace lines 18-23 with:

```ts
// `signal` lets the caller cancel the POST when its React effect cleans up,
// preventing a slow A-stamp from landing after a fast B-stamp on rapid PR
// navigation. The tab-id header is consumed by the BE on /mark-viewed
// (per-tab TabStamp partitioning), /submit (rule (f) lookup), and /reload
// (per-tab stamp write). The BE rejects /mark-viewed and /reload with 422
// tab-id-missing and /submit with 422 tab-id-missing if the header is
// missing or malformed.
```

- [ ] **Step 3: Run typecheck**

```
cd D:/src/prism-cross-tab-stamp/frontend && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/api/draft.ts frontend/src/api/markViewed.ts
git -C D:/src/prism-cross-tab-stamp commit -m "docs(fe): pin _tabId mutability invariant + update markViewed comment block"
```

---

## Phase 7 — Playwright mocked-mode plumbing

The seven mocked-mode submit specs need explicit tab-id coordination between `recordPrViewed` (APIRequestContext) and the page (browser context).

### Task 15: FE test-mode hook exposes `getTabId` to `page.evaluate`

**Files:**
- Modify: `frontend/src/main.tsx` (or wherever app-init wiring lives — find via `grep -rn "aiPreview" frontend/src/`)
- Modify: `frontend/src/api/draft.ts` (export shape, if needed)

- [ ] **Step 1: Find the test-mode init site**

```
git -C D:/src/prism-cross-tab-stamp grep -n "aiPreview" frontend/src/
```

The closest existing pattern for FE test-mode hooks is the one used by PR #58's real-flow suite. Match its shape.

- [ ] **Step 2: Expose `getTabId` on `window` under test mode**

In the test-mode init block:

```ts
if (import.meta.env.MODE === 'test' || /* the existing test-mode predicate */) {
  // Expose getTabId for Playwright's page.evaluate.
  (window as unknown as { __prism_test_getTabId?: () => string }).__prism_test_getTabId = () => getTabId();
}
```

- [ ] **Step 3: Confirm Vitest tests still pass**

```
npm run test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(fe-test-mode): expose getTabId on window for Playwright coordination"
```

---

### Task 16: `recordPrViewed` helper accepts `tabId`

**Files:**
- Modify: `frontend/e2e/helpers/s5-submit.ts:136-148`

- [ ] **Step 1: Update the helper signature**

```ts
export async function recordPrViewed(
  request: APIRequestContext,
  prRef: { owner: string; repo: string; number: number },
  headSha: string,
  tabId: string,                                       // new — required
): Promise<void> {
  await postTest(request, '/test/mark-pr-viewed', {
    owner: prRef.owner,
    repo: prRef.repo,
    number: prRef.number,
    headSha,
    tabId,
  });
}
```

- [ ] **Step 2: Add a small page-tab-id helper**

In `frontend/e2e/helpers/s5-submit.ts`:

```ts
export async function getPageTabId(page: Page): Promise<string> {
  const id = await page.evaluate(() => (window as unknown as { __prism_test_getTabId?: () => string }).__prism_test_getTabId?.());
  if (!id) throw new Error('Page tab id unavailable — is the FE test-mode hook wired?');
  return id;
}
```

- [ ] **Step 3: Confirm typecheck**

```
cd D:/src/prism-cross-tab-stamp/frontend && npx tsc --noEmit -p e2e/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/e2e/helpers/s5-submit.ts
git -C D:/src/prism-cross-tab-stamp commit -m "feat(e2e-helpers): recordPrViewed takes tabId; add getPageTabId helper"
```

---

### Task 17: Update the seven mocked-mode submit specs to plumb `tabId`

**Files (each spec gets one edit):**
- Modify: `frontend/e2e/s5-submit-stale-commit-oid.spec.ts`
- Modify: `frontend/e2e/s5-submit-retry-from-each-step.spec.ts`
- Modify: `frontend/e2e/s5-submit-lost-response-adoption.spec.ts`
- Modify: `frontend/e2e/s5-submit-happy-path.spec.ts`
- Modify: `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts`
- Modify: `frontend/e2e/s5-submit-foreign-pending-review.spec.ts`
- Modify: `frontend/e2e/s5-submit-closed-merged-discard.spec.ts`

- [ ] **Step 1: For each spec, find the `recordPrViewed` call**

Each spec has at least one `await recordPrViewed(page.request, ...)` call. Some have multiple (one per tab in multi-tab tests).

- [ ] **Step 2: Capture the page's tab id before each call**

Before each `recordPrViewed`:

```ts
const tabId = await getPageTabId(page);
await recordPrViewed(page.request, prRef, headSha, tabId);
```

For multi-tab tests (`s5-multi-tab-simultaneous-submit`), each tab page object has its own `getPageTabId` call:

```ts
const tabIdA = await getPageTabId(pageA);
const tabIdB = await getPageTabId(pageB);
await recordPrViewed(pageA.request, prRef, headSha, tabIdA);
await recordPrViewed(pageB.request, prRef, headSha, tabIdB);
```

- [ ] **Step 3: Run the mocked-mode Playwright suite**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test:e2e -- --grep "@mock"
```

(Use whatever tag/project the mocked-mode specs use; check `playwright.config.ts`.)

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/e2e/
git -C D:/src/prism-cross-tab-stamp commit -m "test(e2e): plumb page tab id into recordPrViewed across 7 mocked submit specs"
```

---

## Phase 8 — Project standards updates

### Task 18: Amend `docs/spec/02-architecture.md`

**Files:**
- Modify: `docs/spec/02-architecture.md`

- [ ] **Step 1: Find the `ReviewSessionState` description**

Search `docs/spec/02-architecture.md` for `ReviewSessionState`, `LastViewedHeadSha`, or `Multi-tab consistency`.

- [ ] **Step 2: Add a paragraph noting the V6 reshape**

In the `ReviewSessionState` shape section, add a one-paragraph note:

> *Post-V6: `LastViewedHeadSha` is per-tab via `TabStamps: IReadOnlyDictionary<string, TabStamp>`, keyed by `X-PRism-Tab-Id`. `LastSeenCommentId` stays session-flat as a monotone high-water — both mark-viewed and markAllRead apply `MonotonicCommentId.Max` to preserve the inbox unread-badge invariant across tabs.*

In the `Multi-tab consistency` section (if it exists; if not, add it as a new sub-section), add:

> *One field on `ReviewSessionState` is per-tab as a deliberate exception to the otherwise eventual-consistency-via-polling model: `TabStamps.HeadSha`. The exception is justified by the submit-gate's correctness need (each tab must be gated by its own viewing). All other session fields remain session-flat with `StateChanged`-broadcast convergence. See `docs/specs/2026-05-18-cross-tab-stamp-poisoning-design.md` for the V6 details.*

- [ ] **Step 3: Commit**

```
git -C D:/src/prism-cross-tab-stamp add docs/spec/02-architecture.md
git -C D:/src/prism-cross-tab-stamp commit -m "docs(architecture): note V6 per-tab TabStamps + session-flat LastSeenCommentId"
```

---

## Phase 9 — Pre-push checklist

### Task 19: Run the full pre-push checklist

Per `.ai/docs/development-process.md` and memory: every push runs the full checklist.

- [ ] **Step 1: BE build clean**

```
dotnet build PRism.sln
```

Expected: 0 errors, 0 warnings (in changed files).

- [ ] **Step 2: BE tests pass**

```
dotnet test PRism.sln
```

Expected: all PASS. Timeout ≥ 300000ms per memory.

- [ ] **Step 3: FE lint**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run lint
```

Expected: PASS. (Prettier --check is part of lint; per memory it gates CI.)

- [ ] **Step 4: FE build**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run build
```

Expected: PASS.

- [ ] **Step 5: FE Vitest**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test
```

Expected: all PASS.

- [ ] **Step 6: Mocked-mode Playwright**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test:e2e -- --grep "@mock"
```

Expected: PASS.

- [ ] **Step 7: Real-flow Playwright (manual — requires GitHub sandbox)**

Per project convention, real-flow specs run against `prpande/prism-sandbox`. Confirm the happy-path spec passes; the stale-OID spec stays `.skip`ed.

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test:e2e:real
```

Expected: 3 PASS, 1 SKIP (per PR #58 baseline).

- [ ] **Step 8: Confirm migration on a real `state.json`**

Manual smoke test:

```
# Copy a V5 state.json into a fresh data dir, run PRism, verify it migrates cleanly.
# Confirm the post-migration file has tab-stamps: {} on every session and no last-viewed-head-sha keys.
```

Expected: clean migration; no quarantine.

---

## Phase 10 — PR

### Task 20: Hand off to `pr-autopilot`

After all checks pass, invoke `pr-autopilot` to:
1. Push `feat/cross-tab-stamp` to origin.
2. Open the PR with the spec, plan, deferrals, and implementation diff.
3. Drive the reviewer-bot comment loop to quiescence.
4. Final CI gate.

Do not push manually. Let autopilot own the push + PR-open + comment-loop sequence.
