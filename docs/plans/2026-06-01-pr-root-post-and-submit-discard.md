# PR-root Post path + discard own pending review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Post path for PR-root drafts + the discard-own-pending-review endpoint + the V6→V7 state migration that unifies `DraftSummaryMarkdown` into the PR-root `DraftComment`, plus the SubmitDialog inline-edit toggle.

**Architecture:** Backend = new `IReviewSubmitter.CreateIssueCommentAsync` REST seam + `SubmitCancellationRegistry` primitive + extracted `SessionOverlays` helper + V6→V7 migration with multi-account loop and partial-rollback discriminator. Pipeline filters PR-root drafts out of `AttachThreads` and consumes them on success. Frontend = new shared `PrRootBodyEditor` consumed by `PrRootReplyComposer` and SubmitDialog inline-edit mode; new `DiscardPendingReviewConfirmationModal`; new `PrHeader` pill.

**Tech Stack:** .NET 10 (PRism.Core / PRism.Web / PRism.GitHub) — minimal hosting, xUnit + FluentAssertions. React 19 + TypeScript + Vite + CSS modules + Vitest + Playwright.

**Source spec:** `docs/specs/2026-06-01-pr-root-post-and-submit-discard-design.md`.

---

## Phase A — State model V7 + migration

### Task 1: Add `PostedCommentId` + `PostedBodySnapshot` fields to `DraftComment`

**Files:**
- Modify: `PRism.Core/State/AppState.cs:63-75`
- Test: `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs`

- [ ] **Step 1: Write the failing round-trip test**

Add to `AppStateRoundTripTests`:

```csharp
[Fact]
public void DraftComment_PostedFieldsRoundTrip()
{
    var draft = new DraftComment(
        Id: "d1",
        FilePath: null, LineNumber: null, Side: "pr",
        AnchoredSha: null, AnchoredLineContent: null,
        BodyMarkdown: "hello",
        Status: DraftStatus.Draft,
        IsOverriddenStale: false,
        ThreadId: null,
        PostedCommentId: 12345L,
        PostedBodySnapshot: "hello");

    var json = JsonSerializer.Serialize(draft, AppStateJson.Options);
    var roundTripped = JsonSerializer.Deserialize<DraftComment>(json, AppStateJson.Options);

    roundTripped.Should().BeEquivalentTo(draft);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~DraftComment_PostedFieldsRoundTrip"`
Expected: FAIL — `PostedCommentId` and `PostedBodySnapshot` do not exist on `DraftComment`.

- [ ] **Step 3: Add the fields with trailing defaults**

Edit `PRism.Core/State/AppState.cs:63-75`:

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
    long? PostedCommentId = null,
    string? PostedBodySnapshot = null);
```

- [ ] **Step 4: Verify the test passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~DraftComment_PostedFieldsRoundTrip" --no-build && dotnet build PRism.Core/PRism.Core.csproj -c Release`
Expected: PASS + clean Release build (no CS8019 noise per memory).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/State/AppState.cs tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs
git commit -m "feat(state): add DraftComment.PostedCommentId + PostedBodySnapshot (V7 prep)"
```

---

### Task 2: V6→V7 migration — code + golden-fixture tests

**Files:**
- Modify: `PRism.Core/State/AppStateStore.cs:11` (CurrentVersion = 7) and `:27-29` (register migration)
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs` (add `MigrateV6ToV7`)
- Modify: `PRism.Core/State/AppState.cs` (`AppState.Default` Version → 7)
- Test: `tests/PRism.Core.Tests/State/AppStateMigrationsTests.cs`
- Test fixtures: `tests/PRism.Core.Tests/State/Fixtures/V6/*.json` + `tests/PRism.Core.Tests/State/Fixtures/V7/*.json`

- [ ] **Step 1: Write failing test for summary-only lift**

Add to `AppStateMigrationsTests.cs`:

```csharp
[Fact]
public void MigrateV6ToV7_SummaryOnly_SynthesizesPrRootDraft()
{
    var root = LoadFixture("V6/summary_only.json");
    var migrated = AppStateMigrations.MigrateV6ToV7(root);

    var session = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
    session.ContainsKey("draftSummaryMarkdown").Should().BeFalse();

    var drafts = session["draftComments"]!.AsArray();
    drafts.Count.Should().Be(1);
    var draft = drafts[0]!.AsObject();
    draft["side"]!.GetValue<string>().Should().Be("pr");
    draft["filePath"]!.GetValue<string?>().Should().BeNull();
    draft["bodyMarkdown"]!.GetValue<string>().Should().Be("The summary text.");
    draft["status"]!.GetValue<string>().Should().Be("Draft");
}
```

Add fixture `V6/summary_only.json`:

```json
{
  "version": 6,
  "accounts": {
    "default": {
      "reviews": {
        "sessions": {
          "acme/api/123": {
            "draftComments": [],
            "draftReplies": [],
            "draftSummaryMarkdown": "The summary text.",
            "draftVerdict": null,
            "draftVerdictStatus": "Draft"
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~MigrateV6ToV7_SummaryOnly"`
Expected: FAIL — `MigrateV6ToV7` doesn't exist.

- [ ] **Step 3: Implement `MigrateV6ToV7`**

Add to `PRism.Core/State/Migrations/AppStateMigrations.cs`:

```csharp
public static JsonObject MigrateV6ToV7(JsonObject root)
{
    if (root["accounts"] is not JsonObject accounts) return root;

    // Partial-rollback discriminator: pre-scan every session for the V7-feature-leaked-into-V6 shape.
    foreach (var (accountKey, accountNode) in accounts)
    {
        if (accountNode is not JsonObject account) continue;
        if (account["reviews"] is not JsonObject reviews) continue;
        if (reviews["sessions"] is not JsonObject sessions) continue;
        foreach (var (sessionKey, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;
            var hasSummary = session["draftSummaryMarkdown"]?.GetValue<string?>() is { Length: > 0 };
            if (!hasSummary) continue;
            if (session["draftComments"] is not JsonArray drafts) continue;
            foreach (var draftNode in drafts)
            {
                if (draftNode is not JsonObject draft) continue;
                if (draft["side"]?.GetValue<string>() != "pr") continue;
                if (draft["filePath"]?.GetValue<string?>() is not null) continue;
                if (draft["postedCommentId"]?.GetValue<long?>() is not null)
                    throw new JsonException(
                        $"V6 session {accountKey}/{sessionKey} has draftSummaryMarkdown set AND a PR-root draft with postedCommentId — refusing to lift (looks like a V7→V6 partial rollback).");
            }
        }
    }

    // Lift pass: per-account loop, per-session lift.
    foreach (var (_, accountNode) in accounts)
    {
        if (accountNode is not JsonObject account) continue;
        if (account["reviews"] is not JsonObject reviews) continue;
        if (reviews["sessions"] is not JsonObject sessions) continue;
        foreach (var (_, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;
            LiftSummaryIntoPrRootDraft(session);
        }
    }
    return root;
}

private static void LiftSummaryIntoPrRootDraft(JsonObject session)
{
    var summary = session["draftSummaryMarkdown"]?.GetValue<string?>();
    var trimmedSummary = summary?.Trim() ?? "";

    if (session["draftComments"] is not JsonArray drafts) drafts = new JsonArray();

    // Find PR-root drafts: side=="pr" AND filePath==null.
    var prRoots = new List<JsonObject>();
    for (int i = 0; i < drafts.Count; i++)
    {
        if (drafts[i] is not JsonObject d) continue;
        if (d["side"]?.GetValue<string>() != "pr") continue;
        if (d["filePath"]?.GetValue<string?>() is not null) continue;
        prRoots.Add(d);
    }

    // Collapse multiples (defensive — composer's `find` hydration would shadow them today).
    if (prRoots.Count > 1)
    {
        prRoots = prRoots.OrderBy(d => d["id"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
        var survivor = prRoots[^1];
        var sb = new StringBuilder();
        for (int i = 0; i < prRoots.Count - 1; i++)
        {
            var nonSurvivor = prRoots[i];
            sb.Append("<!-- migrated from previously-shadowed draft ");
            sb.Append(nonSurvivor["id"]!.GetValue<string>());
            sb.Append(" -->\n\n");
            sb.Append(nonSurvivor["bodyMarkdown"]?.GetValue<string>() ?? "");
            sb.Append("\n\n");
            drafts.Remove(nonSurvivor);
        }
        sb.Append(survivor["bodyMarkdown"]?.GetValue<string>() ?? "");
        survivor["bodyMarkdown"] = sb.ToString();
        prRoots = new List<JsonObject> { survivor };
    }

    // Lift the summary (if any).
    if (trimmedSummary.Length > 0)
    {
        if (prRoots.Count == 1)
        {
            var existing = prRoots[0]["bodyMarkdown"]?.GetValue<string>() ?? "";
            prRoots[0]["bodyMarkdown"] = existing.Length > 0
                ? existing + "\n\n" + summary
                : summary;
        }
        else
        {
            var synthesized = new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(),
                ["filePath"] = null,
                ["lineNumber"] = null,
                ["side"] = "pr",
                ["anchoredSha"] = null,
                ["anchoredLineContent"] = null,
                ["bodyMarkdown"] = summary,
                ["status"] = "Draft",
                ["isOverriddenStale"] = false,
                ["threadId"] = null,
                ["postedCommentId"] = null,
                ["postedBodySnapshot"] = null,
            };
            drafts.Add(synthesized);
            session["draftComments"] = drafts;
        }
    }

    session.Remove("draftSummaryMarkdown");
}
```

Update `AppStateStore.cs:24-28`:

```csharp
private static readonly (int Version, Func<JsonObject, JsonObject> Migration)[] Migrations =
{
    (2, AppStateMigrations.MigrateV1ToV2),
    (3, AppStateMigrations.MigrateV2ToV3),
    (4, AppStateMigrations.MigrateV3ToV4),
    (5, AppStateMigrations.MigrateV4ToV5),
    (6, AppStateMigrations.MigrateV5ToV6),
    (7, AppStateMigrations.MigrateV6ToV7),
};
```

Update `AppStateStore.cs:11`:

```csharp
private const int CurrentVersion = 7;
```

Update `AppState.cs` `AppState.Default`:

```csharp
public static AppState Default { get; } = new AppState(Version: 7, ...);
```

- [ ] **Step 4: Verify summary-only test passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~MigrateV6ToV7_SummaryOnly"`
Expected: PASS.

- [ ] **Step 5: Add remaining migration cases**

Add tests + fixtures in pairs:

```csharp
[Fact]
public void MigrateV6ToV7_PrRootOnly_NoSummary_Untouched()
{
    var root = LoadFixture("V6/pr_root_only.json");
    var migrated = AppStateMigrations.MigrateV6ToV7(root);
    var session = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
    session.ContainsKey("draftSummaryMarkdown").Should().BeFalse();
    var drafts = session["draftComments"]!.AsArray();
    drafts.Count.Should().Be(1);
    drafts[0]!["bodyMarkdown"]!.GetValue<string>().Should().Be("Existing PR-root body.");
}

[Fact]
public void MigrateV6ToV7_BothPresent_AppendsSummary()
{
    var migrated = AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/both_present.json"));
    var draft = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!["draftComments"]!.AsArray()[0]!.AsObject();
    draft["bodyMarkdown"]!.GetValue<string>().Should().Be("Existing PR-root body.\n\nThe summary text.");
}

[Fact]
public void MigrateV6ToV7_BothEmpty_NoSynthesis()
{
    var migrated = AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/both_empty.json"));
    var session = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!.AsObject();
    session["draftComments"]!.AsArray().Count.Should().Be(0);
    session.ContainsKey("draftSummaryMarkdown").Should().BeFalse();
}

[Fact]
public void MigrateV6ToV7_CollapsesMultiplePrRootDrafts_WithMarker()
{
    var migrated = AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/multiple_pr_root.json"));
    var drafts = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!["draftComments"]!.AsArray();
    drafts.Count.Should().Be(1);
    var body = drafts[0]!["bodyMarkdown"]!.GetValue<string>();
    body.Should().StartWith("<!-- migrated from previously-shadowed draft ");
    body.Should().Contain("The summary text.");
}

[Fact]
public void MigrateV6ToV7_NonDefaultAccount_AlsoMigrated()
{
    var migrated = AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/non_default_account.json"));
    var session = migrated["accounts"]!["github_acme"]!["reviews"]!["sessions"]!["acme/api/9"]!.AsObject();
    session.ContainsKey("draftSummaryMarkdown").Should().BeFalse();
    session["draftComments"]!.AsArray().Count.Should().Be(1);
}

[Fact]
public void MigrateV6ToV7_PartialRollbackDiscriminator_Throws()
{
    Action act = () => AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/partial_rollback.json"));
    act.Should().Throw<JsonException>().WithMessage("*looks like a V7*V6 partial rollback*");
}

[Fact]
public void MigrateV6ToV7_PreservesPipelineStamps_OnExistingPrRootDraft()
{
    var migrated = AppStateMigrations.MigrateV6ToV7(LoadFixture("V6/pr_root_with_threadid.json"));
    var draft = migrated["accounts"]!["default"]!["reviews"]!["sessions"]!["acme/api/123"]!["draftComments"]!.AsArray()[0]!.AsObject();
    draft["threadId"]!.GetValue<string>().Should().Be("thread-abc");
}
```

Create matching V6 fixture JSON files under `tests/PRism.Core.Tests/State/Fixtures/V6/`.

- [ ] **Step 6: Verify all migration tests pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~MigrateV6ToV7"`
Expected: 7 PASS.

- [ ] **Step 7: Verify the full state test suite (round-trip + Default + load) still passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~AppStateStore|FullyQualifiedName~AppStateRoundTrip|FullyQualifiedName~AppStateMigrations"`
Expected: all green. `AppState.Default` version bump means any test that compared to `new AppState(6, ...)` literal now needs `7`; sweep and fix.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core/State/AppState.cs PRism.Core/State/AppStateStore.cs PRism.Core/State/Migrations/AppStateMigrations.cs tests/PRism.Core.Tests/State/AppStateMigrationsTests.cs tests/PRism.Core.Tests/State/Fixtures/V6 tests/PRism.Core.Tests/State/Fixtures/V7
git commit -m "feat(state): V6→V7 migration unifies DraftSummaryMarkdown into PR-root DraftComment"
```

---

### Task 3: Drop `DraftSummaryMarkdown` from state record + propagate removal

**Files:**
- Modify: `PRism.Core/State/AppState.cs:50-57` (`ReviewSessionState`)
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:173` (summaryBody source) and `:625` (ClearSubmittedSession)
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:31` (SubmittedFields constant)
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs:42` (ScalarKinds) and `:245-251` (case "draftSummaryMarkdown")
- Test: every Core/Web test that constructs `ReviewSessionState` with `DraftSummaryMarkdown` named

- [ ] **Step 1: Sweep all existing references**

Run: `grep -rn "DraftSummaryMarkdown\|draftSummaryMarkdown\|\"draft-summary\"" PRism.Core PRism.Web tests`
Expected output to be replaced/removed in this task.

- [ ] **Step 2: Remove the field from `ReviewSessionState`**

Edit `PRism.Core/State/AppState.cs:50-57`:

```csharp
public sealed record ReviewSessionState(
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    Dictionary<string, TabStamp> TabStamps,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);
```

- [ ] **Step 3: Replace pipeline summaryBody source**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:173` (the `BeginPendingReviewAsync` call). Add helper at the bottom of the class:

```csharp
private static string ExtractPrRootBody(ReviewSessionState session) =>
    session.DraftComments.SingleOrDefault(d => d.FilePath is null && d.LineNumber is null)
        ?.BodyMarkdown ?? "";
```

Update the call site to use `ExtractPrRootBody(session)` instead of `session.DraftSummaryMarkdown ?? ""`.

- [ ] **Step 4: Remove `DraftSummaryMarkdown = null` from `ClearSubmittedSession`**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:625` — drop the `DraftSummaryMarkdown = null,` line.

- [ ] **Step 5: Drop the patch handler + scalar-kind from `PrDraftEndpoints`**

Edit `PRism.Web/Endpoints/PrDraftEndpoints.cs:42`:

```csharp
private static readonly string[] ScalarKinds = { "draftVerdict" };
```

Delete the `case "draftSummaryMarkdown":` block (lines 245-251).

- [ ] **Step 6: Drop `"draft-summary"` from `SubmittedFields`**

Edit `PRism.Web/Endpoints/PrSubmitEndpoints.cs:31`:

```csharp
private static readonly string[] SubmittedFields = { "draft-comments", "draft-replies", "draft-verdict", "draft-verdict-status", "pending-review" };
```

- [ ] **Step 7: Compile & sweep test breakage**

Run: `dotnet build PRism.Core/PRism.Core.csproj PRism.Web/PRism.Web.csproj -c Release && dotnet test --no-build`
Expected: build green; tests likely break on any literal `new ReviewSessionState(...)` constructor call that passed the removed field. Sweep and fix.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core PRism.Web tests
git commit -m "feat(state): drop ReviewSessionState.DraftSummaryMarkdown (V7 unification)"
```

---

## Phase B — Backend shared helpers

### Task 4: Extract `ClearPendingReviewStamps` into `SessionOverlays`

**Files:**
- Create: `PRism.Core/State/SessionOverlays.cs`
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:603-612` (replace private static with call into shared helper)
- Test: `tests/PRism.Core.Tests/State/SessionOverlaysTests.cs`

- [ ] **Step 1: Write failing test for the extracted helper**

```csharp
[Fact]
public void ClearPendingReviewStamps_NullsAllStamps()
{
    var state = AppStateFixtures.WithSession("acme/api/1", s => s with
    {
        PendingReviewId = "PR_123",
        PendingReviewCommitOid = "abc",
        DraftComments = new[] {
            new DraftComment("d1", "file.cs", 10, "RIGHT", "abc", "x", "body", DraftStatus.Draft, false, ThreadId: "T_1"),
        },
        DraftReplies = new[] {
            new DraftReply("r1", "T_parent", ReplyCommentId: "C_1", "body", DraftStatus.Draft, false),
        },
    });

    var cleared = SessionOverlays.ClearPendingReviewStamps(state, "acme/api/1");
    var session = cleared.Reviews.Sessions["acme/api/1"];

    session.PendingReviewId.Should().BeNull();
    session.PendingReviewCommitOid.Should().BeNull();
    session.DraftComments[0].ThreadId.Should().BeNull();
    session.DraftReplies[0].ReplyCommentId.Should().BeNull();
}

[Fact]
public void ClearPendingReviewStamps_PreservesPostedCommentId()
{
    var state = AppStateFixtures.WithSession("acme/api/1", s => s with
    {
        DraftComments = new[] {
            new DraftComment("d1", null, null, "pr", null, null, "body", DraftStatus.Draft, false,
                ThreadId: null, PostedCommentId: 42L, PostedBodySnapshot: "body"),
        },
    });

    var cleared = SessionOverlays.ClearPendingReviewStamps(state, "acme/api/1");
    cleared.Reviews.Sessions["acme/api/1"].DraftComments[0].PostedCommentId.Should().Be(42L);
    cleared.Reviews.Sessions["acme/api/1"].DraftComments[0].PostedBodySnapshot.Should().Be("body");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SessionOverlays"`
Expected: FAIL — `SessionOverlays` class doesn't exist.

- [ ] **Step 3: Create the shared helper**

Create `PRism.Core/State/SessionOverlays.cs`:

```csharp
namespace PRism.Core.State;

public static class SessionOverlays
{
    /// <summary>
    /// Nulls PendingReviewId, PendingReviewCommitOid, every DraftComment.ThreadId,
    /// and every DraftReply.ReplyCommentId for the named session. Does NOT touch
    /// PostedCommentId or PostedBodySnapshot — those belong to the issue-comment
    /// lifecycle, not the review.
    /// </summary>
    public static AppState ClearPendingReviewStamps(AppState state, string sessionKey)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var cleared = cur with
        {
            PendingReviewId = null,
            PendingReviewCommitOid = null,
            DraftComments = cur.DraftComments.Select(d => d.ThreadId is null ? d : d with { ThreadId = null }).ToList(),
            DraftReplies = cur.DraftReplies.Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null }).ToList(),
        };
        return AppStateMutators.WithSession(state, sessionKey, cleared);
    }
}
```

(The existing `WithSession` private helper inside `SubmitPipeline` is extracted at the same time into `PRism.Core/State/AppStateMutators.cs` as `internal static`. Both files land in this task.)

- [ ] **Step 4: Replace pipeline's private helper with call to shared**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:603-612` — delete the `private static AppState ClearPendingReviewStamps(...)` method. Replace every call site (line 90, line 603 self-reference, and others) with `SessionOverlays.ClearPendingReviewStamps(...)`.

- [ ] **Step 5: Verify pipeline tests + new SessionOverlays tests pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/State/SessionOverlays.cs PRism.Core/State/AppStateMutators.cs PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests/PRism.Core.Tests/State/SessionOverlaysTests.cs
git commit -m "refactor(state): extract ClearPendingReviewStamps to SessionOverlays helper"
```

---

### Task 5: Add `SubmitCancellationRegistry` primitive

**Files:**
- Create: `PRism.Web/Submit/SubmitCancellationRegistry.cs`
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (DI registration)
- Test: `tests/PRism.Web.Tests/Submit/SubmitCancellationRegistryTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
public class SubmitCancellationRegistryTests
{
    [Fact]
    public async Task Register_Then_RequestCancel_TripsToken()
    {
        var registry = new SubmitCancellationRegistry();
        var prRef = PrReference.Parse("acme/api/1")!;
        using var cts = new CancellationTokenSource();
        using var registration = registry.Register(prRef, cts);

        registry.RequestCancel(prRef);

        cts.IsCancellationRequested.Should().BeTrue();
        // Should not throw when called twice.
        var act = () => registry.RequestCancel(prRef);
        act.Should().NotThrow();
    }

    [Fact]
    public async Task RequestCancel_OnUnknownPrRef_IsNoop()
    {
        var registry = new SubmitCancellationRegistry();
        var act = () => registry.RequestCancel(PrReference.Parse("acme/api/2")!);
        act.Should().NotThrow();
    }

    [Fact]
    public void Register_WhilePriorEntryAlive_Throws()
    {
        var registry = new SubmitCancellationRegistry();
        var prRef = PrReference.Parse("acme/api/3")!;
        using var ctsA = new CancellationTokenSource();
        using var registrationA = registry.Register(prRef, ctsA);

        using var ctsB = new CancellationTokenSource();
        Action act = () => registry.Register(prRef, ctsB);

        act.Should().Throw<InvalidOperationException>()
            .WithMessage("*registration already exists*");
    }

    [Fact]
    public void Dispose_RemovesEntry_AllowsReRegister()
    {
        var registry = new SubmitCancellationRegistry();
        var prRef = PrReference.Parse("acme/api/4")!;
        using (var ctsA = new CancellationTokenSource())
        {
            registry.Register(prRef, ctsA).Dispose();
        }
        using var ctsB = new CancellationTokenSource();
        var act = () => registry.Register(prRef, ctsB);
        act.Should().NotThrow();
    }

    [Fact]
    public void LateDispose_DoesNotStompFreshRegistration()
    {
        var registry = new SubmitCancellationRegistry();
        var prRef = PrReference.Parse("acme/api/5")!;
        using var ctsA = new CancellationTokenSource();
        var registrationA = registry.Register(prRef, ctsA);

        // Simulate a delayed-A scenario by registering a new CTS after A's dispose
        // (we'd have to bypass the throw above; in production AddOrUpdate-style stomp
        // is prevented at registration, so we test the late-dispose-vs-fresh-registration
        // safety: the late dispose must NOT remove an entry that points to a different CTS).
        registrationA.Dispose();
        using var ctsB = new CancellationTokenSource();
        var registrationB = registry.Register(prRef, ctsB);

        // Late-dispose of A (idempotent) must not clear ctsB.
        registrationA.Dispose();
        registry.RequestCancel(prRef);

        ctsB.IsCancellationRequested.Should().BeTrue();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SubmitCancellationRegistry"`
Expected: FAIL — class doesn't exist.

- [ ] **Step 3: Implement `SubmitCancellationRegistry`**

Create `PRism.Web/Submit/SubmitCancellationRegistry.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Web.Submit;

internal sealed class SubmitCancellationRegistry
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _ctsByPrRef =
        new(StringComparer.Ordinal);

    public IDisposable Register(PrReference reference, CancellationTokenSource cts)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(cts);
        var key = reference.ToString();
        if (!_ctsByPrRef.TryAdd(key, cts))
        {
            throw new InvalidOperationException(
                $"SubmitCancellationRegistry: a registration already exists for {key}. This indicates a stuck pipeline missed its finally cleanup.");
        }
        return new RegistrationHandle(this, key, cts);
    }

    public void RequestCancel(PrReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        if (_ctsByPrRef.TryGetValue(reference.ToString(), out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* race vs pipeline finally */ }
        }
    }

    private sealed class RegistrationHandle : IDisposable
    {
        private readonly SubmitCancellationRegistry _owner;
        private readonly string _key;
        private readonly CancellationTokenSource _cts;
        private int _disposed;

        public RegistrationHandle(SubmitCancellationRegistry owner, string key, CancellationTokenSource cts)
        {
            _owner = owner; _key = key; _cts = cts;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                _owner._ctsByPrRef.TryRemove(new KeyValuePair<string, CancellationTokenSource>(_key, _cts));
            }
        }
    }
}
```

- [ ] **Step 4: Register the singleton**

Edit `PRism.Web/Composition/ServiceCollectionExtensions.cs` — add `services.AddSingleton<SubmitCancellationRegistry>();` next to the existing `SubmitLockRegistry` registration.

- [ ] **Step 5: Verify tests pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SubmitCancellationRegistry"`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Submit/SubmitCancellationRegistry.cs PRism.Web/Composition/ServiceCollectionExtensions.cs tests/PRism.Web.Tests/Submit/SubmitCancellationRegistryTests.cs
git commit -m "feat(submit): add SubmitCancellationRegistry (per-PR CTS handoff)"
```

---

## Phase C — Submit pipeline changes

### Task 6: Add `SubmitOutcome.Cancelled` variant + pipeline OCE catch

**Files:**
- Modify: `PRism.Core/Submit/SubmitResults.cs` (`SubmitOutcome` discriminated union)
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:160-164` (catch OCE)
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (switch case)
- Test: `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineCancelTests.cs`

- [ ] **Step 1: Add the variant**

Edit `PRism.Core/Submit/SubmitResults.cs` — add to the `SubmitOutcome` union:

```csharp
public sealed record Cancelled(string Reason) : SubmitOutcome;
```

- [ ] **Step 2: Write failing test for OCE catch**

Create `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineCancelTests.cs`:

```csharp
[Fact]
public async Task SubmitAsync_WhenCtCanceled_ReturnsCancelledOutcome()
{
    var fake = new FakeReviewSubmitter { BeginDelay = TimeSpan.FromSeconds(5) };
    var store = AppStateFixtures.InMemoryStore(seedSession: true);
    var pipeline = new SubmitPipeline(fake, store);
    var progress = new Progress<SubmitProgressEvent>(_ => { });
    using var cts = new CancellationTokenSource();

    var task = pipeline.SubmitAsync(
        PrReference.Parse("acme/api/1")!, SeedSession(), SubmitEvent.Comment, "sha", progress, cts.Token);

    cts.CancelAfter(TimeSpan.FromMilliseconds(50));
    var outcome = await task;

    outcome.Should().BeOfType<SubmitOutcome.Cancelled>();
}
```

- [ ] **Step 3: Verify failure**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SubmitPipelineCancel"`
Expected: FAIL — OCE escapes today.

- [ ] **Step 4: Wrap pipeline body with OCE catch**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:56-164`. Add an `OperationCanceledException` catch BEFORE the existing `catch (SubmitFailedException)`:

```csharp
try
{
    // ... existing pipeline body ...
}
catch (OperationCanceledException) when (ct.IsCancellationRequested)
{
    return new SubmitOutcome.Cancelled("Pipeline canceled by caller (discard).");
}
catch (SubmitFailedException sfe) { /* existing */ }
```

- [ ] **Step 5: Add endpoint switch case**

Edit `PRism.Web/Endpoints/PrSubmitEndpoints.cs` — inside the `switch (outcome)` block, add:

```csharp
case SubmitOutcome.Cancelled cancelled:
    // No SSE event — the discard endpoint owns the user-facing signal.
    // Log at Information so this doesn't look like a contract violation.
    s_pipelineCancelled(logger, sessionKey, cancelled.Reason, null);
    break;
```

Add the LoggerMessage delegate at the top of the class:

```csharp
private static readonly Action<ILogger, string, string, Exception?> s_pipelineCancelled =
    LoggerMessage.Define<string, string>(LogLevel.Information, new EventId(4, "SubmitPipelineCancelled"),
        "Submit pipeline cancelled for {SessionKey}: {Reason}");
```

- [ ] **Step 6: Verify test passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SubmitPipelineCancel" && dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Submit/SubmitResults.cs PRism.Core/Submit/Pipeline/SubmitPipeline.cs PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineCancelTests.cs
git commit -m "feat(submit): SubmitOutcome.Cancelled variant for caller-initiated cancellation"
```

---

### Task 7: SubmitPipeline AttachThreads partition + ClearSubmittedSession PR-root consumption

**Files:**
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (StepAttachThreadsAsync ~line 212; ClearSubmittedSession ~line 616)
- Test: `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineAttachThreadsTests.cs` + `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineSuccessClearsSessionTests.cs`

- [ ] **Step 1: Write failing tests**

```csharp
[Fact]
public async Task AttachThreads_WithMixedDrafts_SkipsPrRootSilently()
{
    var prRoot = new DraftComment("d0", null, null, "pr", null, null, "pr body", DraftStatus.Draft, false);
    var inline = new DraftComment("d1", "src/x.cs", 10, "RIGHT", "abc", "line", "inline", DraftStatus.Draft, false);
    var session = SeedSession(drafts: new[] { prRoot, inline });
    var fake = new FakeReviewSubmitter();
    var pipeline = new SubmitPipeline(fake, AppStateFixtures.InMemoryStore(session));

    var outcome = await pipeline.SubmitAsync(PrRef, session, SubmitEvent.Comment, "sha", NoProgress, default);

    outcome.Should().BeOfType<SubmitOutcome.Succeeded>();
    fake.AttachedThreads.Should().HaveCount(1);
    fake.AttachedThreads[0].FilePath.Should().Be("src/x.cs");
    // PR-root body went into review.body, not as a thread.
    fake.BeginCalls[0].SummaryBody.Should().Be("pr body");
}

[Fact]
public async Task SuccessfulSubmit_DeletesPrRootDraft_PreservesInlineStamps()
{
    // PR-root drafts are consumed (body shipped as review.body) — they disappear post-submit.
    var prRoot = new DraftComment("d0", null, null, "pr", null, null, "body", DraftStatus.Draft, false);
    var session = SeedSession(drafts: new[] { prRoot });
    var fake = new FakeReviewSubmitter();
    var store = AppStateFixtures.InMemoryStore(session);
    var pipeline = new SubmitPipeline(fake, store);

    await pipeline.SubmitAsync(PrRef, session, SubmitEvent.Comment, "sha", NoProgress, default);

    var after = (await store.LoadAsync(default)).Reviews.Sessions[SessionKey];
    after.DraftComments.Should().BeEmpty();
}

[Fact]
public async Task SuccessfulSubmit_PreservesAlreadyPostedDraft()
{
    var posted = new DraftComment("d0", null, null, "pr", null, null, "body", DraftStatus.Draft, false,
        ThreadId: null, PostedCommentId: 99L, PostedBodySnapshot: "body");
    // ...
    after.DraftComments.Should().ContainSingle(d => d.PostedCommentId == 99L);
}
```

- [ ] **Step 2: Verify failure**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~AttachThreads_WithMixedDrafts|FullyQualifiedName~SuccessfulSubmit_DeletesPrRootDraft"`
Expected: FAIL.

- [ ] **Step 3: Apply the partition filter in `StepAttachThreadsAsync`**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:212`:

```csharp
var drafts = session.DraftComments
    .Where(d => d.Status != DraftStatus.Stale)
    .Where(d => d.FilePath is not null && d.LineNumber is not null)
    .ToList();
```

Delete the throw block at `:284-292` — unreachable.

- [ ] **Step 4: Update `ClearSubmittedSession` partition**

Edit `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:616-630`:

```csharp
private static AppState ClearSubmittedSession(AppState state, string sessionKey)
{
    if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
    var cleared = cur with
    {
        PendingReviewId = null,
        PendingReviewCommitOid = null,
        DraftComments = cur.DraftComments
            .Where(d => (d.Status == DraftStatus.Stale && !d.IsOverriddenStale)
                     || (d.PostedCommentId is not null))
            .ToList(),
        DraftReplies = new List<DraftReply>(),
        DraftVerdict = null,
        DraftVerdictStatus = DraftVerdictStatus.Draft,
    };
    return AppStateMutators.WithSession(state, sessionKey, cleared);
}
```

- [ ] **Step 5: Verify all pipeline tests pass**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SubmitPipeline"`
Expected: all green; sweep any existing `SuccessClearsSession*` tests that asserted full wipe.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests
git commit -m "feat(submit): AttachThreads partition + PR-root consumption on success"
```

---

## Phase D — GitHub seam

### Task 8: Add `CreateIssueCommentAsync` to `IReviewSubmitter`

**Files:**
- Modify: `PRism.Core/IReviewSubmitter.cs` (add method + result record)
- Modify: `PRism.GitHub/GitHubReviewService.cs` (REST implementation — new partial file recommended)
- Create: `PRism.GitHub/GitHubReviewService.IssueComments.cs` (REST partial)
- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (fake impl + force-failure registry + begin-delay knob)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceIssueCommentsTests.cs`

- [ ] **Step 1: Extend the interface**

Edit `PRism.Core/IReviewSubmitter.cs` — add:

```csharp
// Issue comments — independent of the pending-review pipeline (different GitHub REST endpoint).
Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
    PrReference reference,
    string bodyMarkdown,
    CancellationToken ct);
```

Add the result record in `PRism.Core/Submit/` (or alongside existing `BeginPendingReviewResult`):

```csharp
public sealed record CreatedIssueCommentResult(long Id, DateTimeOffset CreatedAt);
```

- [ ] **Step 2: Write failing fake-roundtrip test**

```csharp
[Fact]
public async Task FakeReviewSubmitter_CreateIssueComment_DefaultsToSuccess()
{
    var fake = new FakeReviewSubmitter();
    var result = await fake.CreateIssueCommentAsync(PrRef, "hello", default);
    result.Id.Should().BeGreaterThan(0);
    fake.IssueCommentsCreated.Should().ContainSingle(c => c.Body == "hello");
}

[Fact]
public async Task FakeReviewSubmitter_ForceFailure_GithubCreate_Throws()
{
    var fake = new FakeReviewSubmitter();
    fake.RegisterRootCommentForceFailure("github-create");
    Func<Task> act = () => fake.CreateIssueCommentAsync(PrRef, "hello", default);
    await act.Should().ThrowAsync<HttpRequestException>();
}
```

- [ ] **Step 3: Implement on `FakeReviewSubmitter`**

Edit `PRism.Web/TestHooks/FakeReviewSubmitter.cs`. Add:

```csharp
private string? _rootCommentForceFailure;
private long _nextIssueCommentId = 1000;
public List<(PrReference Pr, string Body)> IssueCommentsCreated { get; } = new();
public TimeSpan BeginDelay { get; set; } = TimeSpan.Zero;

public void RegisterRootCommentForceFailure(string phase) => _rootCommentForceFailure = phase;
public void SetBeginDelayMs(int delayMs) => BeginDelay = TimeSpan.FromMilliseconds(delayMs);

public Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
    PrReference reference, string bodyMarkdown, CancellationToken ct)
{
    if (_rootCommentForceFailure == "github-create")
        throw new HttpRequestException("forced");
    IssueCommentsCreated.Add((reference, bodyMarkdown));
    return Task.FromResult(new CreatedIssueCommentResult(
        Id: Interlocked.Increment(ref _nextIssueCommentId),
        CreatedAt: DateTimeOffset.UtcNow));
}
```

Also wire `BeginDelay` into the existing `BeginPendingReviewAsync` so cancellation tests have a real delay to race against.

- [ ] **Step 4: Implement on `GitHubReviewService`**

Create `PRism.GitHub/GitHubReviewService.IssueComments.cs`:

```csharp
public partial class GitHubReviewService
{
    public async Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
        PrReference reference,
        string bodyMarkdown,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        var url = $"https://api.github.com/repos/{reference.Owner}/{reference.Repo}/issues/{reference.Number}/comments";
        var payload = JsonSerializer.Serialize(new { body = bodyMarkdown });
        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };
        // Inherit auth headers from existing config (same pattern as GraphQL POSTs at GitHubReviewService.cs).
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _tokenProvider.GetToken());
        req.Headers.Add("Accept", "application/vnd.github+json");
        req.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        req.Headers.UserAgent.ParseAdd("PRism/1.0");

        using var resp = await _httpClient.SendAsync(req, ct).ConfigureAwait(false);
        resp.EnsureSuccessStatusCode();
        var json = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        return new CreatedIssueCommentResult(
            Id: doc.RootElement.GetProperty("id").GetInt64(),
            CreatedAt: doc.RootElement.GetProperty("created_at").GetDateTimeOffset());
    }
}
```

- [ ] **Step 5: Verify tests pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~IssueComments" && dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~FakeReviewSubmitter"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/IReviewSubmitter.cs PRism.Core/Submit/*.cs PRism.GitHub/GitHubReviewService.IssueComments.cs PRism.Web/TestHooks/FakeReviewSubmitter.cs tests
git commit -m "feat(github): CreateIssueCommentAsync on IReviewSubmitter (REST issue comments)"
```

---

## Phase E — Endpoints

### Task 9: `newPrRootDraftComment` upsert behavior

**Files:**
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs:271-285`
- Test: `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs`

- [ ] **Step 1: Write failing test for upsert**

```csharp
[Fact]
public async Task NewPrRootDraftComment_WhenExistingPresent_UpsertsInsteadOfDuplicate()
{
    var client = CreateClient();
    var first = await client.PutDraftAsync(PrRef,
        new { kind = "newPrRootDraftComment", payload = new { bodyMarkdown = "first" } });
    var second = await client.PutDraftAsync(PrRef,
        new { kind = "newPrRootDraftComment", payload = new { bodyMarkdown = "second" } });

    var session = await client.GetSessionAsync(PrRef);
    session.DraftComments.Should().ContainSingle(d => d.FilePath == null);
    session.DraftComments.Single(d => d.FilePath == null).BodyMarkdown.Should().Be("second");
    second.AssignedId.Should().Be(first.AssignedId);
}
```

- [ ] **Step 2: Verify failure**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~NewPrRootDraftComment_WhenExistingPresent"`
Expected: FAIL — second call appends.

- [ ] **Step 3: Apply upsert in patch handler**

Edit `PRism.Web/Endpoints/PrDraftEndpoints.cs:271-285`:

```csharp
case "newPrRootDraftComment":
{
    if (payload is not NewPrRootDraftCommentPayload n) return new PatchOutcome.PatchShapeInvalid();
    var existing = session.DraftComments.FirstOrDefault(d => d.FilePath is null && d.LineNumber is null);
    if (existing is not null)
    {
        var updated = existing with { BodyMarkdown = n.BodyMarkdown };
        var list = session.DraftComments.Select(d => d.Id == existing.Id ? updated : d).ToList();
        return new PatchOutcome.Applied(
            session with { DraftComments = list },
            AssignedId: existing.Id, EventDraftId: existing.Id,
            PublishSaved: true, PublishDiscarded: false,
            FieldsTouched: FieldsTouchedDraftComments);
    }
    var id = Guid.NewGuid().ToString();
    var draft = new DraftComment(
        Id: id,
        FilePath: null, LineNumber: null, Side: "pr",
        AnchoredSha: null, AnchoredLineContent: null,
        BodyMarkdown: n.BodyMarkdown,
        Status: DraftStatus.Draft, IsOverriddenStale: false);
    var listNew = new List<DraftComment>(session.DraftComments) { draft };
    return new PatchOutcome.Applied(
        session with { DraftComments = listNew },
        id, id, true, false, FieldsTouchedDraftComments);
}
```

- [ ] **Step 4: Add race test**

```csharp
[Fact]
public async Task NewPrRootDraftComment_TwoConcurrentCalls_OnlyOneRowPersisted()
{
    var client = CreateClient();
    var tasks = Enumerable.Range(0, 2).Select(i =>
        client.PutDraftAsync(PrRef,
            new { kind = "newPrRootDraftComment", payload = new { bodyMarkdown = $"body-{i}" } })).ToArray();
    await Task.WhenAll(tasks);

    var session = await client.GetSessionAsync(PrRef);
    session.DraftComments.Count(d => d.FilePath == null).Should().Be(1);
}
```

- [ ] **Step 5: Verify both tests pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~NewPrRootDraftComment"`
Expected: PASS (the existing `_gate` in `AppStateStore.UpdateAsync` serializes the two calls; the second observes the first's row).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/PrDraftEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs
git commit -m "fix(draft): newPrRootDraftComment upserts on existing PR-root row"
```

---

### Task 10: `POST /api/pr/.../root-comment/post` endpoint

**Files:**
- Create: `PRism.Web/Endpoints/PrRootCommentEndpoints.cs`
- Modify: `PRism.Web/Endpoints/PrSubmitErrors.cs` (if exists) or inline the error DTO
- Modify: `PRism.Web/Program.cs` (register endpoints)
- Test: `tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs`

- [ ] **Step 1: Write happy-path test**

```csharp
[Fact]
public async Task PostRootComment_HappyPath_DeletesDraftAndReturns204()
{
    var client = CreateClient();
    await client.PutDraftAsync(PrRef, new { kind = "newPrRootDraftComment", payload = new { bodyMarkdown = "hi" } });

    var resp = await client.PostAsync($"/api/pr/{PrRef.Owner}/{PrRef.Repo}/{PrRef.Number}/root-comment/post", null);

    resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    var fake = (FakeReviewSubmitter)Services.GetRequiredService<IReviewSubmitter>();
    fake.IssueCommentsCreated.Should().ContainSingle(c => c.Body == "hi");
    var session = await client.GetSessionAsync(PrRef);
    session.DraftComments.Should().BeEmpty();
}

[Fact]
public async Task PostRootComment_NoDraft_Returns400()
{
    var resp = await CreateClient().PostAsync($"/api/pr/.../root-comment/post", null);
    resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    var body = await resp.Content.ReadFromJsonAsync<SubmitErrorDto>();
    body!.Code.Should().Be("no-root-draft");
}

[Fact]
public async Task PostRootComment_AlreadyPostedWithSameBody_Returns204NoGithubCall()
{
    // seed a draft with PostedCommentId already stamped and PostedBodySnapshot matching current body
    // POST → expects no new GitHub call, draft deleted, 204
}

[Fact]
public async Task PostRootComment_AlreadyPostedWithMismatchedBody_Returns409Mismatch()
{
    // seed a draft with PostedCommentId stamped + PostedBodySnapshot != current body
    // POST → expects 409 already-posted-body-mismatch with postedCommentId in payload
}

[Fact]
public async Task PostRootComment_ForceFailureGithubCreate_Returns502NetworkError()
{
    // /test/root-comment/force-failure phase=github-create → POST → expects 502 + draft preserved
}

[Fact]
public async Task PostRootComment_WhenSubmitLockHeld_Returns409InProgress()
{
    // hold the submit lock, attempt POST → 409 submit-in-progress
}
```

- [ ] **Step 2: Implement the endpoint**

Create `PRism.Web/Endpoints/PrRootCommentEndpoints.cs`:

```csharp
internal static class PrRootCommentEndpoints
{
    private static readonly string LoggerCategory = typeof(PrRootCommentEndpoints).FullName!;

    private static readonly string[] FieldsTouchedDraftComments = { "draft-comments" };

    public static IEndpointRouteBuilder MapPrRootCommentEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/root-comment/post", PostRootCommentAsync);
        return app;
    }

    private static async Task<IResult> PostRootCommentAsync(
        string owner, string repo, int number,
        IAppStateStore stateStore,
        IActivePrCache cache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        var logger = loggerFactory.CreateLogger(LoggerCategory);

        if (!cache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("not-subscribed", "PR not subscribed."), statusCode: 403);

        await using var lockHandle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct);
        if (lockHandle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit or post is in progress for this PR."), statusCode: 409);

        var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
        if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session))
            return Results.Json(new SubmitErrorDto("no-session", "No draft session for this PR."), statusCode: 400);

        var draft = session.DraftComments.FirstOrDefault(d => d.FilePath is null && d.LineNumber is null);
        if (draft is null)
            return Results.Json(new SubmitErrorDto("no-root-draft", "No PR-root draft to post."), statusCode: 400);

        // Already-posted path.
        if (draft.PostedCommentId is not null)
        {
            if (!string.Equals(draft.PostedBodySnapshot ?? "", draft.BodyMarkdown, StringComparison.Ordinal))
            {
                return Results.Json(
                    new PostMismatchErrorDto("already-posted-body-mismatch",
                        "This comment was already posted; current body differs from posted snapshot.",
                        PostedCommentId: draft.PostedCommentId.Value),
                    statusCode: 409);
            }
            // Same body — drop the orphan draft.
            await DeleteDraftAsync(stateStore, sessionKey, draft.Id, ct);
            await PublishAsync(bus, prRef, draft.PostedCommentId.Value);
            return Results.NoContent();
        }

        // Body cap (defense-in-depth — middleware already enforces 16 KiB at PUT /draft).
        if (draft.BodyMarkdown.Length > PipelineMarker.GitHubReviewBodyMaxChars)
            return Results.Json(new SubmitErrorDto("body-too-large", "PR-level body exceeds GitHub limit."), statusCode: 400);

        CreatedIssueCommentResult created;
        try
        {
            created = await submitter.CreateIssueCommentAsync(prRef, draft.BodyMarkdown, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException hre)
        {
            var code = MapGithubError(hre);
            return Results.Json(new SubmitErrorDto(code, "GitHub rejected the request."), statusCode: 502);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Results.Json(new SubmitErrorDto("github-network-error", "Network failure reaching GitHub."), statusCode: 502);
        }

        // Stamp + snapshot.
        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
            var list = s.DraftComments.Select(d => d.Id == draft.Id
                ? d with { PostedCommentId = created.Id, PostedBodySnapshot = draft.BodyMarkdown }
                : d).ToList();
            return AppStateMutators.WithSession(state, sessionKey, s with { DraftComments = list });
        }, ct).ConfigureAwait(false);

        // Delete the (now-stamped) draft.
        await DeleteDraftAsync(stateStore, sessionKey, draft.Id, ct);
        await PublishAsync(bus, prRef, created.Id);
        return Results.NoContent();
    }

    private static string MapGithubError(HttpRequestException hre) => hre.StatusCode switch
    {
        HttpStatusCode.Forbidden => "github-forbidden",
        HttpStatusCode.UnprocessableEntity => "github-validation-error",
        HttpStatusCode.TooManyRequests => "github-rate-limited",
        >= HttpStatusCode.InternalServerError => "github-server-error",
        _ => "github-network-error",
    };

    private static Task DeleteDraftAsync(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
            var list = s.DraftComments.Where(d => d.Id != draftId).ToList();
            return AppStateMutators.WithSession(state, sessionKey, s with { DraftComments = list });
        }, ct);

    private static Task PublishAsync(IReviewEventBus bus, PrReference prRef, long issueCommentId) =>
        Task.WhenAll(
            bus.PublishAsync(new StateChangedBusEvent(prRef.ToString(), FieldsTouchedDraftComments)),
            bus.PublishAsync(new RootCommentPostedBusEvent(prRef.ToString(), issueCommentId)));
}

internal sealed record PostMismatchErrorDto(string Code, string Message, long PostedCommentId);
```

- [ ] **Step 3: Register the endpoints**

Edit `PRism.Web/Program.cs` — add `app.MapPrRootCommentEndpoints();` next to `MapPrSubmitEndpoints();`.

- [ ] **Step 4: Verify all tests pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PrRootCommentEndpoint"`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/PrRootCommentEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs
git commit -m "feat(submit): POST /root-comment/post endpoint (idempotent issue comment)"
```

---

### Task 11: `POST /api/pr/.../submit/discard` endpoint

**Files:**
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (add new route + CTS register at endpoint level)
- Test: `tests/PRism.Web.Tests/Endpoints/PrSubmitDiscardEndpointTests.cs`

- [ ] **Step 1: Update `SubmitAsync` to register CTS at endpoint**

Edit `PRism.Web/Endpoints/PrSubmitEndpoints.cs:150-225`. Wrap the existing `Task.Run` with the new registration:

```csharp
using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(appLifetime.ApplicationStopping);
using var registration = cancellationRegistry.Register(reference, linkedCts);
var pipelineCt = linkedCts.Token;
// Task.Run uses pipelineCt instead of appLifetime.ApplicationStopping directly.
```

`cancellationRegistry` is a new DI parameter on the endpoint handler.

- [ ] **Step 2: Write failing tests for discard endpoint**

```csharp
[Fact]
public async Task SubmitDiscard_NoPendingReview_IdempotentNoop()
{
    var resp = await CreateClient().PostAsync(DiscardUrl, null);
    resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
}

[Fact]
public async Task SubmitDiscard_WithPendingReview_DeletesAndClears()
{
    // seed a session with PendingReviewId; GitHub side has the review
    var resp = await client.PostAsync(DiscardUrl, null);
    resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

    var fake = (FakeReviewSubmitter)Services.GetRequiredService<IReviewSubmitter>();
    fake.DeletedPendingReviews.Should().ContainSingle();
    (await client.GetSessionAsync(PrRef)).PendingReviewId.Should().BeNull();
}

[Fact]
public async Task SubmitDiscard_GithubReturns404_TreatedAsSuccess()
{
    // seed PendingReviewId; configure FakeReviewSubmitter to throw a 404 on DeletePendingReview
    var resp = await client.PostAsync(DiscardUrl, null);
    resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    (await client.GetSessionAsync(PrRef)).PendingReviewId.Should().BeNull();
}

[Fact]
public async Task SubmitDiscard_GithubReturns500_Returns502_StampsRemain()
{
    var resp = await client.PostAsync(DiscardUrl, null);
    resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
    (await client.GetSessionAsync(PrRef)).PendingReviewId.Should().NotBeNull();
}

[Fact]
public async Task SubmitDiscard_WithInFlightPipeline_CancelsAndClears()
{
    var fake = (FakeReviewSubmitter)Services.GetRequiredService<IReviewSubmitter>();
    fake.SetBeginDelayMs(2000);

    var submitTask = client.PostAsync(SubmitUrl, ...);
    await Task.Delay(100);  // let the pipeline acquire the lock
    var discardResp = await client.PostAsync(DiscardUrl, null);

    discardResp.StatusCode.Should().Be(HttpStatusCode.NoContent);
    var submitResp = await submitTask;
    // Submit endpoint should have observed SubmitOutcome.Cancelled (no SSE event, 200 with a 'cancelled' outcome envelope).
    submitResp.StatusCode.Should().Be(HttpStatusCode.OK);
}
```

- [ ] **Step 3: Implement the discard handler**

Add to `PrSubmitEndpoints.cs`:

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/discard", DiscardOwnPendingReviewAsync);

private static async Task<IResult> DiscardOwnPendingReviewAsync(
    string owner, string repo, int number,
    IAppStateStore stateStore,
    IActivePrCache cache,
    IReviewSubmitter submitter,
    IReviewEventBus bus,
    SubmitLockRegistry lockRegistry,
    SubmitCancellationRegistry cancellationRegistry,
    ILoggerFactory loggerFactory,
    CancellationToken ct)
{
    var prRef = new PrReference(owner, repo, number);
    var sessionKey = prRef.ToString();
    var logger = loggerFactory.CreateLogger(LoggerCategory);

    if (!cache.IsSubscribed(prRef))
        return Results.Json(new SubmitErrorDto("not-subscribed", "PR not subscribed."), statusCode: 403);

    // 1. Signal cancel (idempotent).
    cancellationRegistry.RequestCancel(prRef);

    // 2. Acquire the lock with timeout — wait for the in-flight pipeline to release.
    await using var lockHandle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.FromSeconds(30), ct);
    if (lockHandle is null)
        return Results.Json(new SubmitErrorDto("pipeline-cancellation-timeout", "Pipeline did not release within 30s."), statusCode: 504);

    // 3. Re-fetch GitHub-side pending review (TOCTOU defense).
    OwnPendingReviewSnapshot? snapshot;
    try
    {
        snapshot = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Json(new SubmitErrorDto("github-find-failed", ex.Message), statusCode: 502);
    }

    if (snapshot is not null)
    {
        try
        {
            await submitter.DeletePendingReviewAsync(prRef, snapshot.PullRequestReviewId, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException hre) when (hre.StatusCode == HttpStatusCode.NotFound)
        {
            // Review already gone — treat as success.
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Results.Json(new SubmitErrorDto("github-delete-failed", ex.Message), statusCode: 502);
        }
    }

    // 4. Clear stamps via shared helper.
    await stateStore.UpdateAsync(s => SessionOverlays.ClearPendingReviewStamps(s, sessionKey), ct)
        .ConfigureAwait(false);

    // 5. Publish.
    await bus.PublishAsync(new StateChangedBusEvent(sessionKey, PendingReviewFields)).ConfigureAwait(false);

    return Results.NoContent();
}

private static readonly string[] PendingReviewFields = { "pending-review", "draft-comments", "draft-replies" };
```

- [ ] **Step 4: Verify discard tests pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SubmitDiscard"`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrSubmitDiscardEndpointTests.cs
git commit -m "feat(submit): POST /submit/discard endpoint (cancel in-flight + clear stamps)"
```

---

### Task 12: Test endpoints — `/test/root-comment/force-failure` + `/test/submit/begin-delay`

**Files:**
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs` (add the two new routes)

- [ ] **Step 1: Add the endpoints**

Edit `PRism.Web/TestHooks/TestEndpoints.cs`:

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

app.MapPost("/test/submit/begin-delay",
    (BeginDelayRequest body, IServiceProvider sp) =>
    {
        if (sp.GetService<IReviewSubmitter>() is not FakeReviewSubmitter fake)
            return Results.Problem(type: "/test/submitter-missing", statusCode: 500);
        fake.SetBeginDelayMs(body.DelayMs);
        return Results.NoContent();
    });

internal sealed record ForceRootCommentFailureRequest(string Phase);
internal sealed record BeginDelayRequest(int DelayMs);
```

- [ ] **Step 2: Commit**

```bash
git add PRism.Web/TestHooks/TestEndpoints.cs
git commit -m "test(hooks): add force-failure + begin-delay endpoints for Playwright"
```

---

### Task 13: Extend `Program.cs` middleware predicate

**Files:**
- Modify: `PRism.Web/Program.cs:188-198` (UseWhen predicate)

- [ ] **Step 1: Add both new endpoints to the suffix list**

Edit `PRism.Web/Program.cs`:

```csharp
app.UseWhen(ctx =>
{
    var p = ctx.Request.Path.Value;
    return p is not null && (
        p.EndsWith("/reload") ||
        p.EndsWith("/submit") ||
        p.EndsWith("/submit/foreign-pending-review/resume") ||
        p.EndsWith("/submit/foreign-pending-review/discard") ||
        p.EndsWith("/submit/discard") ||              // NEW
        p.EndsWith("/root-comment/post") ||           // NEW
        p.EndsWith("/drafts/discard-all"));
}, ...);
```

- [ ] **Step 2: Verify middleware still functions**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Middleware|FullyQualifiedName~BodySize"`
Expected: existing middleware tests pass; new endpoint tests pass (already added in Task 10/11).

- [ ] **Step 3: Commit**

```bash
git add PRism.Web/Program.cs
git commit -m "chore(web): cap new endpoints under existing body-size middleware"
```

---

## Phase F — SSE / events

### Task 14: `RootCommentPostedBusEvent` + SSE projection

**Files:**
- Modify: `PRism.Core/Events/SubmitBusEvents.cs` (add event record)
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (wire-record + Subscribe)
- Test: `tests/PRism.Web.Tests/Sse/SseEventProjectionTests.cs`

- [ ] **Step 1: Add the bus event**

Edit `PRism.Core/Events/SubmitBusEvents.cs`:

```csharp
public sealed record RootCommentPostedBusEvent(string PrRef, long IssueCommentId);
```

- [ ] **Step 2: Add the wire record + subscription**

Edit `PRism.Web/Sse/SseEventProjection.cs`:

```csharp
internal sealed record RootCommentPostedSseEvent(long issueCommentId);

// In the wiring:
bus.Subscribe<RootCommentPostedBusEvent>(evt =>
    publisher.Publish(evt.PrRef, "root-comment-posted", new RootCommentPostedSseEvent(evt.IssueCommentId)));
```

- [ ] **Step 3: Write failing projection test**

```csharp
[Fact]
public async Task RootCommentPosted_FlowsToSse()
{
    var projection = new SseEventProjection(bus, publisher);
    projection.Start();
    await bus.PublishAsync(new RootCommentPostedBusEvent("acme/api/1", 99L));
    publisher.PublishedEvents.Should().ContainSingle(e =>
        e.EventName == "root-comment-posted" && ((RootCommentPostedSseEvent)e.Payload).issueCommentId == 99L);
}
```

- [ ] **Step 4: Verify**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~RootCommentPosted_FlowsToSse"`
Expected: PASS.

- [ ] **Step 5: Wire the frontend consumer**

Edit `frontend/src/hooks/usePrDetail.ts` — find the existing `stream.on('...')` block (the seam that owns PR-detail re-fetches alongside other Submit* events). Add:

```ts
stream.on('root-comment-posted', () => {
  // Re-fetch the PR detail so PrRootConversation picks up the new comment.
  void refetch();
});
```

Add a vitest assertion in `frontend/__tests__/usePrDetail.test.tsx`:

```tsx
it('refetches PR detail on root-comment-posted SSE event', async () => {
  const { result, fetchSpy } = renderHookWithFakeStream(() => usePrDetail(PrRef));
  const before = fetchSpy.mock.calls.length;

  act(() => stream.emit('root-comment-posted', { issueCommentId: 99 }));
  await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(before));
});
```

- [ ] **Step 6: Verify + commit**

```bash
cd frontend && npm test -- usePrDetail
git add PRism.Core/Events/SubmitBusEvents.cs PRism.Web/Sse/SseEventProjection.cs tests frontend/src/hooks/usePrDetail.ts frontend/__tests__/usePrDetail.test.tsx
git commit -m "feat(sse): RootCommentPosted bus event + projection + frontend refetch"
```

---

## Phase G — Frontend types + API wrappers

### Task 15: `api/types.ts` wire-shape changes

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/draft.ts` (drop the `'draftSummaryMarkdown'` patch case)

- [ ] **Step 1: Update DTOs**

Edit `frontend/src/api/types.ts`:

```ts
// In ReviewSessionDto: REMOVE the draftSummaryMarkdown field.
export interface ReviewSessionDto {
  pendingReviewId: string | null;
  pendingReviewCommitOid: string | null;
  tabStamps: Record<string, TabStamp>;
  draftComments: DraftCommentDto[];
  draftReplies: DraftReplyDto[];
  draftVerdict: DraftVerdict | null;
  draftVerdictStatus: DraftVerdictStatus;
}

// In DraftCommentDto: ADD postedCommentId + postedBodySnapshot (both optional + nullable).
export interface DraftCommentDto {
  id: string;
  filePath: string | null;
  lineNumber: number | null;
  side: string | null;
  anchoredSha: string | null;
  anchoredLineContent: string | null;
  bodyMarkdown: string;
  status: DraftStatus;
  isOverriddenStale: boolean;
  threadId: string | null;
  postedCommentId: number | null;
  postedBodySnapshot: string | null;
}

// In DraftPatchKind union: REMOVE 'draftSummaryMarkdown'.
export type DraftPatchKind =
  | 'newDraftComment'
  | 'newPrRootDraftComment'
  | 'updateDraftComment'
  | 'deleteDraftComment'
  | 'newDraftReply'
  | 'updateDraftReply'
  | 'deleteDraftReply'
  | 'overrideStale'
  | 'confirmVerdict'
  | 'draftVerdict'
  | 'markAllRead';
```

- [ ] **Step 2: Drop the patch builder case in `draft.ts`**

Edit `frontend/src/api/draft.ts` — delete the `case 'draftSummaryMarkdown'` block in `toApplyResultPatch` (or equivalent dispatcher).

- [ ] **Step 3: Run TypeScript build to surface every breakage**

Run: `cd frontend && npm run build`
Expected: a list of `Property 'draftSummaryMarkdown' does not exist on type 'ReviewSessionDto'` errors. Capture the list — Task 25 (cross-tier cleanup) will sweep them.

- [ ] **Step 4: Commit (partial — build is intentionally broken; Tasks 16-25 restore green)**

```bash
git add frontend/src/api/types.ts frontend/src/api/draft.ts
git commit -m "feat(api): drop draftSummaryMarkdown from ReviewSessionDto + DraftPatchKind"
```

---

### Task 16: `api/rootComment.ts` — `postRootComment`

**Files:**
- Create: `frontend/src/api/rootComment.ts`
- Test: `frontend/__tests__/api-rootComment.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { postRootComment } from '../src/api/rootComment';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

describe('postRootComment', () => {
  const server = setupServer();
  beforeAll(() => server.listen());
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it('returns ok on 204', async () => {
    server.use(
      http.post('/api/pr/acme/api/1/root-comment/post', () => new HttpResponse(null, { status: 204 })),
    );
    const r = await postRootComment({ owner: 'acme', repo: 'api', number: 1 });
    expect(r.ok).toBe(true);
  });

  it('maps 409 already-posted-body-mismatch with postedCommentId', async () => {
    server.use(
      http.post('/api/pr/acme/api/1/root-comment/post', () =>
        HttpResponse.json({ code: 'already-posted-body-mismatch', message: 'mismatch', postedCommentId: 42 }, { status: 409 })),
    );
    const r = await postRootComment({ owner: 'acme', repo: 'api', number: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('already-posted-body-mismatch');
      expect(r.postedCommentId).toBe(42);
    }
  });

  it('maps 502 github-forbidden', async () => { /* ... */ });
  it('maps network error to github-network-error', async () => { /* ... */ });
});
```

- [ ] **Step 2: Implement**

Create `frontend/src/api/rootComment.ts`:

```ts
import { apiClient, ApiError } from './client';
import type { PrReference } from './types';
import { prRefPath } from './prRef';

export interface PostRootCommentResult { ok: true; }
export interface PostRootCommentError {
  ok: false;
  code:
    | 'no-session' | 'no-root-draft' | 'body-too-large' | 'not-subscribed'
    | 'submit-in-progress' | 'already-posted-body-mismatch'
    | 'github-forbidden' | 'github-validation-error' | 'github-rate-limited'
    | 'github-server-error' | 'github-network-error';
  message: string;
  postedCommentId?: number;
}

export async function postRootComment(
  prRef: PrReference,
): Promise<PostRootCommentResult | PostRootCommentError> {
  try {
    await apiClient.post(`/api/pr/${prRefPath(prRef)}/root-comment/post`, undefined);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { code?: string; message?: string; postedCommentId?: number } | undefined;
      const code = (body?.code as PostRootCommentError['code']) ?? 'github-network-error';
      return {
        ok: false,
        code,
        message: body?.message ?? e.message,
        postedCommentId: body?.postedCommentId,
      };
    }
    return { ok: false, code: 'github-network-error', message: String(e) };
  }
}
```

- [ ] **Step 3: Verify tests pass**

Run: `cd frontend && npm test -- api-rootComment`
Expected: 4 PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/rootComment.ts frontend/__tests__/api-rootComment.test.ts
git commit -m "feat(api): postRootComment wrapper for /root-comment/post"
```

---

### Task 17: `api/submit.ts` — `discardOwnPendingReview`

**Files:**
- Modify: `frontend/src/api/submit.ts`
- Test: `frontend/__tests__/api-submit.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it('discardOwnPendingReview returns ok on 204', async () => {
  server.use(http.post('/api/pr/acme/api/1/submit/discard', () => new HttpResponse(null, { status: 204 })));
  const r = await discardOwnPendingReview({ owner: 'acme', repo: 'api', number: 1 });
  expect(r.ok).toBe(true);
});

it('maps 504 pipeline-cancellation-timeout', async () => { /* ... */ });
it('maps 502 github-delete-failed', async () => { /* ... */ });
```

- [ ] **Step 2: Implement**

```ts
export interface DiscardOwnPendingReviewResult { ok: true; }
export interface DiscardOwnPendingReviewError {
  ok: false;
  code: 'no-session' | 'not-subscribed' | 'pipeline-cancellation-timeout'
      | 'github-find-failed' | 'github-delete-failed' | 'github-network-error';
  message: string;
}

export async function discardOwnPendingReview(
  prRef: PrReference,
): Promise<DiscardOwnPendingReviewResult | DiscardOwnPendingReviewError> {
  try {
    await apiClient.post(`/api/pr/${prRefPath(prRef)}/submit/discard`, undefined);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { code?: string; message?: string } | undefined;
      return {
        ok: false,
        code: (body?.code as DiscardOwnPendingReviewError['code']) ?? 'github-network-error',
        message: body?.message ?? e.message,
      };
    }
    return { ok: false, code: 'github-network-error', message: String(e) };
  }
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npm test -- api-submit
git add frontend/src/api/submit.ts frontend/__tests__/api-submit.test.ts
git commit -m "feat(api): discardOwnPendingReview wrapper for /submit/discard"
```

---

### Task 18: `useSubmit` — expose `submitDialogOpen`, `discardOwnPendingReview`, `discardInFlight`

**Files:**
- Modify: `frontend/src/hooks/useSubmit.ts`
- Test: `frontend/__tests__/useSubmit.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
it('exposes discardOwnPendingReview that flips discardInFlight', async () => {
  const { result } = renderHook(() => useSubmit(PrRef));
  expect(result.current.discardInFlight).toBe(false);

  act(() => { void result.current.discardOwnPendingReview(); });
  expect(result.current.discardInFlight).toBe(true);

  await waitFor(() => expect(result.current.discardInFlight).toBe(false));
});

it('exposes submitDialogOpen for PrHeader pill visibility', () => {
  const { result } = renderHook(() => useSubmit(PrRef));
  expect(typeof result.current.submitDialogOpen).toBe('boolean');
});
```

- [ ] **Step 2: Extend the hook**

Edit `frontend/src/hooks/useSubmit.ts`:

```ts
export function useSubmit(prRef: PrReference) {
  // ... existing fields ...
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [discardInFlight, setDiscardInFlight] = useState(false);

  const discardOwnPendingReview = useCallback(async () => {
    setDiscardInFlight(true);
    try {
      return await discardOwnPendingReviewApi(prRef);
    } finally {
      setDiscardInFlight(false);
    }
  }, [prRef]);

  return {
    // ... existing returns ...
    submitDialogOpen,
    openSubmitDialog: () => setSubmitDialogOpen(true),
    closeSubmitDialog: () => setSubmitDialogOpen(false),
    discardOwnPendingReview,
    discardInFlight,
  };
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npm test -- useSubmit
git add frontend/src/hooks/useSubmit.ts frontend/__tests__/useSubmit.test.tsx
git commit -m "feat(useSubmit): submitDialogOpen + discardOwnPendingReview + discardInFlight"
```

---

## Phase H — Frontend component refactor

### Task 19: `useCantEditRootBodyReason` hook

**Files:**
- Create: `frontend/src/hooks/useCantEditRootBodyReason.ts`
- Test: `frontend/__tests__/useCantEditRootBodyReason.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
it('returns null when no other editor holds the draft', () => {
  const { result } = renderHook(() => useCantEditRootBodyReason({ prRef: PrRef, readOnly: false, ownerKey: 'submit-dialog' }));
  expect(result.current).toBeNull();
});

it('returns editing-in-other-tab when readOnly is true', () => {
  const { result } = renderHook(() => useCantEditRootBodyReason({ prRef: PrRef, readOnly: true, ownerKey: 'submit-dialog' }));
  expect(result.current).toBe('editing-in-other-tab');
});

it('returns editing-in-overview-composer when composer registry has a different owner', () => {
  // seed the open-composer registry with ownerKey='reply-composer' for this PR's PR-root draft
  // ...
  const { result } = renderHook(() => useCantEditRootBodyReason({ prRef: PrRef, readOnly: false, ownerKey: 'submit-dialog' }));
  expect(result.current).toBe('editing-in-overview-composer');
});
```

- [ ] **Step 2: Implement**

```ts
import { useOpenComposerRegistry } from './useOpenComposerRegistry';
import type { PrReference } from '../api/types';

type Reason = 'editing-in-overview-composer' | 'editing-in-other-tab' | null;

interface Args { prRef: PrReference; readOnly: boolean; ownerKey: 'reply-composer' | 'submit-dialog'; }

export function useCantEditRootBodyReason({ prRef, readOnly, ownerKey }: Args): Reason {
  const registry = useOpenComposerRegistry(prRef);
  if (readOnly) return 'editing-in-other-tab';
  const holder = registry.getPrRootHolder();
  if (holder && holder !== ownerKey) {
    return ownerKey === 'submit-dialog' ? 'editing-in-overview-composer' : 'editing-in-overview-composer';
    // The reverse case (composer disabled while dialog edits) uses the same string; the calling component picks copy.
  }
  return null;
}
```

(The `useOpenComposerRegistry` is the existing seam behind `registerOpenComposer`; expose a `getPrRootHolder()` that returns the current `ownerKey` if one is registered for the PR-root draft.)

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npm test -- useCantEditRootBodyReason
git add frontend/src/hooks/useCantEditRootBodyReason.ts frontend/__tests__/useCantEditRootBodyReason.test.tsx
git commit -m "feat(hooks): useCantEditRootBodyReason for cross-surface lock"
```

---

### Task 20: Extract `PrRootBodyEditor`

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx` (move textarea + autosave into the editor)
- Create: `frontend/__tests__/PrRootBodyEditor.test.tsx`

- [ ] **Step 1: Create `PrRootBodyEditor.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import { Modal } from '../../Modal/Modal';
import styles from './PrRootBodyEditor.module.css';
import type { PrReference } from '../../../api/types';
import type { ComposerBadge } from './composerBadge';

export interface PrRootBodyEditorProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string) => () => void;
  readOnly?: boolean;
  onBodyChange?: (body: string) => void;
  onAutosaveControl?: (control: { flush: () => Promise<void>; badge: ComposerBadge }) => void;
}

export function PrRootBodyEditor(props: PrRootBodyEditorProps) {
  const {
    prRef, prState, initialBody, draftId, onDraftIdChange,
    registerOpenComposer, readOnly = false, onBodyChange, onAutosaveControl,
  } = props;

  const [body, setBody] = useState(initialBody);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { badge, flush } = useComposerAutoSave({
    prRef, prState, body, draftId,
    anchor: { kind: 'pr-root' as const },
    onAssignedId: onDraftIdChange,
    onDraftDeletedByServer: () => {
      onDraftIdChange(null);
      setRecoveryOpen(true);
    },
    onLocalDelete: () => onDraftIdChange(null),
    disabled: readOnly,
  });

  useEffect(() => { onAutosaveControl?.({ flush, badge }); }, [flush, badge, onAutosaveControl]);
  useEffect(() => { onBodyChange?.(body); }, [body, onBodyChange]);

  useEffect(() => {
    if (draftId === null) return;
    return registerOpenComposer(draftId);
  }, [draftId, registerOpenComposer]);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  const closedBanner = prState !== 'open';

  return (
    <div className={styles.editor} data-composer="true">
      {closedBanner && (
        <div className="composer-closed-banner muted" role="status">
          PR {prState === 'closed' ? 'closed' : 'merged'} — text not saved
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="composer-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        readOnly={readOnly}
        aria-readonly={readOnly || undefined}
        aria-label="PR-level body"
      />
      <span className={`composer-badge composer-badge--${badge}`} role="status" data-testid="composer-badge">
        {badge}
      </span>

      <Modal
        open={recoveryOpen}
        title="PR reply draft deleted elsewhere"
        defaultFocus="primary"
        disableEscDismiss
        onClose={() => setRecoveryOpen(false)}
      >
        <p>This draft was deleted from another window or by reload. Re-create it with the current text, or discard?</p>
        <button type="button" data-modal-role="cancel" onClick={() => { setRecoveryOpen(false); }}>
          Discard
        </button>
        <button type="button" data-modal-role="primary" onClick={async () => { setRecoveryOpen(false); await flush(); }}>
          Re-create
        </button>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: Move existing composer test cases that exercise autosave + recovery into `PrRootBodyEditor.test.tsx`**

- [ ] **Step 3: Verify + commit**

```bash
cd frontend && npm test -- PrRootBodyEditor
git add frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx frontend/src/components/PrDetail/Composer/PrRootBodyEditor.module.css frontend/__tests__/PrRootBodyEditor.test.tsx
git commit -m "feat(composer): extract PrRootBodyEditor (shared body + autosave)"
```

---

### Task 21: Refactor `PrRootReplyComposer` — wrap `PrRootBodyEditor`, drop Save, add Post

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
- Modify: `frontend/__tests__/PrRootReplyComposer.test.tsx`

- [ ] **Step 1: Update the composer to wrap the editor**

```tsx
export function PrRootReplyComposer(props: PrRootReplyComposerProps) {
  const { prRef, prState, initialBody = '', draftId, onDraftIdChange, registerOpenComposer, onClose, readOnly = false } = props;

  const [body, setBody] = useState(initialBody);
  const [previewMode, setPreviewMode] = useState(false);
  const [postInFlight, setPostInFlight] = useState(false);
  const [postError, setPostError] = useState<PostRootCommentError | null>(null);
  const [discardModalOpen, setDiscardModalOpen] = useState(false);
  const autosaveControl = useRef<{ flush: () => Promise<void>; badge: ComposerBadge } | null>(null);

  const trimmedLength = body.trim().length;
  const bodyEmpty = trimmedLength === 0;
  const belowCreateThreshold = draftId === null && trimmedLength < COMPOSER_CREATE_THRESHOLD;
  const postDisabled = bodyEmpty || belowCreateThreshold || readOnly || postInFlight;

  const postTooltip =
    readOnly ? 'Another tab is editing this PR.'
    : bodyEmpty ? 'Type something to post.'
    : belowCreateThreshold ? `Type at least ${COMPOSER_CREATE_THRESHOLD} characters to post.`
    : '';

  const handlePost = async () => {
    if (postDisabled || !autosaveControl.current) return;
    setPostError(null);
    setPostInFlight(true);
    try {
      await autosaveControl.current.flush();
      const result = await postRootComment(prRef);
      if (!result.ok) {
        setPostError(result);
        return;
      }
      onClose();
    } finally {
      setPostInFlight(false);
    }
  };

  return (
    <div role="form" aria-label="Reply to this PR" data-composer="true" className={styles.composer}>
      {postError && (
        <div role="alert" data-testid="post-error" className={styles.postError}>
          {postError.code === 'already-posted-body-mismatch' ? (
            <>This comment was already posted. Your edits since then haven't been shipped.
              <button type="button" onClick={() => window.open(`...`, '_blank')}>Open on GitHub</button></>
          ) : (
            <>Couldn't post to GitHub: {postError.message}.
              <button type="button" onClick={handlePost}>Retry</button></>
          )}
        </div>
      )}

      {previewMode ? (
        <ComposerMarkdownPreview body={body} />
      ) : (
        <PrRootBodyEditor
          prRef={prRef} prState={prState} initialBody={initialBody}
          draftId={draftId} onDraftIdChange={onDraftIdChange}
          registerOpenComposer={registerOpenComposer}
          readOnly={readOnly || postInFlight}
          onBodyChange={setBody}
          onAutosaveControl={(c) => { autosaveControl.current = c; }}
        />
      )}

      <div className="composer-actions">
        <button type="button" className="composer-preview-toggle" aria-pressed={previewMode} onClick={() => setPreviewMode((p) => !p)}>
          {previewMode ? 'Edit' : 'Preview'}
        </button>
        <AiComposerAssistant />
        <button type="button" className="composer-discard" onClick={() => setDiscardModalOpen(true)} disabled={readOnly || postInFlight}>
          Discard
        </button>
        <button type="button" className="composer-post" disabled={postDisabled} title={postTooltip} onClick={handlePost}>
          {postInFlight ? 'Posting…' : 'Post'}
        </button>
      </div>

      {/* discard modal — unchanged shape from existing code, omitted */}
    </div>
  );
}
```

- [ ] **Step 2: Update keybindings**

`handleKeyDown`: Ctrl+Enter now calls `handlePost` (replaces the prior Save+close).

- [ ] **Step 3: Sweep test file**

Update `PrRootReplyComposer.test.tsx`:
- Remove "Save button is present" tests.
- Add "Post button is disabled while postInFlight" test.
- Add "Post failure renders error row" test.
- Add "Post 409 mismatch renders recovery banner" test.
- Existing autosave/recovery tests move to `PrRootBodyEditor.test.tsx` (Task 20).

- [ ] **Step 4: Run prettier + verify**

Run: `cd frontend && npm run prettier -- --write src/components/PrDetail/Composer/ __tests__/PrRootReplyComposer.test.tsx && npm test -- PrRootReplyComposer && npm run lint`
Expected: green; prettier reformatted any new files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx frontend/__tests__/PrRootReplyComposer.test.tsx
git commit -m "feat(composer): drop Save, add Post + error row (PR-root path)"
```

---

## Phase I — SubmitDialog rework

### Task 22: SubmitDialog — remove summary textarea + preview + Edit toggle + Discard footer

**Files:**
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx`
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.module.css`
- Modify: `frontend/__tests__/SubmitDialog.test.tsx`

- [ ] **Step 1: Remove the summary textarea + state**

Edit `SubmitDialog.tsx`: delete lines 72-93 (`setSummary`, the useEffect hydration, the textarea, and the `onSummaryChange` wire).

- [ ] **Step 2: Add the preview-or-edit body section**

Insert after the verdict picker:

```tsx
const prRootDraft = session.draftComments.find((d) => d.filePath === null && d.lineNumber === null) ?? null;
const [editing, setEditing] = useState(false);
const [bodyDraftId, setBodyDraftId] = useState<string | null>(prRootDraft?.id ?? null);
const cantEdit = useCantEditRootBodyReason({ prRef, readOnly, ownerKey: 'submit-dialog' });

useEffect(() => { if (!open) setEditing(false); }, [open]);

<section className={styles.prRootBodyEditorWrap} aria-label="PR-level body">
  <header className={styles.prRootBodyHeader}>
    <h3>PR-level body</h3>
    {!editing && (
      <button
        type="button"
        className="composer-preview-toggle"
        disabled={cantEdit !== null}
        title={
          cantEdit === 'editing-in-overview-composer' ? 'Editing in the Reply composer — close it to edit here'
          : cantEdit === 'editing-in-other-tab' ? 'Another tab is editing this PR.'
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
      prRef={prRef} prState={prState}
      initialBody={prRootDraft?.bodyMarkdown ?? ''}
      draftId={bodyDraftId} onDraftIdChange={setBodyDraftId}
      registerOpenComposer={(draftId) => registerOpenComposer(draftId, 'submit-dialog')}
      readOnly={readOnly}
    />
  ) : prRootDraft && prRootDraft.bodyMarkdown.trim().length > 0 ? (
    <MarkdownRenderer source={prRootDraft.bodyMarkdown} />
  ) : (
    <p className={`${styles.noPrRootBody} muted`}>No PR-level body — click Edit to add one.</p>
  )}
</section>
```

- [ ] **Step 3: Add Discard footer button**

Above the existing Submit/Cancel button row, prepend:

```tsx
{(session.pendingReviewId !== null || submitInFlight) && (
  <button
    type="button"
    className={styles.dialogDiscardButton}
    data-testid="dialog-discard"
    onClick={() => setDiscardModalOpen(true)}
  >
    Discard pending review
  </button>
)}
```

- [ ] **Step 4: Add the discardInFlight progress label**

The existing `SubmitProgressIndicator` accepts a `phase` prop today. Add a new "Cancelling…" branch driven by the `discardInFlight` flag from `useSubmit`.

- [ ] **Step 5: Update tests**

`SubmitDialog.test.tsx`:
- Remove "summary textarea renders" tests; add "summary textarea does NOT render" negative assertion.
- Add "PR-root body preview renders when prRootDraft exists".
- Add "clicking Edit mounts PrRootBodyEditor" + "clicking Done dismounts it".
- Add "Edit disabled when cross-tab readOnly" + "Edit disabled when reply composer holds the draft".

- [ ] **Step 6: Run prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/SubmitDialog/ __tests__/SubmitDialog.test.tsx
npm test -- SubmitDialog && npm run lint
git add frontend/src/components/PrDetail/SubmitDialog/ frontend/__tests__/SubmitDialog.test.tsx
git commit -m "feat(submit-dialog): remove summary textarea; preview + Edit toggle + Discard footer"
```

---

## Phase J — Modal + PrHeader pill

### Task 23: `DiscardPendingReviewConfirmationModal`

**Files:**
- Create: `frontend/src/components/PrDetail/DiscardPendingReviewConfirmationModal.tsx`
- Create: `frontend/src/components/PrDetail/DiscardPendingReviewConfirmationModal.module.css`
- Test: `frontend/__tests__/DiscardPendingReviewConfirmationModal.test.tsx`

- [ ] **Step 1: Component**

```tsx
import { Modal } from '../Modal/Modal';
import styles from './DiscardPendingReviewConfirmationModal.module.css';
import type { DiscardOwnPendingReviewError } from '../../api/submit';

interface Props {
  open: boolean;
  inFlight: boolean;
  error: DiscardOwnPendingReviewError | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DiscardPendingReviewConfirmationModal(props: Props) {
  const { open, inFlight, error, onConfirm, onClose } = props;
  return (
    <Modal open={open} title="Discard pending review on GitHub?" defaultFocus="cancel"
      disableEscDismiss={inFlight} onClose={onClose}>
      <ul className={styles.bullets}>
        <li>The pending review on GitHub will be deleted, along with its threads.</li>
        <li>Your PRism drafts and replies will be unstamped, ready to submit fresh.</li>
      </ul>
      {error && (
        <div role="alert" className={styles.errorRow}>
          Couldn't discard: {error.message}.
        </div>
      )}
      {inFlight ? (
        <>
          <button type="button" disabled aria-disabled className={styles.discardButton}>
            <span className={styles.spinner} aria-hidden /> Discarding…
          </button>
        </>
      ) : (
        <>
          <button type="button" data-modal-role="cancel" onClick={onClose}>
            {error ? 'Close' : 'Cancel'}
          </button>
          <button type="button" data-modal-role="primary" className={styles.discardButton} onClick={onConfirm}>
            {error ? 'Retry' : 'Discard'}
          </button>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 2: Tests**

```tsx
it('renders default state with Cancel + Discard buttons', () => { /* ... */ });
it('shows Discarding… spinner and hides Cancel during inFlight', () => { /* ... */ });
it('shows Close + Retry on error', () => { /* ... */ });
it('Esc dismisses unless inFlight', () => { /* ... */ });
```

- [ ] **Step 3: Run prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/DiscardPendingReviewConfirmationModal.* __tests__/DiscardPendingReviewConfirmationModal.test.tsx
npm test -- DiscardPendingReviewConfirmationModal
git add frontend/src/components/PrDetail/DiscardPendingReviewConfirmationModal.* frontend/__tests__/DiscardPendingReviewConfirmationModal.test.tsx
git commit -m "feat(submit): DiscardPendingReviewConfirmationModal"
```

---

### Task 24: `PrHeader` pending-review pill

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/src/components/PrDetail/PrHeader.module.css`
- Modify: `frontend/__tests__/PrDetailPage.test.tsx` (or a new PrHeader test file)

- [ ] **Step 1: Add the pill**

```tsx
const { discardOwnPendingReview, discardInFlight, submitDialogOpen } = useSubmit(prRef);
const [discardModalOpen, setDiscardModalOpen] = useState(false);
const [discardError, setDiscardError] = useState<DiscardOwnPendingReviewError | null>(null);

const handleDiscardConfirm = async () => {
  setDiscardError(null);
  const r = await discardOwnPendingReview();
  if (!r.ok) { setDiscardError(r); return; }
  setDiscardModalOpen(false);
};

{!submitDialogOpen && session.pendingReviewId !== null && (
  <button
    type="button"
    className={styles.pendingReviewPill}
    data-testid="pending-review-pill"
    onClick={() => setDiscardModalOpen(true)}
  >
    Pending review on GitHub · Discard
  </button>
)}

<DiscardPendingReviewConfirmationModal
  open={discardModalOpen}
  inFlight={discardInFlight}
  error={discardError}
  onConfirm={handleDiscardConfirm}
  onClose={() => { setDiscardModalOpen(false); setDiscardError(null); }}
/>
```

- [ ] **Step 2: Tests**

```tsx
it('pill renders when pendingReviewId set and dialog closed', () => { /* ... */ });
it('pill hidden when SubmitDialog open', () => { /* ... */ });
it('clicking pill opens the confirmation modal', () => { /* ... */ });
```

- [ ] **Step 3: Run prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/PrHeader.* __tests__/PrDetailPage.test.tsx
npm test -- PrHeader
git add frontend/src/components/PrDetail/PrHeader.* frontend/__tests__
git commit -m "feat(pr-header): pending-review pill + Discard modal wiring"
```

---

## Phase K — Cross-tier consumer cleanup

### Task 25: Migrate FE consumers of `draftSummaryMarkdown`

**Files:**
- Modify: `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx:23,44`
- Modify: `frontend/src/components/PrDetail/SubmitButton.tsx:43-46`
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:46` (if it has a default fixture with the field)
- Modify: every `__tests__/*.tsx` that constructs `ReviewSessionDto` with the field

- [ ] **Step 1: Grep for remaining references**

Run: `grep -rn "draftSummaryMarkdown" frontend/`
Expected: a list of files needing migration.

- [ ] **Step 2: `SubmitButton.isEmptyContent`**

Edit `frontend/src/components/PrDetail/SubmitButton.tsx`:

```ts
function isEmptyContent(s: ReviewSessionDto): boolean {
  const noDrafts = s.draftComments.length === 0;
  const noReplies = s.draftReplies.length === 0;
  return noDrafts && noReplies;
}
```

- [ ] **Step 3: `DiscardAllDraftsButton`**

Edit `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx` — replace `hasSummary` derivation:

```ts
const hasSummary = (session.draftComments.find((d) => d.filePath === null && d.lineNumber === null)?.bodyMarkdown ?? '').trim().length > 0;
```

- [ ] **Step 4: Test fixtures**

Sweep `__tests__/*.tsx` for `draftSummaryMarkdown: ...` in baseProps; remove every occurrence.

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "refactor(frontend): migrate draftSummaryMarkdown consumers to PR-root draft"
```

---

## Phase L — Playwright + parity baselines

### Task 26: Recapture `pr-detail-overview` parity baseline

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts` (the existing `pr-detail-overview` test)
- Update: `frontend/e2e/parity-baselines/pr-detail-overview.png`

- [ ] **Step 1: Run the existing parity test to surface the drift**

```bash
cd frontend && npm run dev &
sleep 5
npx playwright test parity-baselines.spec.ts --update-snapshots
```

Verify the new baseline includes the Post button on the PR-root composer + the `pending-review` pill on the header (when state is appropriate).

- [ ] **Step 2: Commit**

```bash
git add frontend/e2e/parity-baselines/pr-detail-overview.png
git commit -m "test(parity): recapture pr-detail-overview baseline (Post button + pill)"
```

---

### Task 27: New `submit-discard.spec.ts` Playwright scenarios

**Files:**
- Create: `frontend/e2e/submit-discard.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { setupAndOpenStaleDraftFixture } from './helpers/setup';

test.describe('PR-root Post + submit discard', () => {
  test('Post happy path', async ({ page }) => {
    await setupAndOpenStaleDraftFixture(page, /* with a fresh PR-root draft */);
    await page.locator('[data-testid="pr-root-reply-button"]').click();
    await page.locator('textarea[aria-label="PR-level body"]').fill('Hello from PRism');
    await page.locator('.composer-post').click();
    await expect(page.locator('[data-testid="composer-badge"]').filter({ hasText: /Posted/i })).toBeVisible({ timeout: 5000 });
    // Comment appears in PrRootConversation:
    await expect(page.locator('[data-testid="pr-root-comment"]').filter({ hasText: 'Hello from PRism' })).toBeVisible();
  });

  test('Post failure surface', async ({ page, request }) => {
    await request.post('http://localhost:5180/test/root-comment/force-failure', {
      data: { phase: 'github-create' },
    });
    // ... compose, Post, expect error row
  });

  test('Already-shipped retry (post-stamp force failure)', async ({ page, request }) => {
    await request.post('http://localhost:5180/test/root-comment/force-failure', {
      data: { phase: 'post-stamp' },
    });
    // ... compose, Post, observe success + stamped state; re-open composer; observe banner
  });

  test('Discard idle pending review', async ({ page }) => {
    // Seed state with a pending review id; navigate; expect pill; click; confirm; assert pill disappears
  });

  test('Discard in-flight pipeline', async ({ page, request }) => {
    await request.post('http://localhost:5180/test/submit/begin-delay', { data: { delayMs: 2000 } });
    // click Submit, then immediately Discard from dialog footer; expect "Cancelling…"; assert clean state
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
cd frontend && npx playwright test submit-discard.spec.ts
git add frontend/e2e/submit-discard.spec.ts
git commit -m "test(e2e): submit-discard Playwright scenarios"
```

---

### Task 28: New `submit-dialog.spec.ts` Playwright coverage

**Files:**
- Create (or extend existing): `frontend/e2e/submit-dialog.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
test('SubmitDialog no longer renders the legacy summary textarea', async ({ page }) => {
  // ... open dialog
  await expect(page.locator('textarea[aria-label="Review summary"]')).toHaveCount(0);
});

test('PR-root body preview renders when a draft exists', async ({ page }) => {
  // seed a PR-root draft; open dialog; observe preview
});

test('Edit toggle happy path: dialog → Edit → type → Done → preview re-renders', async ({ page }) => {
  // ...
});

test('Edit disabled when reply composer is open in the same tab', async ({ page }) => {
  // open Reply composer; open dialog; assert Edit is disabled + tooltip
});

test('Edit disabled under cross-tab readOnly', async ({ page }) => {
  // simulate readOnly via TabStamps fixture; assert tooltip
});
```

- [ ] **Step 2: Run + commit**

```bash
cd frontend && npx playwright test submit-dialog.spec.ts
git add frontend/e2e/submit-dialog.spec.ts
git commit -m "test(e2e): submit-dialog inline-edit + cross-surface lock"
```

---

## Final pre-merge gate

- [ ] **Step 1: Run the full pre-push checklist per `.ai/docs/development-process.md`**

```bash
dotnet build -c Release
dotnet test
cd frontend && npm install && npm run lint && npm run build && npm test && npx playwright test
```

All steps must be green before opening the PR.

- [ ] **Step 2: Confirm the deferrals sidecar**

If implementation surfaced any deferrals (foreign-pending-review body resume loss is the prime candidate per § 9 Q1 of the spec), populate `docs/specs/2026-06-01-pr-root-post-and-submit-discard-deferrals.md` BEFORE opening the PR. Sidecar template lives next to the spec; new deferrals go under `### [Defer] <title>`.

- [ ] **Step 3: Open the PR via `pr-autopilot`**

Don't `gh pr create` manually unless `pr-autopilot` is unavailable.

---


