# #319 — Shared Endpoints Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `PRism.Web/Endpoints/Shared/` seam (8 helpers) + `AppState.WithSession`, deleting ~200 duplicated lines and aligning drifted status numbers, with zero frontend changes.

**Architecture:** Static helpers / extension methods in a new `Endpoints/Shared/` folder (no DI, no `IEndpointFilter` — matches the codebase, which has zero filter usage and documents why). One Core instance method (`AppState.WithSession`). Status numbers move only (not codes/bodies/`.kind`-deriving statuses); the draft `markAllRead` 404 is a deliberate carve-out.

**Tech Stack:** .NET 10 minimal APIs, C#, xUnit + FluentAssertions, `WebApplicationFactory<Program>` test contexts.

**Spec:** `docs/specs/2026-06-11-319-endpoints-shared-seam-design.md` (gated B2, human-approved).

**Sequencing principle:** behavior-preserving dedup first (Tasks 1–5), then the JSON bug fix and status-number changes (Tasks 6–9), then body-cap (Task 10), then verification (Task 11). Each behavior change is pinned by a test that is **red on main** before the implementation lands. Commit after every task.

**Plan deviations from spec §8 (documented per repo convention):**
- The spec said to "flip the PrReloadEndpoint SHA-reject test." Reality: the existing reject test (`Reload_invalid_sha_returns_422`) uses `"not-a-sha"`, which stays invalid under case-insensitive matching — it does **not** flip. Task 3 instead **adds** a new red-on-main test asserting an uppercase 40-hex SHA is now accepted.
- **Task 9 targets `PrSubmitEndpoints.cs:559` (foreign-pending discard), not the bulk `/drafts/discard-all`.** The spec round-2 review found the original `PrDraftsDiscardAllEndpointTests:35` pin named the wrong endpoint; the issue's "twin discard" is foreign-pending (`:559`) vs own-pending (`:396`). The bulk discard-all stays 200.
- **Task 10 is constant-unification only** — the metadata-migration probe was dropped (it's expected to fail and risked uncapping). Predicate unchanged; pre-existing uncapped `comment/post`/`preferences` are a follow-up.

> **Line-number caveat:** every `file:line` reference is a *pre-implementation* pointer captured against `main`. Tasks 1–10 delete/insert lines in shared files (`PrSubmitEndpoints.cs` is touched by Tasks 1, 2, 5, 7, 8, 9), so absolute line numbers drift as you go. **Locate each edit by its symbol/method name and the quoted code, not by the line number.**

---

## File Structure

**New files (`PRism.Web/Endpoints/Shared/`):**
- `GitHubErrorMapper.cs` — pure `Exception → SubmitErrorDto` switch + `ToResult` (502). [Task 2]
- `RequireSubscribed.cs` — `Check(cache, prRef) → IResult?` (403, code `"unauthorized"`). [Task 7]
- `HttpJson.cs` — `TryReadJsonObjectAsync` + `JsonReadError` enum + `JsonObjectReadResult`. [Task 6]
- `PathValidation.cs` — `Canonicalize(path) → string?` (byte-count). [Task 4]
- `SharedRegexes.cs` — `Sha40()`/`Sha64()` case-insensitive `[GeneratedRegex]`. [Task 3]
- `TabStamps.cs` — `Write(...)` + `TabIdHeader`/`MaxTabStamps` consts. [Task 5]
- `EndpointExtensions.cs` — `MutatingBodyCapBytes` const + `WithBodyCap()`. [Task 10]

**Modified (Core):** `PRism.Core/State/AppState.cs` (+`WithSession`). [Task 1]

**Modified (Web endpoints):** `PrSubmitEndpoints.cs`, `PrRootCommentEndpoints.cs`, `PrCommentEndpoints.cs`, `PrDraftEndpoints.cs`, `PrReloadEndpoints.cs`, `PrDraftsDiscardAllEndpoint.cs`, `PrDetailEndpoints.cs`, `PreferencesEndpoints.cs`, `TestHooks/TestEndpoints.cs`, `Program.cs`.

**Modified (tests):** `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs`, and the Web endpoint test files named per task.

**Out of scope (do NOT touch):** `AuthEndpoints.cs` (JSON-read dedup deferred), `SubmitPipeline.cs` (upsert fold-in deferred), `frontend/` (verify-only), `PrDraftEndpoints.cs:187` `PatchOutcome.NotSubscribed` 404 path (markAllRead carve-out), `PrDraftEndpointTests` `Missing_session_token_returns_401` (SessionToken auth, unrelated).

---

## Task 1: `AppState.WithSession` (Core) + convert 6 upsert sites

**Files:**
- Modify: `PRism.Core/State/AppState.cs` (add after line 38, before `public static AppState Default`)
- Test: `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs`
- Modify call sites: `PrSubmitEndpoints.cs` (delete helper 610-614; rewrite call sites 236, the lambda in 464-475, 552-556), `PrRootCommentEndpoints.cs` (delete helper 198-202; rewrite its call site), `PrCommentEndpoints.cs` (delete helper 176-180; rewrite its call site), `PrDraftEndpoints.cs:155-165` (inline), `PrReloadEndpoints.cs:182-192` (inline), `PrDraftsDiscardAllEndpoint.cs:63-64` (inline)

- [ ] **Step 1: Write the failing Core unit test**

Append to `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs` (inside the existing test class):

```csharp
[Fact]
public void WithSession_upserts_a_session_without_mutating_the_original()
{
    var state = AppState.Default;
    var session = new ReviewSessionState();

    var updated = state.WithSession("o/r/1", session);

    updated.Reviews.Sessions.Should().ContainKey("o/r/1");
    updated.Reviews.Sessions["o/r/1"].Should().BeSameAs(session);
    state.Reviews.Sessions.Should().NotContainKey("o/r/1"); // original unchanged (immutability)
}

[Fact]
public void WithSession_overwrites_an_existing_key_and_preserves_siblings()
{
    var first = new ReviewSessionState();
    var second = new ReviewSessionState();
    var state = AppState.Default.WithSession("o/r/1", first).WithSession("o/r/2", first);

    var updated = state.WithSession("o/r/1", second);

    updated.Reviews.Sessions["o/r/1"].Should().BeSameAs(second);
    updated.Reviews.Sessions["o/r/2"].Should().BeSameAs(first); // sibling preserved
}
```

> If `ReviewSessionState()` has required constructor args, mirror how `AppStateWithDefaultHelpersTests.cs` / `PrSessionsStateTests.cs` already build a session (reuse their helper/factory) rather than inventing one.

- [ ] **Step 2: Run the test — verify it fails to compile**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~WithSession" -v minimal`
Expected: FAIL — `'AppState' does not contain a definition for 'WithSession'`.

- [ ] **Step 3: Add the method to `AppState.cs`** (after line 38, before `public static AppState Default`)

```csharp
/// <summary>
/// Upserts a review session keyed by the canonical session key (the same
/// owner/repo/number key shape used by <see cref="Reviews"/>.Sessions elsewhere).
/// Returns a new AppState; does not mutate. Callers MUST use the canonical key
/// or the session becomes unreachable.
/// </summary>
public AppState WithSession(string sessionKey, ReviewSessionState session)
{
    var sessions = new Dictionary<string, ReviewSessionState>(Reviews.Sessions) { [sessionKey] = session };
    return WithDefaultReviews(Reviews with { Sessions = sessions });
}
```

> If `ReviewSessionState`'s namespace isn't already imported in `AppState.cs`, add the `using` (check the existing usings; `PrSessionsState`/`Sessions` are already referenced, so the type is in scope).

- [ ] **Step 4: Run the test — verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~WithSession" -v minimal`
Expected: PASS (both tests).

- [ ] **Step 5: Convert the 6 endpoint upsert sites to `state.WithSession(...)`**

In `PrSubmitEndpoints.cs`: **delete** the private helper at 610-614, and rewrite each caller (`WithSession(state, sessionKey, X)` → `state.WithSession(sessionKey, X)`):
- Line 236: `await stateStore.UpdateAsync(state => state.WithSession(sessionKey, failed.NewSession), CancellationToken.None)...`
- Inside the 464-475 lambda: `return state.WithSession(sessionKey, merged);`
- Inside the 552-556 lambda: `return state.WithSession(sessionKey, existing with { PendingReviewId = null, PendingReviewCommitOid = null });`

In `PrRootCommentEndpoints.cs`: **delete** helper 198-202; rewrite **both** `WithSession(state, ...)` callers (lines ~172 and ~194) to `state.WithSession(...)`.
In `PrCommentEndpoints.cs`: **delete** helper 176-180; rewrite **all four** `WithSession(state, sessionKey, ...)` callers (the two-step stamp+delete paths, DeleteComment, DeleteReply) to `state.WithSession(...)`.

> ce-doc-review feasibility note: PrComment has 4 callers and PrRootComment has 2 — deleting the helper without rewriting every caller is a compile error. Step 6's build catches a miss, but rewrite them all up front. Grep each file for `WithSession(` after deleting the helper to confirm none remain.
In `PrDraftEndpoints.cs` (155-165): replace the inline `var sessions = new Dictionary<...>(state.Reviews.Sessions) { [refKey] = applied.Updated }; return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });` with `return state.WithSession(refKey, applied.Updated);`
In `PrReloadEndpoints.cs` (182-192): replace the inline `var sessions = new Dictionary<...>(state.Reviews.Sessions) { [refKey] = updated }; return state.WithDefaultReviews(...);` with `return state.WithSession(refKey, updated);`
In `PrDraftsDiscardAllEndpoint.cs` (63-64): replace `var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = cleared }; return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });` with `return state.WithSession(sessionKey, cleared);`

> Do NOT touch `SubmitPipeline.cs` or `SessionOverlays` (own-discard at PrSubmitEndpoints 391-392 uses `SessionOverlays.ClearPendingReviewStamps` — leave it).

- [ ] **Step 6: Build + run the affected suites — verify green (behavior-preserving)**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Release`
Expected: 0 warnings, 0 errors.
Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Submit|FullyQualifiedName~Comment|FullyQualifiedName~Draft|FullyQualifiedName~Reload" -v minimal`
Expected: PASS (no behavior change — same persisted state).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/State/AppState.cs tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs PRism.Web/Endpoints/
git commit -m "refactor(#319): AppState.WithSession replaces 6 inline session upserts"
```

---

## Task 2: `GitHubErrorMapper` — extract the triplicated 502 switch

**Files:**
- Create: `PRism.Web/Endpoints/Shared/GitHubErrorMapper.cs`
- Modify: `PrSubmitEndpoints.cs` (delete `MapGithubError` 626-639; rewrite catch calls 347, 379), `PrRootCommentEndpoints.cs` (delete 209-223; rewrite catch 148), `PrCommentEndpoints.cs` (delete `GitHubError` 126-137; rewrite its catch sites to log then call mapper)

- [ ] **Step 1: Create the helper**

`PRism.Web/Endpoints/Shared/GitHubErrorMapper.cs`:

```csharp
using System.Net;

namespace PRism.Web.Endpoints;

internal static class GitHubErrorMapper
{
    internal static SubmitErrorDto Map(Exception ex)
    {
        var (code, message) = (ex as HttpRequestException)?.StatusCode switch
        {
            HttpStatusCode.Forbidden =>
                ("github-forbidden", "GitHub rejected the request (forbidden). Check your token's permissions."),
            HttpStatusCode.Unauthorized =>
                ("github-unauthorized", "GitHub authentication failed. Reconnect your account."),
            HttpStatusCode.UnprocessableEntity =>
                ("github-validation-error", "GitHub rejected the request as invalid."),
            _ => ("github-network-error", "Couldn't reach GitHub. Try again."),
        };
        return new SubmitErrorDto(code, message);
    }

    internal static IResult ToResult(Exception ex) =>
        Results.Json(Map(ex), statusCode: StatusCodes.Status502BadGateway);
}
```

> `SubmitErrorDto` is declared in `PRism.Web/Endpoints/PrSubmitDtos.cs` under `namespace PRism.Web.Endpoints` — the **same** namespace as this helper, so **no `using` is needed** for it (verified by ce-doc-review feasibility). `Results`/`StatusCodes` come from the implicit `Microsoft.AspNetCore.Http` global usings.

- [ ] **Step 2: Build — verify the helper compiles**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Release`
Expected: 0 errors.

- [ ] **Step 3: Route the three classes through it**

`PrSubmitEndpoints.cs`: delete `MapGithubError` (626-639); change lines 347 & 379 from `Results.Json(MapGithubError(hre), statusCode: StatusCodes.Status502BadGateway)` to `GitHubErrorMapper.ToResult(hre)`. Leave the logging line before each, and leave the earlier `catch (HttpRequestException hre) when (hre.StatusCode == NotFound)` already-gone clause untouched. Leave the separate catch-all that returns the bespoke `"github-network-error"` / `"Network failure contacting GitHub."` DTO as-is (its message differs — not part of the mapper).

`PrRootCommentEndpoints.cs`: delete `MapGithubError` (209-223); change line 148 to `GitHubErrorMapper.ToResult(hre)`. Leave the alternative catch at 154 (bespoke message) as-is.

`PrCommentEndpoints.cs`: delete `GitHubError` (126-137). Its current callers do `return GitHubError(ex, lf, sessionKey);` which also logs. Replace each caller with the log call + mapper:
```csharp
s_commentPostFailed(lf.CreateLogger(typeof(PrCommentEndpoints).FullName!), sessionKey, ex);
return GitHubErrorMapper.ToResult(ex);
```
(Preserve the existing `s_commentPostFailed` logging that `GitHubError` used to do internally.)

- [ ] **Step 4: Build + run GitHub-error suites — verify green**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Release` → 0 warnings.
Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Submit|FullyQualifiedName~Comment|FullyQualifiedName~RootComment" -v minimal`
Expected: PASS — existing 502 tests unchanged (same codes/messages/status).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/
git commit -m "refactor(#319): GitHubErrorMapper replaces 3 copies of the 502 switch"
```

---

## Task 3: `SharedRegexes` — unify SHA regex to case-insensitive

**Files:**
- Create: `PRism.Web/Endpoints/Shared/SharedRegexes.cs`
- Modify: `PrDraftEndpoints.cs` (delete 15-16, route call at 462), `PrReloadEndpoints.cs` (delete 15-16, route calls at 79), **`PrDetailEndpoints.cs` (delete `GitOid40Regex`/`GitOid64Regex` 260-264, route their call sites to `SharedRegexes`)**
- Test: `tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs` (add the red-on-main accept test)

> ce-doc-review scope-guardian catch: the spec (§5 Seam 6) requires `PrDetailEndpoints`'s SHA regex to also fold into the shared one — otherwise the "one definition" AC isn't met. Its regexes are named `GitOid40Regex()`/`GitOid64Regex()` (already `[GeneratedRegex]`, case-insensitive — byte-identical pattern to `SharedRegexes`), so routing them is behavior-preserving.

- [ ] **Step 1: Write the red-on-main test (uppercase SHA now accepted)**

Add to `PrReloadEndpointTests.cs`, matching the house style of `Reload_invalid_sha_returns_422` (around line 145):

```csharp
[Fact]
public async Task Reload_uppercase_sha_is_accepted_not_422()
{
    var client = ClientWithTab();
    var upper = new string('A', 40); // 40 uppercase hex — rejected on main (lowercase-only regex)

    var resp = await client.PostAsJsonAsync("/api/pr/acme/api/1003/reload", new { headSha = upper });

    // The point: it must NOT be rejected as sha-format-invalid. Any downstream
    // outcome (no-session 404, conflict, ok) is fine — just not the 422 format reject.
    resp.StatusCode.Should().NotBe(HttpStatusCode.UnprocessableEntity);
}
```

> Match the exact client/fixture helper this file already uses (`ClientWithTab()` per the existing 422 test). If the seeded PR ref differs, reuse whatever the sibling reload tests seed.

- [ ] **Step 2: Run — verify it fails on main**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Reload_uppercase_sha" -v minimal`
Expected: FAIL — main's `^[0-9a-f]{40}$` rejects uppercase → 422.

- [ ] **Step 3: Create `SharedRegexes.cs`**

```csharp
using System.Text.RegularExpressions;

namespace PRism.Web.Endpoints;

internal static partial class SharedRegexes
{
    [GeneratedRegex("^[0-9a-fA-F]{40}$")]
    internal static partial Regex Sha40();

    [GeneratedRegex("^[0-9a-fA-F]{64}$")]
    internal static partial Regex Sha64();
}
```

- [ ] **Step 4: Route PrDraft + PrReload through it**

`PrReloadEndpoints.cs`: delete the `Sha40`/`Sha64` fields (15-16). Change line 79 from `if (!Sha40.IsMatch(request.HeadSha) && !Sha64.IsMatch(request.HeadSha))` to `if (!SharedRegexes.Sha40().IsMatch(request.HeadSha) && !SharedRegexes.Sha64().IsMatch(request.HeadSha))`. Remove the now-unused `using System.Text.RegularExpressions;` only if nothing else in the file uses it.

`PrDraftEndpoints.cs`: delete fields 15-16; change the `Sha40`/`Sha64` `.IsMatch` call(s) near 462 to `SharedRegexes.Sha40().IsMatch(...)` / `SharedRegexes.Sha64().IsMatch(...)`.

`PrDetailEndpoints.cs`: delete the `GitOid40Regex()`/`GitOid64Regex()` partial-method declarations (260-264); grep the file for `GitOid40Regex()` / `GitOid64Regex()` call sites and replace each with `SharedRegexes.Sha40()` / `SharedRegexes.Sha64()`. (Pattern is identical, so no behavior change.) If `PrDetailEndpoints` was `partial` only for these `[GeneratedRegex]` methods, drop the now-unneeded `partial` only if nothing else requires it.

- [ ] **Step 5: Run — verify the new test passes and existing reject test still passes**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Reload" -v minimal`
Expected: PASS — `Reload_uppercase_sha_is_accepted_not_422` now green; `Reload_invalid_sha_returns_422` (`"not-a-sha"`) still green (still non-hex).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/ tests/PRism.Web.Tests/Endpoints/PrReloadEndpointTests.cs
git commit -m "refactor(#319): SharedRegexes unifies SHA validation (case-insensitive)"
```

---

## Task 4: `PathValidation` — adopt byte-count canonicalization

**Files:**
- Create: `PRism.Web/Endpoints/Shared/PathValidation.cs`
- Modify: `PrDraftEndpoints.cs` (delete `IsCanonicalFilePath` 558-570; route call at 464)
- Test: `tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs` (multi-byte test)

- [ ] **Step 1: Write the red-on-main empty-segment test**

ce-doc-review caught that the first draft's decomposed-Unicode input was **already rejected on main** (`IsCanonicalFilePath` line 568 `path != path.Normalize(FormC)` fires for it) — a green-on-main test, i.e. a fake TDD red. The reliably red-on-main difference is the **empty-segment** case: main uses substring `"/../"`/`"/./"` matching with no empty-segment check, while `CanonicalizePath` splits on `/` and rejects `s.Length == 0`. So `src//foo.cs` is accepted by main, rejected by the canonical validator. Add to `PrDraftEndpointTests.cs` (match the file's request helper + auth/tab headers):

```csharp
[Fact]
public async Task Draft_path_with_empty_segment_is_rejected()
{
    var client = ClientWithTabAndSession(); // reuse this file's authed+seeded helper
    var emptySegment = "src//foo.cs"; // accepted by main's substring validator; rejected by segment-split

    var resp = await client.PutAsJsonAsync(
        "/api/pr/acme/api/123/draft",
        SingleInlinePatch(filePath: emptySegment)); // a patch whose NewDraftComment.FilePath = emptySegment

    resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    (await resp.Content.ReadFromJsonAsync<JsonElement>())
        .GetProperty("error").GetString().Should().Be("file-path-invalid");
}
```

> Use whatever inline-comment-draft patch builder this test file already has (the call site is `IsCanonicalFilePath(ndc.FilePath)` at 464, where `ndc` is a NewDraftComment). If no `SingleInlinePatch` helper exists, build the patch body inline mirroring an existing draft-patch test that exercises `file-path-invalid`. `ReadFromJsonAsync<JsonElement>()` uses Web (camelCase) defaults — no options arg needed.

- [ ] **Step 2: Run — verify it fails on main**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Draft_path_with_empty_segment" -v minimal`
Expected: FAIL — main's `IsCanonicalFilePath` accepts `src//foo.cs` (its substring `"/../"`/`"/./"` checks don't catch an empty segment), so it does not 422.

> The length cap (Step 3) is **not** independently red-on-main for ASCII (1 byte/char == main's char cap), so don't write a separate red test for it; the empty-segment test is the load-bearing TDD red. A 5000-byte-path -> 422 test is worth adding as a *green-after* guard that the inline cap isn't dropped, but it is not a TDD red.

- [ ] **Step 3: Create `PathValidation.cs`** (CanonicalizePath body from `PrDetailEndpoints.cs:273-304`, **plus the inline 4096-byte length cap**)

> **CRITICAL (ce-doc-review security catch):** `PrDetailEndpoints.CanonicalizePath` has **no**
> length check — the `/viewed` route enforces 4096 bytes as a *separate* pre-check at its call
> site (`PrDetailEndpoints.cs:199`). The draft side's `IsCanonicalFilePath` enforces
> `path.Length > 4096` **inside** the validator. Copying CanonicalizePath verbatim would drop the
> draft cap → unbounded `FilePath` persisted to `AppState` (DoS). The inline
> `Encoding.UTF8.GetByteCount(path) > 4096` guard below restores it (byte-count, per spec §5).
> Leave `PrDetailEndpoints.cs:199`'s separate pre-check as-is.

```csharp
using System.Text;

namespace PRism.Web.Endpoints;

internal static class PathValidation
{
    /// <summary>
    /// Canonicalizes a repo-relative file path. Returns the NFC-normalized path, or null
    /// if invalid. Rejects a superset of the prior draft-side validator: 4096-byte length cap,
    /// segment-split (bare `..` and empty segments), control chars, backslash, NFC bypass guard.
    /// </summary>
    internal static string? Canonicalize(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        if (Encoding.UTF8.GetByteCount(path) > 4096) return null; // length cap — DO NOT DROP
        if (path.StartsWith('/') || path.EndsWith('/')) return null;
        if (path.Contains('\\', StringComparison.Ordinal)) return null;
        foreach (var c in path)
        {
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return null;
        }
        var segments = path.Split('/');
        foreach (var s in segments)
        {
            if (s.Length == 0 || s == ".." || s == ".") return null;
        }
        var nfc = path.Normalize(NormalizationForm.FormC);
        if (Encoding.UTF8.GetByteCount(nfc) != Encoding.UTF8.GetByteCount(path)) return null;
        return nfc;
    }
}
```

- [ ] **Step 4: Route the draft call site through it**

`PrDraftEndpoints.cs`: delete `IsCanonicalFilePath` (558-570). Change line 464 from `if (!IsCanonicalFilePath(ndc.FilePath))` to `if (PathValidation.Canonicalize(ndc.FilePath) is null)`.

> Optional (only if a sibling draft test already pins the *normalized* path round-trip): assign the canonical form. The current call only validates (bool), so `is null` preserves behavior; do not adopt the normalized return unless a test requires it.

- [ ] **Step 5: Run — verify the new test passes, draft suite green**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Draft" -v minimal`
Expected: PASS — new rejection test green; existing draft path tests green (canonical validator is a superset reject).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/ tests/PRism.Web.Tests/Endpoints/PrDraftEndpointTests.cs
git commit -m "refactor(#319): PathValidation unifies path canonicalization (byte-count)"
```

---

## Task 5: `TabStamps` — extract stamp-write + header/cap consts

**Files:**
- Create: `PRism.Web/Endpoints/Shared/TabStamps.cs`
- Modify: `PrDetailEndpoints.cs` (151-157 + header read 130), `PrReloadEndpoints.cs` (169-175 + header read 63), `TestHooks/TestEndpoints.cs` (272-279), `PrSubmitEndpoints.cs` (header read 120), `PrDraftEndpoints.cs` (header read 81)

- [ ] **Step 1: Create `TabStamps.cs`**

```csharp
namespace PRism.Web.Endpoints;

internal static class TabStamps
{
    internal const string TabIdHeader = "X-PRism-Tab-Id";
    internal const int MaxTabStamps = 8;

    /// <summary>Returns a new stamp dictionary with tabId set to (headSha, nowUtc),
    /// evicting the oldest entries while over the cap.</summary>
    internal static Dictionary<string, TabStamp> Write(
        IReadOnlyDictionary<string, TabStamp> existing, string tabId, string headSha, DateTime nowUtc)
    {
        var stamps = existing.ToDictionary(kv => kv.Key, kv => kv.Value);
        stamps[tabId] = new TabStamp(headSha, nowUtc);
        while (stamps.Count > MaxTabStamps)
        {
            var oldest = stamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
            stamps.Remove(oldest);
        }
        return stamps;
    }
}
```

> Confirm `TabStamp`'s namespace (it's used in `PrDetailEndpoints`/`PrReloadEndpoints`); add the matching `using` to `TabStamps.cs` if it isn't in the `PRism.Web.Endpoints` namespace already.

- [ ] **Step 2: Build — verify it compiles**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Release` → 0 errors.

- [ ] **Step 3: Route the three stamp-write sites + four header reads**

`PrDetailEndpoints.cs` (151-157): replace the block with `var tabStamps = TabStamps.Write(session.TabStamps, tabId, body.HeadSha, DateTime.UtcNow);`
`PrReloadEndpoints.cs` (169-175): replace with `var tabStamps = TabStamps.Write(current.TabStamps, sourceTabId, request.HeadSha, DateTime.UtcNow);`
`TestHooks/TestEndpoints.cs` (272-279): replace with `var tabStamps = TabStamps.Write(session.TabStamps, req.TabId, headSha, DateTime.UtcNow);`

Header reads → use the const (`TabStamps.TabIdHeader`):
- `PrSubmitEndpoints.cs:120`, `PrDetailEndpoints.cs:130`, `PrDraftEndpoints.cs:81`, `PrReloadEndpoints.cs:63`: change `Request.Headers["X-PRism-Tab-Id"]` → `Request.Headers[TabStamps.TabIdHeader]`.

> `session.TabStamps` / `current.TabStamps` is an `IReadOnlyDictionary<string, TabStamp>` (or `ImmutableDictionary`) — both satisfy the `IReadOnlyDictionary` parameter. Verify the property type; if it's a concrete `Dictionary`, it still binds.

- [ ] **Step 4: Run — verify mark-viewed / reload / test-hook suites green**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Viewed|FullyQualifiedName~Reload|FullyQualifiedName~MarkPrViewed" -v minimal`
Expected: PASS (stamp behavior identical — `while` vs `if` is equivalent for single-insert).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/ PRism.Web/TestHooks/TestEndpoints.cs
git commit -m "refactor(#319): TabStamps unifies stamp-write + X-PRism-Tab-Id/cap consts"
```

---

## Task 6: `HttpJson.TryReadJsonObjectAsync` + Preferences 400 bug fix

**Files:**
- Create: `PRism.Web/Endpoints/Shared/HttpJson.cs`
- Modify: `PreferencesEndpoints.cs` (line 19 parse → helper, **bug fix**), `PrDraftEndpoints.cs` (83-96 → helper)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (red-on-main invalid-json test)

- [ ] **Step 1: Write the red-on-main Preferences test**

Add to `PreferencesEndpointsTests.cs` (match how the file POSTs; raw string body to force a JsonException):

```csharp
[Fact]
public async Task Preferences_malformed_body_returns_400_invalid_json()
{
    using var client = new PRismWebApplicationFactory().CreateClient(); // match this file's existing factory pattern
    using var content = new StringContent("{ not json", System.Text.Encoding.UTF8, "application/json");

    var resp = await client.PostAsync("/api/preferences", content);

    resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    (await resp.Content.ReadFromJsonAsync<JsonElement>())
        .GetProperty("error").GetString().Should().Be("invalid-json");
}
```

> ce-doc-review feasibility: `PreferencesEndpointsTests` has no `CamelCase` field and no `CreateClient()` helper — it instantiates `new PRismWebApplicationFactory().CreateClient()` inline. Match that; `ReadFromJsonAsync<JsonElement>()` uses Web (camelCase) defaults, so no options arg. Adapt to whatever this file actually does.

- [ ] **Step 2: Run — verify it fails on main (500, not 400)**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Preferences_malformed_body" -v minimal`
Expected: FAIL — main has no `catch (JsonException)`, so the unhandled exception yields 500 (via `UseExceptionHandler`), not 400.

- [ ] **Step 3: Create `HttpJson.cs`**

```csharp
using System.Text.Json;

namespace PRism.Web.Endpoints;

internal enum JsonReadError { None, InvalidJson, NotObject }

internal readonly record struct JsonObjectReadResult(JsonDocument? Document, JsonReadError Error);

internal static class HttpJson
{
    /// <summary>Reads the request body as a JSON object. On success Document is non-null and
    /// the caller owns disposal. On failure Document is null and Error says why; the caller maps
    /// Error to its own error DTO so existing envelopes are preserved.</summary>
    internal static async Task<JsonObjectReadResult> TryReadJsonObjectAsync(HttpContext ctx, CancellationToken ct)
    {
        JsonDocument doc;
        try
        {
            doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return new JsonObjectReadResult(null, JsonReadError.InvalidJson);
        }
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            doc.Dispose();
            return new JsonObjectReadResult(null, JsonReadError.NotObject);
        }
        return new JsonObjectReadResult(doc, JsonReadError.None);
    }
}
```

- [ ] **Step 4: Route Preferences through it (the bug fix)**

`PreferencesEndpoints.cs` — replace the line-19 parse + the existing root-kind guard:

Before:
```csharp
using var doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted).ConfigureAwait(false);
if (doc.RootElement.ValueKind != JsonValueKind.Object)
    return Results.BadRequest(new PreferencesError(Error: "body must be a JSON object"));
```
After:
```csharp
var read = await HttpJson.TryReadJsonObjectAsync(ctx, ctx.RequestAborted).ConfigureAwait(false);
if (read.Error == JsonReadError.InvalidJson)
    return Results.BadRequest(new PreferencesError(Error: "invalid-json"));
if (read.Error == JsonReadError.NotObject)
    return Results.BadRequest(new PreferencesError(Error: "body must be a JSON object"));
using var doc = read.Document!;
```

> Verify `PreferencesError`'s shape (it's in `PreferencesDtos.cs`); the `Error:` named-arg matches the existing usage at line 20. Keep the rest of the handler that reads `doc.RootElement`.

- [ ] **Step 5: Route PrDraft through it (preserve its body)**

`PrDraftEndpoints.cs` (83-96) — replace the parse + root-kind block:

Before: (the `JsonDocument doc; try {...} catch (JsonException) { return Results.BadRequest(new { error = "patch-body-missing" }); } using (doc) { if (doc.RootElement.ValueKind != JsonValueKind.Object) return Results.BadRequest(new { error = "patch-body-missing" }); ...`)

After:
```csharp
var read = await HttpJson.TryReadJsonObjectAsync(httpContext, ct).ConfigureAwait(false);
if (read.Error != JsonReadError.None)
    return Results.BadRequest(new { error = "patch-body-missing" }); // both InvalidJson and NotObject -> same body (preserved)
using var doc = read.Document!;
{
    // ... existing patch-parsing body that used `doc.RootElement` continues unchanged ...
```

> Preserve the existing `using (doc) { ... }` block contents; only the acquisition changes. Ensure the closing brace structure still matches.

- [ ] **Step 6: Run — Preferences test passes, draft + auth suites green**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Preferences|FullyQualifiedName~Draft|FullyQualifiedName~Auth" -v minimal`
Expected: PASS — `Preferences_malformed_body_returns_400_invalid_json` green; draft `patch-body-missing` tests green; **AuthEndpoints untouched** (not routed through the helper).

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Endpoints/ tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "fix(#319): HttpJson helper + /api/preferences returns 400 invalid-json (was 500)"
```

---

## Task 7: `RequireSubscribed` — 401→403, code preserved, 6 submit-family sites

**Files:**
- Create: `PRism.Web/Endpoints/Shared/RequireSubscribed.cs`
- Modify: `PrSubmitEndpoints.cs` (109, 308, 418, 523), `PrRootCommentEndpoints.cs` (61), `PrCommentEndpoints.cs` (43), `PrDraftsDiscardAllEndpoint.cs` (46)
- Tests (update old contract): `PrSubmitDiscardEndpointTests` (188-190), `PrCommentEndpointTests` (237-239), `PrRootCommentEndpointTests` (257-259)

- [ ] **Step 1: Update the three contract-encoding tests to expect 403 (red until impl lands)**

`PrSubmitDiscardEndpointTests.cs:188-190`: change `HttpStatusCode.Unauthorized` → `HttpStatusCode.Forbidden`. Keep `body.GetProperty("code")... .Should().Be("unauthorized")` (code preserved). Rename the test method if it embeds `401` (e.g. `*_returns_401` → `*_returns_403`).
`PrCommentEndpointTests.cs:237-239`: same (`Unauthorized` → `Forbidden`, code stays `"unauthorized"`).
`PrRootCommentEndpointTests.cs:257-259`: same.

**Author a new discard-all not-subscribed test** (ce-doc-review adversarial: `PrDraftsDiscardAllEndpoint.cs:46` is the one Task-7 guard with **zero** test coverage today — its 401→403 change would otherwise ship unverified). In `PrDraftsDiscardAllEndpointTests.cs`, mirror a sibling's not-subscribed setup (subscribe=false) and assert:
```csharp
[Fact]
public async Task DiscardAll_not_subscribed_returns_403()
{
    // ... arrange an authed client + tab but NOT subscribed to the PR (mirror the file's seeding) ...
    var resp = await PostDiscardAll(/* unsubscribed PR ref */);

    resp.StatusCode.Should().Be(HttpStatusCode.Forbidden); // red on main: 401
    (await resp.Content.ReadFromJsonAsync<JsonElement>())
        .GetProperty("code").GetString().Should().Be("unauthorized");
}
```
This is red-on-main (401) until Step 4 lands the 403.

- [ ] **Step 2: Run — verify these three now fail on main (still 401)**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Submit|FullyQualifiedName~Comment|FullyQualifiedName~RootComment" -v minimal`
Expected: the three updated assertions FAIL (main returns 401).

- [ ] **Step 3: Create `RequireSubscribed.cs`**

```csharp
using PRism.Core.Contracts; // PrReference
using PRism.Core.PrDetail;  // IActivePrCache

namespace PRism.Web.Endpoints;

internal static class RequireSubscribed
{
    /// <summary>null => subscribed (proceed). Non-null => 403 result the caller returns.
    /// Status moves 401 -> 403; code stays "unauthorized" (a KNOWN_SUBMIT_ERROR_CODES value
    /// the frontend maps), so no FE .code branch regresses.</summary>
    internal static IResult? Check(IActivePrCache cache, PrReference prRef) =>
        cache.IsSubscribed(prRef)
            ? null
            : Results.Json(
                new SubmitErrorDto("unauthorized", "Subscribe to this PR before making changes."),
                statusCode: StatusCodes.Status403Forbidden);
}
```

> ce-doc-review feasibility caught two errors in the first draft: the type is **`PrReference`**
> (not `PrRef` — which doesn't exist), and **`IActivePrCache` lives in `PRism.Core.PrDetail`**
> (verified `IActivePrCache.cs:16`; `IsSubscribed` takes `PrReference`). `SubmitErrorDto` needs
> no `using` (same `PRism.Web.Endpoints` namespace). Confirm the exact namespaces against
> `PrSubmitEndpoints.cs`'s usings before creating the file.

- [ ] **Step 4: Replace the six guards**

At each site, replace the `if (!activePrCache.IsSubscribed(prRef)) return Results.Json(new SubmitErrorDto("unauthorized", "...<per-verb>..."), statusCode: StatusCodes.Status401Unauthorized);` with:
```csharp
if (RequireSubscribed.Check(activePrCache, prRef) is { } notSubscribed)
    return notSubscribed;
```
Sites: `PrSubmitEndpoints.cs` 109, 308, 418, 523; `PrRootCommentEndpoints.cs` 61; `PrCommentEndpoints.cs` 43; `PrDraftsDiscardAllEndpoint.cs` 46.

> Do **not** touch `PrDraftEndpoints.cs:187` (`PatchOutcome.NotSubscribed => Results.NotFound(new { error = "not-subscribed" })`) — the markAllRead 404 carve-out stays.

- [ ] **Step 5: Run — verify the three updated tests pass, no others regress**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Submit|FullyQualifiedName~Comment|FullyQualifiedName~RootComment|FullyQualifiedName~DiscardAll" -v minimal`
Expected: PASS — 403 + code `"unauthorized"`. Confirm no markAllRead/draft test flipped (it shouldn't — that path is untouched).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/ tests/PRism.Web.Tests/Endpoints/
git commit -m "refactor(#319): RequireSubscribed -> 403 (code 'unauthorized' kept), 6 sites"
```

---

## Task 8: no-session 400→404 (submit + root-comment)

**Files:**
- Modify: `PrSubmitEndpoints.cs:129`, `PrRootCommentEndpoints.cs:99-101`
- Tests: `PrSubmitEndpointsTests` (289-290), `PrRootCommentEndpointTests` (`PostRootComment_no_session_returns_400_no_session`, ~108-119)

- [ ] **Step 1: Update both no-session tests to expect 404 (red until impl)**

`PrSubmitEndpointsTests.cs:289-290`: change `HttpStatusCode.BadRequest` → `HttpStatusCode.NotFound`; keep code `"no-session"`.
`PrRootCommentEndpointTests.cs` (`PostRootComment_no_session_returns_400_no_session`): change `HttpStatusCode.BadRequest` → `HttpStatusCode.NotFound`; keep code `"no-session"`. Rename to `..._returns_404_...`.

- [ ] **Step 2: Run — verify both fail on main (still 400)**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~no_session|FullyQualifiedName~no-session" -v minimal`
Expected: FAIL (main returns 400).

- [ ] **Step 3: Change both status codes to 404**

`PrSubmitEndpoints.cs:129`: `StatusCodes.Status400BadRequest` → `StatusCodes.Status404NotFound` (keep `new SubmitErrorDto("no-session", "No draft session for this PR.")`).
`PrRootCommentEndpoints.cs:99-101`: same status change, same body.

- [ ] **Step 4: Run — verify both pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~no_session|FullyQualifiedName~Submit|FullyQualifiedName~RootComment" -v minimal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/ tests/PRism.Web.Tests/Endpoints/
git commit -m "refactor(#319): no-session -> 404 (submit + root-comment), code preserved"
```

---

## Task 9: foreign-pending-review discard 200→204

**Files:**
- Modify: `PrSubmitEndpoints.cs:559` (`DiscardForeignPendingReviewAsync`, `return Results.Ok()`)
- Test: **author a new test** in `PrSubmitDiscardEndpointTests.cs` (none exists for this path)

> **ce-doc-review correction (feasibility + adversarial, conf 100).** The first draft targeted
> the wrong endpoint. The issue's "twin discard" drift is foreign-pending (`:559`, 200) vs
> own-pending (`:396`, 204) — NOT the bulk `POST /drafts/discard-all`
> (`PrDraftsDiscardAllEndpoint.cs:105`, also 200, which has three passing tests at
> `PrDraftsDiscardAllEndpointTests.cs:35,53,69`). Changing `:559` aligns the foreign twin to the
> own twin. The bulk discard-all is **left at 200** (not part of the twin drift; out of scope).
> `DiscardForeignPendingReviewAsync` has **no existing test**, so this task authors one.

- [ ] **Step 1: Author the red-on-main foreign-discard test (expects 204)**

In `PrSubmitDiscardEndpointTests.cs`, mirror the file's foreign-pending-review setup (seed a
foreign pending review, subscribe, then POST the foreign-discard endpoint). Assert 204:
```csharp
[Fact]
public async Task DiscardForeignPendingReview_returns_204()
{
    // ... arrange: authed+subscribed client, seed a FOREIGN pending review for the PR
    //     (mirror the existing foreign-resume/discard test setup in this file) ...
    var resp = await PostForeignDiscard(/* the PR ref */);

    resp.StatusCode.Should().Be(HttpStatusCode.NoContent); // red on main: 200 OK
}
```
> If the file has no foreign-discard helper, copy the arrange from the nearest foreign-pending
> test (resume/discard share setup). The endpoint is
> `POST /api/pr/{o}/{r}/{n}/submit/foreign-pending-review/discard`.

- [ ] **Step 2: Run — verify it fails on main**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~DiscardForeignPendingReview_returns_204" -v minimal`
Expected: FAIL (main returns 200 OK).

- [ ] **Step 3: Change the return to 204**

`PrSubmitEndpoints.cs:559` (`DiscardForeignPendingReviewAsync`): `return Results.Ok();` →
`return Results.NoContent();`. Leave own-discard (`:396`, already 204) and the bulk
`/drafts/discard-all` (`PrDraftsDiscardAllEndpoint.cs:105`, stays 200) untouched.

- [ ] **Step 4: Run — verify green; bulk discard-all tests still pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~Discard" -v minimal`
Expected: PASS — new foreign-discard test green; `PrDraftsDiscardAllEndpointTests` (35/53/69)
still green at 200 (not touched). FE `client.ts` returns `undefined` for 204 and empty-200 alike,
so no FE change.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/PrSubmitEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrSubmitDiscardEndpointTests.cs
git commit -m "refactor(#319): foreign-pending-review discard -> 204 (matches own-discard twin)"
```

---

## Task 10: body-cap constant unification (constant only)

**Files:**
- Create: `PRism.Web/Endpoints/Shared/EndpointExtensions.cs`
- Modify: `Program.cs` (the `const long Cap = 16 * 1024;` at ~274 → shared const), `PrDetailEndpoints.cs:185,251` (the `16384` literals → shared const)

> **ce-doc-review scope + security: the metadata-migration probe is DROPPED.** `RequestSizeLimitTests`
> documents the attribute doesn't fire pre-binding for minimal APIs (so the migration is expected to
> fail), and the revert path risked shipping an endpoint uncapped. This task does **constant
> unification only** — the `Program.cs` `UseWhen` predicate is **unchanged**. `comment/post` and
> `preferences` remain uncapped exactly as on `main` (pre-existing; filed as a §10 follow-up, not
> this PR). Invariant: no currently-capped endpoint loses its cap.

- [ ] **Step 1: Create `EndpointExtensions.cs` (single source for the cap value)**

```csharp
using Microsoft.AspNetCore.Mvc;

namespace PRism.Web.Endpoints;

internal static class EndpointExtensions
{
    internal const int MutatingBodyCapBytes = 16 * 1024; // 16 KiB - single source of truth

    /// <summary>Attaches the body cap as routing metadata. NOTE: RequestSizeLimitAttribute does
    /// not fire pre-binding for minimal APIs (see RequestSizeLimitTests) - the Program.cs
    /// middleware predicate is the load-bearing cap. Defined for future use; NOT wired to any
    /// route in this PR.</summary>
    internal static RouteHandlerBuilder WithBodyCap(this RouteHandlerBuilder builder) =>
        builder.WithMetadata(new RequestSizeLimitAttribute(MutatingBodyCapBytes));
}
```

- [ ] **Step 2: Replace the three literals with the const**

`Program.cs` (~274): `const long Cap = 16 * 1024;` → `const long Cap = EndpointExtensions.MutatingBodyCapBytes;`.
`PrDetailEndpoints.cs:185,251`: `new RequestSizeLimitAttribute(16384)` → `new RequestSizeLimitAttribute(EndpointExtensions.MutatingBodyCapBytes)`.

> Do **not** change the `Program.cs` `UseWhen` predicate. Do **not** wire `.WithBodyCap()` to any
> route. This task only collapses three literals to one named constant.

- [ ] **Step 3: Build + run the body-cap suite — verify green (no behavior change)**

Run: `dotnet build PRism.Web/PRism.Web.csproj -c Release` → 0 warnings.
Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~RequestSizeLimit|FullyQualifiedName~BodySize" -v minimal`
Expected: PASS — pure constant substitution; predicate and all 413 behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add PRism.Web/Endpoints/Shared/EndpointExtensions.cs PRism.Web/Program.cs PRism.Web/Endpoints/PrDetailEndpoints.cs
git commit -m "refactor(#319): unify body-cap value to MutatingBodyCapBytes (predicate unchanged)"
```

---

## Task 11: Frontend verification + full suite + pre-push

**Files:** none changed (verification only).

- [ ] **Step 1: Grep the frontend to confirm no `.code`/`.kind` regression**

Run (from worktree root):
```bash
cd frontend && grep -rn "unauthorized" src/ ; grep -rn "KNOWN_SUBMIT_ERROR_CODES" src/api/submit.ts
```
Expected: `case 'unauthorized'` (PrHeader) and the `KNOWN_SUBMIT_ERROR_CODES` array still contain `'unauthorized'` — which the backend still emits (code preserved). Confirm **no** code path requires `'not-subscribed'` as a submit code. No frontend edit.

- [ ] **Step 2: Confirm the markAllRead path is untouched**

Run: `git diff main -- PRism.Web/Endpoints/PrDraftEndpoints.cs | grep -i "not-subscribed\|NotSubscribed"`
Expected: no change to the `PatchOutcome.NotSubscribed => Results.NotFound(...)` line (404 carve-out intact).

- [ ] **Step 3: Full backend build + test (the pre-push gate)**

Run: `dotnet build -c Release` (whole solution) → 0 warnings, 0 errors.
Run: `dotnet test -c Release` (whole solution; Core + GitHub + Web) with timeout ≥ 300000ms.
Expected: all green. Cross-check the §8 "tests that must change" list — every one updated, and `PrDraftEndpointTests.Missing_session_token_returns_401` **unchanged** (still 401).

- [ ] **Step 4: Run the repo pre-push checklist verbatim**

Follow `.ai/docs/development-process.md` pre-push checklist exactly (build, test, format/lint). Do not substitute a self-curated subset.

- [ ] **Step 5: Final commit (if the checklist edited anything, e.g. formatting)**

```bash
git add -A
git commit -m "chore(#319): pre-push verification (frontend untouched, suites green)"
```

---

## Self-Review

**Spec coverage (§9 ACs → tasks):**
- One definition each (error map / subscribed-guard / session upsert / path / SHA / tab-stamp / JSON-read) → Tasks 2, 7, 1, 4, 3 (incl. PrDetail), 5, 6. ✓
- Preferences 400 invalid-json (red-on-main) → Task 6. ✓
- Draft path byte-count + 4096 length cap (empty-segment red-on-main test) → Task 4. ✓
- Status numbers (not-subscribed 403 / no-session 404 / foreign-discard 204; markAllRead 404 + bulk discard-all 200 carve-outs) → Tasks 7, 8, 9. ✓
- Body-cap value defined once; predicate **unchanged** (constant-only) → Task 10. ✓
- SHA case-insensitive `[GeneratedRegex]` (PrDraft + PrReload + **PrDetail**) → Task 3. ✓
- Tab-stamp write + header + cap once (incl. test hook) → Task 5. ✓
- Full `dotnet test` green; no FE regression → Task 11. ✓

**§8 tests-that-must-change coverage:** flip-to-403 — PrSubmitDiscardEndpointTests, PrCommentEndpointTests, PrRootCommentEndpointTests (T7); flip-to-404 — PrSubmitEndpointsTests no-session, PrRootCommentEndpointTests no-session (T8). **New tests authored:** discard-all 403 (T7), foreign-pending-discard 204 (T9), empty-segment 422 (T4), uppercase-SHA accept (T3), preferences 400 (T6). Do-not-touch: `Missing_session_token_returns_401` and `PrDraftsDiscardAllEndpointTests:35,53,69` (bulk discard-all stays 200). ✓

**Out-of-scope honored:** AuthEndpoints (T6 routes only Preferences+PrDraft), SubmitPipeline (T1 Step 5 note), markAllRead 404 (T7 Step 4), bulk `/drafts/discard-all` 200 (T9), `comment/post`/`preferences` body cap (T10 follow-up), frontend (T11 verify-only). ✓

**Type consistency:** `AppState.WithSession(string, ReviewSessionState)` (T1); `GitHubErrorMapper.ToResult(Exception)` (T2); `RequireSubscribed.Check(IActivePrCache, PrReference) → IResult?` (T7 — `PrReference`, not `PrRef`); `HttpJson.TryReadJsonObjectAsync → JsonObjectReadResult` with `JsonReadError` (T6); `PathValidation.Canonicalize(string) → string?` (T4); `SharedRegexes.Sha40()/Sha64()` (T3); `TabStamps.Write/.TabIdHeader/.MaxTabStamps` (T5); `EndpointExtensions.MutatingBodyCapBytes/.WithBodyCap()` (T10). Consistent across tasks. ✓

**Placeholder scan:** No TBD/TODO. Implementer-verification notes remain where the exact arrange/helper must be matched to a test file's house style (T4, T7, T9 new tests) — each names the concrete pattern to mirror, not a vague "handle it."

**ce-doc-review round 2 (plan review) — dispositions:** Applied — `PrRef`→`PrReference` + namespaces (T7); 4096 length-cap restored inline (T4, security); Task 9 retargeted to `:559` foreign-discard + new test (was wrong endpoint); PrDetail SHA migration added (T3); discard-all 403 test added (T7); all-callers enumerated (T1); wrong `SubmitErrorDto` using dropped (T2/T7); empty-segment as primary red-on-main (T4); test-helper refs fixed (T6). Applied scope call — Task 10 reduced to constant-only (metadata probe dropped; pre-existing uncapped endpoints → follow-up). All five personas' confidence-100 findings actioned.
