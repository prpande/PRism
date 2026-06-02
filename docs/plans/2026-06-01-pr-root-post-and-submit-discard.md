# PR-root Post + discard own pending review — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **Before writing any code snippet that touches an existing file, grep / Read the file first** — v1 of this plan was rewritten after ce-doc-review round 2 surfaced ~30 factual errors from snippets that didn't match real signatures. Treat the code blocks below as starting points to verify, not verbatim recipes.

**Goal:** Ship the Post path for PR-root drafts + the discard-own-pending-review endpoint + the V6→V7 state migration that unifies `DraftSummaryMarkdown` into the PR-root `DraftComment`, plus the SubmitDialog inline-edit toggle.

**Source spec:** `docs/specs/2026-06-01-pr-root-post-and-submit-discard-design.md`.

**Verified seams (the assumptions every task rests on):**

- `IReviewEventBus.Publish<TEvent>(evt)` is **synchronous** (`PRism.Core/Events/IReviewEventBus.cs:5`). No `PublishAsync`.
- `StateChanged(PrReference PrRef, IReadOnlyList<string> FieldsTouched, string? SourceTabId)` (`PRism.Core/Events/StateChanged.cs:5-8`). Pass `SourceTabId: null` from our new endpoints.
- `SubmitOutcome` lives in `PRism.Core/Submit/Pipeline/SubmitOutcome.cs:20` (nested-record union). Add `Cancelled` there, not in `SubmitResults.cs`.
- `AppStateStore.MigrationSteps` (`AppStateStore.cs:21-29`) is an `(int ToVersion, Func<JsonObject, JsonObject> Transform)[]` with `.OrderBy(s => s.ToVersion).ToArray()`. Append the new step there.
- `ReviewSessionState` has **10 fields** (`AppState.cs:47-57`): TabStamps, LastSeenCommentId, PendingReviewId, PendingReviewCommitOid, ViewedFiles, DraftComments, DraftReplies, DraftSummaryMarkdown, DraftVerdict, DraftVerdictStatus. Task 3 drops only `DraftSummaryMarkdown`.
- State file JSON keys are **kebab-case** via `KebabCaseJsonNamingPolicy` (`PRism.Core/Json/JsonSerializerOptionsFactory.cs:19-22`). Migration reads `"draft-summary-markdown"`, `"draft-comments"`, `"side"` (single word — no hyphenation), `"file-path"`, `"line-number"`, `"body-markdown"`, `"posted-comment-id"`, `"posted-body-snapshot"`, `"status"` (PascalCase string value like `"Draft"`).
- `useDraftSession.registerOpenComposer(draftId: string) => () => void` (`useDraftSession.ts:23,37-45`) — refcount-only `Map<string, number>`. Task 19 extends this to track ownerKeys.
- `apiClient.post<T>(path, body, options)` (`api/client.ts:95-96`) returns `Promise<T>` and throws `ApiError` on non-2xx. There is no `.ok` field on the return value.
- `ComposerSaveBadge` is the type name (`useComposerAutoSave.ts:5`); union of `'saved' | 'saving' | 'unsaved' | 'rejected'`. No `'posted'` value exists.
- PUT /draft wire shape is `ReviewSessionPatch` typed record with optional named fields; verified pattern at `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs:52-72` (`SinglePatch(newRoot: new NewPrRootDraftCommentPayload(...))`).
- `IsSubscribed` returns 401 `unauthorized` (`PrSubmitEndpoints.cs:86-87`). Not 403.
- Lock + CTS lifetime: ownership transfers across the fire-and-forget Task.Run boundary; dispose inside the `finally`, NOT `using var` in the endpoint scope (`PrSubmitEndpoints.cs:146-225` + spec § 4.5 endpoint code block).
- Existing test hooks: `/test/submit/inject-failure` + `FakeReviewSubmitter.InjectFailure(name, ex, afterEffect)` for forced failures; `/test/submit/set-begin-delay` + `FakeReviewSubmitter.SetBeginDelay(ms)` for in-flight delays. Both at `TestEndpoints.cs:340-357`. Do NOT introduce new force-failure or begin-delay endpoints.
- Migration test pattern: `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs` — raw-string inline JSON via `JsonNode.Parse("""...""")!.AsObject()`. NO `Fixtures/` directory.

**Pre-merge sequencing constraint.** Tasks 1, 2, 3 together flip the state schema (V6→V7) and remove `DraftSummaryMarkdown`. They MUST land in one slice without a release in between. Backend tests are red between Task 3 and Task 7 (pipeline still throws on PR-root drafts in AttachThreads until Task 7 partitions). Frontend TS build is red between Task 15 and Task 25 (consumers reference the dropped field). Plan this as a single PR; do not push to main until Task 28 is green.

---

## Phase A — V7 state schema + migration

### Task 1: Add `PostedCommentId` + `PostedBodySnapshot` to `DraftComment`

**Files:**
- Modify: `PRism.Core/State/AppState.cs:63-75`
- Test: `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs` (existing file; add a new fact)

- [ ] **Step 1: Read the existing record + a couple of existing round-trip cases**

Read `AppState.cs:63-75` and at least one existing `DraftComment` round-trip test to confirm field-order, JSON-naming, and how `AppStateRoundTripTests` invokes the serializer.

- [ ] **Step 2: Add the failing test**

Construct a `DraftComment` with PostedCommentId=12345L + PostedBodySnapshot="hello", serialize via the AppState's storage options, deserialize, assert equivalence. Pattern mirrors existing fact in that file.

- [ ] **Step 3: Run and verify red**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~DraftComment"
```

Expected: compilation fails (`PostedCommentId` / `PostedBodySnapshot` don't exist).

- [ ] **Step 4: Add fields with trailing defaults**

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

Both new fields trail-default to null. Existing call sites do not need updating (record positional constructors with trailing defaults are compatible).

- [ ] **Step 5: Run and verify green**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~DraftComment"
dotnet build PRism.Core/PRism.Core.csproj -c Release
```

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/State/AppState.cs tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs
git commit -m "feat(state): add DraftComment.PostedCommentId + PostedBodySnapshot (V7 prep)"
```

---

### Task 2: V6→V7 migration

**Files:**
- Modify: `PRism.Core/State/AppStateStore.cs:11` (CurrentVersion) and `:21-29` (`MigrationSteps`)
- Modify: `PRism.Core/State/AppState.cs:40-44` (`AppState.Default` Version: 6→7)
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs` (add `MigrateV6ToV7`)
- Create: `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV6ToV7Tests.cs`

- [ ] **Step 1: Read precedent**

Read `AppStateMigrations.cs:104-151` (V5→V6) for the multi-account iteration + partial-rollback discriminator pattern.
Read `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs` end-to-end for the raw-string JSON test idiom (no fixture files).
Read `PrSessionsMigrations.cs:30-62` to confirm the kebab-case JSON keys we will be reading (`"draft-comments"`, `"draft-summary-markdown"`, etc.). Note also `:41-43` for the corrupted-shape-throws precedent.

- [ ] **Step 2: Write failing tests first** (~8 facts; same shape as V5→V6 tests)

Create `AppStateMigrationsV6ToV7Tests.cs` with raw-string fixtures. Cover (filenames are just fact names — no fixture dir):

```csharp
[Fact] public void Lifts_summary_into_synthesized_pr_root_draft_when_none_exists()
[Fact] public void Appends_summary_into_existing_pr_root_draft_body()
[Fact] public void Idempotent_when_summary_empty_and_no_pr_root_draft()
[Fact] public void Iterates_every_account_not_just_default()
[Fact] public void Collapses_multiple_pr_root_drafts_with_visible_marker()
[Fact] public void Throws_on_partial_rollback_summary_plus_posted_comment_id()
[Fact] public void Throws_on_corrupted_draft_comments_shape()
[Fact] public void Preserves_thread_id_on_existing_pr_root_draft()
```

Each fact builds JSON via `JsonNode.Parse("""...""")!.AsObject()`, calls `AppStateMigrations.MigrateV6ToV7(root)`, asserts on resulting nodes. Refer to existing V5→V6 fact bodies for shape.

Expected: fail-to-compile until the method exists.

- [ ] **Step 3: Implement `MigrateV6ToV7`**

Add to `AppStateMigrations.cs` (between `MigrateV5ToV6` and the closing brace). Skeleton:

```csharp
public static JsonObject MigrateV6ToV7(JsonObject root)
{
    if (root["accounts"] is not JsonObject accounts)
    {
        root["version"] = 7;
        return root;
    }

    // Partial-rollback discriminator (precedent: V4→V5, V5→V6). Iterate first; if any session
    // has `draft-summary-markdown` set AND a PR-root draft carrying `posted-comment-id`, throw —
    // that combination indicates a V7+ file rolled back to V6 then re-upgraded, and the lift
    // would silently merge a body that was already posted.
    foreach (var (accountKey, accountNode) in accounts)
    {
        var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) continue;
        foreach (var (sessionKey, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;
            var summary = session["draft-summary-markdown"]?.GetValue<string?>();
            if (string.IsNullOrEmpty(summary?.Trim())) continue;
            if (session["draft-comments"] is not JsonArray drafts) continue;
            foreach (var draftNode in drafts)
            {
                if (draftNode is not JsonObject d) continue;
                if (d["side"]?.GetValue<string?>() != "pr") continue;
                if (d["file-path"]?.GetValue<string?>() is not null) continue;
                if (d["posted-comment-id"] is not null && d["posted-comment-id"]!.GetValue<long?>() is not null)
                    throw new System.Text.Json.JsonException(
                        $"state.json session {accountKey}/{sessionKey} has draft-summary-markdown set " +
                        "AND a PR-root draft carrying posted-comment-id. Looks like a V7→V6 partial rollback; quarantining.");
            }
        }
    }

    // Lift pass.
    foreach (var (_, accountNode) in accounts)
    {
        var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) continue;
        foreach (var (sessionKey, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;
            LiftSummaryIntoPrRootDraft(sessionKey, session);
        }
    }

    root["version"] = 7;
    return root;
}

private static void LiftSummaryIntoPrRootDraft(string sessionKey, JsonObject session)
{
    var summary = session["draft-summary-markdown"]?.GetValue<string?>();
    var trimmed = summary?.Trim() ?? "";

    // Defensive shape check (precedent: PrSessionsMigrations.AddV3DraftCollections:41-43).
    if (session["draft-comments"] is { } draftsNode && draftsNode is not JsonArray)
        throw new System.Text.Json.JsonException(
            $"state.json reviews.sessions['{sessionKey}'].draft-comments must be a JSON array (V6→V7)");

    var drafts = (session["draft-comments"] as JsonArray) ?? new JsonArray();

    // Collect PR-root drafts (side == "pr" AND file-path == null).
    var prRoots = new List<JsonObject>();
    foreach (var n in drafts)
    {
        if (n is not JsonObject d) continue;
        if (d["side"]?.GetValue<string?>() != "pr") continue;
        if (d["file-path"] is not null && d["file-path"]!.GetValue<string?>() is not null) continue;
        prRoots.Add(d);
    }

    // Collapse multiples (defensive — composer hydration shadows duplicates today,
    // but a test endpoint or hand-edit could produce them).
    if (prRoots.Count > 1)
    {
        prRoots = prRoots.OrderBy(d => d["id"]!.GetValue<string>(), StringComparer.Ordinal).ToList();
        var survivor = prRoots[^1];
        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < prRoots.Count - 1; i++)
        {
            var ns = prRoots[i];
            sb.Append("<!-- migrated from previously-shadowed draft ");
            sb.Append(ns["id"]!.GetValue<string>());
            sb.Append(" -->\n\n");
            sb.Append(ns["body-markdown"]?.GetValue<string>() ?? "");
            sb.Append("\n\n");
            drafts.Remove(ns);
        }
        sb.Append(survivor["body-markdown"]?.GetValue<string>() ?? "");
        survivor["body-markdown"] = sb.ToString();
        prRoots = new List<JsonObject> { survivor };
    }

    // Lift summary (if any).
    if (trimmed.Length > 0)
    {
        if (prRoots.Count == 1)
        {
            var existing = prRoots[0]["body-markdown"]?.GetValue<string>() ?? "";
            prRoots[0]["body-markdown"] = existing.Length > 0
                ? existing + "\n\n" + summary
                : summary;
        }
        else
        {
            var synthesized = new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(),
                ["file-path"] = null,
                ["line-number"] = null,
                ["side"] = "pr",
                ["anchored-sha"] = null,
                ["anchored-line-content"] = null,
                ["body-markdown"] = summary,
                ["status"] = "Draft",
                ["is-overridden-stale"] = false,
                ["thread-id"] = null,
                ["posted-comment-id"] = null,
                ["posted-body-snapshot"] = null,
            };
            drafts.Add(synthesized);
            session["draft-comments"] = drafts;
        }
    }

    session.Remove("draft-summary-markdown");
}
```

**Important:** verify EVERY kebab-case key against an actual round-tripped V6 state file from a running PoC OR against `JsonSerializerOptionsFactory.cs` naming policy + `ReviewSessionState` / `DraftComment` field names. Run a quick round-trip print before trusting key names.

- [ ] **Step 4: Register the migration step**

Edit `AppStateStore.cs:21-29`:

```csharp
private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
    new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
    {
        (2, AppStateMigrations.MigrateV1ToV2),
        (3, AppStateMigrations.MigrateV2ToV3),
        (4, AppStateMigrations.MigrateV3ToV4),
        (5, AppStateMigrations.MigrateV4ToV5),
        (6, AppStateMigrations.MigrateV5ToV6),
        (7, AppStateMigrations.MigrateV6ToV7),
    }.OrderBy(s => s.ToVersion).ToArray();
```

Edit `AppStateStore.cs:11`:

```csharp
private const int CurrentVersion = 7;
```

Edit `AppState.cs:40-44`:

```csharp
public static AppState Default { get; } = new(
    Version: 7,
    UiPreferences: UiPreferences.Default,
    Accounts: ImmutableDictionary<string, AccountState>.Empty
        .Add(AccountKeys.Default, AccountState.Default));
```

- [ ] **Step 5: Run all tests + verify green**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj
```

Sweep any existing `new AppState(...)` literal in tests that passed `Version: 6` — those need to bump to 7. Same for any fixture round-trip assertion.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core PRism.Core.Tests
git commit -m "feat(state): V6→V7 migration lifting DraftSummaryMarkdown into PR-root DraftComment"
```

---

### Task 3: Drop `DraftSummaryMarkdown` from `ReviewSessionState`

**Files:**
- Modify: `PRism.Core/State/AppState.cs:47-57` (`ReviewSessionState`)
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (every `session.DraftSummaryMarkdown` reference)
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:31` (drop `"draft-summary"` from `SubmittedFields`)
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:118-122` (drop `&& summary empty` from rule (e))
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs` (drop `"draftSummaryMarkdown"` from `ScalarKinds` + the patch handler arm)
- Modify: every existing test that constructs `ReviewSessionState` literally

- [ ] **Step 1: Read existing references**

```bash
grep -rn "DraftSummaryMarkdown\|draftSummaryMarkdown\|draft-summary-markdown\|\"draft-summary\"" PRism.Core PRism.Web tests
```

Save the list. Each one needs updating in this task.

- [ ] **Step 2: Modify `ReviewSessionState`**

Edit `AppState.cs:47-57` — remove ONLY the `DraftSummaryMarkdown` field. The other 9 fields stay in place and in order:

```csharp
public sealed record ReviewSessionState(
    IReadOnlyDictionary<string, TabStamp> TabStamps,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);
```

- [ ] **Step 3: Replace the pipeline's summaryBody source**

In `SubmitPipeline.cs`, find the `BeginPendingReviewAsync(...)` call (currently `session.DraftSummaryMarkdown ?? ""` near line 173). Replace with:

```csharp
var summaryBody = session.DraftComments
    .SingleOrDefault(d => d.FilePath is null && d.LineNumber is null)
    ?.BodyMarkdown ?? "";
```

Pass `summaryBody` to `BeginPendingReviewAsync`. Add this as a private static helper at the bottom of the class if you prefer:

```csharp
private static string ExtractPrRootBody(ReviewSessionState s) =>
    s.DraftComments.SingleOrDefault(d => d.FilePath is null && d.LineNumber is null)
        ?.BodyMarkdown ?? "";
```

Also remove the `DraftSummaryMarkdown = null,` line from `ClearSubmittedSession` (the field no longer exists; Task 7 will further update `ClearSubmittedSession` to partition `DraftComments`).

- [ ] **Step 4: Update endpoints + patch handler**

`PrSubmitEndpoints.cs:31`:
```csharp
private static readonly string[] SubmittedFields = { "draft-comments", "draft-replies", "draft-verdict", "draft-verdict-status", "pending-review" };
```

`PrSubmitEndpoints.cs:118-122` — rule (e):
```csharp
if (verdict == SubmitEvent.Comment
    && session.DraftComments.Count == 0
    && session.DraftReplies.Count == 0)
    return Results.Json(new SubmitErrorDto("no-content", "..."), statusCode: 400);
```

`PrDraftEndpoints.cs:42` (`ScalarKinds`):
```csharp
private static readonly string[] ScalarKinds = { "draftVerdict" };
```

In the same file, find the `case "draftSummaryMarkdown":` block in the patch dispatcher (around line 245-251 in the current state) and **delete it**. The dispatcher's `default` branch will reject the kind as invalid; that's the intended behavior for stale-tab compatibility (the V6 SPA reload will 400 once and the user is prompted to refresh).

Also remove the `"draftSummaryMarkdown"` from the dispatcher's `ScalarKinds` membership-check and from any helper like `ExtractUserBody`.

- [ ] **Step 5: Sweep test breakage**

```bash
dotnet build -c Release
```

Every `new ReviewSessionState(...)` literal in tests breaks (one fewer field). Fix mechanically. Every test that constructed `ReviewSessionDto` with `draftSummaryMarkdown` in JSON breaks. Fix.

- [ ] **Step 6: Run tests**

```bash
dotnet test
```

Expect: green except for any test that asserts pipeline behavior involving PR-root drafts AS DraftComment — those break until Task 7 partitions AttachThreads. Document that in the commit message.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core PRism.Web tests
git commit -m "feat(state): drop ReviewSessionState.DraftSummaryMarkdown (V7 unification, pre-pipeline-partition)"
```

---

## Phase B — shared backend helpers

### Task 4: Extract `ClearPendingReviewStamps` into `SessionOverlays`

**Files:**
- Create: `PRism.Core/State/SessionOverlays.cs`
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (replace the private static at ~line 603-612 + call sites)
- Test: `tests/PRism.Core.Tests/State/SessionOverlaysTests.cs`

- [ ] **Step 1: Read the current helper + its 2 call sites**

```bash
grep -n "ClearPendingReviewStamps\|WithSession" PRism.Core/Submit/Pipeline/SubmitPipeline.cs
```

Expected: the private static method definition + ALL call sites (there is more than just two — verify line by line). Also find the private `WithSession` helper to decide whether to ALSO extract it (it has multiple callers in the pipeline).

- [ ] **Step 2: Decide WithSession's fate**

Two options:
- **Keep `WithSession` private in `SubmitPipeline`** — `SessionOverlays.ClearPendingReviewStamps` inlines the dictionary swap. Simpler; no new file beyond `SessionOverlays.cs`.
- **Extract `WithSession` to a separate `internal static`** — only if simpler than inlining.

Recommend: **inline the dictionary swap inside `SessionOverlays.ClearPendingReviewStamps`** to avoid introducing a second new file. The 3-line swap is not worth a new class.

- [ ] **Step 3: Write failing tests**

```csharp
public class SessionOverlaysTests
{
    [Fact]
    public void ClearPendingReviewStamps_NullsAllPendingFieldsAndThreadIds()
    {
        // Build a minimal AppState containing one session under accounts.default
        // with PendingReviewId, ThreadId on a draft, ReplyCommentId on a reply.
        // Call SessionOverlays.ClearPendingReviewStamps(state, sessionKey).
        // Assert PendingReviewId/PendingReviewCommitOid null; ThreadId/ReplyCommentId null.
    }

    [Fact]
    public void ClearPendingReviewStamps_PreservesPostedCommentIdAndSnapshot()
    {
        // Seed a PR-root draft with PostedCommentId=42, PostedBodySnapshot="x".
        // Clear stamps. Assert both Posted* fields unchanged.
    }
}
```

- [ ] **Step 4: Create the file**

```csharp
namespace PRism.Core.State;

public static class SessionOverlays
{
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
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared };
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }
}
```

Verify `state.WithDefaultReviews(...)` is the actual extension used by `PrDraftEndpoints.cs` (read line 163 around the existing `state.WithDefaultReviews(...)` call to confirm; otherwise use whatever `AppState`-update helper the existing pipeline uses inside its private `WithSession`).

- [ ] **Step 5: Replace pipeline call sites**

In `SubmitPipeline.cs`, replace every call to the private `ClearPendingReviewStamps` with `SessionOverlays.ClearPendingReviewStamps(state, sessionKey)`. Delete the private static.

- [ ] **Step 6: Verify**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj
```

- [ ] **Step 7: Commit**

```bash
git add PRism.Core tests/PRism.Core.Tests/State/SessionOverlaysTests.cs
git commit -m "refactor(state): extract ClearPendingReviewStamps to SessionOverlays"
```

---

### Task 5: `SubmitCancellationRegistry` primitive

**Files:**
- Create: `PRism.Web/Submit/SubmitCancellationRegistry.cs`
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (add singleton next to `SubmitLockRegistry`)
- Test: `tests/PRism.Web.Tests/Submit/SubmitCancellationRegistryTests.cs`

- [ ] **Step 1: Read `SubmitLockRegistry` for the precedent shape**

```bash
cat PRism.Web/Submit/SubmitLockRegistry.cs
```

Adopt the same internal-sealed-class style, ConcurrentDictionary, RegistrationHandle pattern.

- [ ] **Step 2: Write failing tests**

```csharp
public class SubmitCancellationRegistryTests
{
    private static PrReference PrRef => new("acme", "api", 1);

    [Fact] public void Register_then_RequestCancel_trips_the_token() { /* ... */ }
    [Fact] public void RequestCancel_on_unknown_prRef_is_noop() { /* ... */ }
    [Fact] public void Register_while_prior_registration_alive_throws_InvalidOperationException() { /* ... */ }
    [Fact] public void Dispose_removes_entry_allows_re_register() { /* ... */ }
    [Fact] public void Late_dispose_does_not_remove_fresh_registration() { /* ... */ }
}
```

- [ ] **Step 3: Implement**

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
                $"SubmitCancellationRegistry: a registration already exists for {key}. " +
                "This indicates a stuck pipeline missed its finally cleanup.");
        }
        return new RegistrationHandle(this, key, cts);
    }

    public void RequestCancel(PrReference reference)
    {
        ArgumentNullException.ThrowIfNull(reference);
        if (_ctsByPrRef.TryGetValue(reference.ToString(), out var cts))
        {
            try { cts.Cancel(); }
            catch (ObjectDisposedException) { /* race vs Task.Run finally */ }
        }
    }

    private sealed class RegistrationHandle : IDisposable
    {
        private readonly SubmitCancellationRegistry _owner;
        private readonly string _key;
        private readonly CancellationTokenSource _cts;
        private int _disposed;

        public RegistrationHandle(SubmitCancellationRegistry o, string k, CancellationTokenSource c)
        { _owner = o; _key = k; _cts = c; }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                _owner._ctsByPrRef.TryRemove(new KeyValuePair<string, CancellationTokenSource>(_key, _cts));
        }
    }
}
```

- [ ] **Step 4: Register the singleton**

Read `PRism.Web/Composition/ServiceCollectionExtensions.cs` to find the line that registers `SubmitLockRegistry` as a singleton. Add `services.AddSingleton<SubmitCancellationRegistry>();` immediately after it.

- [ ] **Step 5: Verify + commit**

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SubmitCancellationRegistry"
git add PRism.Web/Submit/SubmitCancellationRegistry.cs PRism.Web/Composition/ServiceCollectionExtensions.cs tests/PRism.Web.Tests/Submit/SubmitCancellationRegistryTests.cs
git commit -m "feat(submit): add SubmitCancellationRegistry primitive"
```

---

## Phase C — pipeline OCE + AttachThreads partition

### Task 6: `SubmitOutcome.Cancelled` + pipeline OCE catch + endpoint case

**Files:**
- Modify: `PRism.Core/Submit/Pipeline/SubmitOutcome.cs` (add the variant)
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (catch OCE → return Cancelled)
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:177-207` (new case + terminal Failed SSE)
- Test: `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineCancelTests.cs`

- [ ] **Step 1: Read the existing `SubmitOutcome.cs` + outcome switch**

```bash
cat PRism.Core/Submit/Pipeline/SubmitOutcome.cs
sed -n '170,230p' PRism.Web/Endpoints/PrSubmitEndpoints.cs
```

- [ ] **Step 2: Add the variant**

In `SubmitOutcome.cs`, inside the abstract record body:

```csharp
public sealed record Cancelled(SubmitStep LastStep, string Reason) : SubmitOutcome;
```

- [ ] **Step 3: Write failing test**

```csharp
[Fact]
public async Task SubmitAsync_when_ct_canceled_mid_step_returns_Cancelled()
{
    var fake = /* InMemoryReviewSubmitter with BeginDelay = 2000 */;
    var pipeline = new SubmitPipeline(fake, /* in-memory store */);
    using var cts = new CancellationTokenSource();
    var progress = new Progress<SubmitProgressEvent>(_ => { });

    var task = pipeline.SubmitAsync(PrRef, SeedSession(), SubmitEvent.Comment, "sha", progress, cts.Token);
    cts.CancelAfter(50);
    var outcome = await task;

    outcome.Should().BeOfType<SubmitOutcome.Cancelled>();
}
```

- [ ] **Step 4: Add the OCE catch**

In `SubmitPipeline.cs`, wrap the existing try-catch (`catch (SubmitFailedException)`) with a preceding `catch (OperationCanceledException) when (ct.IsCancellationRequested)` that captures the last-emitted `SubmitStep` and returns `new SubmitOutcome.Cancelled(lastStep, "Pipeline canceled by caller (discard).")`. Track the last step via a local mutable variable updated alongside each `progress.Report(new SubmitProgressEvent(step, Started, ...))`.

- [ ] **Step 5: Add the endpoint case**

In `PrSubmitEndpoints.cs`, inside the outcome switch (after the `case SubmitOutcome.StaleCommitOidRecreating:` block):

```csharp
case SubmitOutcome.Cancelled cancelled:
    // Emit a terminal Failed SSE for the last-known step so the SubmitDialog
    // progress UI moves out of an orphan "Started" state. The discard endpoint
    // owns the user-facing "discarded" signal — we don't publish anything else here.
    progress.Report(new SubmitProgressEvent(cancelled.LastStep, SubmitStepStatus.Failed, 0, 0, "cancelled"));
    s_pipelineCancelled(loggerFactory.CreateLogger(LoggerCategory), sessionKey, cancelled.Reason, null);
    break;
```

Add the LoggerMessage delegate at the top of the class:

```csharp
private static readonly Action<ILogger, string, string, Exception?> s_pipelineCancelled =
    LoggerMessage.Define<string, string>(LogLevel.Information, new EventId(4, "SubmitPipelineCancelled"),
        "Submit pipeline cancelled for {SessionKey}: {Reason}");
```

- [ ] **Step 6: Update the OCE catch's log comment**

Lines 209-212 currently say "Host shutting down — per-step persists already wrote". Update the comment to acknowledge that the linked CTS will be added in Task 11 and that the catch will catch both host-shutdown AND user-discard.

- [ ] **Step 7: Verify + commit**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SubmitPipelineCancel"
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj
git add PRism.Core/Submit/Pipeline PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineCancelTests.cs
git commit -m "feat(submit): SubmitOutcome.Cancelled + terminal SSE event on user-discard"
```

---

### Task 7: `StepAttachThreadsAsync` partition + `ClearSubmittedSession` PR-root consumption

**Files:**
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` (filter + delete throw block + partition)
- Test: `tests/PRism.Core.Tests/Submit/Pipeline/SubmitPipelineAttachThreadsTests.cs` (new + update existing `SuccessClearsSession` tests)

- [ ] **Step 1: Read the throw block + ClearSubmittedSession**

```bash
sed -n '275,295p' PRism.Core/Submit/Pipeline/SubmitPipeline.cs
sed -n '614,635p' PRism.Core/Submit/Pipeline/SubmitPipeline.cs
```

- [ ] **Step 2: Write failing tests**

```csharp
[Fact]
public async Task AttachThreads_filters_pr_root_drafts_silently()
{
    // Session with one inline draft + one PR-root draft.
    // Run pipeline to success.
    // Assert: fake.AttachedThreads has 1 inline (no PR-root); fake.BeginCalls[0].SummaryBody equals PR-root body.
}

[Fact]
public async Task SuccessfulSubmit_removes_unposted_pr_root_draft_keeps_posted_one()
{
    // Session with one PR-root draft having PostedCommentId = null, AND one with PostedCommentId = 99.
    // Run pipeline to success.
    // Assert: post-submit session.DraftComments contains only the Posted one.
}
```

- [ ] **Step 3: Add the partition filter**

In `StepAttachThreadsAsync` (around line 212):

```csharp
var drafts = session.DraftComments
    .Where(d => d.Status != DraftStatus.Stale)
    .Where(d => d.FilePath is not null && d.LineNumber is not null)
    .ToList();
```

Delete the `if (draft.FilePath is null || draft.LineNumber is null) throw ...` block at line 284-292 — unreachable after the filter.

- [ ] **Step 4: Update `ClearSubmittedSession`**

Edit the `DraftComments = new List<DraftComment>()` line to partition:

```csharp
DraftComments = cur.DraftComments
    .Where(d => (d.Status == DraftStatus.Stale && !d.IsOverriddenStale)
             || d.PostedCommentId is not null)
    .ToList(),
```

The first clause preserves existing stale-not-overridden semantics; the second preserves PR-root drafts that were already Posted (their lifecycle is independent of submit). Unposted PR-root drafts are CONSUMED by Submit (mirrors inline-thread consumption — the body shipped as `review.body`).

- [ ] **Step 5: Sweep `SuccessClearsSession*` tests**

Existing tests asserting "DraftComments empty post-submit" need updating to the partition rule. Read the existing test bodies, add explicit Posted-survives + Stale-survives cases.

- [ ] **Step 6: Verify + commit**

```bash
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj
git add PRism.Core/Submit/Pipeline tests/PRism.Core.Tests/Submit
git commit -m "feat(submit): AttachThreads partition + PR-root consumption on success"
```

---

## Phase D — GitHub seam

### Task 8: `CreateIssueCommentAsync` on `IReviewSubmitter`

**Files:**
- Modify: `PRism.Core/IReviewSubmitter.cs` (add method)
- Modify: `PRism.Core/Submit/SubmitResults.cs` (add `CreatedIssueCommentResult`)
- Create: `PRism.GitHub/GitHubReviewService.IssueComments.cs` (REST partial)
- Modify: `PRism.Web/TestHooks/FakeReviewSubmitter.cs` (implement)
- Modify: `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs` (implement — usually a no-op throw is fine; the pipeline doesn't call it)
- Modify: `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs` (implement — same)
- Modify: `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointFakes.cs` (`TestReviewSubmitter` — implement)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceIssueCommentsTests.cs`

- [ ] **Step 1: Grep all existing IReviewSubmitter implementers**

```bash
grep -rln ": IReviewSubmitter\|implements IReviewSubmitter" PRism.GitHub PRism.Web tests
```

Expected: at least 4 — `GitHubReviewService`, `FakeReviewSubmitter`, `InMemoryReviewSubmitter`, `TestReviewSubmitter`, possibly `PrDetailFakeReviewService`. ALL need the new method (CS0535 build break otherwise).

- [ ] **Step 2: Add the interface method**

`PRism.Core/IReviewSubmitter.cs`:

```csharp
Task<CreatedIssueCommentResult> CreateIssueCommentAsync(
    PrReference reference,
    string bodyMarkdown,
    CancellationToken ct);
```

Add `CreatedIssueCommentResult` in `PRism.Core/Submit/SubmitResults.cs`:

```csharp
public sealed record CreatedIssueCommentResult(long Id, DateTimeOffset CreatedAt);
```

- [ ] **Step 3: Implement on every implementer**

`FakeReviewSubmitter` — full impl (records the comment for tests + honors `InjectFailure("CreateIssueCommentAsync")`):

```csharp
private long _nextIssueCommentId = 1000;
public List<(PrReference Pr, string Body)> IssueCommentsCreated { get; } = new();

public Task<CreatedIssueCommentResult> CreateIssueCommentAsync(PrReference reference, string bodyMarkdown, CancellationToken ct)
{
    ct.ThrowIfCancellationRequested();
    lock (_gate)
    {
        // InjectFailure honored via the existing _failureByMethod registry:
        if (_failureByMethod.TryGetValue(nameof(CreateIssueCommentAsync), out var inj))
        {
            _failureByMethod.Remove(nameof(CreateIssueCommentAsync));
            if (!inj.AfterEffect) throw inj.Ex;
            // afterEffect=true: record the comment THEN throw (lost-response window).
            var id = Interlocked.Increment(ref _nextIssueCommentId);
            IssueCommentsCreated.Add((reference, bodyMarkdown));
            throw inj.Ex;
        }
        var newId = Interlocked.Increment(ref _nextIssueCommentId);
        IssueCommentsCreated.Add((reference, bodyMarkdown));
        return Task.FromResult(new CreatedIssueCommentResult(newId, DateTimeOffset.UtcNow));
    }
}
```

The other 3 test fakes (`InMemoryReviewSubmitter`, `TestReviewSubmitter`, `PrDetailFakeReviewService`) only need a stub:

```csharp
public Task<CreatedIssueCommentResult> CreateIssueCommentAsync(PrReference reference, string bodyMarkdown, CancellationToken ct)
    => throw new NotImplementedException("CreateIssueCommentAsync is not exercised by this fake.");
```

`GitHubReviewService` — new partial file `GitHubReviewService.IssueComments.cs`. **Read `GitHubReviewService.cs` end-to-end first** to confirm: the partial-class declaration syntax, the auth-header pattern, the HttpClient field name (`_httpClient` may differ), the token-provider seam, the JSON deserialization helpers. The REST endpoint is:

```
POST https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments
Headers: Authorization: Bearer <token>, Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28
Body: { "body": "<markdown>" }
```

Returns JSON with `id` (number) and `created_at` (ISO 8601). Throw `HttpRequestException` (with `StatusCode`) on non-2xx — that's how Task 10 maps to typed error codes.

- [ ] **Step 4: Write failing tests + verify**

```csharp
[Fact]
public async Task FakeReviewSubmitter_CreateIssueComment_records_the_comment()
{
    var fake = new FakeReviewSubmitter();
    var r = await fake.CreateIssueCommentAsync(PrRef, "hi", default);
    r.Id.Should().BeGreaterThan(0);
    fake.IssueCommentsCreated.Should().ContainSingle(c => c.Body == "hi");
}

[Fact]
public async Task FakeReviewSubmitter_InjectFailure_throws()
{
    var fake = new FakeReviewSubmitter();
    fake.InjectFailure("CreateIssueCommentAsync", new HttpRequestException("forced"));
    await fake.Invoking(f => f.CreateIssueCommentAsync(PrRef, "hi", default)).Should().ThrowAsync<HttpRequestException>();
}
```

```bash
dotnet build -c Release
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~CreateIssueComment"
```

- [ ] **Step 5: Commit**

```bash
git add PRism.Core PRism.GitHub PRism.Web/TestHooks tests
git commit -m "feat(github): IReviewSubmitter.CreateIssueCommentAsync (REST seam)"
```

---

## Phase E — endpoints

### Task 9: `newPrRootDraftComment` upsert

**Files:**
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs` (the `case "newPrRootDraftComment":` block, ~line 271-285)
- Test: `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs` (extend)

- [ ] **Step 1: Read the patch handler block + an existing test**

```bash
sed -n '85,180p' PRism.Web/Endpoints/PrDraftEndpoints.cs
sed -n '270,300p' PRism.Web/Endpoints/PrDraftEndpoints.cs
sed -n '50,100p' tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs
```

Note: the patch handler runs INSIDE `store.UpdateAsync` (line 149-166 surrounds the `ApplyPatch` switch). `_gate` already serializes — concurrent racing `newPrRootDraftComment` PUTs both observe their first-call's persisted state because the second's load is gated.

- [ ] **Step 2: Write failing tests**

Extend `PrDraftEndpointTests.cs` (use the existing `SinglePatch(newRoot: ...)` helper at line 60-72):

```csharp
[Fact]
public async Task NewPrRootDraftComment_when_existing_present_updates_in_place()
{
    var client = ClientWithTab();
    var first = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft",
        SinglePatch(newRoot: new NewPrRootDraftCommentPayload("first body")));
    first.StatusCode.Should().Be(HttpStatusCode.OK);

    var second = await client.PutAsJsonAsync("/api/pr/acme/api/123/draft",
        SinglePatch(newRoot: new NewPrRootDraftCommentPayload("second body")));
    second.StatusCode.Should().Be(HttpStatusCode.OK);

    var getResp = await client.GetAsync("/api/pr/acme/api/123/draft");
    var session = await ReadApiJsonAsync<ReviewSessionDto>(getResp);
    session!.DraftComments.Should().ContainSingle(d => d.FilePath == null);
    session.DraftComments.Single(d => d.FilePath == null).BodyMarkdown.Should().Be("second body");
}
```

- [ ] **Step 3: Apply the upsert in the case block**

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

- [ ] **Step 4: Verify + commit**

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~NewPrRootDraftComment"
git add PRism.Web/Endpoints/PrDraftEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs
git commit -m "fix(draft): newPrRootDraftComment upserts on existing PR-root row"
```

---

### Task 10: `POST /api/pr/.../root-comment/post` endpoint

**Files:**
- Create: `PRism.Web/Endpoints/PrRootCommentEndpoints.cs`
- Modify: `PRism.Web/Program.cs` (call `app.MapPrRootCommentEndpoints()` next to `MapPrSubmitEndpoints()`)
- Test: `tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs`

- [ ] **Step 1: Read the existing submit endpoint for shape parity**

```bash
sed -n '20,170p' PRism.Web/Endpoints/PrSubmitEndpoints.cs
```

Note the IsSubscribed 401 pattern (line 86-87), the SubmitLockRegistry 409 pattern (line 152-153), and the SubmitErrorDto record shape.

- [ ] **Step 2: Write failing tests** (use FakeReviewSubmitter introspection):

```csharp
[Fact] public async Task PostRootComment_happy_path_returns_204_and_records_comment() { /* ... */ }
[Fact] public async Task PostRootComment_no_session_returns_400_no_session() { /* ... */ }
[Fact] public async Task PostRootComment_no_root_draft_returns_400_no_root_draft() { /* ... */ }
[Fact] public async Task PostRootComment_already_posted_same_body_returns_204_no_github_call() { /* ... */ }
[Fact] public async Task PostRootComment_already_posted_different_body_returns_409_mismatch() { /* ... */ }
[Fact] public async Task PostRootComment_force_failure_returns_502() { /* uses /test/submit/inject-failure */ }
[Fact] public async Task PostRootComment_lock_held_returns_409_submit_in_progress() { /* uses /test/submit/set-begin-delay */ }
[Fact] public async Task PostRootComment_unauthorized_returns_401() { /* ... */ }
```

- [ ] **Step 3: Implement the endpoint**

`PrRootCommentEndpoints.cs`:

```csharp
namespace PRism.Web.Endpoints;

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

        if (!cache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR first."),
                statusCode: StatusCodes.Status401Unauthorized);

        // Lock — same per-PR slot Submit uses. 409 on contention.
#pragma warning disable CA2000  // released in the finally block below; CA2000 can't see the try/finally
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit or post is in progress."),
                statusCode: StatusCodes.Status409Conflict);

        try
        {
            var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
            if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session))
                return Results.Json(new SubmitErrorDto("no-session", "No draft session."), statusCode: 400);

            var draft = session.DraftComments.FirstOrDefault(d => d.FilePath is null && d.LineNumber is null);
            if (draft is null)
                return Results.Json(new SubmitErrorDto("no-root-draft", "No PR-root draft to post."), statusCode: 400);

            // Already-posted branch.
            if (draft.PostedCommentId is not null)
            {
                if (!string.Equals(draft.PostedBodySnapshot ?? "", draft.BodyMarkdown, StringComparison.Ordinal))
                {
                    return Results.Json(
                        new PostMismatchErrorDto("already-posted-body-mismatch",
                            "This comment was already posted; the current body differs from what shipped.",
                            PostedCommentId: draft.PostedCommentId.Value),
                        statusCode: StatusCodes.Status409Conflict);
                }
                await DeleteDraftAsync(stateStore, sessionKey, draft.Id, ct).ConfigureAwait(false);
                bus.Publish(new StateChanged(prRef, FieldsTouchedDraftComments, SourceTabId: null));
                return Results.NoContent();
            }

            // Defensive body-cap (PUT /draft 16 KiB middleware is the real gate; this is defense-in-depth).
            if (draft.BodyMarkdown.Length > PipelineMarker.GitHubReviewBodyMaxChars)
                return Results.Json(new SubmitErrorDto("body-too-large", "PR-level body exceeds GitHub limit."), statusCode: 400);

            CreatedIssueCommentResult created;
            try
            {
                created = await submitter.CreateIssueCommentAsync(prRef, draft.BodyMarkdown, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException hre)
            {
                return Results.Json(new SubmitErrorDto(MapGithubError(hre), "GitHub rejected the request."), statusCode: 502);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.Json(new SubmitErrorDto("github-network-error", "Network failure."), statusCode: 502);
            }

            // Stamp PostedCommentId + PostedBodySnapshot (overlay #1 — observable for retry).
            var stampedBody = draft.BodyMarkdown;
            await stateStore.UpdateAsync(state =>
            {
                if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
                var list = s.DraftComments.Select(d => d.Id == draft.Id
                    ? d with { PostedCommentId = created.Id, PostedBodySnapshot = stampedBody }
                    : d).ToList();
                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
                    { [sessionKey] = s with { DraftComments = list } };
                return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
            }, ct).ConfigureAwait(false);

            // Delete the (now-stamped) draft (overlay #2).
            await DeleteDraftAsync(stateStore, sessionKey, draft.Id, ct).ConfigureAwait(false);

            bus.Publish(new StateChanged(prRef, FieldsTouchedDraftComments, SourceTabId: null));
            bus.Publish(new RootCommentPostedBusEvent(prRef, created.Id));  // see Task 14
            return Results.NoContent();
        }
        finally
        {
            await handle.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static string MapGithubError(HttpRequestException hre) => hre.StatusCode switch
    {
        System.Net.HttpStatusCode.Forbidden => "github-forbidden",
        System.Net.HttpStatusCode.UnprocessableEntity => "github-validation-error",
        System.Net.HttpStatusCode.TooManyRequests => "github-rate-limited",
        >= System.Net.HttpStatusCode.InternalServerError => "github-server-error",
        _ => "github-network-error",
    };

    private static Task DeleteDraftAsync(IAppStateStore store, string sessionKey, string draftId, CancellationToken ct) =>
        store.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var s)) return state;
            var list = s.DraftComments.Where(d => d.Id != draftId).ToList();
            var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
                { [sessionKey] = s with { DraftComments = list } };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, ct);
}

internal sealed record PostMismatchErrorDto(string Code, string Message, long PostedCommentId);
```

- [ ] **Step 4: Verify state.WithDefaultReviews exists**

```bash
grep -n "WithDefaultReviews" PRism.Core/State/AppState.cs PRism.Web/Endpoints/PrDraftEndpoints.cs
```

If the extension has a different name (e.g., `WithReviews` on a specific account), use that instead. The pattern must match what PrDraftEndpoints uses today.

- [ ] **Step 5: Register the endpoint + verify**

```csharp
// In Program.cs, near the existing MapPrSubmitEndpoints() call:
app.MapPrRootCommentEndpoints();
```

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PrRootCommentEndpoint"
git add PRism.Web/Endpoints/PrRootCommentEndpoints.cs PRism.Web/Program.cs tests
git commit -m "feat(submit): POST /root-comment/post endpoint"
```

---

### Task 11: `POST /api/pr/.../submit/discard` endpoint + CTS register at endpoint

**Files:**
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (new route handler + CTS registration around the existing Task.Run)
- Test: `tests/PRism.Web.Tests/Endpoints/PrSubmitDiscardEndpointTests.cs`

- [ ] **Step 1: Read the existing submit endpoint fire-and-forget pattern**

```bash
sed -n '146,230p' PRism.Web/Endpoints/PrSubmitEndpoints.cs
```

Note specifically: `handle` is acquired outside Task.Run (line 150), disposed INSIDE Task.Run's `finally` (line 225). The cross-task ownership transfer is intentional and `#pragma warning disable CA2000` silences the analyzer. The CTS + registration must follow the SAME pattern.

- [ ] **Step 2: Add CTS registration to the existing SubmitAsync handler**

After line 150 (`var handle = await lockRegistry.TryAcquireAsync(...)`) and before line 156 (`var headSha = callerStamp.HeadSha;`), accept the new DI parameter `SubmitCancellationRegistry cancellationRegistry` on the endpoint signature, then:

```csharp
#pragma warning disable CA2000  // disposed in Task.Run finally
var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(appLifetime.ApplicationStopping);
IDisposable registration;
try
{
    registration = cancellationRegistry.Register(prRef, linkedCts);
}
catch (InvalidOperationException)
{
    // Stuck pipeline missed cleanup. Shouldn't normally happen — but if it does,
    // release the lock and 409 the user. Don't crash with a 500.
    linkedCts.Dispose();
    await handle.DisposeAsync().ConfigureAwait(false);
    return Results.Json(new SubmitErrorDto("submit-in-progress", "A prior submit's cleanup is still pending."),
        statusCode: 409);
}
#pragma warning restore CA2000
var pipelineCt = linkedCts.Token;  // replaces appLifetime.ApplicationStopping
```

In the Task.Run lambda's `finally` block (line 223-226), update to also dispose registration + linkedCts:

```csharp
finally
{
    registration.Dispose();
    linkedCts.Dispose();
    await handle.DisposeAsync().ConfigureAwait(false);
}
```

- [ ] **Step 3: Add the discard route handler**

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

    if (!cache.IsSubscribed(prRef))
        return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR first."), statusCode: 401);

    // 1. Signal cancel (idempotent).
    cancellationRegistry.RequestCancel(prRef);

    // 2. Acquire lock with 30s timeout — wait for the in-flight pipeline to release.
    await using var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);
    if (handle is null)
        return Results.Json(new SubmitErrorDto("pipeline-cancellation-timeout", "Pipeline did not release within 30s."),
            statusCode: 504);

    // 3. Re-fetch own pending review (TOCTOU defense).
    OwnPendingReviewSnapshot? snapshot;
    try
    {
        snapshot = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
    }
    catch (HttpRequestException hre)
    {
        return Results.Json(new SubmitErrorDto(MapGithubError(hre), "GitHub find-own failed."), statusCode: 502);
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Json(new SubmitErrorDto("github-network-error", "Network failure."), statusCode: 502);
    }

    if (snapshot is not null)
    {
        try
        {
            await submitter.DeletePendingReviewAsync(prRef, snapshot.PullRequestReviewId, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException hre) when (hre.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // Already gone — proceed to clear stamps.
        }
        catch (HttpRequestException hre)
        {
            return Results.Json(new SubmitErrorDto(MapGithubError(hre), "GitHub delete failed."), statusCode: 502);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Results.Json(new SubmitErrorDto("github-network-error", "Network failure."), statusCode: 502);
        }
    }

    // 4. Clear stamps via the shared overlay.
    await stateStore.UpdateAsync(s => SessionOverlays.ClearPendingReviewStamps(s, sessionKey), ct).ConfigureAwait(false);

    // 5. Publish.
    bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));

    return Results.NoContent();
}

// Add MapGithubError here too (same shape as PrRootCommentEndpoints.MapGithubError).
```

`PendingReviewFields` already exists at line 32 of `PrSubmitEndpoints.cs`. Verify.

- [ ] **Step 4: Add tests**

Tests for: idle no-op, GitHub 404 as success, GitHub 5xx returns 502 + stamps remain, in-flight cancellation (uses `/test/submit/set-begin-delay`), 401 unauthorized, 504 timeout.

- [ ] **Step 5: Verify + commit**

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SubmitDiscard"
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrSubmitDiscardEndpointTests.cs
git commit -m "feat(submit): POST /submit/discard + endpoint-scoped CTS registration"
```

---

### Task 12: Verify test-endpoint registration is environment-gated

**Files:**
- Inspect: `PRism.Web/TestHooks/TestEndpoints.cs` + `Program.cs` registration site

- [ ] **Step 1: Confirm `MapTestEndpoints` is called only under `IsEnvironment("Test")`**

```bash
grep -n "MapTestEndpoints\|IsEnvironment" PRism.Web/Program.cs PRism.Web/TestHooks/TestEndpoints.cs
```

If the call is guarded → nothing to do.

If unguarded → add the guard:

```csharp
if (app.Environment.IsEnvironment("Test"))
    app.MapTestEndpoints();
```

- [ ] **Step 2: Add a negative test if absent**

```csharp
[Fact]
public async Task TestEndpoints_return_404_in_production_environment() { /* ... */ }
```

- [ ] **Step 3: Commit (if any change)**

```bash
git add PRism.Web/Program.cs tests
git commit -m "chore(test-hooks): gate /test/* registration on IsEnvironment(\"Test\")"
```

(If no change needed, skip this commit.)

---

### Task 13: Add new endpoints to body-size middleware

**Files:**
- Modify: `PRism.Web/Program.cs:173-194` (UseWhen predicate)

- [ ] **Step 1: Read the existing predicate end-to-end**

```bash
sed -n '170,200p' PRism.Web/Program.cs
```

The predicate is method-aware (POST-only, PUT-only sub-branches). PRESERVE that structure.

- [ ] **Step 2: Add two clauses to the POST branch**

```csharp
return value.EndsWith("/reload", StringComparison.Ordinal)
    || value.EndsWith("/submit", StringComparison.Ordinal)
    || value.EndsWith("/submit/foreign-pending-review/resume", StringComparison.Ordinal)
    || value.EndsWith("/submit/foreign-pending-review/discard", StringComparison.Ordinal)
    || value.EndsWith("/submit/discard", StringComparison.Ordinal)          // NEW
    || value.EndsWith("/root-comment/post", StringComparison.Ordinal)       // NEW
    || value.EndsWith("/drafts/discard-all", StringComparison.Ordinal);
```

Do NOT collapse the method-aware checks into a single ternary; keep the existing shape intact.

- [ ] **Step 3: Verify + commit**

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~BodySize|FullyQualifiedName~Middleware"
git add PRism.Web/Program.cs
git commit -m "chore(web): cap new endpoints under existing body-size middleware"
```

---

## Phase F — SSE / events

### Task 14: `RootCommentPostedBusEvent` + SSE projection + frontend refetch

**Files:**
- Modify: `PRism.Core/Events/SubmitBusEvents.cs` (add record)
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (wire-record + Subscribe)
- Modify: `frontend/src/hooks/usePrDetail.ts` (subscribe to the new event)
- Test: `tests/PRism.Web.Tests/Sse/SseEventProjectionTests.cs` (extend) + `frontend/__tests__/usePrDetail.test.tsx`

- [ ] **Step 1: Read precedent in both files**

```bash
cat PRism.Core/Events/SubmitBusEvents.cs
grep -n "SubmitForeignPendingReview\|stream.on" PRism.Web/Sse/SseEventProjection.cs frontend/src/hooks/usePrDetail.ts frontend/src/hooks/useSubmit.ts
```

`useSubmit.ts:76` shows the consumer pattern: `const stream = useEventSource(); stream.on('...', ...)`. `usePrDetail.ts` likely uses the same `useEventSource()` seam — verify.

- [ ] **Step 2: Add the bus event**

`PRism.Core/Events/SubmitBusEvents.cs`:

```csharp
public sealed record RootCommentPostedBusEvent(PrReference PrRef, long IssueCommentId) : IReviewEvent;
```

(Confirm `IReviewEvent` is the marker interface in this file — match existing precedent.)

- [ ] **Step 3: Wire the SSE projection**

Add to `SseEventProjection.cs` (mirror the `SubmitForeignPendingReviewBusEvent` wire-up):

```csharp
internal sealed record RootCommentPostedSseEvent(long issueCommentId);

// In the Subscribe block:
bus.Subscribe<RootCommentPostedBusEvent>(evt =>
    publisher.Publish(evt.PrRef, "root-comment-posted", new RootCommentPostedSseEvent(evt.IssueCommentId)));
```

(Exact API of `publisher.Publish` — read the existing `SubmitForeignPendingReviewBusEvent` site to copy the signature.)

- [ ] **Step 4: Wire the frontend listener**

Edit `usePrDetail.ts` — find the `useEventSource()` consumer (or the existing pattern). Add a listener for `'root-comment-posted'` that calls the hook's existing refetch path.

If `usePrDetail.ts` does NOT currently use `useEventSource()`, the listener can live in `useReviewEventStream` (if such a hook exists) or in `useSubmit.ts` as a pass-through that calls a parent-supplied callback. Read the actual code to decide; the spec calls out "the seam that owns PR-detail re-fetches alongside other Submit* events."

- [ ] **Step 5: Tests + commit**

```bash
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~RootCommentPosted"
cd frontend && npm test -- usePrDetail
git add PRism.Core/Events PRism.Web/Sse tests frontend
git commit -m "feat(sse): RootCommentPosted bus event + projection + frontend refetch"
```

---

## Phase G — frontend API + hooks

### Task 15: Drop `draftSummaryMarkdown` from `api/types.ts` + serializePatch

**Files:**
- Modify: `frontend/src/api/types.ts` (remove field from `ReviewSessionDto` + `DraftPatchKind` union + `ReviewSessionPatch` record)
- Modify: `frontend/src/api/draft.ts:42-43` (remove `case 'draftSummaryMarkdown'` in `serializePatch`)
- Modify: `frontend/src/api/types.ts` (add `postedCommentId: number | null` to `DraftCommentDto`)

- [ ] **Step 1: Grep all references**

```bash
grep -rn "draftSummaryMarkdown" frontend/
```

Catalog every site. They divide into THIS task (api layer) and Task 25 (component consumers).

- [ ] **Step 2: Update `api/types.ts`**

Remove `draftSummaryMarkdown` from `ReviewSessionDto`. Remove `'draftSummaryMarkdown'` from `DraftPatchKind` union. Add `postedCommentId: number | null` to `DraftCommentDto`. **Do NOT add `postedBodySnapshot`** — it's server-side only.

- [ ] **Step 3: Update `serializePatch`**

Delete the `case 'draftSummaryMarkdown':` block at lines 42-43. The `default: never` exhaustiveness check guarantees the remaining union is consistent.

- [ ] **Step 4: Sweep `ReviewSessionPatch`**

The `ReviewSessionPatch` record at `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs:55` includes a `summary` field. Confirm whether the TS type uses the same name or different. Update both sides.

- [ ] **Step 5: Build to surface every breakage**

```bash
cd frontend && npm run build
```

Capture the TS error list — Task 25 will sweep them.

- [ ] **Step 6: Commit (build intentionally broken until Task 25)**

```bash
git add frontend/src/api
git commit -m "feat(api): drop draftSummaryMarkdown wire-shape; add postedCommentId"
```

---

### Task 16: `api/rootComment.ts`

**Files:**
- Create: `frontend/src/api/rootComment.ts`
- Test: `frontend/__tests__/api-rootComment.test.ts`

- [ ] **Step 1: Read `api/submit.ts` for the try/catch pattern**

```bash
sed -n '50,120p' frontend/src/api/submit.ts
```

`submit.ts:78-80` shows the canonical `if (e instanceof ApiError)` mapping pattern.

- [ ] **Step 2: Write failing tests** (use existing `msw` / `setupServer` test pattern from `__tests__/api-*.test.ts`)

```ts
it('returns ok on 204', async () => { /* ... */ });
it('maps 409 already-posted-body-mismatch with postedCommentId payload', async () => { /* ... */ });
it('maps 502 github-forbidden', async () => { /* ... */ });
it('maps network failures to github-network-error', async () => { /* ... */ });
it('maps 401 to unauthorized', async () => { /* ... */ });
```

- [ ] **Step 3: Implement**

```ts
import { apiClient, ApiError } from './client';
import type { PrReference } from './types';

export interface PostRootCommentResult { ok: true; }
export interface PostRootCommentError {
  ok: false;
  code:
    | 'unauthorized'
    | 'no-session' | 'no-root-draft' | 'body-too-large'
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
    await apiClient.post<unknown>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/root-comment/post`,
      undefined,
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { code?: string; message?: string; postedCommentId?: number } | undefined;
      return {
        ok: false,
        code: (body?.code as PostRootCommentError['code']) ?? 'github-network-error',
        message: body?.message ?? e.message,
        postedCommentId: body?.postedCommentId,
      };
    }
    return { ok: false, code: 'github-network-error', message: String(e) };
  }
}
```

- [ ] **Step 4: Verify + commit**

```bash
cd frontend && npm run prettier -- --write src/api/rootComment.ts __tests__/api-rootComment.test.ts
npm test -- api-rootComment
git add frontend/src/api/rootComment.ts frontend/__tests__/api-rootComment.test.ts
git commit -m "feat(api): postRootComment wrapper"
```

---

### Task 17: `discardOwnPendingReview` in `api/submit.ts`

**Files:**
- Modify: `frontend/src/api/submit.ts`
- Test: `frontend/__tests__/api-submit.test.ts`

- [ ] **Step 1: Find the `discardForeignPendingReview` precedent**

```bash
grep -n "discardForeignPendingReview" frontend/src/api/submit.ts
```

Mirror its shape: same try/catch, same error shape.

- [ ] **Step 2: Add `discardOwnPendingReview`**

```ts
export interface DiscardOwnPendingReviewResult { ok: true; }
export interface DiscardOwnPendingReviewError {
  ok: false;
  code: 'unauthorized' | 'pipeline-cancellation-timeout'
      | 'github-find-failed' | 'github-delete-failed' | 'github-network-error'
      | 'github-forbidden' | 'github-validation-error' | 'github-rate-limited' | 'github-server-error';
  message: string;
}

export async function discardOwnPendingReview(
  prRef: PrReference,
): Promise<DiscardOwnPendingReviewResult | DiscardOwnPendingReviewError> {
  try {
    await apiClient.post<unknown>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/submit/discard`,
      undefined,
    );
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
git commit -m "feat(api): discardOwnPendingReview wrapper"
```

---

### Task 18: `useSubmit` — extend with `submitDialogOpen`, `discardOwnPendingReview`, `discardInFlight`

**Files:**
- Modify: `frontend/src/hooks/useSubmit.ts`
- Test: `frontend/__tests__/useSubmit.test.tsx`

- [ ] **Step 1: Read the current state shape**

```bash
sed -n '1,80p' frontend/src/hooks/useSubmit.ts
```

Note the discriminated `SubmitState` union. Adding boolean flags is additive; do NOT touch the union shape.

- [ ] **Step 2: Add the new returns**

Extend `UseSubmitResult` (line 48-58):

```ts
export interface UseSubmitResult {
  // ... existing ...
  submitDialogOpen: boolean;
  openSubmitDialog: () => void;
  closeSubmitDialog: () => void;
  discardOwnPendingReview: () => Promise<DiscardOwnPendingReviewResult | DiscardOwnPendingReviewError>;
  discardInFlight: boolean;
}
```

Inside the hook:

```ts
const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
const [discardInFlight, setDiscardInFlight] = useState(false);

const discardOwnPendingReview = useCallback(async () => {
  setDiscardInFlight(true);
  try {
    return await discardOwnPendingReviewApi(reference);
  } finally {
    setDiscardInFlight(false);
  }
}, [reference.owner, reference.repo, reference.number]);
```

Import `discardOwnPendingReview as discardOwnPendingReviewApi` from `../api/submit` and its return types.

- [ ] **Step 3: Tests + commit**

```bash
cd frontend && npm test -- useSubmit
git add frontend/src/hooks/useSubmit.ts frontend/__tests__/useSubmit.test.tsx
git commit -m "feat(useSubmit): submitDialogOpen + discardOwnPendingReview + discardInFlight"
```

---

## Phase H — frontend component refactor

### Task 19: Extend `useDraftSession.registerOpenComposer` with `ownerKey` + `useCantEditRootBodyReason` hook

**Files:**
- Modify: `frontend/src/hooks/useDraftSession.ts:23,34-45` (extend signature + storage)
- Create: `frontend/src/hooks/useCantEditRootBodyReason.ts`
- Test: `frontend/__tests__/useDraftSession.test.tsx` + new `__tests__/useCantEditRootBodyReason.test.tsx`

- [ ] **Step 1: Read every existing call site of `registerOpenComposer`**

```bash
grep -rn "registerOpenComposer" frontend/src
```

Catalog them — they all need updating to pass an `ownerKey`.

- [ ] **Step 2: Extend `useDraftSession`**

Change the storage from `Map<string, number>` to `Map<string, Set<OwnerKey>>`:

```ts
export type ComposerOwnerKey = 'reply-composer' | 'submit-dialog' | 'files-tab' | 'drafts-tab';

export interface UseDraftSessionResult {
  // ... existing ...
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  getPrRootHolder: () => ComposerOwnerKey | null;
}

// Inside the hook:
const openComposers = useRef(new Map<string, Set<ComposerOwnerKey>>());
const isOpen = useCallback((id: string) => (openComposers.current.get(id)?.size ?? 0) > 0, []);

const registerOpenComposer = useCallback((draftId: string, ownerKey: ComposerOwnerKey): (() => void) => {
  const m = openComposers.current;
  let set = m.get(draftId);
  if (!set) { set = new Set(); m.set(draftId, set); }
  set.add(ownerKey);
  return () => {
    const s = m.get(draftId);
    if (!s) return;
    s.delete(ownerKey);
    if (s.size === 0) m.delete(draftId);
  };
}, []);

const getPrRootHolder = useCallback((): ComposerOwnerKey | null => {
  // Find the session's PR-root draft id from session.draftComments.
  // Return the first ownerKey holding it (deterministic — Set iteration is insertion order).
  if (!session) return null;
  const prRoot = session.draftComments.find((d) => d.filePath === null && d.lineNumber === null);
  if (!prRoot) return null;
  const set = openComposers.current.get(prRoot.id);
  if (!set || set.size === 0) return null;
  return set.values().next().value as ComposerOwnerKey;
}, [session]);
```

- [ ] **Step 3: Update every call site**

Existing `registerOpenComposer(draftId)` calls all need a second arg. Pass `'files-tab'` for inline composers under FilesTab, `'drafts-tab'` for Drafts-tab composers, etc. The two NEW callers (Tasks 20/22) pass `'reply-composer'` and `'submit-dialog'`.

- [ ] **Step 4: Create `useCantEditRootBodyReason`**

```ts
import type { ComposerOwnerKey } from './useDraftSession';

export type CantEditRootBodyReason = 'editing-in-overview-composer' | 'editing-in-submit-dialog' | 'editing-in-other-tab' | null;

interface Args {
  readOnly: boolean;          // cross-tab ownership (TabStamps gate)
  ownerKey: ComposerOwnerKey; // caller's identity
  prRootHolder: ComposerOwnerKey | null; // from useDraftSession.getPrRootHolder()
}

export function useCantEditRootBodyReason({ readOnly, ownerKey, prRootHolder }: Args): CantEditRootBodyReason {
  if (readOnly) return 'editing-in-other-tab';
  if (prRootHolder === null || prRootHolder === ownerKey) return null;
  if (prRootHolder === 'reply-composer') return 'editing-in-overview-composer';
  if (prRootHolder === 'submit-dialog') return 'editing-in-submit-dialog';
  return null;
}
```

(Pure function — could just be a helper, but a hook signature anticipates future state.)

- [ ] **Step 5: Tests + commit**

```bash
cd frontend && npm test -- useDraftSession useCantEditRootBodyReason
git add frontend/src/hooks frontend/__tests__
git commit -m "feat(hooks): registerOpenComposer ownerKey + useCantEditRootBodyReason"
```

---

### Task 20: Extract `PrRootBodyEditor`

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.tsx`
- Create: `frontend/src/components/PrDetail/Composer/PrRootBodyEditor.module.css`
- Move tests: from `PrRootReplyComposer.test.tsx` → `PrRootBodyEditor.test.tsx` (the autosave + recovery cases)

- [ ] **Step 1: Read the existing composer end-to-end**

```bash
cat frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx
```

Identify what moves to the editor (textarea + autosave + recovery modal lifecycle) vs what stays in the composer (Discard/Post/Preview/AI affordances).

- [ ] **Step 2: Create `PrRootBodyEditor.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD, type ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { Modal } from '../../Modal/Modal';
import type { PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import styles from './PrRootBodyEditor.module.css';

export interface PrRootBodyEditorProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;
  readOnly?: boolean;
  onBodyChange?: (body: string) => void;
  onAutosaveControl?: (control: { flush: () => Promise<void>; badge: ComposerSaveBadge }) => void;
  onDraftLost?: () => void;
}

export function PrRootBodyEditor(props: PrRootBodyEditorProps) {
  const {
    prRef, prState, initialBody, draftId, onDraftIdChange,
    registerOpenComposer, ownerKey, readOnly = false,
    onBodyChange, onAutosaveControl, onDraftLost,
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
    return registerOpenComposer(draftId, ownerKey);
  }, [draftId, ownerKey, registerOpenComposer]);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  return (
    <div className={styles.editor} data-composer="true">
      {prState !== 'open' && (
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

      {recoveryOpen && createPortal(
        <Modal
          open={recoveryOpen}
          title="PR reply draft deleted elsewhere"
          defaultFocus="primary"
          disableEscDismiss
          onClose={() => setRecoveryOpen(false)}
        >
          <p>This draft was deleted from another window or by reload. Re-create with the current text, or discard?</p>
          <button type="button" data-modal-role="cancel" onClick={() => { setRecoveryOpen(false); onDraftLost?.(); }}>
            Discard
          </button>
          <button type="button" data-modal-role="primary" onClick={async () => { setRecoveryOpen(false); await flush(); }}>
            Re-create
          </button>
        </Modal>,
        document.body,
      )}
    </div>
  );
}
```

(The portal is critical when the editor is mounted inside SubmitDialog's outer Modal — prevents stacking handler conflicts.)

- [ ] **Step 3: Move autosave + recovery tests from `PrRootReplyComposer.test.tsx`**

- [ ] **Step 4: Prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/Composer/PrRootBodyEditor.{tsx,module.css} __tests__/PrRootBodyEditor.test.tsx
npm test -- PrRootBodyEditor
git add frontend/src/components/PrDetail/Composer/PrRootBodyEditor.* frontend/__tests__/PrRootBodyEditor.test.tsx
git commit -m "feat(composer): extract PrRootBodyEditor shared component"
```

---

### Task 21: Refactor `PrRootReplyComposer` to wrap `PrRootBodyEditor`

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx`
- Modify: `frontend/__tests__/PrRootReplyComposer.test.tsx`

- [ ] **Step 1: Replace inner textarea+autosave with PrRootBodyEditor**

The composer keeps: Discard / Post / Preview / AI buttons + the per-state copy table (§ 4.7 of spec). Drop the Save button. Ctrl+Enter → Post.

Key logic for Post handler:

```tsx
const handlePost = async () => {
  if (postDisabled || !autosaveControl.current) return;
  setPostError(null);
  setPostInFlight(true);
  try {
    await autosaveControl.current.flush();  // drain debounce first
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
```

The error row (above the action bar) handles the `already-posted-body-mismatch` recovery banner + the generic retry-on-failure case.

The composer passes `ownerKey="reply-composer"` to PrRootBodyEditor.

- [ ] **Step 2: Update tests**

Remove "Save button present" assertions; add Post-flow tests; existing autosave/recovery tests are in the body-editor test file now.

- [ ] **Step 3: Prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/Composer/PrRootReplyComposer.tsx __tests__/PrRootReplyComposer.test.tsx
npm test -- PrRootReplyComposer && npm run lint
git add frontend
git commit -m "feat(composer): drop Save, add Post + flush-before-post flow"
```

---

## Phase I — SubmitDialog

### Task 22: SubmitDialog — preview + Edit toggle + Discard footer + state sequencing

**Files:**
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx` (~383 lines today; remove summary plumbing, add preview + edit + Discard footer)
- Modify: `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.module.css`
- Modify: `frontend/__tests__/SubmitDialog.test.tsx`

- [ ] **Step 1: Read the existing dialog end-to-end**

The summary plumbing includes: `setSummary`, the hydration useEffect, the textarea, `saveSummary`, `flushSummary`, the `onSummaryChange` wire, the `confirmReason` inline override at line 230-236, the verdict-pick logic. Cataloging precisely BEFORE deleting is essential.

- [ ] **Step 2: Remove the summary plumbing**

Drop: the `setSummary` state, its hydration `useEffect`, the textarea, the `saveSummary`/`flushSummary` callbacks, the `onSummaryChange` prop wire. KEEP: the verdict-pick state, the Submit button, the existing modal shell, `setEscNotice` logic.

- [ ] **Step 3: Add the preview + Edit toggle**

```tsx
const prRootDraft = session.draftComments.find((d) => d.filePath === null && d.lineNumber === null) ?? null;
const [editing, setEditing] = useState(false);
const [bodyDraftId, setBodyDraftId] = useState<string | null>(prRootDraft?.id ?? null);
const [editingBody, setEditingBody] = useState<string>(prRootDraft?.bodyMarkdown ?? '');
const editorControl = useRef<{ flush: () => Promise<void>; badge: ComposerSaveBadge } | null>(null);

const prRootHolder = useDraftSessionFromContext().getPrRootHolder();
const cantEdit = useCantEditRootBodyReason({ readOnly, ownerKey: 'submit-dialog', prRootHolder });

// Reset to preview on open.
useEffect(() => { if (open) setEditing(false); }, [open]);

// Override session for submitDisabledReason when in edit mode (replicates the old
// inline-draftSummaryMarkdown-override pattern from SubmitDialog.tsx:230-236).
const effectiveSession: ReviewSessionDto = editing
  ? {
      ...session,
      draftComments: session.draftComments.map((d) =>
        d.filePath === null && d.lineNumber === null
          ? { ...d, bodyMarkdown: editingBody }
          : d),
    }
  : session;
const confirmReason = submitDisabledReason(effectiveSession, headShaDrift, validatorResults);
```

The preview block renders the MarkdownRenderer or a placeholder; the editor block mounts PrRootBodyEditor with `ownerKey="submit-dialog"`. Edit button is disabled when `cantEdit !== null` with the appropriate tooltip.

- [ ] **Step 4: Add the close-while-editing flush**

The dialog's Cancel button / Esc handler / overlay click must `await editorControl.current?.flush()` before invoking `onClose()` when `editing` is true. Otherwise the in-flight debounce is canceled and the body is lost.

- [ ] **Step 5: Add the Discard footer button**

Render leftmost in the footer when `session.pendingReviewId !== null OR state.kind === 'in-flight'`:

```tsx
<button
  type="button"
  className={styles.dialogDiscardButton}
  data-testid="dialog-discard"
  onClick={() => setDiscardModalOpen(true)}
>
  Discard pending review
</button>
```

Wire to `DiscardPendingReviewConfirmationModal` (Task 23).

- [ ] **Step 6: Update tests**

Negative: summary textarea absent. Positive: preview present; Edit toggle renders; clicking Edit mounts the editor; cross-surface lock disables Edit when reply composer holds the draft; cross-tab readOnly disables Edit with the other-tab tooltip; close-while-editing awaits flush.

- [ ] **Step 7: Prettier + verify + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/SubmitDialog/ __tests__/SubmitDialog.test.tsx
npm test -- SubmitDialog && npm run lint
git add frontend
git commit -m "feat(submit-dialog): preview + Edit toggle + Discard footer + close-while-editing flush"
```

---

## Phase J — modal + PrHeader pill

### Task 23: `DiscardPendingReviewConfirmationModal`

**Files:**
- Create: `frontend/src/components/PrDetail/DiscardPendingReviewConfirmationModal.tsx` + `.module.css`
- Test: `frontend/__tests__/DiscardPendingReviewConfirmationModal.test.tsx`

(See spec § 4.10 for the modal shape and state-transition table. Tests cover: default/Cancel/Discard buttons; in-flight disabled with "Discarding…" spinner; failure mode renders Close + Retry + error row.)

- [ ] **Step 1: Implement + test + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/DiscardPendingReviewConfirmationModal.* __tests__/DiscardPendingReviewConfirmationModal.test.tsx
npm test -- DiscardPendingReviewConfirmationModal
git add frontend
git commit -m "feat(submit): DiscardPendingReviewConfirmationModal"
```

---

### Task 24: `PrHeader` pending-review pill

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/src/components/PrDetail/PrHeader.module.css`
- Test: extend an existing PrDetail test or add `frontend/__tests__/PrHeaderPendingReviewPill.test.tsx`

(See spec § 4.9. Pill visibility: `session.pendingReviewId !== null && !submitDialogOpen`. Clicking opens the Task 23 modal.)

- [ ] **Step 1: Implement + test + commit**

```bash
cd frontend && npm run prettier -- --write src/components/PrDetail/PrHeader.* __tests__
npm test -- PrHeader
git add frontend
git commit -m "feat(pr-header): pending-review pill + discard modal wiring"
```

---

## Phase K — cross-tier draftSummaryMarkdown sweep

### Task 25: Migrate every remaining `draftSummaryMarkdown` consumer

**Files:**
- Modify: `frontend/src/components/PrDetail/DiscardAllDraftsButton.tsx:23,44` (rewrite `hasSummary` derivation)
- Modify: `frontend/src/components/PrDetail/SubmitButton.tsx:43-46` (rewrite `isEmptyContent`)
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx:46` (if it has a default fixture)
- Modify: every `__tests__/*.tsx` that constructs `ReviewSessionDto` with the field

- [ ] **Step 1: Grep then sweep**

```bash
grep -rn "draftSummaryMarkdown" frontend/
```

- `SubmitButton.isEmptyContent`: drop the `noSummary` clause. `isEmptyContent = noDrafts && noReplies`. (PR-root drafts count as DraftComments today, so `noDrafts` already covers them.)
- `DiscardAllDraftsButton.hasSummary`: replace with `(session.draftComments.find((d) => d.filePath === null && d.lineNumber === null)?.bodyMarkdown ?? '').trim().length > 0`.
- `PrHeader` default fixture: drop the field.
- Every test fixture that includes `draftSummaryMarkdown` in baseProps / mock-session: remove.

- [ ] **Step 2: Verify build green + tests pass**

```bash
cd frontend && npm run build && npm run lint && npm test
```

- [ ] **Step 3: Commit**

```bash
git add frontend
git commit -m "refactor(frontend): migrate every draftSummaryMarkdown consumer to PR-root draft"
```

---

## Phase L — Playwright + parity

### Task 26: Recapture `pr-detail-overview` parity baseline

```bash
cd frontend && npm run dev &
# wait
npx playwright test parity-baselines.spec.ts --update-snapshots
git add frontend/e2e/parity-baselines/pr-detail-overview.png
git commit -m "test(parity): recapture pr-detail-overview baseline (Post button + pill)"
```

### Task 27: `submit-discard.spec.ts` Playwright scenarios

(See spec § 7 + § 10 acceptance criteria 4-9, 11-12. Reuses `/test/submit/inject-failure` + `/test/submit/set-begin-delay`.)

### Task 28: `submit-dialog.spec.ts` Playwright coverage

(Preview vs Edit toggle; cross-surface + cross-tab lock; close-while-editing flush; summary textarea negative.)

---

## Final pre-merge gate

- [ ] **Full pre-push checklist per `.ai/docs/development-process.md`**

```bash
dotnet build -c Release
dotnet test
cd frontend && npm install && npm run lint && npm run build && npm test && npx playwright test
```

- [ ] **Deferrals sidecar**

If any deferrals surfaced during implementation (notably § 9 Q1 — foreign-pending-review body resume loss), populate `docs/specs/2026-06-01-pr-root-post-and-submit-discard-deferrals.md` BEFORE opening the PR. New deferrals go under `### [Defer] <title>`.

- [ ] **Open the PR via `pr-autopilot`**

Don't `gh pr create` manually unless pr-autopilot is unavailable.

---

## Self-review checklist (run on this plan, not on the code)

- [ ] Spec coverage: every § 4 subsection mapped to at least one task.
- [ ] No placeholders left ("TBD", "TODO", "implement later").
- [ ] Every code snippet was verified against the actual file before being written (or has an explicit "read this first" step).
- [ ] No fictional types/methods (verified absences: `ComposerBadge`, `submitInFlight` boolean, `prRefPath` helper, `LoadFixture`/`Fixtures/` test infrastructure, `/test/submit/begin-delay` route, `SetBeginDelayMs` method).
- [ ] All 5 IReviewSubmitter implementers listed in Task 8.
- [ ] Wire shapes match: PUT /draft is `ReviewSessionPatch` typed record (not `{kind, payload}`); apiClient.post returns `T` (not `{ok}`); IReviewEventBus.Publish is sync.
- [ ] CTS lifetime owned at the endpoint with cross-task transfer pattern (NOT `using var` in synchronous scope).
- [ ] IsSubscribed → 401 unauthorized convention.
- [ ] Test infrastructure reused: `/test/submit/inject-failure`, `/test/submit/set-begin-delay`. No new fakes invented.
- [ ] Migration uses kebab-case JSON keys (KebabCaseJsonNamingPolicy).
- [ ] V7 atomicity: AppStateStore.CurrentVersion + MigrationSteps registration + AppState.Default ALL bumped in one commit.
- [ ] Plan acknowledges build is red between T3-T7 (.NET pipeline tests with PR-root drafts) and T15-T25 (TypeScript consumers).
