# #323 Slice C — Typed not-found exception + MSAL comment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake-calibrated message-text exception classification in the submit pipeline with a typed `ReviewThreadNotFoundException`, and document the MSAL exception surface at `TokenStore.cs:87`.

**Architecture:** A new `ReviewThreadNotFoundException` is declared in `PRism.Core` (the contract layer). The GitHub adapter (`GitHubReviewSubmitter.AttachReplyAsync`) detects a NOT_FOUND GraphQL error — via a new `GitHubGraphQLException.IsFirstErrorNotFound` predicate that reads the error's top-level `type` field (GitHub's "could not resolve to a node" shape) or `extensions.code` — and rethrows the typed exception. The in-memory fake throws the same type. `SubmitPipeline` catches by type, and `IsParentThreadGone` (message sniff) is deleted. 3b is a comment-only change.

**Tech Stack:** .NET 10 / C#, xUnit + FluentAssertions, `System.Text.Json`. Backend only — no wire/DTO/UI change.

**Spec:** `docs/specs/2026-06-21-issue-323-slice-c-typed-not-found-design.md`.

## Global Constraints

- `TreatWarningsAsErrors=true`, `AllEnabledByDefault` analyzers — the build fails on any new warning. CA1031 (catch-all) is suppressed only at the existing `#pragma` in `SubmitPipeline.cs:467`; do not add new broad catches without an OCE rethrow + pragma.
- Run exactly one `dotnet build`/`dotnet test` at a time, foreground, timeout ≥ 300000 ms.
- Commit messages end with the two trailers (`Co-Authored-By:` + `Claude-Session:`) used elsewhere in this branch.
- **Gated (B2) — does NOT close #323.** Use bare `#323` in every commit; never a closing keyword. Items 3c and 4c remain open.
- No new public API on `GitHubGraphQLException` — the NOT_FOUND predicate is `internal` (visible to `PRism.GitHub.Tests` via the existing `InternalsVisibleTo`).

## Resolved pre-implementation question

The spec flagged "confirm GitHub's real deleted-thread payload shape." **Confirmed:** GitHub's GraphQL `"Could not resolve to a node with the global id of 'X'"` error carries a **top-level `"type": "NOT_FOUND"`** field (GitHub community discussions [#60620](https://github.com/orgs/community/discussions/60620), [#83980](https://github.com/orgs/community/discussions/83980)). The three existing PRism fixtures (`GitHubReviewServiceSubmitAttachReplyTests`, `...BeginTests`, `...DeleteTests`) omit `type` — they are simplified, message-only. The predicate therefore reads `type` first (covers the real shape) and `extensions.code` second (rate-limit/permission shapes); message-only fixtures with neither field return null → unchanged `GitHubGraphQLException` behavior. The approach fires in production and is non-regressive in every case.

## File Structure

- **Create** `PRism.Core/Submit/ReviewThreadNotFoundException.cs` — the typed contract exception.
- **Modify** `PRism.GitHub/GitHubGraphQLException.cs` — add `FirstErrorCode` (reads `type` then `extensions.code`), refactor `FormatErrorsMessage`'s code extraction to share it, add internal `IsFirstErrorNotFound`.
- **Modify** `PRism.GitHub/GitHubReviewSubmitter.Submit.cs:104-142` — wrap `AttachReplyAsync`'s `PostSubmitGraphQLAsync` call to translate NOT_FOUND → `ReviewThreadNotFoundException`.
- **Modify** `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:461-466, 508-518` — typed catch; delete `IsParentThreadGone` + its TODO.
- **Modify** `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs:65` — fake throws the typed exception (adapter/fake parity).
- **Modify** `PRism.Core/Auth/TokenStore.cs:82-91` — 3b comment.
- **Test** `tests/PRism.GitHub.Tests/GitHubGraphQLExceptionNotFoundTests.cs` (new) — predicate.
- **Test** `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs` — new translation test + existing-fixture update.
- **Test** `tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs` — new pipeline race test.

---

### Task 1: `GitHubGraphQLException` NOT_FOUND predicate

**Files:**
- Modify: `PRism.GitHub/GitHubGraphQLException.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubGraphQLExceptionNotFoundTests.cs` (create)

**Interfaces:**
- Produces: `internal static bool GitHubGraphQLException.IsFirstErrorNotFound(string errorsJson)` — true iff the first error's `type` or `extensions.code` equals `"NOT_FOUND"`. Used by Task 2.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.GitHub.Tests/GitHubGraphQLExceptionNotFoundTests.cs`:

```csharp
using FluentAssertions;
using PRism.GitHub;

namespace PRism.GitHub.Tests;

public class GitHubGraphQLExceptionNotFoundTests
{
    [Fact]
    public void IsFirstErrorNotFound_true_for_top_level_type()  // GitHub's real "could not resolve to a node" shape
    {
        var json = """[{"type":"NOT_FOUND","path":["addPullRequestReviewThreadReply"],"message":"Could not resolve to a node with the global id of 'PRRT_x'."}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeTrue();
    }

    [Fact]
    public void IsFirstErrorNotFound_true_for_extensions_code()
    {
        var json = """[{"message":"nope","extensions":{"code":"NOT_FOUND"}}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeTrue();
    }

    [Fact]
    public void IsFirstErrorNotFound_false_for_message_only()  // the existing simplified fixtures
    {
        var json = """[{"message":"Could not resolve to a node with the global id of 'PRRT_x'."}]""";
        GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeFalse();
    }

    [Theory]
    [InlineData("""[{"type":"FORBIDDEN","message":"no"}]""")]
    [InlineData("""[{"extensions":{"code":"RATE_LIMITED"}}]""")]
    [InlineData("[]")]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""[42]""")]
    public void IsFirstErrorNotFound_false_for_non_notfound_or_malformed(string json)
        => GitHubGraphQLException.IsFirstErrorNotFound(json).Should().BeFalse();

    [Fact]
    public void FormatErrorsMessage_prefixes_top_level_type_code()  // formerly only extensions.code got a [CODE] prefix
    {
        var json = """[{"type":"NOT_FOUND","message":"gone"}]""";
        GitHubGraphQLException.FormatErrorsMessage(json).Should().Contain("[NOT_FOUND]").And.Contain("gone");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter GitHubGraphQLExceptionNotFoundTests`
Expected: FAIL — `IsFirstErrorNotFound` does not exist (compile error).

- [ ] **Step 3: Add `FirstErrorCode` + `IsFirstErrorNotFound`, refactor `FormatErrorsMessage`**

In `GitHubGraphQLException.cs`, add these members and route `FormatErrorsMessage`'s code-prefix through the shared helper:

```csharp
// Reads the first error's machine-readable category. GitHub puts node-resolution failures in the
// top-level `type` field ("Could not resolve to a node" -> "NOT_FOUND"); rate-limit / permission
// shapes use `extensions.code`. Checks `type` first, then `extensions.code`. Null when neither is
// present/parseable. Shared by FormatErrorsMessage (the [CODE] prefix) and IsFirstErrorNotFound.
private static string? FirstErrorCode(string errorsJson)
{
    if (string.IsNullOrEmpty(errorsJson)) return null;
    try
    {
        using var doc = JsonDocument.Parse(errorsJson);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() == 0) return null;
        var first = root[0];
        if (first.ValueKind != JsonValueKind.Object) return null;

        if (first.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String
            && t.GetString() is { Length: > 0 } type)
            return type;

        if (first.TryGetProperty("extensions", out var ext) && ext.ValueKind == JsonValueKind.Object
            && ext.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String
            && c.GetString() is { Length: > 0 } code)
            return code;

        return null;
    }
    catch (JsonException) { return null; }
}

// Used by the GitHub adapter to translate a deleted-thread NOT_FOUND into the typed
// PRism.Core ReviewThreadNotFoundException. Internal — PRism.GitHub.Tests sees it via InternalsVisibleTo.
internal static bool IsFirstErrorNotFound(string errorsJson)
    => string.Equals(FirstErrorCode(errorsJson), "NOT_FOUND", StringComparison.Ordinal);
```

Then in `FormatErrorsMessage`, replace the inline `extensions.code` extraction (the `string? code = null; if (first.TryGetProperty("extensions", …)) { code = c.GetString(); }` block, lines ~85-92) with:

```csharp
            var code = FirstErrorCode(errorsJson);
            if (!string.IsNullOrEmpty(code)) sb.Append('[').Append(code).Append("] ");
```

(`FirstErrorCode` re-parses `errorsJson`; that is one extra parse on the error path only — acceptable, and it keeps a single code-extraction definition. The `[CODE]` prefix now also covers top-level `type`, which is strictly additive: no existing fixture carries `type`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter GitHubGraphQLExceptionNotFoundTests`
Expected: PASS (all cases).

- [ ] **Step 5: Run the full GitHub test project to confirm no formatter regression**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`
Expected: PASS — existing `FormatErrorsMessage` / GraphQL-error tests still green (their fixtures are message-only or `extensions.code`-only; the refactor preserves those outputs).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubGraphQLException.cs tests/PRism.GitHub.Tests/GitHubGraphQLExceptionNotFoundTests.cs
git commit -m "feat(github): NOT_FOUND predicate on GitHubGraphQLException (#323)"
```

---

### Task 2: `ReviewThreadNotFoundException` + adapter translation

**Files:**
- Create: `PRism.Core/Submit/ReviewThreadNotFoundException.cs`
- Modify: `PRism.GitHub/GitHubReviewSubmitter.Submit.cs:104-142`
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs`

**Interfaces:**
- Consumes: `GitHubGraphQLException.IsFirstErrorNotFound(string)` (Task 1).
- Produces: `public sealed class PRism.Core.Submit.ReviewThreadNotFoundException : Exception` with `()`, `(string)`, `(string, Exception)` ctors. Used by Task 3 + Task 4.

- [ ] **Step 1: Write the failing tests**

In `tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs`, add (and note the namespace `using PRism.Core.Submit;`):

```csharp
[Fact]
public async Task AttachReplyAsync_OnNotFound_ThrowsReviewThreadNotFound()  // real GitHub shape: top-level type
{
    var handler = new RecordingHttpMessageHandler(
        HttpStatusCode.OK, """{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a node with the global id of 'PRRT_parent_thread'."}]}""");
    var svc = NewService(handler);

    Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", "body", CancellationToken.None);

    await act.Should().ThrowAsync<ReviewThreadNotFoundException>();
}

[Fact]
public async Task AttachReplyAsync_OnNonNotFoundError_StillThrowsGitHubGraphQLException()  // guard: code-scoped, not blanket
{
    var handler = new RecordingHttpMessageHandler(
        HttpStatusCode.OK, """{"data":null,"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}""");
    var svc = NewService(handler);

    Func<Task> act = () => svc.AttachReplyAsync(Ref, "PRR_x", "PRRT_y", "body", CancellationToken.None);

    await act.Should().ThrowAsync<GitHubGraphQLException>();
}
```

Also update the existing `AttachReplyAsync_OnGraphqlError_ThrowsGitHubGraphQLException` so its fixture is unambiguously **non**-NOT_FOUND (it currently uses a NOT_FOUND-shaped "could not resolve to a node" message with no `type`; with `type` added it would reclassify — keep it as the generic-error path test):

```csharp
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.OK, """{"data":null,"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration."}]}""");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter AttachReply`
Expected: FAIL — `ReviewThreadNotFoundException` does not exist (compile error); the new NOT_FOUND test cannot bind.

- [ ] **Step 3: Create the exception type**

Create `PRism.Core/Submit/ReviewThreadNotFoundException.cs`:

```csharp
namespace PRism.Core.Submit;

/// <summary>
/// Thrown by an <see cref="IReviewSubmitter"/> adapter when a reply's parent review thread no
/// longer exists on the pending review (its author deleted it on github.com between submit
/// attempts). A typed signal so the submit pipeline classifies "parent gone" by exception type
/// rather than by sniffing the adapter's message text — which previously matched only the
/// in-memory fake's "NOT_FOUND: parent thread …" string, not GitHub's GraphQL error shape.
/// </summary>
public sealed class ReviewThreadNotFoundException : Exception
{
    public ReviewThreadNotFoundException() { }
    public ReviewThreadNotFoundException(string message) : base(message) { }
    public ReviewThreadNotFoundException(string message, Exception innerException)
        : base(message, innerException) { }
}
```

- [ ] **Step 4: Translate in `AttachReplyAsync`**

In `GitHubReviewSubmitter.Submit.cs`, replace the `var data = await PostSubmitGraphQLAsync(...)` assignment at `:131-134` with a try/catch (declare `data` as `JsonElement` so it stays in scope):

```csharp
        JsonElement data;
        try
        {
            data = await PostSubmitGraphQLAsync(
                mutation,
                new { prReviewId = pendingReviewId, threadId = parentThreadId, body = replyBody },
                ct).ConfigureAwait(false);
        }
        catch (GitHubGraphQLException ex) when (GitHubGraphQLException.IsFirstErrorNotFound(ex.ErrorsJson))
        {
            // NOT_FOUND here means the parent review thread was deleted on github.com between our
            // snapshot re-fetch and this call. Surface a typed signal the submit pipeline catches by
            // type (demote-to-Stale) instead of sniffing message text. NOT_FOUND on this mutation is
            // ambiguous between a gone threadId and a gone prReviewId; conflating both as thread-gone
            // is accepted — a gone pending review self-heals via the pipeline's next null-snapshot retry.
            throw new ReviewThreadNotFoundException(
                $"Parent review thread {parentThreadId} no longer exists on the pending review.", ex);
        }
```

Confirm `using PRism.Core.Submit;` is present at the top of the file (it already imports the submit contracts — `AttachReplyResult` lives there). `System.Text.Json` is already in use for `JsonElement`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter AttachReply`
Expected: PASS — NOT_FOUND → `ReviewThreadNotFoundException`; FORBIDDEN → `GitHubGraphQLException`; the updated existing test still green.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Submit/ReviewThreadNotFoundException.cs PRism.GitHub/GitHubReviewSubmitter.Submit.cs tests/PRism.GitHub.Tests/GitHubReviewServiceSubmitAttachReplyTests.cs
git commit -m "feat(github): adapter throws typed ReviewThreadNotFoundException on NOT_FOUND (#323)"
```

---

### Task 3: Pipeline typed catch + delete `IsParentThreadGone` + fake parity

**Files:**
- Modify: `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:461-466, 508-518`
- Modify: `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs:65`
- Test: `tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs`

**Interfaces:**
- Consumes: `ReviewThreadNotFoundException` (Task 2).

- [ ] **Step 1: Write the failing test**

In `tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs`, add a test for the race window the `:461` catch guards — the thread is **present** in the snapshot (so the `parent is null` short-circuit at `:440` does NOT fire), but `AttachReplyAsync` throws the typed exception (injected). Mirror the setup of the existing reply tests in this file (seed a pending review with the parent thread, create a reply whose `ParentThreadId` matches). Use the fake's one-shot `InjectFailure` seam:

```csharp
[Fact]
public async Task AttachReplies_ParentThreadDeletedMidCall_DemotesReplyToStale()
{
    // Arrange: pending review with the parent thread PRESENT (so parent-is-null does not short-circuit),
    // plus a draft reply targeting it. (Reuse this file's existing reply-scenario setup helpers.)
    var (fake, session, store) = ReplyScenarioWithPresentParent();  // see sibling tests for the exact builder
    fake.InjectFailure(nameof(IReviewSubmitter.AttachReplyAsync),
        new ReviewThreadNotFoundException("parent thread PRRT_x gone"));

    // Act
    var outcome = await RunPipeline(fake, session, store);

    // Assert: demoted to Stale + SubmitFailedException(AttachReplies) with the typed exception as inner.
    var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
    failed.Exception.Should().BeOfType<SubmitFailedException>()
        .Which.InnerException.Should().BeOfType<ReviewThreadNotFoundException>();
    failed.NewSession.DraftReplies.Single().Status.Should().Be(DraftStatus.Stale);
}
```

> **Note on the assertion (do NOT assert `AttachReplyCallCount == 1`):** the fake's `ConsumeFailureOrContinue` throws the injected exception at the top of `AttachReplyAsync`, before the success counter increments — so the count stays 0. The discriminator from the `parent is null` path is the **inner exception**: `:444` throws `SubmitFailedException` with no inner; only the typed catch at `:465` attaches `ex`. Assert on `InnerException is ReviewThreadNotFoundException`. Match the exact outcome/builder shape (`SubmitOutcome.Failed`, session accessors) to the sibling tests already in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter AttachReplies_ParentThreadDeletedMidCall`
Expected: FAIL — on main the pipeline catches via `IsParentThreadGone(ex)`, which does not match a `ReviewThreadNotFoundException` (its message is "Parent review thread … no longer exists", containing "parent" but the test's injected message is "parent thread … gone" — regardless, the typed catch does not yet exist, so the exception falls to the generic catch and the inner is not asserted-as-typed). The `InnerException is ReviewThreadNotFoundException` assertion fails until the typed catch lands.

- [ ] **Step 3: Replace the catch + delete `IsParentThreadGone`**

In `SubmitPipeline.cs`, replace the `catch (Exception ex) when (IsParentThreadGone(ex))` block (`:461-466`) with:

```csharp
            catch (ReviewThreadNotFoundException ex)
            {
                current = await DemoteReplyAndPersistAsync(sessionKey, current, reply.Id, done, total, progress, ct).ConfigureAwait(false);
                throw new SubmitFailedException(SubmitStep.AttachReplies,
                    $"reply {reply.Id}: parent thread {reply.ParentThreadId} no longer exists on the pending review", current, ex);
            }
```

Then delete the `IsParentThreadGone` method **and its preceding TODO comment** entirely (`:508-518`). The `catch (OperationCanceledException)` / `catch (SubmitFailedException)` blocks above and the generic `catch (Exception ex)` + `#pragma` below are unchanged.

- [ ] **Step 4: Fake parity — fake throws the typed exception**

In `InMemoryReviewSubmitter.cs:65`, change the missing-thread throw so the fake matches the real adapter's contract:

```csharp
        var thread = pending.Threads.FirstOrDefault(t => t.Id == parentThreadId)
            ?? throw new ReviewThreadNotFoundException($"parent thread {parentThreadId}");
```

(Add `using PRism.Core.Submit;` if not already present — it is; the file imports it at the top.)

- [ ] **Step 5: Run the new test + the full submit suite**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter Submit`
Expected: PASS — the new test passes; all existing `AttachRepliesTests` / submit-pipeline tests stay green (the demote-reply observable behavior is unchanged; `ForeignAuthorThreadDeletedTests` still hits the `parent is null` path with `AttachReplyCallCount == 0`).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Submit/Pipeline/SubmitPipeline.cs tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryReviewSubmitter.cs tests/PRism.Core.Tests/Submit/Pipeline/AttachRepliesTests.cs
git commit -m "refactor(submit): classify deleted parent thread by type, drop IsParentThreadGone (#323)"
```

---

### Task 4: 3b — MSAL exception-type comment (`TokenStore.cs`)

**Files:**
- Modify: `PRism.Core/Auth/TokenStore.cs:82-91`

**Interfaces:** none (comment-only; no test).

- [ ] **Step 1: Add the comment**

Above the `catch (Exception ex) when (ex.Message.Contains("DBus", …) …)` at `:87`, add:

```csharp
            // String-match rationale (#323 item 3b): MSAL's persistence layer surfaces keyring/libsecret
            // failures as MsalCachePersistenceException (Microsoft.Identity.Client.Extensions.Msal) — the
            // documented candidate type. We do NOT pin it via `catch (MsalCachePersistenceException)`
            // because this catch wraps MsalCacheHelper.CreateAsync, whereas the keyring is first read at
            // LoadUnencryptedTokenCache (outside this try); the exact type/message reaching here is
            // environment-dependent and unverified (libsecret may surface a raw interop error), and
            // whether this "agent unavailable" branch is even reachable on the CreateAsync path needs a
            // Linux keyring repro. Until then we discriminate on Message text. Follow-ups (both need a
            // Linux repro): (1) narrow to the confirmed exception type; (2) confirm branch reachability.
```

- [ ] **Step 2: Build to confirm no warning regression**

Run: `dotnet build PRism.Core/PRism.Core.csproj`
Expected: SUCCEEDED, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Auth/TokenStore.cs
git commit -m "docs(auth): record MSAL exception-type candidate + caveat at TokenStore keyring catch (#323)"
```

---

### Task 5: Full-suite verification + pre-push checklist

**Files:** none (verification).

- [ ] **Step 1: Build the solution**

Run: `dotnet build PRism.sln`
Expected: SUCCEEDED, 0 warnings (TWAE).

- [ ] **Step 2: Run the full backend test suite**

Run: `dotnet test PRism.sln`
Expected: all green (Core / GitHub / Web / etc.). Confirm `IsParentThreadGone` has no remaining references (`grep -r IsParentThreadGone` → none).

- [ ] **Step 3: Run `/simplify` on the diff, then the repo pre-push checklist** (per `.ai/docs/development-process.md`) before opening the PR. No frontend check needed — backend-only, no wire/DTO/UI change.

---

## Self-Review

**Spec coverage:** 3a typed exception (Tasks 1-3) ✓; 3a adapter `type`+`extensions.code` detection (Task 1) ✓; fake parity (Task 3) ✓; `IsParentThreadGone` deleted (Task 3) ✓; existing-fixture update (Task 2) ✓; 3b comment with candidate+caveat (Task 4) ✓; prReviewId/threadId conflation note (Task 2 inline comment) ✓; payload-shape confirmation (resolved, documented above) ✓; existing demote behavior unchanged (Task 3 Step 5) ✓.

**Placeholder scan:** none — every code step shows full code; the one builder reference (`ReplyScenarioWithPresentParent`) is explicitly flagged to mirror this file's existing sibling-test setup, since the exact helper names are local to `AttachRepliesTests.cs` and must match what is already there.

**Type consistency:** `ReviewThreadNotFoundException` (3-ctor) defined Task 2, consumed Tasks 3-4; `IsFirstErrorNotFound(string)` defined Task 1, consumed Task 2; `FirstErrorCode` private, shared by `FormatErrorsMessage` + the predicate. `data` typed `JsonElement` (matches `PostSubmitGraphQLAsync`'s `Task<JsonElement>`).
