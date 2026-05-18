# Cross-tab stamp poisoning fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the submit-gate bypass class identified in [PR #55 deferrals § "Cross-tab stamp poisoning"](../specs/2026-05-11-s5-submit-pipeline-deferrals.md#defer-cross-tab-stamp-poisoning-f3-from-ce-code-review) by partitioning `LastViewedHeadSha` per-tab inside `ReviewSessionState`, keyed by `X-PRism-Tab-Id`.

**Architecture:** Promote `LastViewedHeadSha` into a per-tab `TabStamp` map (`TabStamps: IReadOnlyDictionary<string, TabStamp>`) inside `ReviewSessionState`; `LastSeenCommentId` stays session-flat as a monotone high-water (preserves the inbox unread badge). V5→V6 schema migration drops legacy `last-viewed-head-sha` keys; cap N=8 with LRU-by-`StampedAtUtc`. Submit gate, mark-viewed, reload, reconciliation pipeline, the `/test/mark-pr-viewed` hook, the inbox projection, and the FE error/banner copy all get wired through.

**Tech Stack:** .NET 10 minimal API (`PRism.Web` / `PRism.Core` / `PRism.GitHub`), React 18 + Vite + TS frontend, Playwright e2e, xUnit BE tests + Vitest FE tests.

**Spec:** [`docs/specs/2026-05-18-cross-tab-stamp-poisoning-design.md`](../specs/2026-05-18-cross-tab-stamp-poisoning-design.md).
**Deferrals sidecar:** [`docs/specs/2026-05-18-cross-tab-stamp-poisoning-deferrals.md`](../specs/2026-05-18-cross-tab-stamp-poisoning-deferrals.md).
**Worktree:** `D:/src/prism-cross-tab-stamp` (branch `feat/cross-tab-stamp`).

---

## Pre-task — Verify test infrastructure

Before any code change, confirm two enabling facts. Both are quick reads; their outcomes shape Task 0.

- `tests/PRism.Web.Tests/AssemblyInfo.cs` (or `.csproj`) declares `[InternalsVisibleTo("PRism.Web.Tests")]` exposing `PRism.Web`'s internals (the existing pattern; the spec relies on `SubmitErrorDto` being readable from test code).
- Existing `PrSubmitEndpointsTests.cs` uses `PRismWebApplicationFactory` directly (no per-endpoint TestContext class). That is the pattern this plan follows — **do not invent `PrDetailEndpointsTestContext` / `PrReloadEndpointsTestContext` / etc.**

---

## Task 0: Add header-aware HTTP test helper

Existing tests on `PRismWebApplicationFactory.CreateClient()` use `client.PostAsJsonAsync(url, body)` — a two-arg form that **does not** accept request-specific headers. Every per-tab test in this plan needs a different `X-PRism-Tab-Id` per call, so an `HttpClient.DefaultRequestHeaders.Add(...)` approach is wrong (one client serves many tests; mutation leaks across tests). Build a small extension method that constructs an `HttpRequestMessage` with the header, then calls `SendAsync`.

**Files:**
- Create: `tests/PRism.Web.Tests/TestHelpers/HttpClientHeaderExtensions.cs`

- [ ] **Step 1: Write the helper**

```csharp
using System.Net.Http.Json;

namespace PRism.Web.Tests.TestHelpers;

internal static class HttpClientHeaderExtensions
{
    /// <summary>
    /// POST JSON with caller-specified request headers. The per-test header semantics that
    /// the cross-tab-stamp tests need: each test sends its own X-PRism-Tab-Id without
    /// mutating the shared HttpClient.DefaultRequestHeaders (which would leak across tests).
    /// </summary>
    public static Task<HttpResponseMessage> PostAsJsonWithHeadersAsync<T>(
        this HttpClient client,
        string requestUri,
        T body,
        IDictionary<string, string>? headers = null,
        CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, requestUri)
        {
            Content = JsonContent.Create(body),
        };
        if (headers is not null)
            foreach (var (k, v) in headers)
                req.Headers.TryAddWithoutValidation(k, v);
        return client.SendAsync(req, ct);
    }

    public static Task<HttpResponseMessage> PatchAsJsonWithHeadersAsync<T>(
        this HttpClient client,
        string requestUri,
        T body,
        IDictionary<string, string>? headers = null,
        CancellationToken ct = default)
    {
        var req = new HttpRequestMessage(HttpMethod.Patch, requestUri)
        {
            Content = JsonContent.Create(body),
        };
        if (headers is not null)
            foreach (var (k, v) in headers)
                req.Headers.TryAddWithoutValidation(k, v);
        return client.SendAsync(req, ct);
    }
}
```

- [ ] **Step 2: Build**

```
dotnet build PRism.sln
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```
git -C D:/src/prism-cross-tab-stamp add tests/PRism.Web.Tests/TestHelpers/HttpClientHeaderExtensions.cs
git -C D:/src/prism-cross-tab-stamp commit -m "test(helpers): add PostAsJsonWithHeadersAsync extension for per-request headers"
```

---

## Phase 1 — Schema + types

Foundation. Tasks 1+2 land as one commit so the build stays green at the commit boundary.

### Task 1: Add `TabStamp` record and reshape `ReviewSessionState`

**Files:**
- Modify: `PRism.Core/State/AppState.cs`
- Test: `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`

- [ ] **Step 1: Write the failing round-trip test**

In `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs` (add a new test method):

```csharp
[Fact]
public void TabStamps_round_trips_through_state_serializer_with_kebab_case_keys()
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
    Assert.Contains("\"tab-stamps\"", json);
    Assert.Contains("\"head-sha\"", json);
    Assert.Contains("\"stamped-at-utc\"", json);

    var deserialized = JsonSerializer.Deserialize<ReviewSessionState>(json, JsonSerializerOptionsFactory.Storage)!;
    Assert.True(deserialized.TabStamps.ContainsKey("tab-A"));
    Assert.Equal("abc123", deserialized.TabStamps["tab-A"].HeadSha);
    Assert.Equal(stamp.StampedAtUtc, deserialized.TabStamps["tab-A"].StampedAtUtc);
    Assert.Equal("999", deserialized.LastSeenCommentId);
}
```

- [ ] **Step 2: Reshape `ReviewSessionState` + add `TabStamp`**

In `PRism.Core/State/AppState.cs`, replace the `ReviewSessionState` record (lines 47-57) with:

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

Build will fail at every call site — that's expected. Task 2 fixes them.

- [ ] **Step 3: Hold the commit**

Do not commit until Task 2's sweep lands. Otherwise the repository is in a non-compiling state.

---

### Task 2: Sweep every `LastViewedHeadSha` site

The Task 1 reshape breaks five categories of sites. Enumerate all of them, fix each, then commit Tasks 1+2 together.

**Files (categorized; verify exact set via `git grep -nl "LastViewedHeadSha"`):**

| Category | Sites |
|---|---|
| Positional / named-arg constructor sites | `PRism.Web/Endpoints/PrDetailEndpoints.cs:110, 169`; `PRism.Web/Endpoints/PrDraftEndpoints.cs:567-578` (`NewEmptySession`); `PRism.Web/TestHooks/TestEndpoints.cs:~160-170`; `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTestHelpers.cs:25-49`; `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTypesTests.cs:~22`; `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStoreTests.cs`; `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs:~146, ~423`; `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`; `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs`; `tests/PRism.Core.Tests/State/PrSessionsStateTests.cs`; `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointsTestContext.cs:~87, ~100`; `tests/PRism.Web.Tests/TestHooks/ClearPrSessionEndpointTests.cs:~27` |
| `with { LastViewedHeadSha = ... }` writes | `PRism.Web/Endpoints/PrDetailEndpoints.cs:~114`; `PRism.Web/Endpoints/PrReloadEndpoints.cs:~161`; `PRism.Web/TestHooks/TestEndpoints.cs:~172` |
| `session.LastViewedHeadSha` reads | `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs:33, ~216`; `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:~244`; `PRism.Web/Endpoints/PrSubmitEndpoints.cs:117, 129, 131, 144` |
| Reconciliation tests with named-arg `LastViewedHeadSha:` seeds | `tests/PRism.Core.Tests/Reconciliation/{BoundaryPermutation, Delete, ForcePushFallback, Matrix, OverrideStale, PipelineGuard, Rename, Reply, VerdictReconfirm, Whitespace}Tests.cs` |
| Inbox test | `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` |

- [ ] **Step 1: Confirm the full set via grep**

```
git -C D:/src/prism-cross-tab-stamp grep -nl "LastViewedHeadSha" -- "*.cs"
```

Expected: ~32 files. Cross-check against the table above; the table is the workplan but the grep is the authority.

- [ ] **Step 2: Rewrite positional / named-arg constructor sites**

Every `new ReviewSessionState(...)` (positional) or `new ReviewSessionState(LastViewedHeadSha: ..., ...)` (named-arg with the old field name) needs `TabStamps: new Dictionary<string, TabStamp>()` (or a seeded map) as the first positional / first named arg. `LastViewedHeadSha` arg goes away. Prefer named-arg form everywhere for grep-able call sites.

For tests that previously seeded `LastViewedHeadSha: "head1"` and expected reconciliation to see head-shift behavior: swap to seed `TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("head1", DateTime.UtcNow.AddMinutes(-1)) }`. Use the constant `"tab-test"` consistently — most reconciliation tests get a `callerTabId: "tab-test"` parameter (Task 10) and the stamp must be under that key for the head-shift derivation to engage.

- [ ] **Step 3: Rewrite `with { LastViewedHeadSha = ... }` writes**

Three sites — mark-viewed, reload, test-hook. Each gets a placeholder write that the relevant Phase-2 task will replace. For now, write to `TabStamps` via a temporary direct assignment so the build compiles:

For mark-viewed (`PrDetailEndpoints.cs:~114`):
```csharp
sessions[key] = session with
{
    TabStamps = AddOrUpdateStamp(session.TabStamps, /* tabId placeholder — Task 4 wires the header */ "tab-PLACEHOLDER", body.HeadSha),
    LastSeenCommentId = body.MaxCommentId,
};
```

Mark each placeholder with a `// TASK4` / `// TASK5` / `// TASK6` comment so the implementer can grep them once those tasks run. Same for reload + test-hook.

If easier: comment out the body of these three endpoint handlers entirely with a `throw new NotImplementedException("Wired in Task N");`, and the relevant tests stay red until that task lands. Pick whichever pattern produces less churn.

- [ ] **Step 4: Rewrite `session.LastViewedHeadSha` reads with sentinels**

Four sites in `PrSubmitEndpoints` (lines 117, 129, 131, 144), two in `DraftReconciliationPipeline` (33, 216), one in `InboxRefreshOrchestrator` (244). Each currently uses `session.LastViewedHeadSha` as a `string?` value. Until the per-tab logic lands (Tasks 9, 10, 11), replace each with a placeholder that compiles but throws at runtime:

```csharp
// TASK9 (or 10 / 11): per-tab readout
throw new InvalidOperationException("Phase-1 placeholder — wired in Task N");
```

The four `PrSubmitEndpoints` sites are inside rule (f) which is fully replaced in Task 9; same for the two reconciliation sites (Task 10) and the inbox site (Task 11). The placeholders are short-lived.

- [ ] **Step 5: Build**

```
dotnet build PRism.sln
```

Expected: 0 errors. Tests will fail at runtime (NotImplementedException) for any path that exercises a placeholder; that's expected until the next phase.

- [ ] **Step 6: Run the round-trip test from Task 1**

```
dotnet test tests/PRism.Core.Tests/ --filter "TabStamps_round_trips_through_state_serializer"
```

Expected: PASS. The round-trip test doesn't touch any placeholder; it exercises pure serialization.

- [ ] **Step 7: Commit Tasks 1 + 2 together**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/State/AppState.cs PRism.Web/Endpoints/ PRism.Web/TestHooks/ tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(state): reshape ReviewSessionState — TabStamps replaces LastViewedHeadSha"
```

The commit is large by design — the type reshape and its sweep are atomic. Don't attempt to land Task 1 in isolation.

---

### Task 3: V5→V6 migration step

**Files:**
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs`
- Modify: `PRism.Core/State/AppStateStore.cs`
- Create: `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs`

- [ ] **Step 1: Write the failing migration tests**

Create `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs`. The five tests below cover legacy-session migration, idempotency, partial-rollback throw, empty `accounts`, and already-populated `tab-stamps`.

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

- [ ] **Step 2: Run tests to verify failure**

```
dotnet test tests/PRism.Core.Tests/ --filter "AppStateMigrationsV5ToV6Tests"
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

- Line 11: `private const int CurrentVersion = 5;` → `private const int CurrentVersion = 6;`
- Inside the `MigrationSteps` array initializer (after the `(5, AppStateMigrations.MigrateV4ToV5)` line, before the closing `}`):

```csharp
(6, AppStateMigrations.MigrateV5ToV6),  // V5→V6 — per-tab LastViewedHeadSha
```

Extend `EnsureCurrentShape` after the existing `accounts.default.reviews.sessions` backfill block:

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

- [ ] **Step 5: Run migration tests + chain tests**

```
dotnet test tests/PRism.Core.Tests/ --filter "Migration"
```

Expected: PASS.

- [ ] **Step 6: Extend `MigrationChainTests` for V1→V6**

Find the longest existing chain test in `tests/PRism.Core.Tests/State/MigrationChainTests.cs`. Add a `V1_through_V6_chain_loads_clean` test that seeds a V1 file, loads through `AppStateStore`, and asserts the resulting `AppState` has empty `TabStamps` on the default session.

- [ ] **Step 7: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/State/Migrations/AppStateMigrations.cs PRism.Core/State/AppStateStore.cs tests/PRism.Core.Tests/State/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(state): V5→V6 migration drops LastViewedHeadSha, seeds tab-stamps"
```

---

## Phase 2 — Write sites

mark-viewed, reload, and the test-hook write to `TabStamps`. markAllRead is **not** in this phase — its server-derived cache value is monotone by construction (see spec § 5.6).

### Task 4: mark-viewed writes `TabStamps[tabId]` + monotone `LastSeenCommentId`

**Files:**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs:89-131`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`

- [ ] **Step 1: Write the failing happy-path test using the header helper from Task 0**

```csharp
[Fact]
public async Task MarkViewed_writes_tab_stamp_under_caller_tab_id()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"42" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    var state = await factory.StateStore.LoadAsync(default);
    var session = state.Reviews.Sessions["owner/repo/1"];
    Assert.True(session.TabStamps.ContainsKey("tab-A"));
    Assert.Equal("abc123", session.TabStamps["tab-A"].HeadSha);
    Assert.Equal("42", session.LastSeenCommentId);
}
```

`SeedSnapshot` and `StateStore` are existing helpers/properties on `PRismWebApplicationFactory` (or add them by following the same pattern the existing `PrSubmitEndpointsTests` uses to seed state). Do not introduce a per-endpoint TestContext class.

- [ ] **Step 2: Replace the mark-viewed handler**

In `PRism.Web/Endpoints/PrDetailEndpoints.cs:89-131`:

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
                var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? PrDraftEndpoints.NewEmptySession();

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

Add (inside the partial class) and `using System.Text.RegularExpressions;` at the top of the file:

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();

// Numeric monotone-max of two stringified comment IDs. Unparseable → "no signal."
// Inlined here (not a shared helper) — only mark-viewed needs this guard; markAllRead
// reads from the IActivePrCache value which is monotone-by-construction (spec § 5.6).
private static string? MonotonicMaxCommentId(string? current, string? incoming)
{
    if (!long.TryParse(incoming, out var inc)) return current;
    if (!long.TryParse(current, out var cur)) return incoming;
    return inc > cur ? incoming : current;
}
```

**Use `PrDraftEndpoints.NewEmptySession()` directly** — do not duplicate the factory. The existing comment in `PrDraftEndpoints.cs:567-571` explicitly documents the single-definition invariant. The `internal` visibility is already in place.

- [ ] **Step 3: Run happy-path test**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkViewed_writes_tab_stamp_under_caller_tab_id"
```

Expected: PASS.

- [ ] **Step 4: Add the remaining mark-viewed scenarios**

Append to `PrDetailEndpointsTests.cs`:

```csharp
[Fact]
public async Task MarkViewed_returns_422_when_tab_id_header_missing()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await client.PostAsJsonWithHeadersAsync(
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
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task MarkViewed_rejects_tab_id_over_64_chars()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");
    var tooLong = new string('a', 65);

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tooLong });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task MarkViewed_evicts_oldest_stamp_at_cap_N_8()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    await factory.StateStore.UpdateAsync(state =>
    {
        var session = PrDraftEndpoints.NewEmptySession();
        var stamps = new Dictionary<string, TabStamp>();
        for (int i = 0; i < 8; i++)
            stamps[$"tab-{i}"] = new TabStamp($"sha-{i}", new DateTime(2026, 5, 18, 0, 0, i, DateTimeKind.Utc));
        session = session with { TabStamps = stamps };
        var sessions = new Dictionary<string, ReviewSessionState> { ["owner/repo/1"] = session };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }, default);

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)null },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-NEW" });

    Assert.Equal(HttpStatusCode.NoContent, resp.StatusCode);
    var state = await factory.StateStore.LoadAsync(default);
    var stamps = state.Reviews.Sessions["owner/repo/1"].TabStamps;
    Assert.Equal(8, stamps.Count);
    Assert.True(stamps.ContainsKey("tab-NEW"));
    Assert.False(stamps.ContainsKey("tab-0"));
}

[Fact]
public async Task MarkViewed_monotone_lastSeenCommentId_does_not_rewind()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSnapshot("owner", "repo", 1, headSha: "abc123");

    await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"999" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });
    await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/mark-viewed",
        new { headSha = "abc123", maxCommentId = (string?)"50" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-B" });

    var state = await factory.StateStore.LoadAsync(default);
    Assert.Equal("999", state.Reviews.Sessions["owner/repo/1"].LastSeenCommentId);
}
```

If `PRismWebApplicationFactory` doesn't already expose `SeedSnapshot` / `StateStore`, add them as `internal` methods on the factory class following the seed pattern in the existing submit tests. Do not create a separate context class.

- [ ] **Step 5: Run all mark-viewed tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "MarkViewed"
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrDetailEndpoints.cs tests/PRism.Web.Tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(mark-viewed): write per-tab TabStamps with N=8 LRU + monotone LastSeenCommentId"
```

---

### Task 5: reload writes `TabStamps[tabId]`

**Files:**
- Modify: `PRism.Web/Endpoints/PrReloadEndpoints.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs` (note: singular — that's the existing file name)

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact]
public async Task Reload_writes_tab_stamp_under_caller_tab_id()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSessionWithDrafts("owner", "repo", 1, currentHeadSha: "oldhead00000000000000000000000000000000");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/reload",
        new { headSha = "newhead00000000000000000000000000000000" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-X" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await factory.StateStore.LoadAsync(default);
    var stamps = state.Reviews.Sessions["owner/repo/1"].TabStamps;
    Assert.True(stamps.ContainsKey("tab-X"));
    Assert.Equal("newhead00000000000000000000000000000000", stamps["tab-X"].HeadSha);
}

[Fact]
public async Task Reload_returns_422_when_tab_id_header_missing()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSessionWithDrafts("owner", "repo", 1, currentHeadSha: "oldhead00000000000000000000000000000000");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/reload",
        new { headSha = "newhead00000000000000000000000000000000" });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}
```

- [ ] **Step 2: Add `partial` to `PrReloadEndpoints`**

`PRism.Web/Endpoints/PrReloadEndpoints.cs:13`: `internal static class PrReloadEndpoints` → `internal static partial class PrReloadEndpoints`.

- [ ] **Step 3: Add the allowlist regex + 422 validation**

After the existing `Sha40` / `Sha64` static fields:

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

In `PostReload`, after the existing `sourceTabId` read at line 63:

```csharp
if (string.IsNullOrEmpty(sourceTabId) || !TabIdAllowlistRegex().IsMatch(sourceTabId))
    return Results.UnprocessableEntity(new { error = "tab-id-missing" });
```

- [ ] **Step 4: Replace the Phase-2 apply block**

Lines 156-162 (the `updated = current with { ... }` block) becomes:

```csharp
var tabStamps = current.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
tabStamps[sourceTabId!] = new TabStamp(request.HeadSha, DateTime.UtcNow);
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

The `!` on `sourceTabId` asserts non-null after the 422 gate in Step 3.

- [ ] **Step 5: Run reload tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "Reload"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrReloadEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs
git -C D:/src/prism-cross-tab-stamp commit -m "feat(reload): write per-tab TabStamps + 422 tab-id-missing"
```

---

### Task 6: `/test/mark-pr-viewed` hook accepts `tabId`

The hook currently uses `MarkPrViewedRequest(string Owner, string Repo, int Number)` — 3 fields, no `HeadSha`; the existing handler reads headSha from `store.CurrentHeadSha`. **Keep that path.** Add only `TabId`.

**Files:**
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs:149-176`
- Modify: `tests/PRism.Web.Tests/TestHooks/` (find the existing hook test file)

- [ ] **Step 1: Write the failing test**

```csharp
[Fact]
public async Task TestMarkPrViewed_writes_tab_stamp_under_provided_tab_id()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedActivePrCache("owner", "repo", 1, currentHeadSha: "abc123");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/test/mark-pr-viewed",
        new { owner = "owner", repo = "repo", number = 1, tabId = "tab-X" });

    Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
    var state = await factory.StateStore.LoadAsync(default);
    Assert.True(state.Reviews.Sessions["owner/repo/1"].TabStamps.ContainsKey("tab-X"));
    Assert.Equal("abc123", state.Reviews.Sessions["owner/repo/1"].TabStamps["tab-X"].HeadSha);
}

[Fact]
public async Task TestMarkPrViewed_rejects_missing_tab_id()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedActivePrCache("owner", "repo", 1, currentHeadSha: "abc123");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/test/mark-pr-viewed",
        new { owner = "owner", repo = "repo", number = 1 });
    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}
```

- [ ] **Step 2: Extend the request record + handler**

```csharp
internal sealed record MarkPrViewedRequest(string Owner, string Repo, int Number, string TabId);
```

In the handler, BEFORE the existing logic that derives `headSha` from the active-PR cache, add:

```csharp
if (string.IsNullOrEmpty(body.TabId) ||
    !System.Text.RegularExpressions.Regex.IsMatch(body.TabId, @"^[a-zA-Z0-9_-]{1,64}$"))
    return Results.UnprocessableEntity(new { error = "tab-id-missing" });
```

(Inline `Regex.IsMatch` here is fine — this is test-only code; the perf cost is irrelevant and adding `partial` to a test-mode class is over-engineering.)

In the `UpdateAsync` transform, replace the existing write that uses `LastViewedHeadSha` (already converted to a placeholder in Task 2) with:

```csharp
var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
tabStamps[body.TabId] = new TabStamp(headSha, DateTime.UtcNow);  // headSha from active-PR cache, existing logic
if (tabStamps.Count > 8)
{
    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
    tabStamps.Remove(oldest);
}
session = session with { TabStamps = tabStamps };
```

- [ ] **Step 3: Run tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "TestMarkPrViewed"
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/TestHooks/TestEndpoints.cs tests/PRism.Web.Tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(test-hook): /test/mark-pr-viewed accepts tabId for V6 per-tab stamping"
```

---

## Phase 3 — Submit gate

The bypass-closing change. Single task that combines `partial`/regex addition with the rule-(f) rewrite (no separate prep-only commit — folded per scope-guardian finding).

### Task 7: `PrSubmitEndpoints` becomes `partial` + new logger + rule (f) rewrite

**Files:**
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`

- [ ] **Step 1: Write the two-tab bypass test (the named regression)**

```csharp
[Fact]
public async Task Submit_rejects_caller_tab_without_own_stamp_even_if_other_tab_stamped_current_head()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedActivePrCache("owner", "repo", 1, currentHeadSha: "shaB");
    await factory.StateStore.UpdateAsync(state =>
    {
        var session = PrDraftEndpoints.NewEmptySession() with
        {
            TabStamps = new Dictionary<string, TabStamp> { ["tab-A"] = new TabStamp("shaB", DateTime.UtcNow) },
            DraftSummaryMarkdown = "lgtm",
        };
        return state.WithDefaultReviews(state.Reviews with
        {
            Sessions = new Dictionary<string, ReviewSessionState> { ["owner/repo/1"] = session }
        });
    }, default);

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-B" });

    Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    Assert.Equal("head-sha-not-stamped", body!.Code);
}
```

If `SubmitErrorDto` is `internal`, confirm `InternalsVisibleTo("PRism.Web.Tests")` is set on `PRism.Web` (it is, per the pre-task check). If not, the alternative is `var body = await resp.Content.ReadFromJsonAsync<Dictionary<string, string>>(); Assert.Equal("head-sha-not-stamped", body!["code"]);`.

- [ ] **Step 2: Make the class `partial` and add the new infrastructure**

`PRism.Web/Endpoints/PrSubmitEndpoints.cs:23`: `internal static class PrSubmitEndpoints` → `internal static partial class PrSubmitEndpoints`.

Add `using System.Text.RegularExpressions;` at the top.

Near the existing `s_headShaNotStamped` (around line 47):

```csharp
private static readonly Action<ILogger, string, Exception?> s_tabIdMissing =
    LoggerMessage.Define<string>(LogLevel.Warning, new EventId(4, "SubmitRejectedTabIdMissing"),
        "POST /submit rejected for {SessionKey}: X-PRism-Tab-Id header is missing or fails allowlist. " +
        "The frontend must always send this header; see frontend/src/api/draft.ts:TAB_ID_HEADER.");
```

Update the existing `s_headShaNotStamped` format string from `"... session.LastViewedHeadSha is null. ..."` to:

```csharp
"POST /submit rejected for {SessionKey}: session.TabStamps has no entry for the caller's tab. " +
"The frontend must call POST /api/pr/{{ref}}/mark-viewed when PR detail loads; see PrDetailEndpoints.MarkViewed."
```

Add the regex:

```csharp
[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

- [ ] **Step 3: Replace rule (f) in `SubmitAsync`**

Add `HttpContext httpContext` to the `SubmitAsync` parameter list. Replace lines 113-144 (the rule-(f) block + the `var headSha = session.LastViewedHeadSha;` line) with:

```csharp
// Authorization: IsSubscribed(prRef) already gates this endpoint at the top (line 85-86),
// so the rule (f) error-code differential is NOT reachable by unauthenticated probes.
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

// Lock acquisition unchanged ...

var headSha = stamp.HeadSha;
```

- [ ] **Step 4: Add the remaining submit tests**

```csharp
[Fact]
public async Task Submit_returns_422_when_tab_id_header_missing()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSubmittableSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Theory]
[InlineData("../../etc/passwd")]
[InlineData("tab with space")]
public async Task Submit_returns_422_on_invalid_tab_id(string tabId)
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedSubmittableSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId });

    Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
}

[Fact]
public async Task Submit_happy_path_single_tab_runs_pipeline()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedActivePrCache("owner", "repo", 1, currentHeadSha: "shaA");
    await factory.SeedSubmittableSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.True(resp.IsSuccessStatusCode);
}

[Fact]
public async Task Submit_returns_400_head_sha_drift_when_poll_observes_different_head()
{
    await using var factory = new PRismWebApplicationFactory();
    using var client = factory.CreateClient();
    await factory.SeedActivePrCache("owner", "repo", 1, currentHeadSha: "shaB");
    await factory.SeedSubmittableSessionWithStamp("owner", "repo", 1, tabId: "tab-A", headSha: "shaA");

    var resp = await client.PostAsJsonWithHeadersAsync(
        "/api/pr/owner/repo/1/submit",
        new { verdict = "Comment" },
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-A" });

    Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    Assert.Equal("head-sha-drift", body!.Code);
}
```

Add `SeedSubmittableSessionWithStamp` as an `internal` method on `PRismWebApplicationFactory` — it seeds a session with the given tab-id stamp + a non-empty `DraftSummaryMarkdown` so rule (e) doesn't reject. Pattern matches existing `SubmitEndpointsTestContext` helpers; lift them onto the factory if needed.

- [ ] **Step 5: Run all submit tests**

```
dotnet test tests/PRism.Web.Tests/ --filter "Submit"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Web.Tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(submit): rule (f) reads TabStamps[tabId] + distinct error codes + partial+regex+logger"
```

---

## Phase 4 — Reconciliation pipeline

### Task 8: `ReconcileAsync` requires `callerTabId` + three-branch `headShifted`

**Files:**
- Modify: `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs`
- Modify: `PRism.Web/Endpoints/PrReloadEndpoints.cs:91-93` (caller)
- Modify: all `tests/PRism.Core.Tests/Reconciliation/*.cs` (10 files; enumerated below)

- [ ] **Step 1: Write the failing per-tab headShifted tests**

Add a new test file `tests/PRism.Core.Tests/Reconciliation/HeadShiftedPerTabTests.cs`:

```csharp
namespace PRism.Core.Tests.Reconciliation;

public class HeadShiftedPerTabTests
{
    private static ReviewSessionState SessionWithOverriddenStaleDraft(IReadOnlyDictionary<string, TabStamp> stamps) =>
        new(
            TabStamps: stamps,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>
            {
                new("d1", "Foo.cs", 10, "RIGHT", "sha-A", "line", "body", DraftStatus.Stale, IsOverriddenStale: true)
            },
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

    [Fact]
    public async Task Per_tab_branch_clears_override_when_caller_tab_has_prior_stamp_at_different_head()
    {
        var stamps = new Dictionary<string, TabStamp>
        {
            ["tab-X"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-1))
        };
        var session = SessionWithOverriddenStaleDraft(stamps);
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, "sha-B", "tab-X", new FakeFileContentSource(), default);
        Assert.False(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);
    }

    [Fact]
    public async Task Empty_map_fallback_preserves_override_first_reload_semantic()
    {
        var session = SessionWithOverriddenStaleDraft(new Dictionary<string, TabStamp>());
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, "sha-B", "tab-Y", new FakeFileContentSource(), default);
        Assert.True(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);
    }

    [Fact]
    public async Task Session_level_fallback_clears_override_when_caller_missing_but_other_stamps_differ()
    {
        var stamps = new Dictionary<string, TabStamp>
        {
            ["tab-A"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-1)),
            ["tab-B"] = new TabStamp("sha-A", DateTime.UtcNow.AddMinutes(-2)),
        };
        var session = SessionWithOverriddenStaleDraft(stamps);
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, "sha-B", "tab-X-evicted", new FakeFileContentSource(), default);
        Assert.False(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);
    }

    [Fact]
    public async Task Session_level_fallback_preserves_override_when_all_other_stamps_match_new_head()
    {
        var stamps = new Dictionary<string, TabStamp>
        {
            ["tab-A"] = new TabStamp("sha-B", DateTime.UtcNow.AddMinutes(-1)),
            ["tab-B"] = new TabStamp("sha-B", DateTime.UtcNow.AddMinutes(-2)),
        };
        var session = SessionWithOverriddenStaleDraft(stamps);
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, "sha-B", "tab-X-new", new FakeFileContentSource(), default);
        Assert.True(result.Drafts.Single(d => d.Id == "d1").IsOverriddenStale);
    }
}
```

`FakeFileContentSource` exists in the test assembly; reuse it.

- [ ] **Step 2: Reshape `ReconcileAsync` signature**

In `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs:12-18`:

```csharp
public async Task<ReconciliationResult> ReconcileAsync(
    ReviewSessionState session,
    string newHeadSha,
    string callerTabId,
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

    bool headShifted = ComputeHeadShifted(session, callerTabId, newHeadSha);
    if (headShifted)
    {
        // ... existing override-clear block ...
    }

    // ... rest of method ...
}

private static bool ComputeHeadShifted(ReviewSessionState session, string callerTabId, string newHeadSha)
{
    if (session.TabStamps.TryGetValue(callerTabId, out var priorStamp))
        return priorStamp.HeadSha != newHeadSha;
    if (session.TabStamps.Count == 0)
        return false;
    return session.TabStamps.Values.Any(s => s.HeadSha != newHeadSha);
}
```

Replace the line-33 `headShifted` derivation with the helper call. Replace the line-216 verdict-reconcile derivation (`verdictHeadShifted = session.LastViewedHeadSha is not null && session.LastViewedHeadSha != newHeadSha`) with `var verdictHeadShifted = ComputeHeadShifted(session, callerTabId, newHeadSha);` — the helper is reused, no separate branch shape.

- [ ] **Step 3: Update the caller in `PrReloadEndpoints.cs:91-93`**

```csharp
var result = await pipeline.ReconcileAsync(
    session, request.HeadSha, sourceTabId!, fileSource, ct,
    renames: null, deletedPaths: null).ConfigureAwait(false);
```

- [ ] **Step 4: Update every test caller (10 files)**

The enumerated set:
- `tests/PRism.Core.Tests/Reconciliation/BoundaryPermutationTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/DeleteTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/ForcePushFallbackTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/OverrideStaleTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/PipelineGuardTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/RenameTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/ReplyTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/VerdictReconfirmTests.cs`
- `tests/PRism.Core.Tests/Reconciliation/WhitespaceTests.cs`

For each `pipeline.ReconcileAsync(session, newHeadSha, fileSource, ct, ...)` call, insert `callerTabId: "tab-test"` as the third positional argument. **For tests that previously seeded `LastViewedHeadSha: "head1"` and depended on head-shift behavior**, the Task-2 sweep already converted those seeds to `TabStamps: new Dictionary<string, TabStamp> { ["tab-test"] = new TabStamp("head1", t) }`. The `"tab-test"` value flowing through `callerTabId` matches the seeded key, so the per-tab branch fires — preserving the original test semantics.

For reconciliation tests that don't care about head-shift (most of them — they exercise rename/move/delete logic), `"tab-test"` with an unseeded `TabStamps` map means the helper returns `false` (no shift), which matches the pre-V6 behavior when `LastViewedHeadSha` was `null`.

- [ ] **Step 5: Run all reconciliation tests**

```
dotnet test tests/PRism.Core.Tests/ --filter "Reconciliation"
```

Expected: PASS (including the four new HeadShifted tests).

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs PRism.Web/Endpoints/PrReloadEndpoints.cs tests/
git -C D:/src/prism-cross-tab-stamp commit -m "feat(reconcile): ReconcileAsync requires callerTabId + three-branch headShifted"
```

---

## Phase 5 — Inbox projection

### Task 9: Inbox projects most-recent `TabStamp` + keeps session-flat `LastSeenCommentId`

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:~244`
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

- [ ] **Step 1: Locate the projection site**

Read `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` around lines 230-260. The `MaterializePrInboxItem` (or similarly-named) function constructs `new PrInboxItem(...)` positionally; line 244 currently reads `session.LastViewedHeadSha`. Replace that read with the most-recent-stamp projection.

- [ ] **Step 2: Update the projection (in-place, positional construction unchanged)**

```csharp
// Before the new PrInboxItem(...) construction:
var lastViewedHeadSha = session.TabStamps
    .Values
    .OrderByDescending(s => s.StampedAtUtc)
    .Select(s => (string?)s.HeadSha)
    .FirstOrDefault();
var lastSeenCommentId = session.LastSeenCommentId is { } id && long.TryParse(id, out var parsed) ? (long?)parsed : null;

// Then existing positional construction with these as the values:
return new PrInboxItem(
    /* ... existing args ... */,
    LastViewedHeadSha: lastViewedHeadSha,
    LastSeenCommentId: lastSeenCommentId);
```

- [ ] **Step 3: Add the test**

In `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`, add:

```csharp
[Fact]
public async Task InboxProjection_lastViewedHeadSha_is_most_recent_TabStamp_HeadSha()
{
    // Drive the orchestrator end-to-end. Seed two stamps with different StampedAtUtc;
    // assert the projected PrInboxItem.LastViewedHeadSha is the more-recent one's HeadSha.
    // (Use the existing test pattern in this file as the template — usually a fake IAppStateStore
    // + IPrDiscovery + invoke RefreshAsync, then assert the published inbox item shape.)
}
```

(Exact test wiring depends on the existing fixture pattern; the principle is to drive `RefreshAsync` with seeded state and assert the projection, not to test an extracted `InboxItemMapper.FromSession` — that helper does not exist.)

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

### Task 10: `tab-id-missing` arm for submit error

**Files:**
- Modify: `frontend/src/api/submit.ts`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:159-204`
- Modify: `frontend/__tests__/PrHeader.test.tsx`

- [ ] **Step 1: Add `'tab-id-missing'` to `KNOWN_SUBMIT_ERROR_CODES`**

In `frontend/src/api/submit.ts`, find the `KNOWN_SUBMIT_ERROR_CODES` const and append `'tab-id-missing'`.

- [ ] **Step 2: Write the failing component-rendering test**

`submitErrorMessage` is a closure inside the `PrHeader` component (not exported). Test it via the rendered component, using the pattern that already exists in `PrHeader.test.tsx` for the other submit errors (mock `submitReview` to reject with the new code; assert the toast surfaces the right copy).

```tsx
test('surfaces tab-id-missing as refresh-tab toast copy', async () => {
  submitReviewMock.mockRejectedValueOnce(new SubmitConflictError('tab-id-missing', 'whatever'));
  // Render PrHeader with submittable props
  render(<PrHeader {...props} />);
  // Click Submit Review
  await userEvent.click(screen.getByText('Submit Review'));
  // Toast copy appears
  expect(await screen.findByText(/Refresh the browser tab/)).toBeInTheDocument();
});
```

(Match the exact pattern of the existing tests in `PrHeader.test.tsx`; the imports + mock setup should mirror the closest sibling test.)

- [ ] **Step 3: Run test to verify failure**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test -- PrHeader
```

Expected: FAIL — switch has no arm for the new code.

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

### Task 11: useReconcile arm for reload 422 `tab-id-missing`

**Files:**
- Modify: `frontend/src/api/draft.ts` (`PostReloadResult` union + `postReload` 422 branch)
- Modify: `frontend/src/hooks/useReconcile.ts`
- Modify: `frontend/__tests__/useReconcile.test.tsx` (or equivalent)

- [ ] **Step 1: Locate the two reload call sites in useReconcile**

Read `frontend/src/hooks/useReconcile.ts`. It has TWO `postReload` calls: one initial, one as the retry after 409 reload-stale-head. Both need the new 422 arm.

- [ ] **Step 2: Write failing test**

```tsx
test('reload 422 tab-id-missing surfaces refresh-tab banner with no auto-retry', async () => {
  postReloadMock.mockResolvedValueOnce({
    ok: false,
    status: 422,
    kind: 'tab-id-missing',
    body: { error: 'tab-id-missing' },
  });
  // Render useReconcile (via the existing test wrapper)
  // Trigger a reload
  // Assert banner === BANNER_TAB_ID_MISSING
  // Assert postReloadMock was called exactly once (no auto-retry)
});
```

Use the existing test wrapper pattern from `useReconcile.test.tsx`.

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

In `postReload` (lines 166-191), add the 422 branch:

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

Add `hasErrorField` if it doesn't already exist:

```ts
function hasErrorField(body: unknown, value: string): boolean {
  return typeof body === 'object' && body !== null && 'error' in body
    && (body as { error: unknown }).error === value;
}
```

- [ ] **Step 4: Add the arm in useReconcile — at BOTH call sites**

Add the banner constant:

```ts
export const BANNER_TAB_ID_MISSING = "Couldn't reload — refresh the browser tab and retry.";
```

After each `postReload` call (both the initial and the post-409-retry), add:

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
git -C D:/src/prism-cross-tab-stamp commit -m "feat(fe): useReconcile arm for reload 422 tab-id-missing (no auto-retry, both call sites)"
```

---

### Task 12: Tab-id mutability invariant comment + markViewed comment block update

**Files:**
- Modify: `frontend/src/api/draft.ts:5-12`
- Modify: `frontend/src/api/markViewed.ts:18-23`

- [ ] **Step 1: Add invariant comment to `_tabId`**

In `frontend/src/api/draft.ts`, replace lines 5-7 with:

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
let _tabId: string | null = null;
```

- [ ] **Step 2: Update markViewed.ts comment**

In `frontend/src/api/markViewed.ts`, lines 18-23:

```ts
// `signal` lets the caller cancel the POST when its React effect cleans up,
// preventing a slow A-stamp from landing after a fast B-stamp on rapid PR
// navigation. The tab-id header is consumed by the BE on /mark-viewed
// (per-tab TabStamp partitioning), /submit (rule (f) lookup), and /reload
// (per-tab stamp write). The BE rejects /mark-viewed and /reload with 422
// tab-id-missing and /submit with 422 tab-id-missing if the header is
// missing or malformed.
```

- [ ] **Step 3: Typecheck**

```
cd D:/src/prism-cross-tab-stamp/frontend && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit (folded into Task 11's commit is also fine — comment-only)**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/api/draft.ts frontend/src/api/markViewed.ts
git -C D:/src/prism-cross-tab-stamp commit -m "docs(fe): pin _tabId mutability invariant + update markViewed comment"
```

---

## Phase 7 — Playwright mocked-mode plumbing

The mocked-mode submit suite uses `recordPrViewed` via `APIRequestContext`, whose tab-id context is separate from the page's browser context. Eight specs call `recordPrViewed`; all eight need explicit tab-id coordination.

### Task 13: FE test-mode hook exposes `getTabId` to `page.evaluate`

**Files:**
- Modify: `frontend/src/main.tsx` (or app-init wiring)
- Modify: `frontend/vite.config.ts` (gate via `define` or env var)

- [ ] **Step 1: Pick the test-mode predicate**

Use `import.meta.env.VITE_E2E_TEST === 'true'`. This is settable from Playwright's `playwright.config.ts` via the `webServer.env` block. Vite strips the conditional from production builds when `VITE_E2E_TEST` is unset.

- [ ] **Step 2: Add the hook in `main.tsx`**

After the existing app-mount:

```ts
if (import.meta.env.VITE_E2E_TEST === 'true') {
  import('./api/draft').then(({ getTabId }) => {
    (window as unknown as { __prism_test_getTabId?: () => string }).__prism_test_getTabId = () => getTabId();
  });
}
```

- [ ] **Step 3: Confirm `playwright.config.ts` sets `VITE_E2E_TEST=true`**

Read `playwright.config.ts`. Under `webServer`, add (or confirm) `env: { VITE_E2E_TEST: 'true' }`.

- [ ] **Step 4: Confirm production-build strips the hook**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run build && grep -r "__prism_test_getTabId" dist/
```

Expected: no matches in `dist/`.

- [ ] **Step 5: Confirm Vitest tests still pass**

```
npm run test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/src/main.tsx frontend/playwright.config.ts
git -C D:/src/prism-cross-tab-stamp commit -m "feat(fe-test-mode): expose getTabId on window under VITE_E2E_TEST"
```

---

### Task 14: `recordPrViewed` helper + `getPageTabId`

**Files:**
- Modify: `frontend/e2e/helpers/s5-submit.ts`

- [ ] **Step 1: Add `getPageTabId` with init-race guard**

```ts
export async function getPageTabId(page: Page, timeoutMs: number = 5000): Promise<string> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __prism_test_getTabId?: () => string }).__prism_test_getTabId === 'function',
    { timeout: timeoutMs },
  );
  const id = await page.evaluate(() => (window as unknown as { __prism_test_getTabId?: () => string }).__prism_test_getTabId?.());
  if (!id || typeof id !== 'string') throw new Error('Page tab id unavailable — FE test-mode hook returned no value');
  return id;
}
```

- [ ] **Step 2: Update `recordPrViewed` to accept `tabId`**

```ts
export async function recordPrViewed(
  request: APIRequestContext,
  prRef: { owner: string; repo: string; number: number },
  tabId: string,
): Promise<void> {
  await postTest(request, '/test/mark-pr-viewed', {
    owner: prRef.owner,
    repo: prRef.repo,
    number: prRef.number,
    tabId,
  });
}
```

Note: the helper does NOT pass `headSha` — the BE hook reads it from the active-PR cache server-side (see Task 6).

- [ ] **Step 3: Typecheck**

```
cd D:/src/prism-cross-tab-stamp/frontend && npx tsc --noEmit -p e2e/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/e2e/helpers/s5-submit.ts
git -C D:/src/prism-cross-tab-stamp commit -m "feat(e2e-helpers): recordPrViewed takes tabId; add getPageTabId with init-race guard"
```

---

### Task 15: Update the eight mocked-mode submit specs

**Files (all eight — verified via `grep -l recordPrViewed frontend/e2e/`):**
- Modify: `frontend/e2e/s5-marker-prefix-collision.spec.ts`
- Modify: `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts`
- Modify: `frontend/e2e/s5-submit-closed-merged-discard.spec.ts`
- Modify: `frontend/e2e/s5-submit-foreign-pending-review.spec.ts`
- Modify: `frontend/e2e/s5-submit-happy-path.spec.ts`
- Modify: `frontend/e2e/s5-submit-lost-response-adoption.spec.ts`
- Modify: `frontend/e2e/s5-submit-retry-from-each-step.spec.ts`
- Modify: `frontend/e2e/s5-submit-stale-commit-oid.spec.ts`

- [ ] **Step 1: Audit call counts per spec**

```
git -C D:/src/prism-cross-tab-stamp grep -c "recordPrViewed" frontend/e2e/s5-*.spec.ts
```

Expected: most specs 1-2 calls; `s5-submit-foreign-pending-review.spec.ts` has 3.

- [ ] **Step 2: For each spec, add `getPageTabId(page)` before each `recordPrViewed` call**

Standard pattern (single-tab spec):

```ts
const tabId = await getPageTabId(page);
await recordPrViewed(page.request, prRef, tabId);
```

Multi-tab spec (`s5-multi-tab-simultaneous-submit.spec.ts` and the 3-call `foreign-pending-review` spec) — each `recordPrViewed` call uses the same-page tab id if it's from the same page, or different tab ids if explicitly multi-page:

```ts
const tabIdA = await getPageTabId(pageA);
await recordPrViewed(pageA.request, prRef, tabIdA);
// ...
const tabIdB = await getPageTabId(pageB);
await recordPrViewed(pageB.request, prRef, tabIdB);
```

- [ ] **Step 3: Run the mocked-mode Playwright suite**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run test:e2e -- --grep "@mock"
```

(Confirm the tag in `playwright.config.ts`; if the project structure uses `--project mocked` or similar, use that instead.)

Expected: PASS.

- [ ] **Step 4: Commit**

```
git -C D:/src/prism-cross-tab-stamp add frontend/e2e/
git -C D:/src/prism-cross-tab-stamp commit -m "test(e2e): plumb page tab id into recordPrViewed across 8 mocked submit specs"
```

---

## Phase 8 — Project standards updates

### Task 16: Amend `docs/spec/02-architecture.md`

**Files:**
- Modify: `docs/spec/02-architecture.md`

- [ ] **Step 1: Locate the relevant sections**

```
git -C D:/src/prism-cross-tab-stamp grep -n -E "(ReviewSessionState|LastViewedHeadSha|Multi-tab consistency)" docs/spec/02-architecture.md
```

- [ ] **Step 2: Add the two amendments**

For the `ReviewSessionState` shape section:

> *Post-V6: `LastViewedHeadSha` is per-tab via `TabStamps: IReadOnlyDictionary<string, TabStamp>`, keyed by `X-PRism-Tab-Id`. `LastSeenCommentId` stays session-flat as a monotone high-water — mark-viewed applies a `MonotonicMaxCommentId` guard at the write site; markAllRead's value is read server-side from `IActivePrCache.HighestIssueCommentId` and is monotone by construction.*

For the `Multi-tab consistency` section (or add as a new sub-section):

> *One field on `ReviewSessionState` is per-tab as a deliberate exception to the otherwise eventual-consistency-via-polling model: `TabStamps.HeadSha`. The exception is justified by the submit-gate's correctness need (each tab must be gated by its own viewing). All other session fields remain session-flat with `StateChanged`-broadcast convergence. See `docs/specs/2026-05-18-cross-tab-stamp-poisoning-design.md` for the V6 details.*

- [ ] **Step 3: Commit**

```
git -C D:/src/prism-cross-tab-stamp add docs/spec/02-architecture.md
git -C D:/src/prism-cross-tab-stamp commit -m "docs(architecture): note V6 per-tab TabStamps + session-flat LastSeenCommentId"
```

---

## Phase 9 — Pre-push

### Task 17: Run the full pre-push checklist

Per `.ai/docs/development-process.md` + memory: every push runs the full checklist.

- [ ] **Step 1: BE build**

```
dotnet build PRism.sln
```

Expected: 0 errors, 0 warnings in changed files. Timeout ≥ 300000ms.

- [ ] **Step 2: BE tests**

```
dotnet test PRism.sln
```

Expected: all PASS. Timeout ≥ 300000ms.

- [ ] **Step 3: FE lint (gates CI per memory — Prettier `--check` is included)**

```
cd D:/src/prism-cross-tab-stamp/frontend && npm run lint
```

Expected: PASS. If Prettier fails, run `npm run prettier -- --write <files>` on the new files before re-running lint.

- [ ] **Step 4: FE build**

```
npm run build
```

Expected: PASS.

- [ ] **Step 5: FE Vitest**

```
npm run test
```

Expected: all PASS.

- [ ] **Step 6: Mocked-mode Playwright**

```
npm run test:e2e -- --grep "@mock"
```

Expected: PASS.

- [ ] **Step 7: Real-flow Playwright**

```
npm run test:e2e:real
```

Expected: 3 PASS, 1 SKIP (per PR #58 baseline). Requires `prpande/prism-sandbox` access.

- [ ] **Step 8: Manual migration smoke**

Copy a V5 `state.json` into a fresh data dir, run PRism, verify:
- post-migration file has `tab-stamps: {}` on every session
- no `last-viewed-head-sha` keys remain
- `last-seen-comment-id` values are preserved

---

## Phase 10 — PR

### Task 18: Hand off to `pr-autopilot`

After Phase 9 is green, invoke `pr-autopilot`:
- Pushes `feat/cross-tab-stamp` to origin
- Opens the PR with spec + plan + deferrals + implementation diff
- Drives the reviewer-bot comment loop to quiescence
- Final CI gate

Do not push manually. Let autopilot own the push + PR-open + comment-loop sequence.
