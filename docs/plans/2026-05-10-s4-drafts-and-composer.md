# S4 Drafts + Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship S4 — drafts persistence end-to-end (save drafts on a PR; quit and relaunch; drafts survive; classification fires correctly when a teammate pushes).

**Architecture:** Layer-up ordering across 7 PRs. PR1 lands the AppState wrap rename + migration framework + v2→v3 step + consumer-site updates (pure refactor + framework, all existing tests stay green). PR2 lands the `DraftReconciliationPipeline` in `PRism.Core/Reconciliation/Pipeline/` with no consumers yet. PR3 lands `PUT/GET /api/pr/{ref}/draft` + `POST /api/pr/{ref}/reload` + bus events + SSE wiring + the spec/02 documentation update. PR4–PR7 land the frontend in cohesive chunks (composer + draft client; reply + PR-root + Mark all read; Drafts tab + reconciliation panel; multi-tab consistency + cross-tab presence). Submit Review button stays disabled — that's S5.

**Tech Stack:** .NET 10 + ASP.NET Core minimal APIs + xUnit + WebApplicationFactory; React 18 + Vite + TypeScript + Vitest + Testing Library + Playwright; SSE via `Microsoft.AspNetCore.Http.IResultExtensions`; `BroadcastChannel` API for cross-tab presence; `react-markdown` v9 with strict `urlTransform` allowlist.

**Spec:** `docs/specs/2026-05-09-s4-drafts-and-composer-design.md` is the authoritative reference. Every task here cites the relevant spec section.

---

## How to use this plan

- **Phases = PRs.** Each phase produces a single reviewable PR. Land them in order.
- **Tasks within a phase share commits where natural** — the commit step at the end of each task names the conventional-commit message.
- **Every test is written red first.** Run the test, see it fail with the expected error, then write the minimal implementation.
- **Use the worktree at `.claude/worktrees/docs-s4-spec`.** Do NOT make changes on `main`.

---

# Phase 1 — PR1: AppState wrap + migration framework + V2→V3

**PR title:** `feat(s4-pr1): AppState wrap + migration framework + v2→v3 draft fields`

**Spec sections:** § 2.1 (wrap rename), § 2.2 (migration framework), § 2.3 (V2→V3 step), § 2.4 (schema additions), § 2.5 (tests + scope).

**Files touched (~11):**
- Create: `PRism.Core/State/PrSessionsState.cs`
- Create: `PRism.Core/State/Migrations/Migrations.cs`
- Create: `PRism.Core/State/Migrations/PrSessionsMigrations.cs`
- Modify: `PRism.Core/State/AppState.cs` (rename `ReviewSessions` → `Reviews`; new `IsOverriddenStale`)
- Modify: `PRism.Core/State/AppStateStore.cs` (extract migration framework; bump `CurrentVersion` to 3)
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (key normalization to slash form; consume `state.Reviews.Sessions`)
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs` (~6 sites consume `state.Reviews.Sessions`)
- Create: `tests/PRism.Core.Tests/State/MigrationStepTests.cs`
- Create: `tests/PRism.Core.Tests/State/MigrationChainTests.cs`
- Create: `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`
- Modify: `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs`, `AppStateStoreTests.cs`, `AppStateStoreMigrationTests.cs`
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`

---

### Task 1: Add `PrSessionsState` record

**Files:**
- Create: `PRism.Core/State/PrSessionsState.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/State/PrSessionsStateTests.cs`:

```csharp
using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class PrSessionsStateTests
{
    [Fact]
    public void Empty_HasZeroSessions()
    {
        Assert.Empty(PrSessionsState.Empty.Sessions);
    }

    [Fact]
    public void Constructor_HoldsProvidedDictionary()
    {
        var sessions = new Dictionary<string, ReviewSessionState>
        {
            ["acme/api/123"] = new ReviewSessionState(
                LastViewedHeadSha: "abc",
                LastSeenCommentId: null,
                PendingReviewId: null,
                PendingReviewCommitOid: null,
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: new List<DraftComment>(),
                DraftReplies: new List<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft)
        };

        var state = new PrSessionsState(sessions);

        Assert.Single(state.Sessions);
        Assert.True(state.Sessions.ContainsKey("acme/api/123"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PrSessionsStateTests"`
Expected: FAIL with build errors — `PrSessionsState`, `DraftComment`, `DraftReply`, `DraftVerdictStatus` don't exist yet.

- [ ] **Step 3: Create `PrSessionsState.cs`**

```csharp
namespace PRism.Core.State;

public sealed record PrSessionsState(
    IReadOnlyDictionary<string, ReviewSessionState> Sessions)
{
    public static PrSessionsState Empty { get; } =
        new(new Dictionary<string, ReviewSessionState>());
}
```

(The test will still fail to compile because `ReviewSessionState` hasn't been extended with the new fields yet — Task 2 fixes that.)

- [ ] **Step 4: Commit pre-snapshot (red on Tasks 1+2 fixed together)**

Hold the commit; both tests + AppState changes go together in Task 2's commit. Tests will be runnable after Task 2.

---

### Task 2: Extend `ReviewSessionState` with v3 fields and add new draft records

**Files:**
- Modify: `PRism.Core/State/AppState.cs`

- [ ] **Step 1: Add new draft records and enums to `AppState.cs`**

Append to `PRism.Core/State/AppState.cs`:

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
    bool IsOverriddenStale);

public sealed record DraftReply(
    string Id,
    string ParentThreadId,
    string? ReplyCommentId,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

public enum DraftVerdict { Approve, RequestChanges, Comment }
public enum DraftVerdictStatus { Draft, NeedsReconfirm }
public enum DraftStatus { Draft, Moved, Stale }
```

- [ ] **Step 2: Extend `ReviewSessionState` with v3 fields**

Replace the existing `ReviewSessionState` declaration:

```csharp
public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    string? DraftSummaryMarkdown,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);
```

- [ ] **Step 3: Run `PrSessionsStateTests` to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~PrSessionsStateTests"`
Expected: PASS (2 tests).

- [ ] **Step 4: Commit**

```bash
git add PRism.Core/State/AppState.cs PRism.Core/State/PrSessionsState.cs tests/PRism.Core.Tests/State/PrSessionsStateTests.cs
git commit -m "feat(s4-pr1): add PrSessionsState wrap + v3 draft fields on ReviewSessionState"
```

---

### Task 3: Update `AppState` to wrap `Reviews: PrSessionsState`

**Files:**
- Modify: `PRism.Core/State/AppState.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`:

```csharp
using System.Text.Json;
using PRism.Core.Json;
using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class AppStateRoundTripTests
{
    [Fact]
    public void Default_HasEmptyReviews()
    {
        Assert.Empty(AppState.Default.Reviews.Sessions);
    }

    [Fact]
    public void SerializeAndDeserialize_PreservesShape()
    {
        var session = new ReviewSessionState(
            LastViewedHeadSha: "abc",
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var state = AppState.Default with
        {
            Reviews = new PrSessionsState(new Dictionary<string, ReviewSessionState>
            {
                ["acme/api/123"] = session
            })
        };

        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);
        var roundTripped = JsonSerializer.Deserialize<AppState>(json, JsonSerializerOptionsFactory.Storage);

        Assert.NotNull(roundTripped);
        Assert.Single(roundTripped!.Reviews.Sessions);
        Assert.Equal("abc", roundTripped.Reviews.Sessions["acme/api/123"].LastViewedHeadSha);
    }

    [Fact]
    public void JsonShape_TopLevelKey_IsReviewsNotReviewSessions()
    {
        var state = AppState.Default;

        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);

        Assert.Contains("\"reviews\":", json);
        Assert.DoesNotContain("\"review-sessions\":", json);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AppStateRoundTripTests"`
Expected: FAIL — `AppState` still has `ReviewSessions`, no `Reviews` property.

- [ ] **Step 3: Update `AppState` declaration in `AppState.cs`**

Replace the `AppState` record:

```csharp
public sealed record AppState(
    int Version,
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost,
    UiPreferences UiPreferences)
{
    public static AppState Default { get; } = new(
        Version: 3,
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null,
        UiPreferences: UiPreferences.Default);
}
```

- [ ] **Step 4: Run round-trip test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~AppStateRoundTripTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run full PRism.Core.Tests suite — expect failures from existing consumer tests**

Run: `dotnet test tests/PRism.Core.Tests`
Expected: build errors / test failures referring to `state.ReviewSessions` (in other test files). Tasks 4-8 fix those.

Do NOT commit yet — the suite is red.

---

### Task 4: Update `InboxRefreshOrchestrator` to use `state.Reviews.Sessions` + slash key

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`

- [ ] **Step 1: Locate the existing call site**

Run: `grep -n "ReviewSessions\|review-sessions\|sessionKey" PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
Expected: see line ~239 with `var sessionKey = $"{r.Reference.Owner}/{r.Reference.Repo}#{r.Reference.Number}";` and line ~242 with `state.ReviewSessions.TryGetValue(sessionKey, ...)`.

- [ ] **Step 2: Write the failing test for slash-form key**

Add to `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`:

```csharp
[Fact]
public async Task EnrichesPrItem_UsingSlashSeparatedSessionKey()
{
    var state = AppState.Default with
    {
        Reviews = new PrSessionsState(new Dictionary<string, ReviewSessionState>
        {
            ["acme/api/123"] = new ReviewSessionState(
                LastViewedHeadSha: "abc",
                LastSeenCommentId: "100",
                PendingReviewId: null,
                PendingReviewCommitOid: null,
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: new List<DraftComment>(),
                DraftReplies: new List<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft)
        })
    };
    // ... (existing test scaffolding to feed state into the orchestrator and assert it reads
    // unread bookkeeping; assert the slash-form key is the one consulted, not the # form)
}
```

(Adapt this to whatever existing scaffolding the file has for InboxRefreshOrchestrator tests — the key assertion is "slash form is the one used to look up sessions.")

- [ ] **Step 3: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxRefreshOrchestrator"`
Expected: FAIL — orchestrator still uses `#` separator.

- [ ] **Step 4: Update `InboxRefreshOrchestrator.cs`**

Replace `var sessionKey = $"{r.Reference.Owner}/{r.Reference.Repo}#{r.Reference.Number}";` with:

```csharp
var sessionKey = r.Reference.ToString();   // canonical slash form, matches PrReference.ToString()
```

Replace `state.ReviewSessions.TryGetValue(sessionKey, ...)` with `state.Reviews.Sessions.TryGetValue(sessionKey, ...)`.

- [ ] **Step 5: Run InboxRefreshOrchestrator tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxRefreshOrchestrator"`
Expected: PASS.

- [ ] **Step 6: Hold commit until Task 5 done (consumer updates land together)**

---

### Task 5: Update `PrDetailEndpoints` consumer sites

**Files:**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs`

- [ ] **Step 1: Locate all consumer sites**

Run: `grep -n "ReviewSessions" PRism.Web/Endpoints/PrDetailEndpoints.cs`
Expected: 6 hits at approximately lines 104, 109, 111, 117, 162, 168, 186, 188 (existing code uses both reads and `state with { ReviewSessions = ... }` writes).

- [ ] **Step 2: For each site, rewrite to `Reviews.Sessions`**

Reads — replace:
```csharp
state.ReviewSessions.TryGetValue(key, out var session)
```
with:
```csharp
state.Reviews.Sessions.TryGetValue(key, out var session)
```

Writes — replace:
```csharp
state with { ReviewSessions = sessions }
```
with:
```csharp
state with { Reviews = state.Reviews with { Sessions = sessions } }
```

(There may be other patterns; mechanically rewrite each one. The compile error tells you which lines need attention.)

- [ ] **Step 3: Run `PRism.Web.Tests` to verify no regressions**

Run: `dotnet test tests/PRism.Web.Tests`
Expected: existing PrDetailEndpoints tests may need fixture updates (Task 6 handles them). The build must succeed first.

- [ ] **Step 4: Hold commit**

---

### Task 6: Update test fixtures across the consumer tests

**Files:**
- Modify: `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs`
- Modify: `tests/PRism.Core.Tests/State/AppStateStoreTests.cs`
- Modify: `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`

- [ ] **Step 1: Sweep tests for `ReviewSessions:` constructor arguments**

Run: `grep -rn "ReviewSessions:\|ReviewSessions =" tests/`
Expected: ~5 sites that hand-construct `AppState` with `ReviewSessions: new Dictionary<...>()`.

- [ ] **Step 2: Rewrite each fixture site**

Replace:
```csharp
new AppState(
    Version: 2,
    ReviewSessions: new Dictionary<string, ReviewSessionState>(),
    ...
)
```
with:
```csharp
new AppState(
    Version: 3,
    Reviews: new PrSessionsState(new Dictionary<string, ReviewSessionState>()),
    ...
)
```

For sites that pass a populated dict, wrap in `new PrSessionsState(...)` and update `Version: 3`.

For sites that do `state with { ReviewSessions = ... }`, rewrite to `state with { Reviews = state.Reviews with { Sessions = ... } }`.

For sites that hand-construct `ReviewSessionState`, add the new positional arguments:
```csharp
new ReviewSessionState(
    LastViewedHeadSha: ...,
    LastSeenCommentId: ...,
    PendingReviewId: null,
    PendingReviewCommitOid: null,
    ViewedFiles: new Dictionary<string, string>(),
    DraftComments: new List<DraftComment>(),
    DraftReplies: new List<DraftReply>(),
    DraftSummaryMarkdown: null,
    DraftVerdict: null,
    DraftVerdictStatus: DraftVerdictStatus.Draft)
```

- [ ] **Step 3: Run all PRism.Core.Tests + PRism.Web.Tests**

Run: `dotnet test tests/PRism.Core.Tests tests/PRism.Web.Tests`
Expected: Build succeeds; some migration-specific tests may still fail (Tasks 7+8 introduce the v3 migration that those tests will exercise).

- [ ] **Step 4: Commit Tasks 4 + 5 + 6 together**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs PRism.Web/Endpoints/PrDetailEndpoints.cs tests/PRism.Core.Tests tests/PRism.Web.Tests
git commit -m "refactor(s4-pr1): consume state.Reviews.Sessions across consumer sites + canonical slash key"
```

---

### Task 7: Add migration framework + V1→V2 helper extraction

**Files:**
- Create: `PRism.Core/State/Migrations/Migrations.cs`
- Create: `PRism.Core/State/Migrations/PrSessionsMigrations.cs`
- Modify: `PRism.Core/State/AppStateStore.cs`

- [ ] **Step 1: Write the failing chain test**

Create `tests/PRism.Core.Tests/State/MigrationChainTests.cs`:

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.State;

namespace PRism.Core.Tests.State;

public class MigrationChainTests
{
    [Fact]
    public async Task LoadsV1File_AppliesV1ToV2_ThenV2ToV3_ResultIsV3()
    {
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var v1Json = """
            {
              "version": 1,
              "review-sessions": {
                "acme/api/123": {
                  "last-viewed-head-sha": "abc",
                  "last-seen-comment-id": "100"
                }
              },
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            File.WriteAllText(Path.Combine(dir, "state.json"), v1Json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.Equal(3, loaded.Version);
            Assert.True(loaded.Reviews.Sessions.ContainsKey("acme/api/123"));
            var session = loaded.Reviews.Sessions["acme/api/123"];
            Assert.Empty(session.DraftComments);
            Assert.Empty(session.DraftReplies);
            Assert.Null(session.DraftSummaryMarkdown);
            Assert.Equal(DraftVerdictStatus.Draft, session.DraftVerdictStatus);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task LoadsV3File_AppliesNothing_ResultUnchanged()
    {
        var temp = Path.GetTempPath();
        var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
        try
        {
            var v3Json = """
            {
              "version": 3,
              "reviews": { "sessions": {} },
              "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
              "last-configured-github-host": null,
              "ui-preferences": { "diff-mode": "side-by-side" }
            }
            """;
            File.WriteAllText(Path.Combine(dir, "state.json"), v3Json);

            var store = new AppStateStore(dir);
            var loaded = await store.LoadAsync(CancellationToken.None);

            Assert.Equal(3, loaded.Version);
            Assert.Empty(loaded.Reviews.Sessions);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MigrationChainTests"`
Expected: FAIL — `CurrentVersion` is still 2; v1 file migrates only to v2.

- [ ] **Step 3: Create `Migrations.cs`**

```csharp
using System.Text.Json.Nodes;

namespace PRism.Core.State.Migrations;

internal static class Migrations
{
    public static JsonObject MigrateV1ToV2(JsonObject root)
    {
        var sessionsNode = root["review-sessions"];
        if (sessionsNode is not null)
        {
            if (sessionsNode is not JsonObject sessions)
                throw new System.Text.Json.JsonException(
                    "state.json 'review-sessions' must be a JSON object");

            foreach (var sessionEntry in sessions)
            {
                if (sessionEntry.Value is JsonObject obj && obj["viewed-files"] is null)
                    obj["viewed-files"] = new JsonObject();
            }
        }
        root["version"] = 2;
        return root;
    }

    public static JsonObject MigrateV2ToV3(JsonObject root)
    {
        PrSessionsMigrations.RenameReviewSessionsToReviews(root);
        PrSessionsMigrations.AddV3DraftCollections(root);
        root["version"] = 3;
        return root;
    }
}
```

- [ ] **Step 4: Create `PrSessionsMigrations.cs`**

```csharp
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PRism.Core.State.Migrations;

internal static class PrSessionsMigrations
{
    public static void RenameReviewSessionsToReviews(JsonObject root)
    {
        // Idempotent: skip if already renamed (half-migrated v3 file from a crashed write).
        if (root["reviews"] is not null) return;

        var sessionsNode = root["review-sessions"];
        if (sessionsNode is null)
        {
            // Materialize an empty wrap so the deserializer doesn't choke on a missing field.
            root["reviews"] = new JsonObject { ["sessions"] = new JsonObject() };
            return;
        }

        if (sessionsNode is not JsonObject sessionsObj)
            throw new JsonException("state.json 'review-sessions' must be a JSON object");

        // Detach so we can re-attach under the new parent.
        root.Remove("review-sessions");
        root["reviews"] = new JsonObject { ["sessions"] = sessionsObj };
    }

    public static void AddV3DraftCollections(JsonObject root)
    {
        var sessions = root["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) return;

        foreach (var entry in sessions)
        {
            if (entry.Value is not JsonObject sessionObj) continue;

            if (sessionObj["draft-comments"] is null)
                sessionObj["draft-comments"] = new JsonArray();
            else if (sessionObj["draft-comments"] is not JsonArray)
                throw new JsonException(
                    $"state.json reviews.sessions['{entry.Key}'].draft-comments must be a JSON array");

            if (sessionObj["draft-replies"] is null)
                sessionObj["draft-replies"] = new JsonArray();
            else if (sessionObj["draft-replies"] is not JsonArray)
                throw new JsonException(
                    $"state.json reviews.sessions['{entry.Key}'].draft-replies must be a JSON array");

            if (sessionObj["draft-summary-markdown"] is null)
                sessionObj["draft-summary-markdown"] = JsonValue.Create((string?)null);

            if (sessionObj["draft-verdict"] is null)
                sessionObj["draft-verdict"] = JsonValue.Create((string?)null);

            if (sessionObj["draft-verdict-status"] is null)
                sessionObj["draft-verdict-status"] = "draft";

            // Inbox key normalization: rewrite any '#'-separated keys to '/' canonical form
            // (handled at the dictionary level — done in Step 5).
        }

        NormalizeSessionKeysToSlashForm(sessions);
    }

    private static void NormalizeSessionKeysToSlashForm(JsonObject sessions)
    {
        // Two-pass: collect all '#' keys, then rewrite. Avoids modifying the dict while iterating.
        var hashKeys = new List<string>();
        foreach (var entry in sessions)
        {
            if (entry.Key.Contains('#')) hashKeys.Add(entry.Key);
        }

        foreach (var hashKey in hashKeys)
        {
            var slashKey = hashKey.Replace('#', '/');
            // Collision policy: slash-form wins; drop the # entry (its bookkeeping will be
            // repopulated on the next inbox poll).
            if (sessions.ContainsKey(slashKey))
            {
                sessions.Remove(hashKey);
                continue;
            }

            var value = sessions[hashKey];
            sessions.Remove(hashKey);
            sessions[slashKey] = value?.DeepClone();
        }
    }
}
```

- [ ] **Step 5: Modify `AppStateStore.cs` to use the migration framework**

Replace the `MigrateIfNeeded` method body and the inline `MigrateV1ToV2` method:

```csharp
private const int CurrentVersion = 3;

private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] Steps =
{
    (2, Migrations.Migrations.MigrateV1ToV2),
    (3, Migrations.Migrations.MigrateV2ToV3),
};

private JsonNode MigrateIfNeeded(JsonNode root)
{
    if (root is not JsonObject obj)
        throw new JsonException("state.json root must be a JSON object");

    var versionNode = obj["version"];
    if (versionNode is null)
        throw new UnsupportedStateVersionException(0);

    int stored;
    try
    {
        stored = versionNode.GetValue<int>();
    }
    catch (Exception ex) when (ex is InvalidOperationException or FormatException or OverflowException)
    {
        throw new JsonException("state.json `version` field is not an integer", ex);
    }

    if (stored > CurrentVersion)
    {
        IsReadOnlyMode = true;
        EnsureCurrentShape(obj);
        return obj;
    }

    if (stored < 1)
        throw new JsonException($"state.json has unsupported version {stored}");

    foreach (var (toVersion, transform) in Steps)
    {
        if (toVersion > stored && toVersion <= CurrentVersion)
            obj = transform(obj);
    }

    EnsureCurrentShape(obj);
    IsReadOnlyMode = false;
    return obj;
}

// Renamed from EnsureV2Shape — same job, current name reflects its scope.
private static void EnsureCurrentShape(JsonObject root)
{
    if (root["ui-preferences"] is null)
        root["ui-preferences"] = new JsonObject { ["diff-mode"] = "side-by-side" };
    if (root["reviews"] is null)
        root["reviews"] = new JsonObject { ["sessions"] = new JsonObject() };
}
```

Delete the old `MigrateV1ToV2` private method on `AppStateStore` (it now lives in `Migrations.cs`).

- [ ] **Step 6: Run the chain test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MigrationChainTests"`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full PRism.Core.Tests suite**

Run: `dotnet test tests/PRism.Core.Tests`
Expected: PASS (existing migration tests still pass because v1→v2 behavior is preserved).

- [ ] **Step 8: Commit**

```bash
git add PRism.Core/State/Migrations/Migrations.cs PRism.Core/State/Migrations/PrSessionsMigrations.cs PRism.Core/State/AppStateStore.cs tests/PRism.Core.Tests/State/MigrationChainTests.cs
git commit -m "feat(s4-pr1): migration framework + v2→v3 step + slash-key normalization"
```

---

### Task 8: Add per-step migration tests

**Files:**
- Create: `tests/PRism.Core.Tests/State/MigrationStepTests.cs`

- [ ] **Step 1: Write the per-step tests**

```csharp
using System.Text.Json.Nodes;
using PRism.Core.State.Migrations;

namespace PRism.Core.Tests.State;

public class MigrationStepTests
{
    [Fact]
    public void MigrateV1ToV2_AddsViewedFilesToEachSession()
    {
        var root = JsonNode.Parse("""
        {
          "version": 1,
          "review-sessions": {
            "acme/api/123": { "last-viewed-head-sha": "abc" }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV1ToV2(root);

        Assert.Equal(2, result["version"]!.GetValue<int>());
        var session = result["review-sessions"]!["acme/api/123"]!.AsObject();
        Assert.NotNull(session["viewed-files"]);
        Assert.IsType<JsonObject>(session["viewed-files"]);
    }

    [Fact]
    public void MigrateV2ToV3_RenamesReviewSessionsToReviewsSessions()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV2ToV3(root);

        Assert.Equal(3, result["version"]!.GetValue<int>());
        Assert.Null(result["review-sessions"]);
        Assert.NotNull(result["reviews"]);
        Assert.NotNull(result["reviews"]!["sessions"]);
        Assert.NotNull(result["reviews"]!["sessions"]!["acme/api/123"]);
    }

    [Fact]
    public void MigrateV2ToV3_BackfillsDraftFieldsPerSession()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV2ToV3(root);

        var session = result["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
        Assert.IsType<JsonArray>(session["draft-comments"]);
        Assert.IsType<JsonArray>(session["draft-replies"]);
        Assert.Null(session["draft-summary-markdown"]?.GetValue<string?>());
        Assert.Null(session["draft-verdict"]?.GetValue<string?>());
        Assert.Equal("draft", session["draft-verdict-status"]!.GetValue<string>());
    }

    [Fact]
    public void MigrateV2ToV3_NormalizesHashKeyToSlashForm()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api#123": { "viewed-files": {} }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV2ToV3(root);

        var sessions = result["reviews"]!["sessions"]!.AsObject();
        Assert.True(sessions.ContainsKey("acme/api/123"));
        Assert.False(sessions.ContainsKey("acme/api#123"));
    }

    [Fact]
    public void MigrateV2ToV3_HashKeyCollidesWithSlashKey_SlashFormWins()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "review-sessions": {
            "acme/api/123": { "viewed-files": {}, "marker": "slash" },
            "acme/api#123": { "viewed-files": {}, "marker": "hash" }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV2ToV3(root);

        var sessions = result["reviews"]!["sessions"]!.AsObject();
        Assert.Single(sessions);
        Assert.Equal("slash", sessions["acme/api/123"]!["marker"]!.GetValue<string>());
    }

    [Fact]
    public void MigrateV2ToV3_HalfMigratedV3File_SkipsRenameRunsBackfillOnly()
    {
        var root = JsonNode.Parse("""
        {
          "version": 2,
          "reviews": {
            "sessions": {
              "acme/api/123": { "viewed-files": {} }
            }
          }
        }
        """)!.AsObject();

        var result = Migrations.MigrateV2ToV3(root);

        var session = result["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
        Assert.IsType<JsonArray>(session["draft-comments"]);
    }
}
```

- [ ] **Step 2: Run to verify all pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MigrationStepTests"`
Expected: PASS (6 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Core.Tests/State/MigrationStepTests.cs
git commit -m "test(s4-pr1): per-step migration tests + key-normalization edge cases"
```

---

### Task 9: Verify forward-compat and PR1 green; push PR1

- [ ] **Step 1: Run the existing forward-compat test against v3**

Open `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs` (or the equivalent forward-compat test file). Find the test `LoadsV3File_SetsReadOnlyMode_AppliesEnsureCurrentShape` (or similar). If it exists, update its fixture from `version: 3` to `version: 4`. If it doesn't exist, add:

```csharp
[Fact]
public async Task LoadsV4File_SetsReadOnlyMode_AppliesEnsureCurrentShape()
{
    var temp = Path.GetTempPath();
    var dir = Directory.CreateDirectory(Path.Combine(temp, $"prism-test-{Guid.NewGuid():N}")).FullName;
    try
    {
        var v4Json = """
        {
          "version": 4,
          "reviews": { "sessions": {} },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": null
        }
        """;
        File.WriteAllText(Path.Combine(dir, "state.json"), v4Json);

        var store = new AppStateStore(dir);
        var loaded = await store.LoadAsync(CancellationToken.None);

        Assert.True(store.IsReadOnlyMode);
        Assert.Equal(4, loaded.Version);
    }
    finally { Directory.Delete(dir, recursive: true); }
}
```

- [ ] **Step 2: Run the full test sweep**

Run: `dotnet test`
Expected: ALL PASS (PRism.Core.Tests, PRism.Web.Tests, PRism.GitHub.Tests).

- [ ] **Step 3: Commit + push**

```bash
git add tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs
git commit -m "test(s4-pr1): forward-compat test bumped to v4"
git push origin docs/s4-drafts-and-composer-spec
```

(Note: PR1 lands as a sub-PR of the spec branch; in practice you may want a fresh branch off `main` named `feat/s4-pr1-state-wrap` for review separation. Decide at PR-creation time.)

---

# Phase 2 — PR2: Reconciliation pipeline

**PR title:** `feat(s4-pr2): DraftReconciliationPipeline + matrix tests + override semantics`

**Spec sections:** § 3.1 (layout), § 3.2 (result shape), § 3.4 (tests), § 5.5 (override propagation).

**Files touched:**
- Create: `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/IFileContentSource.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/ReviewServiceFileContentSource.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/FileResolution.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/LineMatching.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/Classifier.cs`
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/ForcePushFallback.cs`
- Create: `PRism.Core/Reconciliation/WhitespaceInsignificantExtensions.cs`
- Create: `PRism.Core/Reconciliation/ReconciliationDtos.cs`
- Modify: `PRism.Core/IReviewService.cs` (add `GetCommitAsync` if absent)
- Create: `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/BoundaryPermutationTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/OverrideStaleTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/{ForcePushFallback,Whitespace,Rename,Delete,Reply,VerdictReconfirm}Tests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/Fakes/FakeFileContentSource.cs`

---

### Task 10: Add `IFileContentSource` + reachability probe + fake

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/IFileContentSource.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/Fakes/FakeFileContentSource.cs`

- [ ] **Step 1: Create the interface**

```csharp
namespace PRism.Core.Reconciliation.Pipeline;

public interface IFileContentSource
{
    Task<string?> GetAsync(string filePath, string sha, CancellationToken ct);
    Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct);
}
```

- [ ] **Step 2: Create the fake for tests**

```csharp
using PRism.Core.Reconciliation.Pipeline;

namespace PRism.Core.Tests.Reconciliation.Fakes;

internal sealed class FakeFileContentSource : IFileContentSource
{
    private readonly Dictionary<(string FilePath, string Sha), string> _files;
    private readonly HashSet<string> _reachableShas;

    public FakeFileContentSource(
        Dictionary<(string, string), string>? files = null,
        HashSet<string>? reachableShas = null)
    {
        _files = files ?? new();
        _reachableShas = reachableShas ?? new();
    }

    public Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
        => Task.FromResult(_files.GetValueOrDefault((filePath, sha)));

    public Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
        => Task.FromResult(_reachableShas.Contains(sha));
}
```

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/IFileContentSource.cs tests/PRism.Core.Tests/Reconciliation/Fakes/FakeFileContentSource.cs
git commit -m "feat(s4-pr2): IFileContentSource abstraction + test fake"
```

---

### Task 11: Add `WhitespaceInsignificantExtensions` allowlist + reconciliation DTOs

**Files:**
- Create: `PRism.Core/Reconciliation/WhitespaceInsignificantExtensions.cs`
- Create: `PRism.Core/Reconciliation/ReconciliationDtos.cs`

- [ ] **Step 1: Create the allowlist**

```csharp
namespace PRism.Core.Reconciliation;

internal static class WhitespaceInsignificantExtensions
{
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        ".cs", ".ts", ".tsx", ".js", ".jsx", ".go", ".java", ".rs",
        ".rb", ".cpp", ".h", ".html", ".css", ".json", ".md", ".txt",
        ".sh", ".sql"
    };

    public static bool IsAllowed(string filePath)
    {
        var ext = Path.GetExtension(filePath);
        return !string.IsNullOrEmpty(ext) && Allowed.Contains(ext);
    }
}
```

- [ ] **Step 2: Create the DTOs**

```csharp
using PRism.Core.State;

namespace PRism.Core.Reconciliation;

public sealed record ReconciliationResult(
    IReadOnlyList<ReconciledDraft> Drafts,
    IReadOnlyList<ReconciledReply> Replies,
    VerdictReconcileOutcome VerdictOutcome);

public sealed record ReconciledDraft(
    string Id,
    DraftStatus Status,
    string? ResolvedFilePath,
    int? ResolvedLineNumber,
    string? ResolvedAnchoredSha,
    int AlternateMatchCount,
    StaleReason? StaleReason,
    bool ForcePushFallbackTriggered,
    bool IsOverriddenStale);

public sealed record ReconciledReply(
    string Id,
    DraftStatus Status,
    StaleReason? StaleReason,
    bool IsOverriddenStale);

public enum StaleReason
{
    FileDeleted,
    NoMatch,
    ParentThreadDeleted,
    ForcePushAmbiguous
}

public enum VerdictReconcileOutcome { Unchanged, NeedsReconfirm }
```

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Reconciliation/WhitespaceInsignificantExtensions.cs PRism.Core/Reconciliation/ReconciliationDtos.cs
git commit -m "feat(s4-pr2): whitespace allowlist + reconciliation result DTOs"
```

---

### Task 12: Write seven-row matrix tests (red)

**Files:**
- Create: `tests/PRism.Core.Tests/Reconciliation/MatrixTests.cs`

- [ ] **Step 1: Write the table-driven matrix test**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class MatrixTests
{
    private const string PrRef = "acme/api/123";
    private const string OldSha = "old-sha";
    private const string NewSha = "new-sha";

    public static IEnumerable<object[]> MatrixRows()
    {
        // Row 1: Exact match at original line, no others → Fresh (silent re-anchor)
        yield return new object[]
        {
            "Row1_ExactAtOriginal_NoOthers_Fresh",
            "line A\nline B\nline C\n",   // new file content
            2,                              // original line number
            "line B",                       // anchored line content
            DraftStatus.Draft, 2, 0, (StaleReason?)null
        };

        // Row 2: Exact match at original + N others → Fresh-but-ambiguous
        yield return new object[]
        {
            "Row2_ExactAtOriginal_PlusOthers_FreshAmbiguous",
            "line B\nline B\nline C\n",
            1,
            "line B",
            DraftStatus.Draft, 1, 1, (StaleReason?)null
        };

        // Row 3: Exact elsewhere only (single) → Moved
        yield return new object[]
        {
            "Row3_ExactElsewhere_Single_Moved",
            "line A\nline X\nline B\n",
            2,
            "line B",
            DraftStatus.Moved, 3, 0, (StaleReason?)null
        };

        // Row 4: Multiple exact elsewhere, none at original → Moved-ambiguous (closest wins)
        yield return new object[]
        {
            "Row4_MultipleExactElsewhere_NoneAtOriginal_MovedAmbiguous",
            "line B\nline X\nline B\n",
            2,
            "line B",
            DraftStatus.Moved, 1, 1, (StaleReason?)null   // line 1 closer to original (2) than line 3
        };

        // Row 5: No exact, single whitespace-equivalent → Fresh
        yield return new object[]
        {
            "Row5_NoExact_SingleWhitespaceEquiv_Fresh",
            "line A\n  line B  \nline C\n",
            2,
            "line B",
            DraftStatus.Draft, 2, 0, (StaleReason?)null
        };

        // Row 6: No exact, multiple whitespace-equivalent → Moved-ambiguous (closest wins)
        yield return new object[]
        {
            "Row6_NoExact_MultipleWhitespaceEquiv_MovedAmbiguous",
            "  line B\nline X\nline B  \n",
            2,
            "line B",
            DraftStatus.Moved, 3, 1, (StaleReason?)null
        };

        // Row 7: No match → Stale
        yield return new object[]
        {
            "Row7_NoMatch_Stale",
            "line X\nline Y\nline Z\n",
            2,
            "line B",
            DraftStatus.Stale, (int?)null, 0, (StaleReason?)StaleReason.NoMatch
        };
    }

    [Theory]
    [MemberData(nameof(MatrixRows))]
    public async Task MatrixRow(
        string name,
        string newFileContent,
        int originalLine,
        string anchoredContent,
        DraftStatus expectedStatus,
        int? expectedResolvedLine,
        int expectedAlternates,
        StaleReason? expectedStaleReason)
    {
        var draft = new DraftComment(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: originalLine,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: anchoredContent,
            BodyMarkdown: "comment body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

        var session = SessionWith(draft);

        var fake = new FakeFileContentSource(
            files: new Dictionary<(string, string), string>
            {
                [("src/Foo.cs", NewSha)] = newFileContent
            },
            reachableShas: new HashSet<string> { OldSha, NewSha });

        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var reconciled = Assert.Single(result.Drafts);
        Assert.Equal(expectedStatus, reconciled.Status);
        Assert.Equal(expectedResolvedLine, reconciled.ResolvedLineNumber);
        Assert.Equal(expectedAlternates, reconciled.AlternateMatchCount);
        Assert.Equal(expectedStaleReason, reconciled.StaleReason);
    }

    private static ReviewSessionState SessionWith(params DraftComment[] drafts)
        => new ReviewSessionState(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MatrixTests"`
Expected: FAIL — `DraftReconciliationPipeline` doesn't exist yet.

---

### Task 13: Implement `LineMatching` step

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/LineMatching.cs`

- [ ] **Step 1: Write `LineMatching.cs`**

```csharp
using PRism.Core.Reconciliation;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class LineMatching
{
    public sealed record MatchSet(
        IReadOnlyList<int> ExactAtOriginal,        // 0 or 1
        IReadOnlyList<int> ExactElsewhere,         // 0..N
        IReadOnlyList<int> WhitespaceEquivAll);    // 0..N (excludes exact matches)

    public static MatchSet Compute(string fileContent, int originalLine, string anchoredContent, string filePath)
    {
        var lines = SplitLines(fileContent);
        var exactAtOriginal = new List<int>();
        var exactElsewhere = new List<int>();
        var whitespaceEquiv = new List<int>();

        var allowWhitespaceEquiv = WhitespaceInsignificantExtensions.IsAllowed(filePath);

        for (int i = 0; i < lines.Count; i++)
        {
            int oneBasedLine = i + 1;
            if (lines[i] == anchoredContent)
            {
                if (oneBasedLine == originalLine) exactAtOriginal.Add(oneBasedLine);
                else exactElsewhere.Add(oneBasedLine);
            }
            else if (allowWhitespaceEquiv && WhitespaceEquivalent(lines[i], anchoredContent))
            {
                whitespaceEquiv.Add(oneBasedLine);
            }
        }

        return new MatchSet(exactAtOriginal, exactElsewhere, whitespaceEquiv);
    }

    private static List<string> SplitLines(string content)
    {
        // Strip trailing CR from each line so CRLF↔LF flips don't leak into the comparison.
        return content
            .Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .ToList();
    }

    private static bool WhitespaceEquivalent(string a, string b)
    {
        return Normalize(a) == Normalize(b);
    }

    private static string Normalize(string s)
    {
        // Collapse runs of whitespace (but preserve content order).
        return string.Concat(
            s.Where(c => !char.IsWhiteSpace(c))
        );
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/Steps/LineMatching.cs
git commit -m "feat(s4-pr2): line-matching step (exact + whitespace-equiv with allowlist)"
```

---

### Task 14: Implement `Classifier` step

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/Classifier.cs`

- [ ] **Step 1: Write `Classifier.cs`**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class Classifier
{
    public sealed record ClassifyResult(
        DraftStatus Status,
        int? ResolvedLine,
        int AlternateMatchCount,
        StaleReason? StaleReason);

    public static ClassifyResult Classify(LineMatching.MatchSet matches, int originalLine)
    {
        // Row 1: exact at original, no others
        if (matches.ExactAtOriginal.Count == 1 && matches.ExactElsewhere.Count == 0)
            return new ClassifyResult(DraftStatus.Draft, originalLine, 0, null);

        // Row 2: exact at original + N others
        if (matches.ExactAtOriginal.Count == 1 && matches.ExactElsewhere.Count > 0)
            return new ClassifyResult(DraftStatus.Draft, originalLine, matches.ExactElsewhere.Count, null);

        // Row 3: exact elsewhere only, single
        if (matches.ExactAtOriginal.Count == 0 && matches.ExactElsewhere.Count == 1)
            return new ClassifyResult(DraftStatus.Moved, matches.ExactElsewhere[0], 0, null);

        // Row 4: multiple exact elsewhere, none at original
        if (matches.ExactAtOriginal.Count == 0 && matches.ExactElsewhere.Count > 1)
        {
            var closest = ClosestTo(matches.ExactElsewhere, originalLine);
            return new ClassifyResult(DraftStatus.Moved, closest, matches.ExactElsewhere.Count - 1, null);
        }

        // Row 5: no exact, single whitespace-equivalent
        if (matches.ExactAtOriginal.Count == 0
            && matches.ExactElsewhere.Count == 0
            && matches.WhitespaceEquivAll.Count == 1)
            return new ClassifyResult(DraftStatus.Draft, matches.WhitespaceEquivAll[0], 0, null);

        // Row 6: no exact, multiple whitespace-equivalent
        if (matches.ExactAtOriginal.Count == 0
            && matches.ExactElsewhere.Count == 0
            && matches.WhitespaceEquivAll.Count > 1)
        {
            var closest = ClosestTo(matches.WhitespaceEquivAll, originalLine);
            return new ClassifyResult(DraftStatus.Moved, closest, matches.WhitespaceEquivAll.Count - 1, null);
        }

        // Row 7: no match
        return new ClassifyResult(DraftStatus.Stale, null, 0, StaleReason.NoMatch);
    }

    private static int ClosestTo(IReadOnlyList<int> candidates, int target)
    {
        int best = candidates[0];
        int bestDist = Math.Abs(best - target);
        for (int i = 1; i < candidates.Count; i++)
        {
            int dist = Math.Abs(candidates[i] - target);
            if (dist < bestDist) { best = candidates[i]; bestDist = dist; }
        }
        return best;
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/Steps/Classifier.cs
git commit -m "feat(s4-pr2): seven-row matrix classifier (table-driven)"
```

---

### Task 15: Implement `FileResolution` step

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/FileResolution.cs`

- [ ] **Step 1: Write `FileResolution.cs`**

```csharp
using PRism.Core.Reconciliation;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class FileResolution
{
    public sealed record FileResolveResult(
        bool Resolved,
        string? ResolvedPath,
        StaleReason? StaleReason);

    // For S4 the diff snapshot is read from outside the pipeline; the pipeline accepts
    // a IReadOnlyDictionary<oldPath, newPath> for renamed files and a HashSet<deletedPath>.
    // Caller (POST /reload handler) builds these from the PR's file-changes list.
    public static FileResolveResult Resolve(
        string draftFilePath,
        IReadOnlyDictionary<string, string> renames,
        IReadOnlySet<string> deletedPaths)
    {
        if (deletedPaths.Contains(draftFilePath))
            return new FileResolveResult(false, null, StaleReason.FileDeleted);

        if (renames.TryGetValue(draftFilePath, out var newPath))
            return new FileResolveResult(true, newPath, null);

        return new FileResolveResult(true, draftFilePath, null);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/Steps/FileResolution.cs
git commit -m "feat(s4-pr2): file-resolution step (rename / delete / exists)"
```

---

### Task 16: Implement `ForcePushFallback` step

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/Steps/ForcePushFallback.cs`

- [ ] **Step 1: Write `ForcePushFallback.cs`**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class ForcePushFallback
{
    public sealed record FallbackResult(
        DraftStatus Status,
        int? ResolvedLine,
        StaleReason? StaleReason);

    // Whole-file scan against new content (no original line as tie-breaker).
    public static FallbackResult Apply(string newFileContent, string anchoredContent, string filePath)
    {
        var matches = LineMatching.Compute(newFileContent, originalLine: -1, anchoredContent, filePath);

        // Combine exact + whitespace-equiv (no priority distinction in fallback path; either
        // multi-match → Stale per spec/03 § 5).
        var totalExact = matches.ExactElsewhere.Count;   // ExactAtOriginal is always empty (-1 line)
        var totalWs = matches.WhitespaceEquivAll.Count;

        if (totalExact == 1 && totalWs == 0)
            return new FallbackResult(DraftStatus.Moved, matches.ExactElsewhere[0], null);

        if (totalExact == 0 && totalWs == 1)
            return new FallbackResult(DraftStatus.Moved, matches.WhitespaceEquivAll[0], null);

        if (totalExact == 0 && totalWs == 0)
            return new FallbackResult(DraftStatus.Stale, null, StaleReason.NoMatch);

        // Multi-match (any combination) → Stale per spec/03 § 5
        return new FallbackResult(DraftStatus.Stale, null, StaleReason.ForcePushAmbiguous);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/Steps/ForcePushFallback.cs
git commit -m "feat(s4-pr2): force-push-fallback step (whole-file scan; multi-match → Stale)"
```

---

### Task 17: Implement `DraftReconciliationPipeline` orchestrator

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs`

- [ ] **Step 1: Write the orchestrator**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline.Steps;
using PRism.Core.State;

namespace PRism.Core.Reconciliation.Pipeline;

public sealed class DraftReconciliationPipeline
{
    public async Task<ReconciliationResult> ReconcileAsync(
        ReviewSessionState session,
        string newHeadSha,
        IFileContentSource fileSource,
        CancellationToken ct,
        IReadOnlyDictionary<string, string>? renames = null,
        IReadOnlySet<string>? deletedPaths = null)
    {
        renames ??= new Dictionary<string, string>();
        deletedPaths ??= new HashSet<string>();

        var fileCache = new Dictionary<(string, string), string>();
        var reachabilityCache = new Dictionary<string, bool>();

        var reconciledDrafts = new List<ReconciledDraft>();
        foreach (var draft in session.DraftComments)
        {
            // PR-root drafts have no anchor — pass through as-is.
            if (draft.FilePath is null)
            {
                reconciledDrafts.Add(new ReconciledDraft(
                    Id: draft.Id,
                    Status: draft.Status,
                    ResolvedFilePath: null,
                    ResolvedLineNumber: null,
                    ResolvedAnchoredSha: draft.AnchoredSha,
                    AlternateMatchCount: 0,
                    StaleReason: null,
                    ForcePushFallbackTriggered: false,
                    IsOverriddenStale: draft.IsOverriddenStale));
                continue;
            }

            // Step 1: file resolution
            var fileResult = FileResolution.Resolve(draft.FilePath, renames, deletedPaths);
            if (!fileResult.Resolved)
            {
                reconciledDrafts.Add(MakeStale(draft, fileResult.StaleReason!.Value, forcePush: false));
                continue;
            }

            // Step 2: SHA reachability (probe the original anchored SHA)
            bool reachable = await GetCachedReachable(draft.AnchoredSha!, fileSource, reachabilityCache, ct);

            string? newContent = await GetCachedContent(
                fileResult.ResolvedPath!, newHeadSha, fileSource, fileCache, ct);

            if (newContent is null)
            {
                // File doesn't exist at newHeadSha (deleted at this SHA, even if not in renames map)
                reconciledDrafts.Add(MakeStale(draft, StaleReason.FileDeleted, forcePush: !reachable));
                continue;
            }

            if (!reachable)
            {
                // Force-push fallback path
                var fb = ForcePushFallback.Apply(newContent, draft.AnchoredLineContent!, fileResult.ResolvedPath!);

                // Override gate: if user clicked Keep anyway and we'd classify Stale here, the
                // override doesn't apply (anchor reasoning is broken) — leave as-is.
                reconciledDrafts.Add(new ReconciledDraft(
                    Id: draft.Id,
                    Status: fb.Status,
                    ResolvedFilePath: fb.Status == DraftStatus.Stale ? null : fileResult.ResolvedPath,
                    ResolvedLineNumber: fb.ResolvedLine,
                    ResolvedAnchoredSha: fb.Status == DraftStatus.Stale ? draft.AnchoredSha : newHeadSha,
                    AlternateMatchCount: 0,
                    StaleReason: fb.StaleReason,
                    ForcePushFallbackTriggered: true,
                    IsOverriddenStale: false));   // force-push clears any prior override
                continue;
            }

            // Step 2 (standard path): line matching + classification
            var matches = LineMatching.Compute(newContent, draft.LineNumber!.Value, draft.AnchoredLineContent!, fileResult.ResolvedPath!);
            var cls = Classifier.Classify(matches, draft.LineNumber!.Value);

            // Override propagation: if matrix says Stale AND user has IsOverriddenStale, short-circuit
            // to Draft (anchor remains as the original line; user accepted it).
            DraftStatus finalStatus = cls.Status;
            bool overrideStillSet = false;
            if (cls.Status == DraftStatus.Stale && draft.IsOverriddenStale)
            {
                finalStatus = DraftStatus.Draft;
                overrideStillSet = true;
            }
            // If not Stale, override is no longer needed; clear it.

            reconciledDrafts.Add(new ReconciledDraft(
                Id: draft.Id,
                Status: finalStatus,
                ResolvedFilePath: fileResult.ResolvedPath,
                ResolvedLineNumber: cls.ResolvedLine,
                ResolvedAnchoredSha: newHeadSha,
                AlternateMatchCount: cls.AlternateMatchCount,
                StaleReason: finalStatus == DraftStatus.Stale ? cls.StaleReason : null,
                ForcePushFallbackTriggered: false,
                IsOverriddenStale: overrideStillSet));
        }

        // Replies — PR2 scope: only ParentThreadDeleted detection (caller passes a
        // HashSet<string> of known-existing thread ids). For now, pass-through.
        var reconciledReplies = session.DraftReplies
            .Select(r => new ReconciledReply(r.Id, r.Status, null, r.IsOverriddenStale))
            .ToList();

        // Verdict reconcile: head shifted? mark NeedsReconfirm if verdict was set.
        var verdictOutcome =
            session.DraftVerdict is not null && session.LastViewedHeadSha != newHeadSha
                ? VerdictReconcileOutcome.NeedsReconfirm
                : VerdictReconcileOutcome.Unchanged;

        return new ReconciliationResult(reconciledDrafts, reconciledReplies, verdictOutcome);
    }

    private static ReconciledDraft MakeStale(DraftComment draft, StaleReason reason, bool forcePush)
        => new(
            Id: draft.Id,
            Status: DraftStatus.Stale,
            ResolvedFilePath: null,
            ResolvedLineNumber: null,
            ResolvedAnchoredSha: draft.AnchoredSha,
            AlternateMatchCount: 0,
            StaleReason: reason,
            ForcePushFallbackTriggered: forcePush,
            IsOverriddenStale: false);

    private static async Task<string?> GetCachedContent(
        string filePath, string sha,
        IFileContentSource source,
        Dictionary<(string, string), string> cache,
        CancellationToken ct)
    {
        if (cache.TryGetValue((filePath, sha), out var cached)) return cached;
        var fetched = await source.GetAsync(filePath, sha, ct);
        if (fetched is not null) cache[(filePath, sha)] = fetched;
        return fetched;
    }

    private static async Task<bool> GetCachedReachable(
        string sha,
        IFileContentSource source,
        Dictionary<string, bool> cache,
        CancellationToken ct)
    {
        if (cache.TryGetValue(sha, out var cached)) return cached;
        var reachable = await source.IsCommitReachableAsync(sha, ct);
        cache[sha] = reachable;
        return reachable;
    }
}
```

- [ ] **Step 2: Run matrix tests to verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~MatrixTests"`
Expected: PASS (7 cases).

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs
git commit -m "feat(s4-pr2): DraftReconciliationPipeline orchestrator (file resolution + line match + classify + force-push fallback + override + verdict)"
```

---

### Task 18: Add `BoundaryPermutationTests`

**Files:**
- Create: `tests/PRism.Core.Tests/Reconciliation/BoundaryPermutationTests.cs`

- [ ] **Step 1: Write the boundary tests**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class BoundaryPermutationTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task Row4IntersectRow6_TwoExactPlusFiveWhitespaceEquiv_ExactWins_AlternateCountOne()
    {
        // 2 exact-elsewhere + 5 whitespace-equiv-elsewhere; row 4 wins
        var content = "line B\n  line B  \nline X\nline B\n  line B\nline B  \n  line B  \n  line B  \n";
        var result = await Run(content, originalLine: 5, anchored: "line B");
        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Moved, d.Status);
        Assert.Equal(1, d.AlternateMatchCount);   // counting only exact tier (2 - chosen = 1)
    }

    [Fact]
    public async Task Row2IntersectRow6_ExactAtOriginalPlusOneExactPlusFiveWhitespace_FreshAmbiguousAltCountOne()
    {
        var content = "line X\nline B\nline B\n  line B  \n  line B  \n  line B  \n  line B  \n  line B  \n";
        var result = await Run(content, originalLine: 2, anchored: "line B");
        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal(2, d.ResolvedLineNumber);
        Assert.Equal(1, d.AlternateMatchCount);   // 1 other exact
    }

    [Fact]
    public async Task ForcePushIntersectMultipleWhitespace_Stale()
    {
        var content = "  line B  \n  line B  \n  line B  \n";
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });   // OldSha NOT reachable

        var session = SessionWith(MakeDraft(originalLine: 5, anchored: "line B"));
        var pipeline = new DraftReconciliationPipeline();
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    [Fact]
    public async Task RenameAndContentUnchanged_StandardPathRunsAgainstNewPath()
    {
        var content = "line A\nline B\nline C\n";
        var fake = new FakeFileContentSource(
            files: new() { [("src/NewFoo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });

        var session = SessionWith(MakeDraft(originalLine: 2, anchored: "line B", path: "src/Foo.cs"));
        var pipeline = new DraftReconciliationPipeline();
        var renames = new Dictionary<string, string> { ["src/Foo.cs"] = "src/NewFoo.cs" };
        var result = await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None, renames);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal("src/NewFoo.cs", d.ResolvedFilePath);
    }

    private static async Task<ReconciliationResult> Run(string content, int originalLine, string anchored)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(MakeDraft(originalLine, anchored));
        var pipeline = new DraftReconciliationPipeline();
        return await pipeline.ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static DraftComment MakeDraft(int originalLine, string anchored, string path = "src/Foo.cs")
        => new(
            Id: "d1",
            FilePath: path,
            LineNumber: originalLine,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: anchored,
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: false);

    private static ReviewSessionState SessionWith(params DraftComment[] drafts)
        => new(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 2: Run to verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~BoundaryPermutationTests"`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Core.Tests/Reconciliation/BoundaryPermutationTests.cs
git commit -m "test(s4-pr2): boundary-permutation matrix tests (row intersections + force-push + rename)"
```

---

### Task 19: Add `OverrideStaleTests`

**Files:**
- Create: `tests/PRism.Core.Tests/Reconciliation/OverrideStaleTests.cs`

- [ ] **Step 1: Write override tests**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class OverrideStaleTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task IsOverriddenStaleTrueAndAnchoredShaReachable_ClassifierShortCircuitsToDraft()
    {
        var content = "line X\nline Y\nline Z\n";   // no match
        var draft = MakeDraft(isOverridden: true);
        var result = await RunReachable(content, draft);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);   // override short-circuit
        Assert.True(d.IsOverriddenStale);
    }

    [Fact]
    public async Task IsOverriddenStaleTrueButForcePushFallback_OverrideIgnored_StillStale()
    {
        var content = "  line B  \n  line B  \n";
        var draft = MakeDraft(isOverridden: true);
        var result = await RunUnreachable(content, draft);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
        Assert.False(d.IsOverriddenStale);   // cleared
    }

    [Fact]
    public async Task IsOverriddenStaleTrueButContentNowMatches_OverrideCleared()
    {
        var content = "line A\nline B\nline C\n";   // exact match at line 2
        var draft = MakeDraft(isOverridden: true);
        var result = await RunReachable(content, draft);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.False(d.IsOverriddenStale);   // override no longer needed; cleared
    }

    private static async Task<ReconciliationResult> RunReachable(string content, DraftComment draft)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(draft);
        return await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static async Task<ReconciliationResult> RunUnreachable(string content, DraftComment draft)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });   // OldSha NOT reachable
        var session = SessionWith(draft);
        return await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static DraftComment MakeDraft(bool isOverridden)
        => new(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: isOverridden);

    private static ReviewSessionState SessionWith(params DraftComment[] drafts)
        => new(
            LastViewedHeadSha: OldSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 2: Run to verify pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~OverrideStaleTests"`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.Core.Tests/Reconciliation/OverrideStaleTests.cs
git commit -m "test(s4-pr2): override-stale propagation + force-push override-ignored cases"
```

---

### Task 20: Add edge-case test files (Force-push, Whitespace, Rename, Delete, Reply, Verdict)

**Files:**
- Create: `tests/PRism.Core.Tests/Reconciliation/ForcePushFallbackTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/WhitespaceTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/RenameTests.cs`
- Create: `tests/PRism.Core.Tests/Reconciliation/DeleteTests.cs`
- ~~Create: `tests/PRism.Core.Tests/Reconciliation/ReplyTests.cs`~~ — DEFERRED to PR3 (Task 30 region) where the endpoint passes `existingThreadIds` to the pipeline; PR2's reply tests would be tautological pass-through.
- Create: `tests/PRism.Core.Tests/Reconciliation/VerdictReconfirmTests.cs`

- [ ] **Step 1: Write `ForcePushFallbackTests.cs`**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class ForcePushFallbackTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task SingleExactMatch_Moved_WithFlagSet()
    {
        var fake = MakeFake("line A\nline B\nline C\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Moved, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
        Assert.Equal(2, d.ResolvedLineNumber);
    }

    [Fact]
    public async Task MultipleMatches_Stale()
    {
        var fake = MakeFake("line B\nline B\nline B\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.ForcePushAmbiguous, d.StaleReason);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    [Fact]
    public async Task NoMatch_Stale()
    {
        var fake = MakeFake("line X\nline Y\n");
        var session = SessionWith(MakeDraft());
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.NoMatch, d.StaleReason);
        Assert.True(d.ForcePushFallbackTriggered);
    }

    private static FakeFileContentSource MakeFake(string content) =>
        new(files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });   // OldSha NOT reachable → fallback

    private static DraftComment MakeDraft() => new(
        Id: "d1", FilePath: "src/Foo.cs", LineNumber: 2, Side: "right",
        AnchoredSha: OldSha, AnchoredLineContent: "line B",
        BodyMarkdown: "body", Status: DraftStatus.Draft, IsOverriddenStale: false);

    private static ReviewSessionState SessionWith(params DraftComment[] drafts) => new(
        LastViewedHeadSha: OldSha, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: drafts, DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: null, DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 2: Write `WhitespaceTests.cs`**

```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class WhitespaceTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task CrlfToLfFlip_TreatedAsExact()
    {
        // anchored content has trailing CR; new content has trailing LF only.
        // SplitLines TrimEnd('\r') normalizes both → exact match at original line.
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1", FilePath: "src/Foo.cs", LineNumber: 2, Side: "right",
            AnchoredSha: OldSha, AnchoredLineContent: "line B\r",   // CR-suffixed
            BodyMarkdown: "body", Status: DraftStatus.Draft, IsOverriddenStale: false);

        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        // After TrimEnd('\r') on anchored content, normalized as "line B" → matches at line 2.
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal(2, d.ResolvedLineNumber);
    }

    [Fact]
    public async Task WhitespaceEquivInAllowlistedExt_TreatedAsMatch()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = "line A\n  line B  \nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = MakeDraft(path: "src/Foo.cs", anchored: "line B");
        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);   // single whitespace-equiv → Fresh
    }

    [Fact]
    public async Task WhitespaceEquivInPyExt_NotAllowlisted_FallsBackToExactOnly_Stale()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/foo.py", NewSha)] = "line A\n  line B  \nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = MakeDraft(path: "src/foo.py", anchored: "line B");
        var session = SessionWith(draft);
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        // .py not in allowlist → no whitespace-equiv match → no exact match → Stale
        Assert.Equal(DraftStatus.Stale, d.Status);
    }

    private static DraftComment MakeDraft(string path, string anchored) => new(
        Id: "d1", FilePath: path, LineNumber: 2, Side: "right",
        AnchoredSha: OldSha, AnchoredLineContent: anchored,
        BodyMarkdown: "body", Status: DraftStatus.Draft, IsOverriddenStale: false);

    private static ReviewSessionState SessionWith(params DraftComment[] drafts) => new(
        LastViewedHeadSha: OldSha, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: drafts, DraftReplies: new List<DraftReply>(),
        DraftSummaryMarkdown: null, DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 3: Write `RenameTests.cs`, `DeleteTests.cs`, `ReplyTests.cs`, `VerdictReconfirmTests.cs`**

`RenameTests.cs`:
```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class RenameTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task RenamedFile_DraftFollowsRename()
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/NewFoo.cs", NewSha)] = "line A\nline B\nline C\n" },
            reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1", FilePath: "src/Foo.cs", LineNumber: 2, Side: "right",
            AnchoredSha: OldSha, AnchoredLineContent: "line B",
            BodyMarkdown: "body", Status: DraftStatus.Draft, IsOverriddenStale: false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: OldSha, LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new[] { draft }, DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var renames = new Dictionary<string, string> { ["src/Foo.cs"] = "src/NewFoo.cs" };
        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None, renames);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.Equal("src/NewFoo.cs", d.ResolvedFilePath);
        Assert.Equal(2, d.ResolvedLineNumber);
    }
}
```

`DeleteTests.cs`:
```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class DeleteTests
{
    private const string OldSha = "old", NewSha = "new";

    [Fact]
    public async Task DeletedFile_StaleWithFileDeletedReason()
    {
        var fake = new FakeFileContentSource(
            files: new(), reachableShas: new() { OldSha, NewSha });

        var draft = new DraftComment(
            Id: "d1", FilePath: "src/Foo.cs", LineNumber: 2, Side: "right",
            AnchoredSha: OldSha, AnchoredLineContent: "line B",
            BodyMarkdown: "body", Status: DraftStatus.Draft, IsOverriddenStale: false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: OldSha, LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new[] { draft }, DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var deleted = new HashSet<string> { "src/Foo.cs" };
        var result = await new DraftReconciliationPipeline().ReconcileAsync(
            session, NewSha, fake, CancellationToken.None,
            renames: null, deletedPaths: deleted);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.Equal(StaleReason.FileDeleted, d.StaleReason);
    }
}
```

`ReplyTests.cs`:
```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class ReplyTests
{
    [Fact]
    public async Task Reply_PassesThroughUnchanged_PR2Scope()
    {
        // PR2 scope: replies pass-through. ParentThreadDeleted check is added in PR3
        // when the endpoint passes the existing-comments cache to the pipeline.
        var fake = new FakeFileContentSource(reachableShas: new() { "old", "new" });

        var reply = new DraftReply(
            Id: "r1", ParentThreadId: "PRRT_xxx",
            ReplyCommentId: null, BodyMarkdown: "body",
            Status: DraftStatus.Draft, IsOverriddenStale: false);

        var session = new ReviewSessionState(
            LastViewedHeadSha: "old", LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(), DraftReplies: new[] { reply },
            DraftSummaryMarkdown: null, DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, "new", fake, CancellationToken.None);

        var r = Assert.Single(result.Replies);
        Assert.Equal(DraftStatus.Draft, r.Status);
    }
}
```

`VerdictReconfirmTests.cs`:
```csharp
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class VerdictReconfirmTests
{
    [Fact]
    public async Task VerdictSetAndHeadShifted_NeedsReconfirm()
    {
        var session = SessionWith("old", verdict: DraftVerdict.Approve);
        var fake = new FakeFileContentSource(reachableShas: new() { "old", "new" });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, "new", fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.NeedsReconfirm, result.VerdictOutcome);
    }

    [Fact]
    public async Task VerdictSetAndHeadUnchanged_Unchanged()
    {
        var session = SessionWith("same", verdict: DraftVerdict.Approve);
        var fake = new FakeFileContentSource(reachableShas: new() { "same" });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, "same", fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.Unchanged, result.VerdictOutcome);
    }

    [Fact]
    public async Task NoVerdictSet_HeadShifted_Unchanged()
    {
        var session = SessionWith("old", verdict: null);
        var fake = new FakeFileContentSource(reachableShas: new() { "old", "new" });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, "new", fake, CancellationToken.None);

        Assert.Equal(VerdictReconcileOutcome.Unchanged, result.VerdictOutcome);
    }

    private static ReviewSessionState SessionWith(string lastViewedHeadSha, DraftVerdict? verdict)
        => new(
            LastViewedHeadSha: lastViewedHeadSha, LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(), DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: verdict,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
```

- [ ] **Step 4: Run all reconciliation tests**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~Reconciliation"`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/PRism.Core.Tests/Reconciliation/{ForcePushFallbackTests,WhitespaceTests,RenameTests,DeleteTests,ReplyTests,VerdictReconfirmTests}.cs
git commit -m "test(s4-pr2): edge-case fixtures (force-push, whitespace, rename, delete, reply, verdict)"
```

---

### Task 21: Verify PR2 green; push

- [ ] **Step 1: Full test sweep**

Run: `dotnet test`
Expected: ALL PASS.

- [ ] **Step 2: Push**

```bash
git push origin docs/s4-drafts-and-composer-spec
```

---

# Phase 3 — PR3: Backend draft endpoints + bus events + SSE + spec/02 update

**PR title:** `feat(s4-pr3): PUT/GET /draft + POST /reload + bus events + SSE wiring + spec/02 update`

**Optional split for review-load.** PR3 lands ~18 files across six review concerns (HTTP endpoint design, event bus contract, SSE wire format, GitHub API addition, middleware policy, spec doc edit). At reviewer's discretion, split as:
- **PR3a** (Tasks 22-24a + 27-28): events + SSE projection + `IActivePrCache` + `IReviewService.GetCommitAsync` + `ReviewServiceFileContentSource`. Pure infrastructure; no endpoints.
- **PR3b** (Tasks 25-26 + 29-32): `PUT/GET /draft` + `POST /reload` + middleware + spec/02 doc edit + tests.

If shipping as single PR3, the description should call out the review-attention split: (1) endpoint validation rules, (2) SSE projection wire shape, (3) middleware predicate, (4) `GetCommitAsync` signature on `IReviewService`, (5) `IActivePrCache` design, (6) spec/02 doc edit.

**Spec sections:** § 4 (entire), § 4.5 (SSE), § 4.6 (concurrency), § 4.7 (markAllRead semantics), § 4.8 (spec/02 update obligation), § 5.5 (overrideStale endpoint behavior).

**Files touched:**
- Create: `PRism.Core/Events/DraftSaved.cs`
- Create: `PRism.Core/Events/DraftDiscarded.cs`
- Create: `PRism.Core/Events/DraftSubmitted.cs`
- Create: `PRism.Core/Events/StateChanged.cs`
- Create: `PRism.Web/Sse/SseEventProjection.cs`
- Create: `PRism.Web/Endpoints/PrDraftDtos.cs`
- Create: `PRism.Web/Endpoints/PrDraftEndpoints.cs`
- Create: `PRism.Web/Endpoints/PrReloadEndpoints.cs`
- Modify: `PRism.Web/Program.cs` (extend UseWhen body-cap predicate; register new endpoints)
- Modify: `PRism.Core/IReviewService.cs` (add `GetCommitAsync` if absent)
- Modify: `PRism.GitHub/GitHubReviewService.cs` (implement `GetCommitAsync`)
- Modify: `docs/spec/02-architecture.md` (add new patch kinds to wire-shape table)
- Create: `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`
- Create: `tests/PRism.Web.Tests/Concurrency/DraftRaceTests.cs`
- Create: `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs`

---

### Task 22: Add new `IReviewEvent` records

**Files:**
- Create: `PRism.Core/Events/DraftSaved.cs`, `DraftDiscarded.cs`, `DraftSubmitted.cs`, `StateChanged.cs`

- [ ] **Step 1: Confirm existing event records and the IReviewEvent shape**

Run: `grep -n "IReviewEvent\|public record" PRism.Core/Events/*.cs`
Expected: see `IReviewEvent` interface and existing `InboxUpdated` / `ActivePrUpdated` records — match the file convention (one record per file).

- [ ] **Step 2: Create `DraftSaved.cs`**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record DraftSaved(PrReference Pr, string DraftId, string? SourceTabId) : IReviewEvent;
```

- [ ] **Step 3: Create `DraftDiscarded.cs`**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record DraftDiscarded(PrReference Pr, string DraftId, string? SourceTabId) : IReviewEvent;
```

- [ ] **Step 4: Create `DraftSubmitted.cs`**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Events;

// Declared in S4 for forward-compat per spec § 4.4; published in S5 (no producer in S4).
// Note: NO SourceTabId field. The spec's wire-shape table only enumerates state-changed,
// draft-saved, draft-discarded — DraftSubmitted has no S4 wire shape; S5 will decide
// whether to add SourceTabId when it adds the publication path.
public sealed record DraftSubmitted(PrReference Pr) : IReviewEvent;
```

- [ ] **Step 5: Create `StateChanged.cs`**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Events;

public sealed record StateChanged(
    PrReference Pr,
    IReadOnlyList<string> FieldsTouched,
    string? SourceTabId) : IReviewEvent;
```

- [ ] **Step 6: Verify build + run existing test suite**

Run: `dotnet build && dotnet test`
Expected: ALL PASS (new records compile; no consumers yet).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Events/{DraftSaved,DraftDiscarded,DraftSubmitted,StateChanged}.cs
git commit -m "feat(s4-pr3): IReviewEvent records for draft lifecycle + multi-tab consistency"
```

---

### Task 23: Add SSE projection for `PrReference` shape

**Files:**
- Create: `PRism.Web/Sse/SseEventProjection.cs`

- [ ] **Step 1: Inspect existing SseChannel for the projection seam**

Run: `grep -n "SseChannel\|OnInboxUpdated\|OnActivePrUpdated" PRism.Web/Sse/SseChannel.cs`
Expected: see existing per-event-type fan-out methods.

- [ ] **Step 2: Create `SseEventProjection.cs`**

```csharp
using PRism.Core.Events;

namespace PRism.Web.Sse;

// Wire-shape projections — convert IReviewEvent records (which carry PrReference)
// into the JSON payload shape the frontend consumes (prRef as "owner/repo/number" string).
internal static class SseEventProjection
{
    public sealed record StateChangedWire(string PrRef, IReadOnlyList<string> FieldsTouched, string? SourceTabId);
    public sealed record DraftSavedWire(string PrRef, string DraftId, string? SourceTabId);
    public sealed record DraftDiscardedWire(string PrRef, string DraftId, string? SourceTabId);

    public static (string EventName, object Payload) Project(IReviewEvent evt) => evt switch
    {
        StateChanged e => ("state-changed", new StateChangedWire(e.Pr.ToString(), e.FieldsTouched, e.SourceTabId)),
        DraftSaved e => ("draft-saved", new DraftSavedWire(e.Pr.ToString(), e.DraftId, e.SourceTabId)),
        DraftDiscarded e => ("draft-discarded", new DraftDiscardedWire(e.Pr.ToString(), e.DraftId, e.SourceTabId)),
        // existing event kinds (InboxUpdated, ActivePrUpdated) handled elsewhere or default-passthrough
        _ => throw new ArgumentOutOfRangeException(nameof(evt), $"No SSE projection for {evt.GetType().Name}")
    };
}
```

- [ ] **Step 3: Wire the projection into `SseChannel`** (explicit per-event-type subscription)

`SseChannel` today (verified at `PRism.Web/Sse/SseChannel.cs:45-46`) uses **per-event-type subscription** (not a wildcard dispatcher):

```csharp
_busInbox = bus.Subscribe<InboxUpdated>(OnInboxUpdated);
_busActivePr = bus.Subscribe<ActivePrUpdated>(OnActivePrUpdated);
```

Add three more parallel subscriptions in the constructor:

```csharp
_busStateChanged = bus.Subscribe<StateChanged>(OnStateChanged);
_busDraftSaved = bus.Subscribe<DraftSaved>(OnDraftSaved);
_busDraftDiscarded = bus.Subscribe<DraftDiscarded>(OnDraftDiscarded);
// NOTE: DraftSubmitted intentionally NOT subscribed in S4 (no producer; S5 wires it).
```

Add three corresponding `OnXxx(IReviewEvent)` handler methods that:
1. Filter fanout: only push to subscribers registered for `evt.Pr` (per-PR fanout, mirroring `OnActivePrUpdated`'s pattern). Cross-PR information leakage if you broadcast.
2. Use `SseEventProjection.Project(evt)` to compute the wire shape + event name.
3. Serialize via `JsonSerializerOptionsFactory.Api` and write `event: <name>\ndata: <json>\n\n` per the existing channel framing.

Add three `IDisposable` fields and call `Dispose()` on each in the existing `Dispose()` method.

**Crucially:** `SseEventProjection.Project` is called from inside the new handler methods only. `OnInboxUpdated` and `OnActivePrUpdated` retain their inline framing — they do NOT route through `Project` (whose default arm throws). The projection is only for the three new event types; the throw arm signals "this event type was added without updating the projection switch" and is correct as-is.

- [ ] **Step 4: Verify build + tests**

Run: `dotnet build && dotnet test`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Sse/SseEventProjection.cs PRism.Web/Sse/SseChannel.cs
git commit -m "feat(s4-pr3): SSE projection for draft + state-changed events (PrReference → string)"
```

---

### Task 24: Add `PrDraftDtos.cs`

**Files:**
- Create: `PRism.Web/Endpoints/PrDraftDtos.cs`

- [ ] **Step 1: Create the DTO file**

```csharp
namespace PRism.Web.Endpoints;

// GET /api/pr/{ref}/draft response shape.
public sealed record ReviewSessionDto(
    string? DraftVerdict,
    string DraftVerdictStatus,
    string? DraftSummaryMarkdown,
    IReadOnlyList<DraftCommentDto> DraftComments,
    IReadOnlyList<DraftReplyDto> DraftReplies,
    IReadOnlyList<IterationOverrideDto> IterationOverrides,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    FileViewStateDto FileViewState);

public sealed record DraftCommentDto(
    string Id,
    string? FilePath,
    int? LineNumber,
    string? Side,
    string? AnchoredSha,
    string? AnchoredLineContent,
    string BodyMarkdown,
    string Status,
    bool IsOverriddenStale);

public sealed record DraftReplyDto(
    string Id,
    string ParentThreadId,
    string? ReplyCommentId,
    string BodyMarkdown,
    string Status,
    bool IsOverriddenStale);

public sealed record IterationOverrideDto();   // empty in S4; S3 placeholder

public sealed record FileViewStateDto(IReadOnlyDictionary<string, string> ViewedFiles);

// PUT /api/pr/{ref}/draft request shape (exactly-one-field constraint enforced server-side).
public sealed record ReviewSessionPatch(
    string? DraftVerdict,
    string? DraftSummaryMarkdown,
    NewDraftCommentPayload? NewDraftComment,
    NewPrRootDraftCommentPayload? NewPrRootDraftComment,
    UpdateDraftCommentPayload? UpdateDraftComment,
    DeleteDraftPayload? DeleteDraftComment,
    NewDraftReplyPayload? NewDraftReply,
    UpdateDraftPayload? UpdateDraftReply,
    DeleteDraftPayload? DeleteDraftReply,
    bool? ConfirmVerdict,
    bool? MarkAllRead,
    OverrideStalePayload? OverrideStale);

public sealed record NewDraftCommentPayload(
    string FilePath, int LineNumber, string Side,
    string AnchoredSha, string AnchoredLineContent, string BodyMarkdown);

public sealed record NewPrRootDraftCommentPayload(string BodyMarkdown);

public sealed record UpdateDraftCommentPayload(string Id, string BodyMarkdown);
public sealed record UpdateDraftPayload(string Id, string BodyMarkdown);
public sealed record DeleteDraftPayload(string Id);
public sealed record NewDraftReplyPayload(string ParentThreadId, string BodyMarkdown);
public sealed record OverrideStalePayload(string Id);

// Response shape for new-* patches.
public sealed record AssignedIdResponse(string AssignedId);
```

- [ ] **Step 2: Verify build**

Run: `dotnet build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add PRism.Web/Endpoints/PrDraftDtos.cs
git commit -m "feat(s4-pr3): PrDraftDtos (ReviewSessionDto + ReviewSessionPatch discriminated shape)"
```

---

### Task 24a: Introduce `IActivePrCache` (S4-internal, not S3 — correction)

**Files:**
- Create: `PRism.Core/PrDetail/IActivePrCache.cs`
- Create: `PRism.Core/PrDetail/ActivePrCache.cs`
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs` (publish into cache after each successful poll)
- Modify: `PRism.Core/PrDetail/ServiceCollectionExtensions.cs` (or wherever `ActivePrPoller` is registered) — register the cache as a singleton

**Why this task exists.** The earlier draft of the plan referenced "IActivePrCache (S3 dependency)" — that was wrong. S3 ships `ActivePrPoller` with private state; no public-facing cache surface exists. Tasks 25 (`markAllRead`) and 29 (`POST /reload` head-shift detection) both need to read "current head SHA per active PR" and "highest issue-comment id per active PR." This task introduces the minimal cache surface they need.

- [ ] **Step 1: Create the interface + record**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

public interface IActivePrCache
{
    bool IsSubscribed(PrReference prRef);                    // any tab subscribed?
    ActivePrSnapshot? GetCurrent(PrReference prRef);         // null if not subscribed or no poll completed yet
    void Update(PrReference prRef, ActivePrSnapshot snapshot);
}

public sealed record ActivePrSnapshot(
    string HeadSha,
    long? HighestIssueCommentId,                              // null if no issue comments observed
    DateTimeOffset ObservedAt);
```

- [ ] **Step 2: Create the in-memory impl**

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

public sealed class ActivePrCache : IActivePrCache
{
    private readonly ActivePrSubscriberRegistry _subscribers;
    private readonly ConcurrentDictionary<PrReference, ActivePrSnapshot> _snapshots = new();

    public ActivePrCache(ActivePrSubscriberRegistry subscribers) { _subscribers = subscribers; }

    public bool IsSubscribed(PrReference prRef) => _subscribers.AnySubscribers(prRef);

    public ActivePrSnapshot? GetCurrent(PrReference prRef)
        => _snapshots.TryGetValue(prRef, out var snap) ? snap : null;

    public void Update(PrReference prRef, ActivePrSnapshot snapshot)
        => _snapshots[prRef] = snapshot;
}
```

(If `ActivePrSubscriberRegistry` doesn't expose `AnySubscribers(PrReference)` today, add it as a small read method in the same task.)

- [ ] **Step 3: Wire `ActivePrPoller` to publish into the cache**

In `ActivePrPoller.cs`, after each successful per-PR poll cycle, call `_cache.Update(prRef, new ActivePrSnapshot(currentHeadSha, highestIssueCommentId, DateTimeOffset.UtcNow))`. The `highestIssueCommentId` is computed by the same path that builds `ActivePrUpdated` events.

- [ ] **Step 4: DI registration**

Register `IActivePrCache` → `ActivePrCache` as `Singleton` in the service composition root (alongside `ActivePrSubscriberRegistry`). Inject into `ActivePrPoller`.

- [ ] **Step 5: Tests**

Create `tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs`:
- `Empty_GetCurrent_ReturnsNull`
- `Update_Then_GetCurrent_ReturnsSnapshot`
- `IsSubscribed_DelegatesToRegistry`

- [ ] **Step 6: Verify build + existing S3 tests stay green**

Run: `dotnet build && dotnet test`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/PrDetail/IActivePrCache.cs PRism.Core/PrDetail/ActivePrCache.cs PRism.Core/PrDetail/ActivePrPoller.cs PRism.Core/PrDetail/ServiceCollectionExtensions.cs tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs
git commit -m "feat(s4-pr3): IActivePrCache exposes per-PR head SHA + highest comment id; populated by ActivePrPoller"
```

---

### Task 25: Add `PUT /api/pr/{ref}/draft` endpoint with all patch kinds

**Files:**
- Create: `PRism.Web/Endpoints/PrDraftEndpoints.cs`
- Create (test stub): `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`

- [ ] **Step 1: Write the failing test (one test per patch kind)**

Create `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Endpoints;

namespace PRism.Web.Tests.Endpoints;

public class PrDraftEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public PrDraftEndpointTests(WebApplicationFactory<Program> factory) { _factory = factory; }

    private HttpClient ClientWithSession()
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-PRism-Session", TestSessionToken);
        client.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-test-1");
        return client;
    }

    private const string TestSessionToken = "test-session";

    [Fact]
    public async Task NewDraftComment_SuccessPath_ReturnsAssignedIdAndPersists()
    {
        var client = ClientWithSession();
        var patch = new ReviewSessionPatch(
            null, null,
            NewDraftComment: new NewDraftCommentPayload(
                FilePath: "src/Foo.cs", LineNumber: 42, Side: "right",
                AnchoredSha: new string('a', 40),
                AnchoredLineContent: "line content",
                BodyMarkdown: "this is a draft comment"),
            null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<AssignedIdResponse>();
        Assert.NotNull(body);
        Assert.NotEmpty(body!.AssignedId);
    }

    [Fact]
    public async Task MissingSessionToken_401_Unauthorized()
    {
        var client = _factory.CreateClient();   // no session header
        var patch = new ReviewSessionPatch(
            null, "summary", null, null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task RejectsMultiFieldPatch_400_InvalidPatchShape()
    {
        var client = ClientWithSession();
        var patch = new ReviewSessionPatch(
            DraftVerdict: "approve", DraftSummaryMarkdown: "summary",   // two fields set
            null, null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task UpdateDraftCommentMissingId_404_DraftNotFound()
    {
        var client = ClientWithSession();
        var patch = new ReviewSessionPatch(
            null, null, null, null,
            UpdateDraftComment: new UpdateDraftCommentPayload(Id: "missing-uuid", BodyMarkdown: "body"),
            null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task NewDraftCommentBodyTooLarge_422_BodyTooLarge()
    {
        var client = ClientWithSession();
        var patch = new ReviewSessionPatch(
            null, null,
            NewDraftComment: new NewDraftCommentPayload(
                "src/Foo.cs", 42, "right",
                new string('a', 40), "line content",
                BodyMarkdown: new string('x', 8193)),   // 8193 chars, over 8192 cap
            null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task NewDraftCommentInvalidShaFormat_422_ShaFormatInvalid()
    {
        var client = ClientWithSession();
        var patch = new ReviewSessionPatch(
            null, null,
            NewDraftComment: new NewDraftCommentPayload(
                "src/Foo.cs", 42, "right",
                AnchoredSha: "not-a-sha",
                "line content", "body"),
            null, null, null, null, null, null, null, null, null);

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }

    [Fact]
    public async Task OverrideStaleAgainstNonStaleDraft_400_NotStale()
    {
        // (precondition: PUT a fresh draft first)
        var client = ClientWithSession();
        var newPatch = new ReviewSessionPatch(
            null, null,
            new NewDraftCommentPayload("src/Foo.cs", 42, "right", new string('a', 40), "line content", "body"),
            null, null, null, null, null, null, null, null, null);
        var newResp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", newPatch);
        var assigned = await newResp.Content.ReadFromJsonAsync<AssignedIdResponse>();

        var overridePatch = new ReviewSessionPatch(
            null, null, null, null, null, null, null, null, null, null, null,
            OverrideStale: new OverrideStalePayload(Id: assigned!.AssignedId));

        var resp = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft", overridePatch);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrDraftEndpointTests"`
Expected: FAIL — endpoint route not registered (404 on every test).

- [ ] **Step 3: Create `PrDraftEndpoints.cs`**

```csharp
using System.Text.RegularExpressions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

public static class PrDraftEndpoints
{
    private static readonly Regex Sha40 = new(@"^[0-9a-f]{40}$", RegexOptions.Compiled);
    private static readonly Regex Sha64 = new(@"^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly Regex ParentThreadId = new(@"^PRRT_[A-Za-z0-9_-]{1,128}$", RegexOptions.Compiled);
    private const int BodyMarkdownMaxChars = 8192;

    public static void MapPrDraftEndpoints(this WebApplication app)
    {
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/draft", GetDraft)
           .WithName("GetDraft");

        app.MapPut("/api/pr/{owner}/{repo}/{number:int}/draft", PutDraft)
           .WithName("PutDraft");
    }

    private static async Task<IResult> GetDraft(
        string owner, string repo, int number,
        IAppStateStore store, CancellationToken ct)
    {
        var refKey = $"{owner}/{repo}/{number}";
        var state = await store.LoadAsync(ct);
        if (!state.Reviews.Sessions.TryGetValue(refKey, out var session))
            return Results.Ok(EmptyReviewSessionDto());

        return Results.Ok(MapToDto(session));
    }

    private static async Task<IResult> PutDraft(
        string owner, string repo, int number,
        ReviewSessionPatch patch,
        HttpContext httpContext,
        IAppStateStore store,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();

        // 1. Validate "exactly one field set"
        var setFields = EnumerateSetFields(patch).ToList();
        if (setFields.Count != 1)
            return Results.BadRequest(new { error = "exactly one patch field must be set", fieldsSet = setFields });

        // 2. Validate body shape per kind
        var validation = ValidatePatch(patch);
        if (validation is not null) return validation;

        // 3. Apply through AppStateStore.UpdateAsync
        string? assignedId = null;
        bool draftNotFound = false;
        bool notStale = false;
        bool fileNotInDiff = false;
        string? eventDraftId = null;
        bool publishSaved = false;
        bool publishDiscarded = false;
        IReadOnlyList<string> fieldsTouched = Array.Empty<string>();

        await store.UpdateAsync(state =>
        {
            var session = state.Reviews.Sessions.TryGetValue(refKey, out var existing)
                ? existing
                : new ReviewSessionState(
                    LastViewedHeadSha: null, LastSeenCommentId: null,
                    PendingReviewId: null, PendingReviewCommitOid: null,
                    ViewedFiles: new Dictionary<string, string>(),
                    DraftComments: new List<DraftComment>(),
                    DraftReplies: new List<DraftReply>(),
                    DraftSummaryMarkdown: null, DraftVerdict: null,
                    DraftVerdictStatus: DraftVerdictStatus.Draft);

            ReviewSessionState updated;
            (updated, assignedId, draftNotFound, notStale, fileNotInDiff, eventDraftId, publishSaved, publishDiscarded, fieldsTouched)
                = ApplyPatch(session, patch);

            if (draftNotFound || notStale || fileNotInDiff)
                return state;   // no-op write

            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
            {
                [refKey] = updated
            };
            return state with { Reviews = state.Reviews with { Sessions = sessions } };
        }, ct);

        if (draftNotFound) return Results.NotFound(new { error = "draft-not-found" });
        if (notStale) return Results.BadRequest(new { error = "not-stale" });
        if (fileNotInDiff) return Results.UnprocessableEntity(new { error = "draft-file-not-in-diff" });

        // 4. Publish events (outside _gate per § 4.4)
        if (publishSaved)
            bus.Publish(new DraftSaved(prRef, eventDraftId!, sourceTabId));
        if (publishDiscarded)
            bus.Publish(new DraftDiscarded(prRef, eventDraftId!, sourceTabId));
        bus.Publish(new StateChanged(prRef, fieldsTouched, sourceTabId));

        if (assignedId is not null)
            return Results.Ok(new AssignedIdResponse(assignedId));
        return Results.Ok();
    }

    private static (
        ReviewSessionState Updated,
        string? AssignedId,
        bool DraftNotFound,
        bool NotStale,
        bool FileNotInDiff,
        string? EventDraftId,
        bool PublishSaved,
        bool PublishDiscarded,
        IReadOnlyList<string> FieldsTouched
    ) ApplyPatch(ReviewSessionState session, ReviewSessionPatch patch)
    {
        // — newDraftComment —
        if (patch.NewDraftComment is { } ndc)
        {
            var id = Guid.NewGuid().ToString();
            var draft = new DraftComment(
                Id: id,
                FilePath: ndc.FilePath, LineNumber: ndc.LineNumber, Side: ndc.Side,
                AnchoredSha: ndc.AnchoredSha, AnchoredLineContent: ndc.AnchoredLineContent,
                BodyMarkdown: ndc.BodyMarkdown,
                Status: DraftStatus.Draft, IsOverriddenStale: false);

            return (
                session with { DraftComments = session.DraftComments.Append(draft).ToList() },
                id, false, false, false, id, true, false, new[] { "draft-comments" });
        }

        // — newPrRootDraftComment —
        if (patch.NewPrRootDraftComment is { } nprdc)
        {
            var id = Guid.NewGuid().ToString();
            var draft = new DraftComment(
                Id: id,
                FilePath: null, LineNumber: null, Side: "pr",
                AnchoredSha: null, AnchoredLineContent: null,
                BodyMarkdown: nprdc.BodyMarkdown,
                Status: DraftStatus.Draft, IsOverriddenStale: false);

            return (
                session with { DraftComments = session.DraftComments.Append(draft).ToList() },
                id, false, false, false, id, true, false, new[] { "draft-comments" });
        }

        // — updateDraftComment —
        if (patch.UpdateDraftComment is { } udc)
        {
            var idx = session.DraftComments.ToList().FindIndex(d => d.Id == udc.Id);
            if (idx < 0) return (session, null, true, false, false, null, false, false, Array.Empty<string>());
            var list = session.DraftComments.ToList();
            list[idx] = list[idx] with { BodyMarkdown = udc.BodyMarkdown };
            return (
                session with { DraftComments = list },
                null, false, false, false, udc.Id, true, false, new[] { "draft-comments" });
        }

        // — deleteDraftComment —
        if (patch.DeleteDraftComment is { } ddc)
        {
            var idx = session.DraftComments.ToList().FindIndex(d => d.Id == ddc.Id);
            if (idx < 0) return (session, null, true, false, false, null, false, false, Array.Empty<string>());
            var list = session.DraftComments.ToList();
            list.RemoveAt(idx);
            return (
                session with { DraftComments = list },
                null, false, false, false, ddc.Id, false, true, new[] { "draft-comments" });
        }

        // — newDraftReply —
        if (patch.NewDraftReply is { } ndr)
        {
            var id = Guid.NewGuid().ToString();
            var reply = new DraftReply(
                Id: id, ParentThreadId: ndr.ParentThreadId, ReplyCommentId: null,
                BodyMarkdown: ndr.BodyMarkdown, Status: DraftStatus.Draft, IsOverriddenStale: false);

            return (
                session with { DraftReplies = session.DraftReplies.Append(reply).ToList() },
                id, false, false, false, id, true, false, new[] { "draft-replies" });
        }

        // — updateDraftReply —
        if (patch.UpdateDraftReply is { } udr)
        {
            var idx = session.DraftReplies.ToList().FindIndex(r => r.Id == udr.Id);
            if (idx < 0) return (session, null, true, false, false, null, false, false, Array.Empty<string>());
            var list = session.DraftReplies.ToList();
            list[idx] = list[idx] with { BodyMarkdown = udr.BodyMarkdown };
            return (
                session with { DraftReplies = list },
                null, false, false, false, udr.Id, true, false, new[] { "draft-replies" });
        }

        // — deleteDraftReply —
        if (patch.DeleteDraftReply is { } ddr)
        {
            var idx = session.DraftReplies.ToList().FindIndex(r => r.Id == ddr.Id);
            if (idx < 0) return (session, null, true, false, false, null, false, false, Array.Empty<string>());
            var list = session.DraftReplies.ToList();
            list.RemoveAt(idx);
            return (
                session with { DraftReplies = list },
                null, false, false, false, ddr.Id, false, true, new[] { "draft-replies" });
        }

        // — draftVerdict —
        // Discriminator: "is this the verdict patch?" — driven by EnumerateSetFields detecting
        // it via the explicit "draftVerdict" name. Because the wire is "exactly one field set,"
        // by the time ApplyPatch runs we know which kind it is from EnumerateSetFields.
        // The verdict patch is the only one whose value can legitimately be `null` (clears the
        // verdict), so a presence check on `patch.DraftVerdict is not null` is wrong (it would
        // miss the explicit-null-clear case). Instead, we pass the discriminator kind alongside
        // the patch and dispatch in this method by kind, not by value-presence. Simpler shape:
        // EnumerateSetFields returns the kind name; ApplyPatch switches on it directly. See
        // refactor in Step 3a below.
        // For now, the verdict arm is reached when EnumerateSetFields returned "draftVerdict":
        if (/* dispatch reached the verdict arm */ false /* placeholder; see refactor */)
        {
            var verdict = patch.DraftVerdict switch
            {
                "approve" => (DraftVerdict?)DraftVerdict.Approve,
                "requestChanges" => (DraftVerdict?)DraftVerdict.RequestChanges,
                "comment" => (DraftVerdict?)DraftVerdict.Comment,
                null => null,
                _ => throw new ArgumentException($"unknown verdict: {patch.DraftVerdict}")
            };
            return (
                session with { DraftVerdict = verdict },
                null, false, false, false, null, false, false, new[] { "draft-verdict" });
        }

        // — draftSummaryMarkdown —
        if (patch.DraftSummaryMarkdown is not null)
        {
            return (
                session with { DraftSummaryMarkdown = patch.DraftSummaryMarkdown },
                null, false, false, false, null, false, false, new[] { "draft-summary" });
        }

        // — confirmVerdict —
        if (patch.ConfirmVerdict == true)
        {
            return (
                session with { DraftVerdictStatus = DraftVerdictStatus.Draft },
                null, false, false, false, null, false, false, new[] { "draft-verdict-status" });
        }

        // — overrideStale —
        if (patch.OverrideStale is { } os)
        {
            // Look up the draft (could be comment OR reply)
            var commentIdx = session.DraftComments.ToList().FindIndex(d => d.Id == os.Id);
            if (commentIdx >= 0)
            {
                var d = session.DraftComments.ToList()[commentIdx];
                if (d.Status != DraftStatus.Stale)
                    return (session, null, false, true, false, null, false, false, Array.Empty<string>());
                var list = session.DraftComments.ToList();
                list[commentIdx] = list[commentIdx] with { IsOverriddenStale = true, Status = DraftStatus.Draft };
                return (
                    session with { DraftComments = list },
                    null, false, false, false, os.Id, true, false, new[] { "draft-comments" });
            }
            var replyIdx = session.DraftReplies.ToList().FindIndex(r => r.Id == os.Id);
            if (replyIdx >= 0)
            {
                var r = session.DraftReplies.ToList()[replyIdx];
                if (r.Status != DraftStatus.Stale)
                    return (session, null, false, true, false, null, false, false, Array.Empty<string>());
                var list = session.DraftReplies.ToList();
                list[replyIdx] = list[replyIdx] with { IsOverriddenStale = true, Status = DraftStatus.Draft };
                return (
                    session with { DraftReplies = list },
                    null, false, false, false, os.Id, true, false, new[] { "draft-replies" });
            }
            return (session, null, true, false, false, null, false, false, Array.Empty<string>());
        }

        // — markAllRead —
        // NOTE: Implementation reads from active-PR cache in production. Fixture-based test
        // implementation is in IActivePrCache (S3 dependency). For now, always succeeds.
        if (patch.MarkAllRead == true)
        {
            return (
                session,   // no actual mutation here without cache; spec § 4.7 covers details
                null, false, false, false, null, false, false, new[] { "last-seen-comment-id" });
        }

        throw new InvalidOperationException("unreachable: validation should have caught unknown patch");
    }

    private static IEnumerable<string> EnumerateSetFields(ReviewSessionPatch p)
    {
        if (p.DraftVerdict is not null) yield return "draftVerdict";
        if (p.DraftSummaryMarkdown is not null) yield return "draftSummaryMarkdown";
        if (p.NewDraftComment is not null) yield return "newDraftComment";
        if (p.NewPrRootDraftComment is not null) yield return "newPrRootDraftComment";
        if (p.UpdateDraftComment is not null) yield return "updateDraftComment";
        if (p.DeleteDraftComment is not null) yield return "deleteDraftComment";
        if (p.NewDraftReply is not null) yield return "newDraftReply";
        if (p.UpdateDraftReply is not null) yield return "updateDraftReply";
        if (p.DeleteDraftReply is not null) yield return "deleteDraftReply";
        if (p.ConfirmVerdict == true) yield return "confirmVerdict";
        if (p.MarkAllRead == true) yield return "markAllRead";
        if (p.OverrideStale is not null) yield return "overrideStale";
    }

    private static IResult? ValidatePatch(ReviewSessionPatch patch)
    {
        if (patch.NewDraftComment is { } ndc)
        {
            if (ndc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                return Results.UnprocessableEntity(new { error = "body-too-large" });
            if (string.IsNullOrWhiteSpace(ndc.BodyMarkdown))
                return Results.BadRequest(new { error = "body-empty" });
            if (!Sha40.IsMatch(ndc.AnchoredSha) && !Sha64.IsMatch(ndc.AnchoredSha))
                return Results.UnprocessableEntity(new { error = "sha-format-invalid" });
            if (!IsCanonicalFilePath(ndc.FilePath))
                return Results.UnprocessableEntity(new { error = "file-path-invalid" });
        }
        if (patch.NewDraftReply is { } ndr)
        {
            if (ndr.BodyMarkdown.Length > BodyMarkdownMaxChars)
                return Results.UnprocessableEntity(new { error = "body-too-large" });
            if (string.IsNullOrWhiteSpace(ndr.BodyMarkdown))
                return Results.BadRequest(new { error = "body-empty" });
            if (!ParentThreadId.IsMatch(ndr.ParentThreadId))
                return Results.UnprocessableEntity(new { error = "thread-id-format-invalid" });
        }
        if (patch.UpdateDraftComment is { } udc && udc.BodyMarkdown.Length > BodyMarkdownMaxChars)
            return Results.UnprocessableEntity(new { error = "body-too-large" });
        if (patch.UpdateDraftReply is { } udr && udr.BodyMarkdown.Length > BodyMarkdownMaxChars)
            return Results.UnprocessableEntity(new { error = "body-too-large" });
        return null;
    }

    private static bool IsCanonicalFilePath(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;
        if (path.Length > 4096) return false;
        if (path.Contains('\\') || path.Contains('\0')) return false;
        if (path.StartsWith('/') || path.EndsWith('/')) return false;
        if (path.Contains("/../") || path.StartsWith("../") || path.EndsWith("/..")) return false;
        if (path.Contains("/./") || path.StartsWith("./") || path.EndsWith("/.")) return false;
        foreach (var c in path)
            if (c < 0x20 || (c >= 0x7F && c < 0xA0)) return false;
        if (path != path.Normalize(System.Text.NormalizationForm.FormC)) return false;
        return true;
    }

    private static ReviewSessionDto MapToDto(ReviewSessionState s) => new(
        DraftVerdict: s.DraftVerdict?.ToString().ToLowerInvariant() switch
        {
            "approve" => "approve",
            "requestchanges" => "requestChanges",
            "comment" => "comment",
            _ => null
        },
        DraftVerdictStatus: s.DraftVerdictStatus == DraftVerdictStatus.Draft ? "draft" : "needs-reconfirm",
        DraftSummaryMarkdown: s.DraftSummaryMarkdown,
        DraftComments: s.DraftComments.Select(MapDraft).ToList(),
        DraftReplies: s.DraftReplies.Select(MapReply).ToList(),
        IterationOverrides: Array.Empty<IterationOverrideDto>(),
        PendingReviewId: s.PendingReviewId,
        PendingReviewCommitOid: s.PendingReviewCommitOid,
        FileViewState: new FileViewStateDto(s.ViewedFiles));

    private static DraftCommentDto MapDraft(DraftComment d) => new(
        d.Id, d.FilePath, d.LineNumber, d.Side, d.AnchoredSha, d.AnchoredLineContent,
        d.BodyMarkdown, d.Status.ToString().ToLowerInvariant(), d.IsOverriddenStale);

    private static DraftReplyDto MapReply(DraftReply r) => new(
        r.Id, r.ParentThreadId, r.ReplyCommentId, r.BodyMarkdown,
        r.Status.ToString().ToLowerInvariant(), r.IsOverriddenStale);

    private static ReviewSessionDto EmptyReviewSessionDto() => new(
        null, "draft", null,
        Array.Empty<DraftCommentDto>(), Array.Empty<DraftReplyDto>(),
        Array.Empty<IterationOverrideDto>(),
        null, null,
        new FileViewStateDto(new Dictionary<string, string>()));
}
```

- [ ] **Step 3a: REFACTOR `ApplyPatch` to dispatch on the kind discriminator (fixes draftVerdict null-clear bug + markAllRead no-op + reduces tuple-shape coupling)**

The Step 3 code is a sketch. Before commit, restructure as follows. The `EnumerateSetFields` already determines which patch kind is set; pass that string into a switch. This eliminates the buggy `is { } verdictStr || patch.DraftVerdict is null && false` condition (which never fired the verdict arm for null-clear) and forces every kind to be explicitly handled.

Replace `ApplyPatch` with a `(string kind, ReviewSessionPatch patch, ReviewSessionState session, IActivePrCache cache) -> PatchOutcome` shape:

```csharp
internal abstract record PatchOutcome
{
    public sealed record Applied(
        ReviewSessionState Updated,
        string? AssignedId,
        string? EventDraftId,
        bool PublishSaved,
        bool PublishDiscarded,
        IReadOnlyList<string> FieldsTouched) : PatchOutcome;

    public sealed record DraftNotFound : PatchOutcome;
    public sealed record NotStale : PatchOutcome;
    public sealed record FileNotInDiff : PatchOutcome;
    public sealed record NotSubscribed : PatchOutcome;
    public sealed record NoOp : PatchOutcome;   // confirmVerdict-when-already-draft, markAllRead-when-cache-empty
}

private static PatchOutcome ApplyPatch(
    string kind,
    ReviewSessionPatch patch,
    ReviewSessionState session,
    IActivePrCache cache,
    PrReference prRef)
{
    switch (kind)
    {
        case "draftVerdict":
            // Note: DraftVerdict CAN be null (clears the verdict). Only this arm handles null.
            var verdict = patch.DraftVerdict switch
            {
                "approve" => (DraftVerdict?)DraftVerdict.Approve,
                "requestChanges" => (DraftVerdict?)DraftVerdict.RequestChanges,
                "comment" => (DraftVerdict?)DraftVerdict.Comment,
                null => null,
                _ => throw new ArgumentException($"unknown verdict: {patch.DraftVerdict}")
            };
            return new PatchOutcome.Applied(
                session with { DraftVerdict = verdict },
                AssignedId: null, EventDraftId: null,
                PublishSaved: false, PublishDiscarded: false,
                FieldsTouched: new[] { "draft-verdict" });

        case "draftSummaryMarkdown":
            return new PatchOutcome.Applied(
                session with { DraftSummaryMarkdown = patch.DraftSummaryMarkdown },
                null, null, false, false, new[] { "draft-summary" });

        case "newDraftComment":
            // ... (same as Step 3 code, returning PatchOutcome.Applied)

        case "newPrRootDraftComment":
            // ... (same)

        case "updateDraftComment":
            // ... (same — return PatchOutcome.DraftNotFound on missing id)

        case "deleteDraftComment":
            // ... (same — return PatchOutcome.DraftNotFound on missing id)

        case "newDraftReply":
        case "updateDraftReply":
        case "deleteDraftReply":
            // ... (same patterns)

        case "confirmVerdict":
            if (session.DraftVerdictStatus == DraftVerdictStatus.Draft)
                return new PatchOutcome.NoOp();
            return new PatchOutcome.Applied(
                session with { DraftVerdictStatus = DraftVerdictStatus.Draft },
                null, null, false, false, new[] { "draft-verdict-status" });

        case "markAllRead":
            // SECURITY: closes the drive-by-tab vector per spec § 4.7.
            if (!cache.IsSubscribed(prRef))
                return new PatchOutcome.NotSubscribed();
            var snapshot = cache.GetCurrent(prRef);
            if (snapshot is null || snapshot.HighestIssueCommentId is null)
                return new PatchOutcome.NoOp();   // cache cold or no issue comments
            var newId = snapshot.HighestIssueCommentId.Value.ToString();
            if (session.LastSeenCommentId == newId)
                return new PatchOutcome.NoOp();
            return new PatchOutcome.Applied(
                session with { LastSeenCommentId = newId },
                null, null, false, false, new[] { "last-seen-comment-id" });

        case "overrideStale":
            // ... (same as Step 3 code)

        default:
            throw new InvalidOperationException($"unhandled patch kind: {kind}");
    }
}
```

The `PutDraft` endpoint then handles the `PatchOutcome` cases:
```csharp
return outcome switch
{
    PatchOutcome.Applied a when a.AssignedId is not null => Results.Ok(new AssignedIdResponse(a.AssignedId)),
    PatchOutcome.Applied => Results.Ok(),
    PatchOutcome.NoOp => Results.Ok(),
    PatchOutcome.DraftNotFound => Results.NotFound(new { error = "draft-not-found" }),
    PatchOutcome.NotStale => Results.BadRequest(new { error = "not-stale" }),
    PatchOutcome.FileNotInDiff => Results.UnprocessableEntity(new { error = "draft-file-not-in-diff" }),
    PatchOutcome.NotSubscribed => Results.NotFound(new { error = "not-subscribed" }),
    _ => throw new InvalidOperationException($"unhandled outcome: {outcome}")
};
```

Event publication (outside `_gate`):
```csharp
if (outcome is PatchOutcome.Applied applied)
{
    if (applied.PublishSaved && applied.EventDraftId is not null)
        bus.Publish(new DraftSaved(prRef, applied.EventDraftId, sourceTabId));
    if (applied.PublishDiscarded && applied.EventDraftId is not null)
        bus.Publish(new DraftDiscarded(prRef, applied.EventDraftId, sourceTabId));
    bus.Publish(new StateChanged(prRef, applied.FieldsTouched, sourceTabId));
}
// Crucially: NoOp / NotFound / NotStale / NotSubscribed / FileNotInDiff do NOT publish events.
// This prevents the false-StateChanged-after-no-op bug (markAllRead on cold cache used to
// publish a misleading event in the earlier sketch).
```

- [ ] **Step 4: Wire endpoint registration in `Program.cs`**

Add `app.MapPrDraftEndpoints();` near the existing endpoint registrations (after the existing `MapPrDetailEndpoints()` etc.)

- [ ] **Step 5: Update tests for refactored shape + add missing tests**

Add to `PrDraftEndpointTests.cs`:
- `MarkAllRead_NotSubscribed_404_NotSubscribed` (security defense from spec § 4.7).
- `MarkAllRead_CacheEmpty_NoOp_NoEvent` (cold cache; should NOT publish StateChanged).
- `MarkAllRead_Success_UpdatesLastSeenCommentId_PublishesStateChanged` (use a fake `IActivePrCache` injected via `WebApplicationFactory<Program>.WithWebHostBuilder`).
- `DraftVerdictNullClear_PersistsNull_PublishesStateChanged` (covers the previously-buggy null-clear arm).
- `ConfirmVerdictWhenAlreadyDraft_NoOp_NoEvent_NoStateChange` (verifies no-op truly does nothing, including no event).

- [ ] **Step 6: Run the endpoint tests to verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrDraftEndpointTests"`
Expected: PASS (7 + 5 new = 12 tests).

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Endpoints/PrDraftEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs
git commit -m "feat(s4-pr3): PUT/GET /api/pr/{ref}/draft + PatchOutcome dispatch + markAllRead with cache + null-clear verdict fix"
```

---

### Task 26: Extend body-cap middleware to cover `PUT /draft`

**Files:**
- Modify: `PRism.Web/Program.cs`

- [ ] **Step 1: Locate the existing `UseWhen` predicate**

Run: `grep -n "UseWhen\|MaxRequestBodySize" PRism.Web/Program.cs`
Expected: see line ~81 with `app.UseWhen(...)` predicate matching the existing capped routes.

- [ ] **Step 2: Extend the predicate**

Update the predicate to include the new draft route. The existing predicate matches by path prefix (`POST /api/pr/{owner}/{repo}/{n}/files/viewed`); add a parallel match for `PUT /api/pr/{owner}/{repo}/{n}/draft`. Example shape:

```csharp
app.UseWhen(
    ctx =>
    {
        var path = ctx.Request.Path.Value ?? "";
        var method = ctx.Request.Method;
        return (method == HttpMethods.Post && path.Contains("/files/viewed"))
            || (method == HttpMethods.Put && path.EndsWith("/draft"))
            || (method == HttpMethods.Post && path.EndsWith("/reload"));
    },
    branch => branch.Use(async (ctx, next) =>
    {
        var feat = ctx.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        if (feat is { IsReadOnly: false }) feat.MaxRequestBodySize = 16384;

        if (ctx.Request.ContentLength is { } len && len > 16384)
        {
            ctx.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            await ctx.Response.WriteAsync("body too large");
            return;
        }
        await next();
    }));
```

(Match the existing surrounding code style — the comment block above the existing `UseWhen` preserves intent.)

- [ ] **Step 3: Run the existing `RequestSizeLimitTests`**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~RequestSizeLimit"`
Expected: PASS (existing tests cover the existing routes; new tests added in Task 25 cover the new route).

- [ ] **Step 4: Commit**

```bash
git add PRism.Web/Program.cs
git commit -m "feat(s4-pr3): extend body-cap middleware UseWhen predicate to cover PUT /draft + POST /reload"
```

---

### Task 27: Add `IReviewService.GetCommitAsync` (if absent) and impl

**Files:**
- Modify: `PRism.Core/IReviewService.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs`

- [ ] **Step 1: Check if `GetCommitAsync` exists**

Run: `grep -n "GetCommitAsync\|GetFileContentAsync" PRism.Core/IReviewService.cs`

If it does NOT exist:

- [ ] **Step 2: Add to `IReviewService.cs`**

```csharp
// Returns null if commit unreachable (404). Throws on transport errors.
Task<CommitInfo?> GetCommitAsync(PrReference pr, string sha, CancellationToken ct);
```

(Add `CommitInfo` record to `PRism.Core.Contracts` — `public sealed record CommitInfo(string Sha, string Author, DateTimeOffset Date);` or whatever shape matches existing GraphQL/REST adapters.)

- [ ] **Step 3: Implement in `GitHubReviewService.cs`**

Use the GitHub REST `GET /repos/{owner}/{repo}/commits/{sha}` endpoint via the existing `Octokit` client. Return null on `NotFoundException`; throw other exceptions.

- [ ] **Step 4: Verify build + tests**

Run: `dotnet build && dotnet test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/IReviewService.cs PRism.Core.Contracts/CommitInfo.cs PRism.GitHub/GitHubReviewService.cs
git commit -m "feat(s4-pr3): IReviewService.GetCommitAsync + GitHub REST impl (null on 404)"
```

(Skip Task 27 entirely if `GetCommitAsync` already exists.)

---

### Task 28: Add `ReviewServiceFileContentSource` (with `FileContentResult` projection)

**Files:**
- Create: `PRism.Core/Reconciliation/Pipeline/ReviewServiceFileContentSource.cs`

**IMPORTANT: API-shape correction from earlier draft.** `IReviewService.GetFileContentAsync` returns `Task<FileContentResult>` (verified at `PRism.Core/IReviewService.cs:30`), not `Task<string?>`. `FileContentResult` has `Status` (`Ok | NotFound | TooLarge | Binary | NotInDiff`) and nullable `Content`. The wrapper must project explicitly. Per spec § 3.3 "the file-deleted-vs-SHA-unreachable distinction" — `NotFound` here means "file absent at this SHA" (file deleted); `NotInDiff` is a programmer error inside reconciliation (the pipeline should never request a file outside the PR's diff after FileResolution); `TooLarge` and `Binary` are "we can't reconcile against this content" → treat as Stale-NoMatch.

- [ ] **Step 1: Create the wrapper**

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Reconciliation.Pipeline;

internal sealed class ReviewServiceFileContentSource : IFileContentSource
{
    private readonly IReviewService _inner;
    private readonly PrReference _pr;

    public ReviewServiceFileContentSource(IReviewService inner, PrReference pr)
    {
        _inner = inner;
        _pr = pr;
    }

    public async Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
    {
        var result = await _inner.GetFileContentAsync(_pr, filePath, sha, ct);
        return result.Status switch
        {
            FileContentStatus.Ok => result.Content,
            FileContentStatus.NotFound => null,                 // file gone at this SHA → caller treats as FileDeleted
            FileContentStatus.TooLarge => null,                 // unreconcileable → caller falls through to NoMatch
            FileContentStatus.Binary => null,                   // unreconcileable
            FileContentStatus.NotInDiff =>                       // programmer error: FileResolution should have caught this
                throw new InvalidOperationException(
                    $"Reconciliation pipeline requested file '{filePath}' at SHA '{sha}' that is not in the PR diff. " +
                    "FileResolution step should reject this earlier. This is a bug in the pipeline."),
            _ => null
        };
    }

    public async Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
    {
        var commit = await _inner.GetCommitAsync(_pr, sha, ct);
        return commit is not null;
    }
}
```

**Note:** `FileContentStatus.TooLarge` and `Binary` produce `null` here, which the pipeline classifies as `Stale (NoMatch)` (per `Classifier.cs` row 7 — no exact, no whitespace-equiv = Stale). That's the correct behavior — we cannot do line-content reconciliation on binary or oversized files, so the user must re-anchor manually. A future enhancement could classify these as a distinct `StaleReason` (e.g., `FileBinary` / `FileTooLarge`) so the panel surfaces a more specific message; out of scope for S4.

- [ ] **Step 2: Commit**

```bash
git add PRism.Core/Reconciliation/Pipeline/ReviewServiceFileContentSource.cs
git commit -m "feat(s4-pr3): ReviewServiceFileContentSource (production IFileContentSource impl)"
```

---

### Task 29: Add `POST /api/pr/{ref}/reload` endpoint (two-phase)

**Files:**
- Create: `PRism.Web/Endpoints/PrReloadEndpoints.cs`
- Create: `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Endpoints;

namespace PRism.Web.Tests.Endpoints;

public class PrReloadEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public PrReloadEndpointTests(WebApplicationFactory<Program> f) { _factory = f; }

    private HttpClient ClientWithSession()
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", "test-session");
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-1");
        return c;
    }

    [Fact]
    public async Task Reload_HappyPath_ReturnsFullSessionDto()
    {
        var client = ClientWithSession();
        var resp = await client.PostAsJsonAsync(
            "/api/pr/acme/api/123/reload",
            new { headSha = new string('a', 40) });

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var dto = await resp.Content.ReadFromJsonAsync<ReviewSessionDto>();
        Assert.NotNull(dto);
    }

    [Fact]
    public async Task Reload_DoubleClick_409_ReloadInProgress()
    {
        var client = ClientWithSession();
        var t1 = client.PostAsJsonAsync("/api/pr/acme/api/123/reload",
            new { headSha = new string('a', 40) });
        var t2 = client.PostAsJsonAsync("/api/pr/acme/api/123/reload",
            new { headSha = new string('a', 40) });

        var responses = await Task.WhenAll(t1, t2);
        // Exactly one should be 409 reload-in-progress
        Assert.Contains(responses, r => r.StatusCode == HttpStatusCode.Conflict);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrReloadEndpointTests"`
Expected: FAIL — endpoint not registered.

- [ ] **Step 3: Create `PrReloadEndpoints.cs`**

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

public static class PrReloadEndpoints
{
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> PerPrSemaphores = new();

    public sealed record ReloadRequest(string HeadSha);
    public sealed record ReloadStaleHeadResponse(string CurrentHeadSha);

    public static void MapPrReloadEndpoints(this WebApplication app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/reload", PostReload).WithName("PostReload");
    }

    private static readonly System.Text.RegularExpressions.Regex Sha40 = new(@"^[0-9a-f]{40}$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex Sha64 = new(@"^[0-9a-f]{64}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    private static async Task<IResult> PostReload(
        string owner, string repo, int number,
        ReloadRequest request,
        HttpContext httpContext,
        IAppStateStore store,
        IReviewService reviewService,
        IActivePrCache activePrCache,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();

        // SECURITY: validate headSha format (mirrors PUT /draft anchoredSha validation per spec § 4.2)
        if (!Sha40.IsMatch(request.HeadSha) && !Sha64.IsMatch(request.HeadSha))
            return Results.UnprocessableEntity(new { error = "sha-format-invalid" });

        var sem = PerPrSemaphores.GetOrAdd(refKey, _ => new SemaphoreSlim(1, 1));
        if (!await sem.WaitAsync(0, ct))
            return Results.Conflict(new { error = "reload-in-progress" });

        try
        {
            // Phase 1: reconcile (no _gate held)
            var stateBefore = await store.LoadAsync(ct);
            if (!stateBefore.Reviews.Sessions.TryGetValue(refKey, out var session))
                return Results.NotFound(new { error = "session-not-found" });

            var fileSource = new ReviewServiceFileContentSource(reviewService, prRef);
            var pipeline = new DraftReconciliationPipeline();

            // Build renames + deletedPaths from PR file changes (S3's GetPrFiles cache)
            // For MVP: pass empty maps; extension lands when iterating against real PRs.
            var result = await pipeline.ReconcileAsync(
                session, request.HeadSha, fileSource, ct,
                renames: null, deletedPaths: null);

            // Phase 2: apply (gate held briefly)
            string? currentHeadShaForRetry = null;
            await store.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(refKey, out var current))
                    return state;

                // Head-shift detection per spec § 3.3. Compare the request's headSha against
                // the active-PR cache's current head (populated by ActivePrPoller — Task 24a).
                // If they diverge, the poller has observed a newer head between Phase 1's read
                // and this Phase 2 apply — return without persisting and surface 409 with the
                // current sha so the frontend can auto-retry (Task 46).
                var cached = activePrCache.GetCurrent(prRef);
                if (cached is not null && cached.HeadSha != request.HeadSha)
                {
                    currentHeadShaForRetry = cached.HeadSha;
                    return state;   // no-op the apply
                }

                var updatedDrafts = result.Drafts.Select(r =>
                {
                    var orig = current.DraftComments.First(d => d.Id == r.Id);
                    return orig with
                    {
                        FilePath = r.ResolvedFilePath ?? orig.FilePath,
                        LineNumber = r.ResolvedLineNumber ?? orig.LineNumber,
                        AnchoredSha = r.ResolvedAnchoredSha ?? orig.AnchoredSha,
                        Status = r.Status,
                        IsOverriddenStale = r.IsOverriddenStale
                    };
                }).ToList();

                var updatedReplies = result.Replies.Select(r =>
                {
                    var orig = current.DraftReplies.First(rp => rp.Id == r.Id);
                    return orig with { Status = r.Status, IsOverriddenStale = r.IsOverriddenStale };
                }).ToList();

                var newVerdictStatus = result.VerdictOutcome == VerdictReconcileOutcome.NeedsReconfirm
                    ? DraftVerdictStatus.NeedsReconfirm
                    : current.DraftVerdictStatus;

                var updated = current with
                {
                    DraftComments = updatedDrafts,
                    DraftReplies = updatedReplies,
                    DraftVerdictStatus = newVerdictStatus,
                    LastViewedHeadSha = request.HeadSha
                };

                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
                {
                    [refKey] = updated
                };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }, ct);

            if (currentHeadShaForRetry is not null)
                return Results.Json(
                    new ReloadStaleHeadResponse(currentHeadShaForRetry),
                    statusCode: StatusCodes.Status409Conflict);

            // Publish event (outside _gate)
            bus.Publish(new StateChanged(prRef, new[] { "draft-comments", "draft-replies", "draft-verdict-status" }, sourceTabId));

            // Return updated DTO (saves the frontend a round-trip)
            var stateAfter = await store.LoadAsync(ct);
            var session2 = stateAfter.Reviews.Sessions[refKey];
            return Results.Ok(MapSessionToDto(session2));
        }
        finally
        {
            sem.Release();
        }
    }

    // Re-uses PrDraftEndpoints.MapToDto by promoting it to `internal static` (Task 25's
    // private mapper becomes internal so this endpoint can call it without copy-paste).
    // The duplicate inline mapper from the earlier sketch is REMOVED — call site:
    //   var session2 = stateAfter.Reviews.Sessions[refKey];
    //   return Results.Ok(PrDraftEndpoints.MapToDto(session2));
    // (Step 6 of Task 25 includes the visibility change.)
    // The block below is preserved only to document the mapper shape; delete before commit.
    private static ReviewSessionDto MapSessionToDto(ReviewSessionState s) => new(
        DraftVerdict: s.DraftVerdict?.ToString().ToLowerInvariant() switch
        {
            "approve" => "approve",
            "requestchanges" => "requestChanges",
            "comment" => "comment",
            _ => null
        },
        DraftVerdictStatus: s.DraftVerdictStatus == DraftVerdictStatus.Draft ? "draft" : "needs-reconfirm",
        DraftSummaryMarkdown: s.DraftSummaryMarkdown,
        DraftComments: s.DraftComments.Select(d => new DraftCommentDto(
            d.Id, d.FilePath, d.LineNumber, d.Side, d.AnchoredSha, d.AnchoredLineContent,
            d.BodyMarkdown, d.Status.ToString().ToLowerInvariant(), d.IsOverriddenStale)).ToList(),
        DraftReplies: s.DraftReplies.Select(r => new DraftReplyDto(
            r.Id, r.ParentThreadId, r.ReplyCommentId, r.BodyMarkdown,
            r.Status.ToString().ToLowerInvariant(), r.IsOverriddenStale)).ToList(),
        IterationOverrides: Array.Empty<IterationOverrideDto>(),
        PendingReviewId: s.PendingReviewId,
        PendingReviewCommitOid: s.PendingReviewCommitOid,
        FileViewState: new FileViewStateDto(s.ViewedFiles));
}
```

- [ ] **Step 4: Wire registration in `Program.cs`**

Add `app.MapPrReloadEndpoints();` next to the draft endpoint registration.

- [ ] **Step 5: Run reload tests**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrReloadEndpointTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/PrReloadEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs
git commit -m "feat(s4-pr3): POST /api/pr/{ref}/reload — two-phase + per-PR semaphore + reload-in-progress 409"
```

---

### Task 30: Add concurrency tests + SSE flow tests

**Files:**
- Create: `tests/PRism.Web.Tests/Concurrency/DraftRaceTests.cs`
- Create: `tests/PRism.Web.Tests/Sse/StateChangedSseTests.cs`

- [ ] **Step 1: Write `DraftRaceTests.cs`**

```csharp
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Endpoints;

namespace PRism.Web.Tests.Concurrency;

public class DraftRaceTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public DraftRaceTests(WebApplicationFactory<Program> f) { _factory = f; }

    [Fact]
    public async Task TwoParallelUpdateDraftComments_LastWriterWins_TwoEvents()
    {
        // 1. Create a draft to update
        var setup = MakeClient("tab-setup");
        var newPatch = new ReviewSessionPatch(
            null, null,
            new NewDraftCommentPayload("src/Foo.cs", 42, "right",
                new string('a', 40), "line content", "initial body"),
            null, null, null, null, null, null, null, null, null);
        var newResp = await setup.PutAsJsonAsync("/api/pr/acme/api/123/draft", newPatch);
        var assigned = await newResp.Content.ReadFromJsonAsync<AssignedIdResponse>();
        var draftId = assigned!.AssignedId;

        // 2. Two clients race updateDraftComment with different bodies
        var clientA = MakeClient("tab-A");
        var clientB = MakeClient("tab-B");
        var taskA = clientA.PutAsJsonAsync("/api/pr/acme/api/123/draft",
            new ReviewSessionPatch(null, null, null, null,
                new UpdateDraftCommentPayload(draftId, "body from A"),
                null, null, null, null, null, null, null));
        var taskB = clientB.PutAsJsonAsync("/api/pr/acme/api/123/draft",
            new ReviewSessionPatch(null, null, null, null,
                new UpdateDraftCommentPayload(draftId, "body from B"),
                null, null, null, null, null, null, null));

        await Task.WhenAll(taskA, taskB);
        Assert.True((await taskA).IsSuccessStatusCode);
        Assert.True((await taskB).IsSuccessStatusCode);

        // 3. GET to confirm one of the two bodies survives
        var getResp = await clientA.GetAsync("/api/pr/acme/api/123/draft");
        var dto = await getResp.Content.ReadFromJsonAsync<ReviewSessionDto>();
        var draft = dto!.DraftComments.Single(d => d.Id == draftId);
        Assert.Contains(draft.BodyMarkdown, new[] { "body from A", "body from B" });
    }

    private HttpClient MakeClient(string tabId)
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-PRism-Session", "test-session");
        c.DefaultRequestHeaders.Add("X-PRism-Tab-Id", tabId);
        return c;
    }
}
```

- [ ] **Step 2: Write `StateChangedSseTests.cs`**

```csharp
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Endpoints;

namespace PRism.Web.Tests.Sse;

public class StateChangedSseTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public StateChangedSseTests(WebApplicationFactory<Program> f) { _factory = f; }

    [Fact]
    public async Task PutDraft_PublishesStateChanged_FlowsToSseSubscribers()
    {
        var sseClient = _factory.CreateClient();
        sseClient.DefaultRequestHeaders.Add("X-PRism-Session", "test-session");
        sseClient.Timeout = TimeSpan.FromSeconds(10);

        var sseStream = sseClient.GetStreamAsync("/api/events");

        var putClient = _factory.CreateClient();
        putClient.DefaultRequestHeaders.Add("X-PRism-Session", "test-session");
        putClient.DefaultRequestHeaders.Add("X-PRism-Tab-Id", "tab-1");
        var patch = new ReviewSessionPatch(
            DraftSummaryMarkdown: "summary",
            null, null, null, null, null, null, null, null, null, null, null);
        await putClient.PutAsJsonAsync("/api/pr/acme/api/123/draft", patch);

        // Read SSE stream, look for state-changed event
        using var reader = new StreamReader(await sseStream);
        var observed = "";
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var line = await reader.ReadLineAsync();
            if (line is null) break;
            observed += line + "\n";
            if (observed.Contains("event: state-changed") && observed.Contains("acme/api/123"))
                break;
        }

        Assert.Contains("event: state-changed", observed);
        Assert.Contains("\"prRef\":\"acme/api/123\"", observed);
        Assert.Contains("\"sourceTabId\":\"tab-1\"", observed);
    }
}
```

- [ ] **Step 3: Run tests**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~DraftRaceTests|FullyQualifiedName~StateChangedSseTests"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.Web.Tests/Concurrency tests/PRism.Web.Tests/Sse
git commit -m "test(s4-pr3): draft-race + SSE state-changed flow tests"
```

---

### Task 31: Update spec/02 wire-shape table

**Files:**
- Modify: `docs/spec/02-architecture.md`

- [ ] **Step 1: Find the wire-shape table**

Open `docs/spec/02-architecture.md` and locate the `PUT /api/pr/{ref}/draft` body section (~line 328). The current jsonc block enumerates the patch kinds.

- [ ] **Step 2: Add the three new patch kinds**

Add to the jsonc block:

```jsonc
"newPrRootDraftComment": { "bodyMarkdown": "..." },
"confirmVerdict": true,
"markAllRead": true,
"overrideStale": { "id": "uuid" }
```

If the existing prose says "n patch fields" or similar with a count, update accordingly.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/02-architecture.md
git commit -m "docs(spec/02): add newPrRootDraftComment + confirmVerdict + markAllRead + overrideStale patch kinds"
```

---

### Task 32: Verify PR3 green; push

- [ ] **Step 1: Full test sweep**

Run: `dotnet test`
Expected: ALL PASS.

- [ ] **Step 2: Push**

```bash
git push origin docs/s4-drafts-and-composer-spec
```

---

# Phase 4 — PR4: Frontend draft client + composer hook + inline composer

**PR title:** `feat(s4-pr4): draft client (useDraftSession + api/draft) + useComposerAutoSave + InlineCommentComposer`

**Spec sections:** § 5.1 (component tree), § 5.2 (state architecture), § 5.3 (composer auto-save model), § 5.3a (composer Esc/Discard flow), § 5.7 (multi-tab subscriber), § 5.8 (AI placeholder slots), § 5.9 (TS types).

## Frontend implementation requirements addendum (applies to PR4-PR7)

These requirements were surfaced by the design-lens review of the plan. The per-task descriptions in Phases 4-7 hit the load-bearing surfaces; these addenda fill in the spec-mandated details that weren't enumerated per-task. Apply during the relevant task; cross-reference here when a Vitest test file lands.

### A1. AI placeholder slots (spec § 5.8) — wire in PR4 + PR6

Three slot components, all rendering `null` when their capability flag is `false` (the PoC default; capability hook from S0+S1 is `useCapability(flag)` — verify exact name in `frontend/src/hooks/useCapability.ts` from S3):

| Slot | Mounted at | Capability flag |
|---|---|---|
| `<AiComposerAssistant>` | Inside `InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer` next to the Save button | `ai.composerAssist` |
| `<AiDraftSuggestionsPanel>` | Top of `DraftsTab`, above the list (Task 43) | `ai.draftSuggestions` |
| AI badge slot inside `StaleDraftRow` | Per stale draft in `UnresolvedPanel` (Task 44) | `ai.draftReconciliationAssist` |

Per slot:
- Create a stub `.tsx` file at `frontend/src/components/Ai/<Name>.tsx`. Component reads its capability via `useCapability('ai.<flag>')`; returns `null` when false; otherwise returns a placeholder div (whatever existing AI Placeholder pattern S2/S3 ships with; verify via existing `<AiSummarySlot>` from S3).
- Add the slot mount point at the designated parent.
- Add a Vitest test asserting renders-null when capability is false.

The three new flag names must also be added to the `/api/capabilities` response shape on the backend per spec § 5.8 — done in PR4 alongside slot creation (or in a small backend follow-up PR if the capability dispatcher is closed for changes by PR3).

### A2. "Click another line while composer is open" flow (spec § 5.3a) — Task 39 sub-step

In Task 39 Step 5 (wire diff-line-click), before mounting `<InlineCommentComposer>` at the new anchor, check whether a composer is already mounted for a different anchor in the same tab:
- If no existing composer mounted: mount the new one (current behavior).
- If existing composer mounted AND has no `draftId` yet: close the existing composer (no PUT — nothing to discard server-side), mount the new one.
- If existing composer mounted AND has a `draftId`: surface a `Modal` (Task 38 primitive) titled "You have a saved draft on line N. Discard or keep it as you switch to line M?" with two buttons:
  - `Discard`: send `deleteDraftComment(draftId)`, close existing composer, mount new one.
  - `Keep`: leave existing composer's draft saved (it remains visible in the Drafts tab and reappears if user navigates back to line N), close current composer panel, mount new one at line M.

Tests:
- `ClickAnotherLine_NoExistingDraft_OpensNewComposerImmediately`
- `ClickAnotherLine_ExistingDraftSaved_ShowsModalWithDiscardOrKeep`
- `ClickAnotherLine_DiscardBranch_FiresDeleteDraftComment`
- `ClickAnotherLine_KeepBranch_LeavesDraftPersisted`

### A3. Composer accessibility (spec § 5.5c) — Tasks 39 / 40 / 42 sub-step

Every composer (`InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`) MUST:
- Set `role="form"` on the outer container.
- Set `aria-label` to the anchor description (e.g., `"Draft comment on src/Foo.cs line 42"` for inline; `"Reply to thread PRRT_..."` for reply; `"Reply to this PR"` for PR-root). Use a helper `composerAriaLabel(anchor)` to centralize.
- `ComposerMarkdownPreview` (Task 39 Step 3) gets `tabIndex={0}` on its container so Tab from the textarea reaches the preview pane when toggled on. Without `tabIndex`, the focus skips it. Include a Vitest test `Tab_FromTextarea_ReachesPreview_WhenToggleOn`.
- Save button: `aria-disabled={!body.trim()}` when body empty; tooltip "Type something to save."

### A4. Modal `disableEscDismiss` prop (spec § 5.3 recovery modal) — Task 38 sub-step

The 404-recovery modal (per spec § 5.3) explicitly says: "The modal is dismissable only by one of the two actions (no Esc-to-dismiss; the user must choose, otherwise the composer is in an inconsistent state)."

Add an optional prop to the Modal primitive:
```typescript
export interface ModalProps {
  // ... existing props ...
  disableEscDismiss?: boolean;   // default false
}
```

In the keydown handler: only call `onClose` on Esc when `!disableEscDismiss`. Add Vitest test `EscKey_Suppressed_WhenDisableEscDismissTrue`.

Task 39 Step 4's recovery modal sets `disableEscDismiss={true}`.

### A5. `VerdictReconfirmRow` implementation (spec § 5.5) — Task 44 sub-step

Task 44's Step 4 lists `VerdictReconfirmRow_FiresConfirmVerdictPatch` as a test — but Step 1 doesn't create the row. Add to Step 1:

```tsx
// frontend/src/components/PrDetail/Reconciliation/VerdictReconfirmRow.tsx
import { sendPatch } from '../../../api/draft';

export function VerdictReconfirmRow({ prRef, sessionToken }: { prRef: string; sessionToken: string }) {
  return (
    <div role="group" aria-label="Verdict re-confirm">
      <p>Verdict needs re-confirm because the PR head shifted. Click your verdict to confirm:</p>
      <button onClick={() => sendPatch(prRef, { kind: 'confirmVerdict' }, sessionToken)}>Confirm</button>
    </div>
  );
}
```

`UnresolvedPanel` mounts `<VerdictReconfirmRow>` when `session.draftVerdictStatus === 'needs-reconfirm'`, alongside (above) the per-stale-draft rows. The single "Confirm" button fires `confirmVerdict` patch — the user's existing verdict (Approve / RequestChanges / Comment) is preserved server-side; the click just flips `DraftVerdictStatus` from `NeedsReconfirm` back to `Draft`.

(The spec's framing — "Single click on the verdict picker calls `confirmVerdict` patch" — is preserved with this minimal shape. If dogfooding shows users want to *change* the verdict at re-confirm time, a future task can extend the row with the three-button picker. Not S4 scope.)

### A6. `MarkdownRendererSecurity.test.tsx` parameterization update — Tasks 43 + 44 sub-step

Per spec § 5.6's reuse rule, every render site for `bodyMarkdown` (composer preview, `DraftListItem` body preview, `StaleDraftRow` body display, `DiscardAllStaleButton` confirm modal preview) must route through the shared `MarkdownRenderer`. The `MarkdownRendererSecurity.test.tsx` (Task 38) is parameterized over the consumer list; when Tasks 43 (DraftListItem, DraftListEmpty, DiscardAllStaleButton) and 44 (StaleDraftRow body) land, **append** to the parameterized fixture:

```typescript
// In MarkdownRendererSecurity.test.tsx
const COMPONENTS = [
  // PR4 (added in Task 38)
  { name: 'ComposerMarkdownPreview', render: (md: string) => <ComposerMarkdownPreview body={md} /> },
  // PR6 (added in Tasks 43 + 44)
  { name: 'DraftListItem.preview', render: (md: string) => <DraftListItem ...preview={md} /> },
  { name: 'StaleDraftRow.body', render: (md: string) => <StaleDraftRow ...body={md} /> },
  { name: 'DiscardAllStaleButton.modalPreview', render: (md: string) => /* render the modal */ },
];

it.each(COMPONENTS)('$name renders javascript: URL as escaped text', ({ render }) => { /* ... */ });
```

Tasks 43 and 44 each include a step "extend `MarkdownRendererSecurity.test.tsx` with this component as a parameterized case" — without it, the spec § 5.6 enforcement is prose-only.

### A7. `useStateChangedSubscriber` inbox-badge invalidation test — Task 39 Step 2 addition

Add to Task 39 Step 2's test list:
- `StateChanged_LastSeenCommentId_InvalidatesInboxBadge` (per spec § 5.10) — fire a fake `state-changed` event with `fieldsTouched: ['last-seen-comment-id']`; assert the inbox badge invalidation hook is called.

### A8. Cross-tab "Switch to other tab" — sender-side test (Task 45 Step 4 addition)

Add to Task 45 Step 4:
- `SwitchToOtherTab_PostsRequestFocusMessage` — render the banner; click "Switch to other tab"; assert `BroadcastChannel.postMessage({ kind: "request-focus", tabId })` was called.

### A9. `bool? ConfirmVerdict` / `bool? MarkAllRead` JSON binding — backend + TS client contract

The backend `ReviewSessionPatch` uses `bool? ConfirmVerdict` / `bool? MarkAllRead`. `System.Text.Json` deserializes `false` to `false` (not `null`), so a wire payload `{"confirmVerdict": false}` would have `ConfirmVerdict = false` in the C# record. The `EnumerateSetFields` check `if (p.ConfirmVerdict == true)` correctly treats `false` as "not set" — but the multi-field guard would then reject the patch (zero fields set) with `400 invalid-patch-shape`.

The TS client at `api/draft.ts` (Task 34) already handles this correctly: `serializePatch` for `kind: 'confirmVerdict'` returns `{ confirmVerdict: true }` (literal true; never serializes `false`). This must remain — a refactor that emits `false` for "absent" via `JSON.stringify` over an object with default values would break the contract.

Add a Vitest test `serializePatch_ConfirmVerdict_AlwaysEmitsTrue_NeverFalse` in `api/draft.test.ts` (Task 34 Step 2).

---

### Task 33: Add new TS types in `frontend/src/api/types.ts`

- [ ] **Step 1: Append to `frontend/src/api/types.ts`** the S4 draft types per spec § 5.9 — `DraftStatus`, `DraftVerdictValue`, `DraftVerdictStatus`, `DraftCommentDto`, `DraftReplyDto`, `IterationOverrideDto`, `FileViewStateDto`, `ReviewSessionDto`, `ReviewSessionPatch` discriminated union (12 variants), and SSE event payload types (`StateChangedEvent`, `DraftSavedEvent`, `DraftDiscardedEvent` — all with `sourceTabId: string | null`).

- [ ] **Step 2: Commit**: `feat(s4-pr4): TS types for draft session + patch DU + SSE events`

---

### Task 34: Add `api/draft.ts` wrapper with exhaustiveness check

- [ ] **Step 1: Create `frontend/src/api/draft.ts`** with `getDraft(prRef, sessionToken)`, `sendPatch(prRef, patch, sessionToken)`, `postReload(prRef, headSha, sessionToken)`, and a per-launch `TAB_ID = crypto.randomUUID()` exposed via `getTabId()`. The `serializePatch` switch ends with a `const _exhaustive: never = p` line (compile-time guarantee). Set `X-PRism-Session` and `X-PRism-Tab-Id` headers on every request. Map 200 / 404 / 422 / 409 status codes to `{ ok, ... }` discriminated result.

- [ ] **Step 2: Write `frontend/__tests__/api/draft.test.ts`** — one round-trip test per patch kind asserting wire shape has exactly one top-level field set; one test confirming `sendPatch` includes `X-PRism-Tab-Id` header.

- [ ] **Step 3: Run + commit**: `feat(s4-pr4): api/draft.ts wrapper + exhaustiveness tests`

---

### Task 35: Extend `frontend/src/api/events.ts` with new SSE event names

- [ ] **Step 1: Locate `EventPayloadByType` map and `addEventListener` registration loop** (`grep -n "EventPayloadByType\|addEventListener" frontend/src/api/events.ts`).

- [ ] **Step 2: Add three entries to `EventPayloadByType`**: `'state-changed': StateChangedEvent`, `'draft-saved': DraftSavedEvent`, `'draft-discarded': DraftDiscardedEvent`. Add the three names to the registration loop's tuple. Verify `npm run build --prefix frontend` succeeds.

- [ ] **Step 3: Commit**: `feat(s4-pr4): SSE event-name registry extended with state-changed + draft-saved + draft-discarded`

---

### Task 36: Add `useDraftSession` with diff-and-prefer merge

- [ ] **Step 1: Create `frontend/src/hooks/useDraftSession.ts`** — `useState<ReviewSessionDto | null>` + `useEffect` that fetches `getDraft` and merges via the diff-and-prefer rule:
  - **`registerOpenComposer` refcount semantics:** the registry is `Map<draftId, number>` (refcount), NOT `Set<draftId>`. Each call to `registerOpenComposer(id)` increments the count and returns a cleanup that decrements. The "is this id open" predicate is `count > 0`. This handles the case where two composers in the same tab open for the same draft id (e.g., `InlineCommentComposer` mounted in Files tab + user clicks `Edit` in Drafts tab without unmounting the first); the second composer's mount doesn't clobber the first composer's protection when the second unmounts. Merger uses `(registry.get(id) ?? 0) > 0` to decide protection.
  - For each id present in both local and server: if `(registry.get(id) ?? 0) > 0`, keep local body but accept server `status` / `isOverriddenStale`; otherwise use server.
  - For each id present only server: add to local list.
  - For each id present only local: drop. (The composer's next save will hit 404 and trigger the recovery modal — Task 37.)
  - When the merger detects a remote body change for an id with no open composer: call `setOutOfBandToast({ draftId, filePath })`. Return `{ session, status, error, refetch, registerOpenComposer, outOfBandToast, clearOutOfBandToast }`.

- [ ] **Step 2: Write `frontend/__tests__/hooks/useDraftSession.test.ts`** with 5 tests:
  - `DiffAndPreferMerge_KeepsLocalBody_WhenComposerOpen`
  - `DiffAndPreferMerge_AcceptsServer_WhenNoComposerOpen`
  - `DraftDeletedElsewhere_RemovesFromLocalList`
  - `OutOfBandUpdate_NoComposer_FiresToast`
  - `OutOfBandUpdate_OwnTab_NoToast` (via `useStateChangedSubscriber` filter; this test mocks the subscriber's source-tab filter)

- [ ] **Step 3: Run + commit**: `feat(s4-pr4): useDraftSession with diff-and-prefer merge + out-of-band toast`

---

### Task 37: Add `useComposerAutoSave` (threshold + in-flight-create promise + 404 recovery + retry)

- [ ] **Step 1: Create `frontend/src/hooks/useComposerAutoSave.ts`**:
  - **`prState` parameter** (per spec § 6 closed/merged handling): hook accepts `prState: 'open' | 'closed' | 'merged'`. When `prState !== 'open'`, the debounce body short-circuits before any PUT (no auto-save while PR is closed/merged); the composer renders a per-composer banner "PR closed — text not saved" — that's the composer's responsibility (Task 39).
  - 250 ms debounce via `setTimeout` cleared on body-state-change.
  - Threshold: `body.trim().length >= 3` (UTF-16 code units; `bodyMarkdown.trim().length` per spec § 5.3 emoji edge note). Sub-threshold debounces are no-ops *unless* `draftId !== null`.
  - **Threshold gate on existing drafts (body shrinks below 3 chars after creation):** when `draftId !== null` AND `body.trim().length < 3`:
    - If `body.trim().length === 0` → fire `deleteDraftComment` (or reply variant) and unmount the composer (per spec § 5.4 "When body is empty: no confirmation — instant delete (defensive against the rare zero-body draft that survived the threshold somehow)"). The "somehow" is THIS path.
    - If `body.trim().length` is 1 or 2 → still fire `updateDraftComment` (the user is mid-edit; trust them). Persisting a 2-char body is acceptable; the threshold is for *creation* only.
  - In-flight create: a `Promise<assignedId> | null` ref. While non-null, subsequent debounces `await` it before deciding create-vs-update. Cleared on completion.
  - Status badge state: `'saved' | 'saving' | 'unsaved' | 'rejected'` driven by HTTP response.
  - 404 from `updateDraftComment` / `updateDraftReply`: clears local `draftId`, calls `onDraftDeleted` callback (composer surfaces recovery modal — Task 39).
  - 5xx / network: keeps local body, sets badge `'unsaved'`, retry on next keystroke.
  - 422: badge `'rejected'`, no retry.
  - `flush()` method force-fires the save (used by Cmd+Enter and Reload-blocked modal "Save as draft").

- [ ] **Step 2: Write `frontend/__tests__/hooks/useComposerAutoSave.test.ts`** — at minimum 7 tests:
  - `Debounce_250ms_BatchesKeystrokes`
  - `BodyBelow3Chars_NoPut_NoDraftCreated`
  - `BodyAt3Chars_FiresNewDraftComment`
  - `EmptyComposer_NoPut_NoDraftCreated`
  - `AfterAssignedId_SubsequentKeystrokesUseUpdateDraftComment`
  - `InFlightCreate_QueuesSubsequentDebounce_NoDuplicateCreate`
  - `Update404_TriggersDraftDeletedRecoveryCallback`
  - `Network5xx_KeepsLocalBody_MarksUnsaved_RetriesOnNextKeystroke`
  - `Body422_SurfacesRejectedBadge_NoRetry`

- [ ] **Step 3: Run + commit**: `feat(s4-pr4): useComposerAutoSave (threshold + in-flight promise + 404 recovery + retry on next keystroke)`

---

### Task 38: Add `Modal` primitive + `MarkdownRendererSecurity` test

- [ ] **Step 1: Create `frontend/src/components/Modal.tsx`** implementing the spec § 5.5a focus-trap rules:
  - On open: focus moves to the button with `data-modal-role="cancel"` if `defaultFocus="cancel"`, else `"primary"`.
  - Tab cycles within the dialog (Shift+Tab cycles backward; both wrap at edges).
  - Esc invokes `onClose`.
  - On unmount: focus returns to the previously-active element.
  - Carries `role="dialog"`, `aria-modal="true"`, `aria-labelledby="modal-title"`.

- [ ] **Step 2: Write `frontend/__tests__/Modal.test.tsx`**:
  - `OnOpen_FocusMovesToDefaultButton`
  - `TabKey_TrapsFocusInModal`
  - `EscKey_ClosesViaCancelAction`
  - `OnClose_FocusReturnsToTrigger`

- [ ] **Step 3: Verify `MarkdownRenderer` exists from S3** (`grep -rn "MarkdownRenderer" frontend/src`). If absent, create as a `react-markdown` v9 wrapper with `urlTransform` allowlist of `http`, `https`, `mailto` per spec/03 § 4. Reuse single instance everywhere.

- [ ] **Step 4: Write `frontend/__tests__/MarkdownRendererSecurity.test.tsx`**:
  - `JavascriptUrl_RendersAsEscapedText_NotHref` — assert no `<a>` with `href` matching `^javascript:`.
  - `RawHtmlScriptTag_StrippedFromOutput` — assert no `<script>` in rendered output.
  - Parameterized over each component that calls `MarkdownRenderer` (composer preview, DraftListItem preview, StaleDraftRow body, discard-all modal preview — these are added in subsequent PRs; this test is updated as components land).

- [ ] **Step 5: Commit**: `feat(s4-pr4): Modal primitive (focus-trap) + MarkdownRenderer hardening tests`

---

### Task 39: Add `useStateChangedSubscriber` + `InlineCommentComposer`; wire diff-line-click

- [ ] **Step 1: Create `frontend/src/hooks/useStateChangedSubscriber.ts`** — subscribes to `state-changed` SSE; filters out events where `sourceTabId === getTabId()` (suppresses own-tab refetch noise per spec § 5.7). Calls `refetch()` on matching events.

- [ ] **Step 2: Write `frontend/__tests__/hooks/useStateChangedSubscriber.test.ts`**:
  - `StateChanged_DraftComments_InvalidatesDraftSession`
  - `StateChanged_OwnTab_DoesNotRefetch`
  - `StateChanged_OtherPrRef_Ignored`

- [ ] **Step 3: Create `frontend/src/components/PrDetail/Composer/ComposerMarkdownPreview.tsx`** — wraps `MarkdownRenderer` in a `role="region"` with `aria-label="Markdown preview"`.

- [ ] **Step 4: Create `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx`**:
  - Uses `useComposerAutoSave` with `anchor: { kind: 'inline-comment', filePath, lineNumber, side, anchoredSha, anchoredLineContent }`.
  - Calls `props.registerOpenComposer(draftId)` (returns cleanup) once the draft is created — register/unregister via `useEffect` watching `draftId`.
  - Renders textarea + Save button + Discard button + preview toggle (`Cmd/Ctrl+Shift+P` keyboard shortcut, `aria-pressed`).
  - Save button: `aria-disabled` when body empty; tooltip "Type something to save."
  - `Cmd/Ctrl+Enter` on the textarea calls `auto.flush()` then `props.onClose()`.
  - `Esc` on the textarea: if `draftId !== null`, prompt `Modal` "Discard saved draft?" with `defaultFocus="cancel"`; on confirm, sends `deleteDraftComment` patch and unmounts. If `draftId === null`, just unmounts (nothing to discard server-side).
  - 404-recovery modal: on `onDraftDeleted` callback from `useComposerAutoSave`, render a `Modal` with two buttons "Re-create" (calls `flush()` → creates new draftId with current body) and "Discard" (closes composer).

- [ ] **Step 5: Wire into S3's diff renderer**: In the existing `FilesTab` diff-line-click handler, render `<InlineCommentComposer>` mounted to the clicked line with anchor metadata pulled from the diff context. Pass `prRef`, `sessionToken`, `registerOpenComposer` (from parent's `useDraftSession`).

- [ ] **Step 6: Run all frontend tests**: `npm test --prefix frontend`. Expected: ALL PASS.

- [ ] **Step 7: Commit + push**: `feat(s4-pr4): InlineCommentComposer + useStateChangedSubscriber + diff-line-click integration`. Then `git push origin docs/s4-drafts-and-composer-spec`.

---

# Phase 5 — PR5: Reply composer + PR-root composer + Mark all read

**PR title:** `feat(s4-pr5): ReplyComposer + PrRootReplyComposer + Mark-all-read button`

**Spec sections:** § 5.6, § 5.1 (`useFirstActivePrPollComplete`).

---

### Task 40: Add `ReplyComposer.tsx`

- [ ] **Step 1: Create the component** — same shape as `InlineCommentComposer` but anchor is `{ kind: 'reply', parentThreadId }`. Mounts on click of the existing thread's "Reply" button (S3 component — find via `grep -n "Reply\b" frontend/src/components/PrDetail/`).

- [ ] **Step 2: Write `frontend/__tests__/ReplyComposer.test.tsx`**:
  - First non-whitespace keystroke ≥ 3 chars fires `newDraftReply` with the parent thread id.
  - Esc with draftId saved prompts discard-confirm modal; on confirm, sends `deleteDraftReply`.

- [ ] **Step 3: Wire into existing-thread "Reply" buttons in S3's thread renderer.**

- [ ] **Step 4: Commit**: `feat(s4-pr5): ReplyComposer (anchored to existing thread Node ID)`

---

### Task 41: Add `useFirstActivePrPollComplete` hook

- [ ] **Step 1: Create `frontend/src/hooks/useFirstActivePrPollComplete.ts`**:

```typescript
import { useEffect, useState } from 'react';
import { onEvent } from '../api/events';

export function useFirstActivePrPollComplete(prRef: string): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    const unsub = onEvent('pr-updated', (evt) => {
      if (evt.prRef === prRef) setReady(true);
    });
    return unsub;
  }, [prRef]);
  return ready;
}
```

- [ ] **Step 2: Write `frontend/__tests__/hooks/useFirstActivePrPollComplete.test.ts`**:
  - `BeforeFirstPoll_ReturnsFalse`
  - `AfterFirstPoll_ReturnsTrue`
  - `PrRefChange_ResetsToFalse`

- [ ] **Step 3: Commit**: `feat(s4-pr5): useFirstActivePrPollComplete (gates Mark-all-read button until first PR poll)`

---

### Task 42: Add `PrRootReplyComposer` + `MarkAllReadButton` on Overview tab

- [ ] **Step 1: Create `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`** — same composer pattern with `anchor: { kind: 'pr-root' }`. On first qualifying keystroke, sends `newPrRootDraftComment` patch.

- [ ] **Step 2: Create `frontend/src/components/PrDetail/Overview/MarkAllReadButton.tsx`**:

```tsx
import { useFirstActivePrPollComplete } from '../../../hooks/useFirstActivePrPollComplete';
import { sendPatch } from '../../../api/draft';

export function MarkAllReadButton({ prRef, sessionToken }: { prRef: string; sessionToken: string }) {
  const ready = useFirstActivePrPollComplete(prRef);
  return (
    <button
      disabled={!ready}
      onClick={() => sendPatch(prRef, { kind: 'markAllRead' }, sessionToken)}
      title={ready ? 'Mark all conversation comments read' : 'Loading…'}
      aria-disabled={!ready}
    >
      Mark all read
    </button>
  );
}
```

- [ ] **Step 3: Wire into S3's Overview-tab conversation header** — replace the existing `pr-conv-reply` button + add `MarkAllReadButton` next to it.

- [ ] **Step 4: Tests** — `MarkAllReadButton_DisabledBeforeFirstPoll`, `MarkAllReadButton_FiresMarkAllReadPatch_AfterPoll`, `PrRootReplyComposer_FirstKeystroke_FiresNewPrRootDraftComment`.

- [ ] **Step 5: Commit + push**: `feat(s4-pr5): PrRootReplyComposer + MarkAllReadButton on Overview tab` then `git push`.

---

# Phase 6 — PR6: Drafts tab + Reconciliation panel

**PR title:** `feat(s4-pr6): DraftsTab activated + UnresolvedPanel sticky-top`

**Spec sections:** § 5.4 (Drafts tab content), § 5.5 (UnresolvedPanel + override-stale endpoint behavior), § 5.5a (modal focus rules — uses Task 38 Modal), § 5.5b (panel keyboard nav + aria-live).

---

### Task 43: Replace `DraftsTabDisabled` with `DraftsTab` + sub-components

- [ ] **Step 1: Delete `frontend/src/components/PrDetail/DraftsTab/DraftsTabDisabled.tsx`** and create `DraftsTab.tsx` per spec § 5.4.

- [ ] **Step 2: Sub-components** (each in its own file under `DraftsTab/`):
  - `DraftListItem.tsx` — per-row: status chip (`Draft` / `Moved (line M → N)` / `Stale (reason)`); ambiguity chip when `alternateMatchCount > 0`; override chip when `isOverriddenStale === true`; body preview via `MarkdownRenderer`; `Edit` (cross-tab navigation), `Delete` (confirmation modal), `Jump to file`.
  - `DraftListEmpty.tsx` — "No drafts on this PR yet. Open any line in the Files tab to start one."
  - `DraftsTabSkeleton.tsx` — shimmer header + 3 row skeletons.
  - `DraftsTabError.tsx` — inline card "Couldn't load drafts. [Retry]" (calls `useDraftSession.refetch()`).
  - `DiscardAllStaleButton.tsx` — visible only when `staleCount >= 1`; opens confirm modal (count + first-3 previews; both comments and replies; labels each as `[thread on path:line]` or `[reply on PRRT_…]`); on confirm, iterates `deleteDraftComment` / `deleteDraftReply` per stale id.

- [ ] **Step 3: Wire `DraftsTab` into S3 routing** — replace the route binding `DraftsTabDisabled` → `DraftsTab` in `frontend/src/App.tsx` (or wherever S3 wired the routes per spec/specs/2026-05-06-s3-pr-detail-read-design.md § 7).

- [ ] **Step 4: Update Drafts-tab-strip count** — the existing tab strip badge (S3 component `PrSubTabStrip`) currently counts as 0; wire it to `useDraftSession().session?.draftComments.length`.

- [ ] **Step 5: Write tests** per spec § 5.10:
  - `RendersLoadingSkeleton_WhilePending`
  - `RendersErrorCard_OnLoadFailure`
  - `RendersEmptyState_WhenNoDrafts`
  - `RendersDraftsGroupedByFile`
  - `RendersStaleBadge_WhenStaleCountGtZero`
  - `RendersOverrideChip_WhenIsOverriddenStale`
  - `DiscardAllStaleButton_VisibleOnlyWhenStaleCountGtZero`
  - `DiscardAllStaleConfirmModal_ListsCountAndPreviews`
  - `EditAction_NavigatesToFilesTabAndOpensComposer`
  - `DeleteAction_OpensConfirmation_FocusesCancel`

- [ ] **Step 6: Commit**: `feat(s4-pr6): DraftsTab activated + sub-components (loading/error/empty/list/discard-all)`

---

### Task 44: Add `UnresolvedPanel` + `StaleDraftRow` + Keep-anyway flow

- [ ] **Step 1: Create `frontend/src/components/PrDetail/Reconciliation/UnresolvedPanel.tsx`**:
  - Renders sticky-top when `staleCount > 0` (excluding `isOverriddenStale === true` drafts) OR `draftVerdictStatus === 'needs-reconfirm'`.
  - `role="region"`, `aria-label="Unresolved drafts"`, `tabIndex={-1}` (focusable programmatically per spec § 5.5b).
  - Summary line: omits clauses with zero count.
  - `aria-live="polite"` region announces transitions (`All drafts reconciled.` / `N drafts need attention.`).
  - Per-row tab order matches visual order.

- [ ] **Step 2: Create `StaleDraftRow.tsx`** — four actions per spec § 5.5: `Show me` (cross-tab nav to `/files/<path>?line=N`; focus the diff line container with `tabIndex={-1}` + `.focus()`), `Edit` (Task 43's Edit mechanic), `Delete` (uses Modal primitive), `Keep anyway` (sends `overrideStale` patch via `sendPatch({ kind: 'overrideStale', payload: { id } })`).

- [ ] **Step 3: Mount `UnresolvedPanel` sticky-top** in the existing PR-detail layout (above `PrSubTabStrip`) — shared across Overview / Files / Drafts.

- [ ] **Step 4: Tests** per spec § 5.10:
  - `RendersOnEveryTab_WhenStaleCountGtZero`
  - `HiddenWhenNoStaleAndNoVerdictReconfirm`
  - `OverriddenStaleDraft_NotCountedTowardStaleCount`
  - `VerdictReconfirmRow_FiresConfirmVerdictPatch`
  - `KeepAnyway_FiresOverrideStalePatch_RowDisappears`
  - `KeyboardNavigation_TabOrderMatchesVisualOrder`
  - `AriaLive_AnnouncesStaleCountTransition`

- [ ] **Step 5: Commit + push**: `feat(s4-pr6): UnresolvedPanel sticky-top + StaleDraftRow with overrideStale wire-up` then `git push`.

---

# Phase 7 — PR7: Multi-tab consistency + cross-tab presence + Playwright

**PR title:** `feat(s4-pr7): cross-tab presence banner + reload retry + Playwright E2E`

**Spec sections:** § 3.3 (`409 reload-stale-head` retry behavior), § 5.7a (cross-tab presence), § 5.10 (Playwright E2E).

---

### Task 45: Add `useCrossTabPrPresence` hook + banner

- [ ] **Step 1: Create `frontend/src/hooks/useCrossTabPrPresence.ts`** per spec § 5.7a:
  - Channel: `prism:pr-presence:<prRef>`.
  - On mount: post `{ kind: 'open', tabId }`.
  - On `'open'` from a different `tabId`: surface banner.
  - On `'request-focus'`: call `window.focus()`.
  - On `'claim'` from another tab: switch to read-only mode (return `readOnly: true`).
  - `dismissForSession()`: write `sessionStorage["prism:pr-presence-dismissed:" + prRef] = "true"` and suppress banner re-show.
  - Return `{ showBanner, readOnly, switchToOther, takeOver, dismissForSession }`.

- [ ] **Step 2: Create `CrossTabPresenceBanner.tsx`** — non-dismissable banner with three actions: Switch to other tab / Take over here / Dismiss for this session. Mount at top of PR-detail layout (above `UnresolvedPanel`).

- [ ] **Step 3: Read-only enforcement** — when `readOnly === true`, all composers render disabled (`disabled` on textarea + Save button); auto-save short-circuits; UI dims via CSS.

- [ ] **Step 4: Tests**:
  - `OpenSamePrInTwoTabs_BothTabsShowBanner`
  - `TakeOver_TransitionsOtherTabToReadOnly`
  - `BannerDismissForSession_PersistsToSessionStorage_NoReshow`
  - `RequestFocus_BringsOtherTabToFront` (mock `window.focus()`)

- [ ] **Step 5: Commit**: `feat(s4-pr7): useCrossTabPrPresence + CrossTabPresenceBanner (open/switch/take-over/dismiss)`

---

### Task 46: Wire `useReconcile` with `409 reload-stale-head` auto-retry

- [ ] **Step 1: Create `frontend/src/hooks/useReconcile.ts`**:
  - On user clicking Reload: fetch the current `headSha` from S3's active-PR cache (or pass through props).
  - Call `postReload(prRef, headSha, sessionToken)`.
  - If `409 reload-stale-head`: extract `currentHeadSha` from response, retry once with the new SHA. If second call also returns `409`: surface banner "Head shifted while reloading; please click Reload again." Stop retrying.
  - If `409 reload-in-progress`: surface banner "Reload already in progress; please wait." (no retry).
  - On success: replace `useDraftSession`'s session with the returned full DTO.

- [ ] **Step 2: Tests**:
  - `Reload_HappyPath_UpdatesSession`
  - `Reload_409StaleHead_AutoRetriesOnce_WithCurrentHeadSha`
  - `Reload_TwoConsecutive409StaleHead_StopsRetrying_SurfacesBanner`
  - `Reload_409InProgress_NoRetry_SurfacesBanner`

- [ ] **Step 3: Commit**: `feat(s4-pr7): useReconcile with 409 reload-stale-head auto-retry`

---

### Task 47: Set up Playwright fixture infrastructure

- [ ] **Step 1: Create `tests/PRism.Web.Tests/Fakes/FakeReviewService.cs`** (or similar location matching project convention) — a test-only `IReviewService` impl that:
  - Reads canned PR-state JSON files from `frontend/e2e/fixtures/<scenario-name>.json`.
  - Exposes a state-mutation hook for advancing head SHAs / changing file content.

- [ ] **Step 2: Create `PRism.Web/TestHooks/TestEndpoints.cs`** (only registered when `ASPNETCORE_ENVIRONMENT=Test`):
  - `POST /test/advance-head?prRef=...&newHeadSha=...&fileChanges=...` mutates `FakeReviewService` state.
  - PR fixtures are loaded from `frontend/e2e/fixtures/<scenario>.json` at startup (no separate `POST /test/seed-pr` endpoint — fixtures are static-file-based, eliminating an endpoint with no current consumer).
  - **Env-flag implementation (load-bearing for security per spec § 6 / security review):**
    ```csharp
    public static void MapTestEndpoints(this WebApplication app)
    {
        if (!app.Environment.IsEnvironment("Test")) return;   // hard guard at registration
        app.MapPost("/test/advance-head", /* ... */);
    }
    ```
  - **`SessionTokenMiddleware` interaction:** the existing middleware (`PRism.Web/Middleware/SessionTokenMiddleware.cs`) enforces auth in non-Development environments (`!env.IsDevelopment()`). Under `ASPNETCORE_ENVIRONMENT=Test`, the middleware is enforced. Either: (a) bypass the middleware for `/test/*` routes via `MapWhen` in `Program.cs`, or (b) Playwright supplies the `X-PRism-Session` header to `/test/*` calls (matching how it supplies it for the actual API calls). Pick (b) — keeps security behavior uniform.
  - **Playwright env wiring** (`playwright.config.ts`):
    ```typescript
    webServer: {
      command: 'dotnet run --project PRism.Web',
      env: { ASPNETCORE_ENVIRONMENT: 'Test' },
      // ...
    }
    ```
  - Add a test: `TestEndpoints_NotRegisteredInProduction_404` (boots a `WebApplicationFactory` with `ASPNETCORE_ENVIRONMENT=Production`; asserts `POST /test/advance-head` returns 404).

- [ ] **Step 3: Create `frontend/e2e/fixtures/`** with starter scenarios:
  - `pr-with-three-iterations.json`
  - `pr-with-renamed-file.json`
  - `pr-after-force-push.json`

- [ ] **Step 4: Verify `npm run e2e --prefix frontend` infrastructure boots without errors against an empty fixture.**

- [ ] **Step 5: Commit**: `test(s4-pr7): Playwright fixture infrastructure (FakeReviewService + /test/* endpoints)`

---

### Task 48: Playwright E2E suite

- [ ] **Step 1: `frontend/e2e/s4-drafts-survive-restart.spec.ts`** — open PR → click line 42 → type "this needs work" → wait 300ms → close browser context → reopen at same URL → composer pre-filled with body at line 42.

- [ ] **Step 2: `frontend/e2e/s4-reconciliation-fires.spec.ts`** — save draft on iter-3 → `POST /test/advance-head?prRef=acme/api/123&newHeadSha=...&fileChanges=...` → click Reload → assert each row of the matrix produces the expected classification badge.

- [ ] **Step 3: `frontend/e2e/s4-multi-tab-consistency.spec.ts`** — open same PR in two browser contexts → both show cross-tab presence banner → save draft in tab A → tab B's draft list updates (after `state-changed` SSE) → open composer in tab B for *different* draft → tab A's update of *that* draft is held back from clobbering tab B's open composer.

- [ ] **Step 4: `frontend/e2e/s4-keep-anyway-survives-reload.spec.ts`** — save draft on iter-3 → fixture-trigger reconcile that classifies it Stale → click Keep anyway → click Reload (no new content change, head unchanged) → row stays absent from panel; remains in Drafts tab with override chip → fixture-trigger another head shift → row reappears (override cleared).

- [ ] **Step 5: Verify all E2E pass on CI**

Run: `npm run e2e --prefix frontend`
Expected: ALL PASS.

- [ ] **Step 6: Commit + push**: `test(s4-pr7): Playwright E2E (drafts-survive-restart + reconciliation + multi-tab + keep-anyway)` then `git push`.

---

### Task 49: Final verification + roadmap update

- [ ] **Step 1: Full test sweep**

Run: `dotnet test && npm test --prefix frontend && npm run e2e --prefix frontend`
Expected: ALL PASS.

- [ ] **Step 2: Manual demo capture**

Open the app → PR detail → save draft → quit and relaunch → draft visible at anchor → simulate teammate push (via `/test/advance-head` from a quick console fetch) → click Reload → reconciliation classifies. Capture as screencast attached to PR7.

- [ ] **Step 3: Update `docs/roadmap.md` S4 row**

Replace `Status: Not started` with `Shipped — PR1 (#NN), PR2 (#NN), PR3 (#NN), PR4 (#NN), PR5 (#NN), PR6 (#NN), PR7 (#NN). Plan: `plans/2026-05-10-s4-drafts-and-composer.md`.`

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md
git commit -m "docs(s4): mark S4 shipped on roadmap"
git push
```

---

## Self-review checklist

Before declaring this plan ready, the orchestrator should verify:

1. **Spec coverage:** Every section of `docs/specs/2026-05-09-s4-drafts-and-composer-design.md` maps to at least one task. Verify: § 1 (goals + non-goals + § 1.1a precedent boundary — referenced in spec; no new task needed), § 2.1–2.5 (Tasks 1–9), § 3.1–3.4 (Tasks 10–21), § 4.1–4.9 (Tasks 22–32), § 5.1–5.10 (Tasks 33–44), § 5.5a (Task 38 Modal), § 5.5b (Task 44 panel keyboard nav), § 5.5c (composer a11y in Task 39), § 5.7a (Task 45), § 6 (closed/merged: composer's `prState !== 'open'` short-circuit covered in Task 37; full closed/merged bulk-discard defers to S5 per spec), § 7 (error edges — distributed across endpoint/composer task tests), § 8 (test matrix — every row has a corresponding task), § 9 (this plan IS the sequencing).
2. **Placeholder scan:** No "TBD", "TODO", "fill in", "appropriate" patterns in this plan.
3. **Type consistency:**
   - `DraftStatus = Draft | Moved | Stale` (3 values) throughout.
   - `IsOverriddenStale: bool` on both `DraftComment` and `DraftReply`.
   - `sourceTabId: string | null` everywhere (header, event payload, hook filter).
   - 12 patch kinds consistent across § 4.2 wire-shape JSON, § 4.3 fieldsTouched table, `ReviewSessionPatch` TS DU, and `serializePatch` switch.
4. **Cross-task type/name references:**
   - Hooks: `useDraftSession`, `useComposerAutoSave`, `useStateChangedSubscriber`, `useFirstActivePrPollComplete`, `useCrossTabPrPresence`, `useReconcile`.
   - Components: `InlineCommentComposer`, `ReplyComposer`, `PrRootReplyComposer`, `ComposerMarkdownPreview`, `Modal`, `MarkdownRenderer`, `DraftsTab`, `DraftListItem`, `DraftListEmpty`, `DraftsTabSkeleton`, `DraftsTabError`, `DiscardAllStaleButton`, `UnresolvedPanel`, `StaleDraftRow`, `MarkAllReadButton`, `CrossTabPresenceBanner`.
   - Endpoints: `PUT/GET /api/pr/{ref}/draft`, `POST /api/pr/{ref}/reload`, `/api/events` (existing).
   - Bus events: `DraftSaved`, `DraftDiscarded`, `DraftSubmitted` (declared, not published in S4), `StateChanged`.
   - SSE event names (kebab-case): `state-changed`, `draft-saved`, `draft-discarded`.

If any of the above fail, fix inline and re-run the self-review.

---

## Where saved + execution handoff

Plan saved to `docs/plans/2026-05-10-s4-drafts-and-composer.md` (NOT `docs/superpowers/plans/` — per project CLAUDE.md location override).

