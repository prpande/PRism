# Decompose `GitHubReviewService` — PR2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `IReviewSubmitter` out of `GitHubReviewService` into a new `GitHubReviewSubmitter`, extract a shared static GraphQL transport (`GitHubGraphQL.PostAsync`) + shared `TryGetPath`/`Truncate`, converge the four `LoggerMessage.Define` fields to `[LoggerMessage]`, and fold in the `IsDnsFailure` inner-message fix — closing the two acceptance criteria #321 left open after PR1.

**Architecture:** Approach A (owner-approved). The raw GraphQL POST becomes a static `GitHubGraphQL.PostAsync` (the byte-identity B2 surface, routed through `GitHubHttp.SendAsync` so the PAT same-host guard stays in the call chain). Reader and the new submitter each keep a thin private `PostGraphQLAsync(query, variables, ct)` instance wrapper (token-read + `CreateClient("github")` + delegate to the static), so existing call-site bodies stay **byte-identical**. Shared pure helpers move to `internal static` homes and are reached via `using static`, again keeping bodies byte-identical. DI rebinds only `IReviewSubmitter`.

**Tech Stack:** .NET 10, C# (`Nullable enable`, `TreatWarningsAsErrors=true`), xUnit + FluentAssertions, `Microsoft.Extensions.Logging` source-gen (`[LoggerMessage]`). Backend-only — zero frontend files.

**Source of truth:** `docs/specs/2026-06-13-decompose-github-review-service-pr2-design.md`. The spec's *What moves/what stays*, *DI before/after*, *Logging convergence*, and *Tests* tables are authoritative; this plan sequences them.

**Worktree / branch:** `D:/src/PRism-321-pr2` / `feature/321-decompose-pr2-submit`. All `git`/`dotnet` commands target this worktree. One build/test at a time, foreground, timeout ≥ 300000ms.

**Why not TDD-first:** This is a behavior-preserving relocation (bodies byte-identical) + one isolated behavior fix (fold-in 1, which DOES get a test-first treatment). The existing `PRism.GitHub.Tests` suite is the regression net; it must stay green with **only** the mechanical SUT-type swaps the spec enumerates. The one genuinely new behavior — `IsDnsFailure` reading `se.Message` — is the only place a failing-test-first step applies (Task 5).

**Commit boundaries (each leaves a green tree):**
0. Task 0 → no commit; captures the pre-move submit-body literal (B2 ground truth) from the still-unmodified tree, used by Task 4's assertion.
1. Task 1 → shared transport + helpers + reader logging convergence.
2. Tasks 2–4 → submitter split + DI rebind + test migration (the build is red between Task 2 and the end of Task 4; commit once at Task 4's green checkpoint).
3. Task 5 → fold-in 1 (`IsDnsFailure` + its test) as its **own** commit (separable behavior line for the B2 reviewer).
4. Task 6 → verification only (no code; no commit unless a gate surfaces a fix).

---

## File map

**Create:**
- `PRism.GitHub/GitHubGraphQL.cs` — `internal static class GitHubGraphQL`: `PostAsync` (raw transport, verbatim body of the old `PostGraphQLAsync`), `TryGetPath`, nested `Log` (EventId 5 `GraphQLTransportFailed`).
- `PRism.GitHub/GitHubReviewSubmitter.cs` — `internal sealed partial class GitHubReviewSubmitter : IReviewSubmitter`: ctor, fields, thin `PostGraphQLAsync` wrapper, `SendGitHubAsync` copy, nested `Log` (EventIds 2,3).
- `PRism.GitHub/GitHubReviewSubmitter.Submit.cs` ← move of `GitHubReviewService.Submit.cs`.
- `PRism.GitHub/GitHubReviewSubmitter.ReviewComments.cs` ← move of `GitHubReviewService.ReviewComments.cs`.
- `PRism.GitHub/GitHubReviewSubmitter.IssueComments.cs` ← move of `GitHubReviewService.IssueComments.cs`.
- `tests/PRism.GitHub.Tests/GitHubGraphQLAuthHeaderTests.cs` — security: PAT attached on trusted host, refused off-host, via the new static.
- `tests/PRism.GitHub.Tests/GitHubAuthValidatorDnsFailureTests.cs` — fold-in 1 two-case test.

**Modify:**
- `PRism.GitHub/GitHubReviewService.cs` — drop `IReviewSubmitter` from declaration; drop moved members (`PostGraphQLAsync` body→static, `TryGetPath`, `Truncate`, `s_graphqlTransportFailed`); add thin `PostGraphQLAsync` wrapper + `using static`; convert `s_graphqlReadFailed` (4) to `[LoggerMessage]`; pin explicit EventIds on `Log`.
- `PRism.GitHub/GitHubHttp.cs` — add `internal static string Truncate(string, int)`.
- `PRism.GitHub/GitHubAuthValidator.cs` — `IsDnsFailure` reads `se.Message` (Task 5).
- `PRism.GitHub/ServiceCollectionExtensions.cs` — rebind `IReviewSubmitter` → `GitHubReviewSubmitter`; update XML-doc.
- `tests/PRism.GitHub.Tests/TestHelpers/GitHubReviewServiceFactory.cs` — add `CreateSubmitter`.
- 8 submit/comment test files — SUT helper return type swap (enumerated in Task 4).
- `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` — re-point `SubmitPath` to `CreateSubmitter`; strengthen it to pin the request body.

**Byte-identical, do NOT touch the bodies of:** the 7 pending-review methods, `PostSubmitGraphQLAsync`, `ResolvePullRequestNodeIdAsync`, the comment-create methods, the cap-hit trio, `ParseFileChanges`, the query consts, `TryParsePrUrl`.

---

## Task 0: Pin the submit request body on the PRE-MOVE tree (B2 ground truth)

**Why first (before any code change):** The strengthened `SubmitPath` body assertion (Task 4) is the **only** guard on the submit GraphQL request *body* — the integration shape-drift suite covers the read side only. If the expected literal were captured by running the *post-move* code, a drift introduced by the transport move would be recorded as "expected" and `Assert.Equal(drifted, drifted)` would pass green — locking in the drift instead of catching it. The working tree is currently at PR1 state (no PR2 code change yet), so capture the ground-truth bytes **now**, from the unmodified transport, and assert against them later.

**Files:** none modified permanently — a throwaway probe + a recorded constant carried into Task 4.

- [ ] **Step 1: Dump the current submit request body**

Temporarily add a body dump to the existing `GraphQlByteIdentityTests.SubmitPath_graphql_request_transport_is_unchanged` (or a scratch copy): make `CapturingHandler.SendAsync` capture `await request.Content!.ReadAsStringAsync(ct)` and the test write it out, e.g. `Console.WriteLine($"BODY={body}"); Console.WriteLine($"CT={request.Content!.Headers.ContentType}");`. Run:
```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --configuration Release --settings .runsettings --filter "FullyQualifiedName~SubmitPath_graphql_request_transport_is_unchanged" --logger "console;verbosity=detailed"
```

- [ ] **Step 2: Record the canonical literal**

Record the exact emitted body string and content-type verbatim (this is `JsonSerializer.Serialize(new { query = <finalize mutation>, variables = <the finalize variables object> })` over the test's fixed inputs — deterministic). Keep them here for Task 4:

```
PRE_MOVE_SUBMIT_BODY  = <paste the exact captured string>
PRE_MOVE_CONTENT_TYPE = application/json; charset=utf-8   # confirm from the CT= line
```

- [ ] **Step 3: Revert the throwaway probe**

`git checkout -- tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (or discard the scratch file). Nothing from Task 0 is committed — only the recorded literal carries forward. The real (kept) assertion lands in Task 4 Step 3, asserting the **post-move** output equals `PRE_MOVE_SUBMIT_BODY`. That is a genuine before-vs-after regression check, not a self-derived echo.

---

## Task 1: Extract shared transport + helpers; converge reader logging

**Why first:** The spec's risk-ordering — move the shared statics (`TryGetPath`/`Truncate`/transport) and re-point the reader **before** moving the submit partials, so a naive file move can't drag a staying member, and the reader stays green at this checkpoint independent of the submitter split.

**Files:**
- Create: `PRism.GitHub/GitHubGraphQL.cs`
- Modify: `PRism.GitHub/GitHubHttp.cs`, `PRism.GitHub/GitHubReviewService.cs`

- [ ] **Step 1: Create `GitHubGraphQL.cs` with the static transport, `TryGetPath`, and the EventId-5 log**

Create `PRism.GitHub/GitHubGraphQL.cs`. The `PostAsync` body is the **verbatim** transport from `GitHubReviewService.PostGraphQLAsync` (`GitHubReviewService.cs:558-588`), reshaped from instance fields to parameters. **It MUST route through `GitHubHttp.SendAsync`** (the same-host PAT guard lives in `GitHubHttp.ApplyHeaders`, reachable only via `SendAsync`) — never `http.SendAsync` directly.

```csharp
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PRism.Core; // HostUrlResolver

namespace PRism.GitHub;

// #321 PR2 — the shared raw GraphQL transport, extracted from
// GitHubReviewService.PostGraphQLAsync so the reader (IPrReader/IPrDiscovery) and the
// split-out GitHubReviewSubmitter (IReviewSubmitter) both POST through one provably-
// identical function. Static + takes the resolved (http, token, host, log) so each caller
// keeps its own token-read cadence — the #320 pattern. The request stays byte-identical to
// the pre-split form (same endpoint resolution, apiVersion:false, StringContent), which is
// the B2 submit-transport contract pinned by GraphQlByteIdentityTests + the integration
// shape-drift test.
// `partial` is required at the class level because of the nested source-gen `partial class Log`.
internal static partial class GitHubGraphQL
{
    // Raw GraphQL POST: resolves the host's GraphQL endpoint, sends apiVersion:false,
    // logs transport failures (EventId 5), throws HttpRequestException on non-2xx.
    // Returns the raw JSON body. MUST send via GitHubHttp.SendAsync so the same-host
    // PAT credential guard (GitHubHttp.ApplyHeaders) stays in the call chain.
    internal static async Task<string> PostAsync(
        HttpClient http, string? token, string host, ILogger log,
        string query, object variables, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new { query, variables });
        // Absolute URL to defeat the named client's BaseAddress = `<host>/api/v3/`. GHES's
        // GraphQL endpoint is `<host>/api/graphql` (no /v3); resolving against BaseAddress
        // would 404 on every GraphQL call against GHES.
        var endpoint = HostUrlResolver.GraphQlEndpoint(host);
        // apiVersion:false — the REST version header is meaningless to the GraphQL endpoint;
        // suppressing it keeps this request byte-identical to its pre-#320 form. The submit
        // pipeline rides this method, so byte-identity here preserves the B2 submit transport.
        using var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
        using var resp = await GitHubHttp.SendAsync(
            http, HttpMethod.Post, endpoint.ToString(), token, ct,
            content: content, apiVersion: false).ConfigureAwait(false);
        if (!resp.IsSuccessStatusCode)
        {
            // GitHub's error body carries the actionable reason ({"message":"Bad credentials",…}
            // for 401, abuse/rate-limit details for 403, etc.); read it (best-effort) so the
            // exception message and the transport-failure log include it.
            string body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            Log.GraphQLTransportFailed(log, (int)resp.StatusCode, resp.ReasonPhrase ?? "", GitHubHttp.Truncate(body, 1024));
            throw new HttpRequestException(
                $"GitHub GraphQL HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {GitHubHttp.Truncate(body, 512)}",
                inner: null,
                statusCode: resp.StatusCode);
        }
        return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    }

    // Walks a chain of property names defensively. Returns false on any missing key,
    // any non-object intermediate, or short-circuits at the first JSON null. Shared by the
    // reader read path and all submit methods (moved out of GitHubReviewService in PR2).
    internal static bool TryGetPath(JsonElement root, out JsonElement leaf, params string[] path)
    {
        var current = root;
        foreach (var key in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(key, out var next))
            {
                leaf = default;
                return false;
            }
            current = next;
        }
        leaf = current;
        return true;
    }

    private static partial class Log
    {
        // Transport-level failures are logged at Warning because rate-limits and auth
        // expiry are recoverable conditions. Body is truncated to 1024 chars in the log so a
        // pathological 5xx body doesn't bloat the log file; the response code + first 512
        // chars in the exception's Message are what callers surface. EventId 5 preserved from
        // the pre-PR2 GitHubReviewService field (operators grep on it); after the split the
        // event surfaces under whichever ILogger category the caller passes (reader or
        // submitter) — see spec § Logging convergence (accepted consequence).
        [LoggerMessage(Level = LogLevel.Warning, EventId = 5, EventName = "GraphQLTransportFailed",
            Message = "GraphQL HTTP request failed: {StatusCode} {ReasonPhrase}. Body: {Body}")]
        internal static partial void GraphQLTransportFailed(ILogger logger, int statusCode, string reasonPhrase, string body);
    }
}
```

Note: `Log` must be `partial` (source-gen requirement) and so must the enclosing `GitHubGraphQL` class — change the declaration to `internal static partial class GitHubGraphQL`.

- [ ] **Step 2: Move `Truncate` into `GitHubHttp`**

In `PRism.GitHub/GitHubHttp.cs`, add (next to `ReadErrorBodyBestEffortAsync`):

```csharp
    // Truncates HTTP error bodies for log/exception messages. Lives here next to
    // ReadErrorBodyBestEffortAsync — both the GraphQL transport error path (GitHubGraphQL)
    // and the REST comment-POST error paths (GitHubReviewSubmitter) reach it without a new
    // dependency. Appends an ellipsis when clipped. (Moved from GitHubReviewService in PR2.)
    internal static string Truncate(string s, int max)
        => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : string.Concat(s.AsSpan(0, max), "…"));
```

- [ ] **Step 3: Reduce `GitHubReviewService.PostGraphQLAsync` to a thin wrapper; delete the moved members**

In `GitHubReviewService.cs`:

Replace the full `PostGraphQLAsync` (`:558-588`) with the thin wrapper:

```csharp
    // Thin per-class transport wrapper: reads the token, builds the named "github" client,
    // delegates the raw POST to the shared GitHubGraphQL.PostAsync (#321 PR2). Keeping this
    // wrapper named PostGraphQLAsync(query, variables, ct) leaves the read-path call sites
    // (GetPrDetailAsync / GetTimelineAsync) byte-identical.
    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }
```

Delete from `GitHubReviewService.cs`:
- `Truncate` (`:590-591`) — moved to `GitHubHttp`.
- `s_graphqlTransportFailed` field + its comment (`:593-600`) — moved to `GitHubGraphQL.Log`.
- `TryGetPath` (`:637-653`) — moved to `GitHubGraphQL`.

Keep on the reader: `ThrowIfGraphQLErrorsWithoutData`, `s_graphqlReadFailed` (converted in Step 5), the cap-hit trio (`PagedConnections`/`HasAnyNextPage`/`ConnectionHasNext`), `SendGitHubAsync`, `ParseFileChanges`, the fan-out methods, the query consts.

- [ ] **Step 4: Add `using static` so reader call sites stay byte-identical**

At the top of `GitHubReviewService.cs`, add:

```csharp
using static PRism.GitHub.GitHubGraphQL; // TryGetPath
using static PRism.GitHub.GitHubHttp;    // Truncate
```

This keeps every `TryGetPath(...)` and `Truncate(...)` call site in the reader unchanged. (The reader currently calls `TryGetPath` in `GetPrDetailAsync` and elsewhere; `Truncate` only inside the now-moved transport — but `using static` is harmless if unused and documents the shared origin. If `TreatWarningsAsErrors` flags an unused `using static`, drop the `GitHubHttp` one — verify by build.)

- [ ] **Step 5: Convert the read-failed logger (EventId 4) to `[LoggerMessage]` and pin the reader `Log` class EventIds**

The four currently-`[LoggerMessage]` reader methods (`FanOutDegraded`/`TimelineCapHit`/`DiffPagesCapped`/`PatchParseFailed`, `:545-555`) omit explicit EventIds. Converting `s_graphqlReadFailed` to a `[LoggerMessage]` with explicit `EventId = 4` places an explicit Id beside four implicit ones in the **same** `Log` class — the only within-class collision risk in this PR (the generator enforces EventId uniqueness per class). Resolve it empirically, preserving operator-facing Ids:

**5a. Probe the current Ids.** Build once (Step 6 will build anyway, but do a probe build now), then inspect the generated source to read what `EventId.Id` each of the four implicit methods currently emits:

```
dotnet build PRism.GitHub/PRism.GitHub.csproj --configuration Release
```

Then locate the generated logger source and read the four Ids:

```
# PowerShell — find the generated LoggerMessage source for the reader's Log class
Get-ChildItem -Recurse PRism.GitHub/obj -Filter *.g.cs |
  Select-String -Pattern "GraphQLReadFailed|FanOutDegraded|TimelineCapHit|DiffPagesCapped|PatchParseFailed|new EventId\(" |
  Select-Object Path, LineNumber, Line
```

Record the emitted `EventId(<n>, ...)` for each of the four implicit methods.

**5b. Convert + pin.** Replace the `s_graphqlReadFailed` field (`:628-635`, including its comment) with a `[LoggerMessage]` method on the reader `Log` class, and add explicit `EventId`/`EventName` to all five methods now in that class:

```csharp
        // s_graphqlReadFailed → GraphQLReadFailed. Logged at Warning (not Error) because the
        // read-side queries can legitimately run against repos the user no longer has access
        // to or PRs that have been deleted — those produce errors-without-data legitimately
        // and the UI surfaces an empty state. EventId 4 preserved (operators grep on it).
        [LoggerMessage(Level = LogLevel.Warning, EventId = 4, EventName = "GraphQLReadFailed",
            Message = "Read-side GraphQL call returned {ErrorCount} error(s) with no usable data. Raw errors: {ErrorsJson}")]
        internal static partial void GraphQLReadFailed(ILogger logger, int errorCount, string errorsJson);
```

Pin the four previously-implicit methods explicitly. **Most likely outcome:** the `Microsoft.Extensions.Logging` source generator assigns `EventId = 0` to *every* method that omits one (it does **not** auto-increment), so the probe will show all four as `0` — operator-indistinguishable today. In that case assign distinct stable Ids `FanOutDegraded = 6, TimelineCapHit = 7, DiffPagesCapped = 8, PatchParseFailed = 9` (next free block above 5; a strict improvement, since no operator could have keyed on four identical `0` events) and record the 6–9 assignment in the PR change story (it is the one operator-visible logging change in this PR). The new `GraphQLReadFailed = 4` then sits in the class beside `{6,7,8,9}` — no collision.

**If the probe contradicts that** (the generator on this toolchain emits distinct or non-zero Ids): pin each method to the Id it already emits (preserve operator-facing Ids — do **not** renumber); flag any genuinely-changed Id in the PR change story. The "a probed Id already equals 4" case is a defensive guard only — given omitted ⇒ `0`, it should not fire; if it somehow does, that collision is latent today, so give the colliding method the next free Id and flag it.

Update the call site `s_graphqlReadFailed(_log, …, null)` (in `ThrowIfGraphQLErrorsWithoutData`, `:622`) to `Log.GraphQLReadFailed(_log, errors.GetArrayLength(), errorsJson)` (drop the trailing `null` — `[LoggerMessage]` methods take no `Exception` unless declared). Likewise the transport field's old call site is gone (moved). Confirm `FanOutDegraded`/`TimelineCapHit`/`DiffPagesCapped`/`PatchParseFailed` call sites already use `Log.X(...)` form (they do, e.g. `:714`).

> This completes the "explicit EventIds on every method in the three touched Log classes" requirement for the reader class. The other two touched classes are trivially pinned: `GitHubGraphQL.Log` carries only `GraphQLTransportFailed` (explicit 5, Step 1); `GitHubReviewSubmitter.Log` will carry only `GraphQLSubmitFailed`/`GraphQLSubmitNoData` (explicit 2,3, Task 2). The two untouched all-source-gen classes (`GitHubAwaitingAuthorFilter`, `GitHubSectionQueryRunner`) are left as-is per spec.

- [ ] **Step 6: Build + reader-path tests green**

```
dotnet build PRism.GitHub/PRism.GitHub.csproj --configuration Release
```
Expected: 0 warnings, 0 errors. (`IReviewSubmitter` is still on `GitHubReviewService` at this point — the submit partials still compile against it; their `PostGraphQLAsync`/`TryGetPath`/`Truncate` calls now resolve to the wrapper + shared statics via the same class membership and `using static`. **Add the same two `using static` lines to `GitHubReviewService.Submit.cs`, `.ReviewComments.cs`, `.IssueComments.cs` now** so they still compile — they will move with these directives in Task 2.)

```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --no-build --configuration Release --settings .runsettings
```
Expected: all green (including `GraphQlByteIdentityTests.SubmitPath`, which still constructs `GitHubReviewService` — unchanged this task).

- [ ] **Step 7: Commit**

```
git add PRism.GitHub/GitHubGraphQL.cs PRism.GitHub/GitHubHttp.cs PRism.GitHub/GitHubReviewService.cs PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.ReviewComments.cs PRism.GitHub/GitHubReviewService.IssueComments.cs
git commit -F - <<'EOF'
refactor(github): extract shared GitHubGraphQL transport + helpers (#321)

Move the raw GraphQL POST to a static GitHubGraphQL.PostAsync (routed through
GitHubHttp.SendAsync so the same-host PAT guard stays in the call chain), and
move TryGetPath -> GitHubGraphQL, Truncate -> GitHubHttp. Reader keeps a thin
PostGraphQLAsync wrapper + using-static so call-site bodies stay byte-identical.
Converge the read/transport loggers (EventId 4, 5) to [LoggerMessage] and pin
explicit EventIds across the reader Log class. No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Split `IReviewSubmitter` into `GitHubReviewSubmitter`

**Files:**
- Create: `PRism.GitHub/GitHubReviewSubmitter.cs`
- Move: `GitHubReviewService.Submit.cs` → `GitHubReviewSubmitter.Submit.cs`; `GitHubReviewService.ReviewComments.cs` → `GitHubReviewSubmitter.ReviewComments.cs`; `GitHubReviewService.IssueComments.cs` → `GitHubReviewSubmitter.IssueComments.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (drop `IReviewSubmitter`)

- [ ] **Step 1: Create `GitHubReviewSubmitter.cs` (ctor, fields, wrappers, Log)**

```csharp
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using static PRism.GitHub.GitHubGraphQL; // TryGetPath
using static PRism.GitHub.GitHubHttp;    // Truncate

namespace PRism.GitHub;

// IReviewSubmitter — the GraphQL pending-review pipeline + the REST comment-create paths,
// split out of GitHubReviewService in #321 PR2 (ADR-S5-1 capability split; single-capability
// class). Transport rides the shared static GitHubGraphQL.PostAsync (byte-identical to the
// pre-split form — the B2 contract) via the thin PostGraphQLAsync wrapper below. internal
// sealed; constructed via DI and the test factory (InternalsVisibleTo).
internal sealed partial class GitHubReviewSubmitter : IReviewSubmitter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubReviewSubmitter> _log;

    public GitHubReviewSubmitter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubReviewSubmitter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubReviewSubmitter>.Instance;
    }

    // Thin per-class transport wrapper — verbatim twin of the reader's. Keeping the name
    // PostGraphQLAsync(query, variables, ct) leaves PostSubmitGraphQLAsync byte-identical.
    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    // The REST comment paths' token-read wrapper — verbatim copy of the reader's SendGitHubAsync
    // (the #320 per-class token-read cadence, not meaningful duplication).
    private async Task<HttpResponseMessage> SendGitHubAsync(HttpClient http, HttpMethod method, string url, CancellationToken ct, HttpContent? content = null)
    {
        var token = await _readToken().ConfigureAwait(false);
        return await GitHubHttp.SendAsync(http, method, url, token, ct, content).ConfigureAwait(false);
    }

    private static partial class Log
    {
        // s_graphqlSubmitFailed → GraphQLSubmitFailed. Logged at Error because submit-pipeline
        // GraphQL failures always abort the pipeline (no partial-data path here). Full errors
        // JSON included so the operator sees every error, not just the first in the toast.
        // EventId 2 preserved.
        [LoggerMessage(Level = LogLevel.Error, EventId = 2, EventName = "GraphQLSubmitFailed",
            Message = "Submit-pipeline GraphQL call returned {ErrorCount} error(s). Raw errors: {ErrorsJson}")]
        internal static partial void GraphQLSubmitFailed(ILogger logger, int errorCount, string errorsJson);

        // s_graphqlSubmitNoData → GraphQLSubmitNoData. EventId 3 preserved.
        [LoggerMessage(Level = LogLevel.Error, EventId = 3, EventName = "GraphQLSubmitNoData",
            Message = "Submit-pipeline GraphQL call succeeded with no errors but no `data` object — server contract violation.")]
        internal static partial void GraphQLSubmitNoData(ILogger logger);
    }
}
```

- [ ] **Step 2: Move the three submit partials (verbatim bodies)**

Rename the files and change only the class name + headers — **method bodies stay byte-identical**:

1. `git mv PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewSubmitter.Submit.cs`
2. `git mv PRism.GitHub/GitHubReviewService.ReviewComments.cs PRism.GitHub/GitHubReviewSubmitter.ReviewComments.cs`
3. `git mv PRism.GitHub/GitHubReviewService.IssueComments.cs PRism.GitHub/GitHubReviewSubmitter.IssueComments.cs`

In each moved file:
- Change `public sealed partial class GitHubReviewService` → `internal sealed partial class GitHubReviewSubmitter`. (In `.Submit.cs` it's `public sealed partial class GitHubReviewService` at `:18`; the comment partials carry their own `partial class GitHubReviewService` line — change all three.)
- Keep the `using static PRism.GitHub.GitHubGraphQL;` + `using static PRism.GitHub.GitHubHttp;` lines added in Task 1 Step 6 (so `TryGetPath`/`Truncate` call sites stay byte-identical).
- **In `GitHubReviewSubmitter.Submit.cs`**, convert the two submit logger fields (`s_graphqlSubmitFailed` `:508-510`, `s_graphqlSubmitNoData` `:512-514`) — **delete them** (they're now `[LoggerMessage]` methods on the `Log` class in `GitHubReviewSubmitter.cs`, Step 1). Update their two call sites inside `PostSubmitGraphQLAsync`:
  - `s_graphqlSubmitFailed(_log, errors.GetArrayLength(), errorsJson, null);` → `Log.GraphQLSubmitFailed(_log, errors.GetArrayLength(), errorsJson);`
  - `s_graphqlSubmitNoData(_log, null);` → `Log.GraphQLSubmitNoData(_log);`

  These two lines are the **only** body edits permitted in the moved partials (the logging-style convergence). Everything else — the 7 pending-review methods, `PostSubmitGraphQLAsync`'s structure, `ResolvePullRequestNodeIdAsync`, `ProjectPendingReviewThread`, `ReadInt`, the comment-create methods — stays byte-identical.

- [ ] **Step 3: Drop `IReviewSubmitter` from `GitHubReviewService`**

In `GitHubReviewService.cs:11`:
```csharp
public sealed partial class GitHubReviewService : IPrDiscovery, IPrReader
```
(Remove `, IReviewSubmitter`.) Update the class-level doc comment if it enumerates the three interfaces.

- [ ] **Step 4: Build (tests still red — expected)**

```
dotnet build PRism.GitHub/PRism.GitHub.csproj --configuration Release
```
Expected: 0 warnings, 0 errors. (Production compiles; the **test** project won't until Task 4 — do not build/test the test project here.)

No commit yet — the tree is green for production but the test project references moved methods on `GitHubReviewService`. Tasks 3 + 4 land before the next commit.

---

## Task 3: Rebind `IReviewSubmitter` in DI + update XML-doc

**Files:** Modify `PRism.GitHub/ServiceCollectionExtensions.cs`

- [ ] **Step 1: Rebind the `IReviewSubmitter` alias**

Replace the one-line alias (`:79`):
```csharp
services.AddSingleton<IReviewSubmitter>(sp => sp.GetRequiredService<GitHubReviewService>());
```
with a dedicated `GitHubReviewSubmitter` singleton (mirrors the `GitHubReviewService` registration's late-binding: same `factory` / token closure / `config.Current.Github.Host`):
```csharp
// IReviewSubmitter is backed by its own GitHubReviewSubmitter (split out of
// GitHubReviewService in #321 PR2) — single-capability class. Same late-bound host + token
// closure as the reader registration; the submit path shares no mutable state with read.
services.AddSingleton<IReviewSubmitter>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubReviewSubmitter(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        config.Current.Github.Host,
        sp.GetRequiredService<ILogger<GitHubReviewSubmitter>>());
});
```
Leave the `IPrDiscovery`/`IPrReader` aliases (`:77-78`) and the `GitHubReviewService` singleton (`:54-64`) untouched. Leave the PR1 `IReviewAuth` → `GitHubAuthValidator` registration (`:67-76`) untouched. `IReviewSubmitter` is the only binding that moves.

- [ ] **Step 2: Update the `AddPrismGitHub` XML-doc summary**

In the `<summary>` (`:17-26`), change the `GitHubReviewService` clause to read "bound to the Reader+Discovery pairing (`<see cref="IPrDiscovery"/>`, `<see cref="IPrReader"/>`)" and add a clause "`<see cref="GitHubReviewSubmitter"/>` bound to `<see cref="IReviewSubmitter"/>`". Do not disturb the `GitHubAuthValidator`/`IReviewAuth` sentence.

- [ ] **Step 3: Build**

```
dotnet build PRism.GitHub/PRism.GitHub.csproj --configuration Release
```
Expected: 0 warnings, 0 errors.

---

## Task 4: Migrate tests + strengthen the byte-identity guard + security test

**Files:**
- Modify: `tests/PRism.GitHub.Tests/TestHelpers/GitHubReviewServiceFactory.cs`, the 8 submit/comment test files, `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs`
- Create: `tests/PRism.GitHub.Tests/GitHubGraphQLAuthHeaderTests.cs`

- [ ] **Step 1: Add `CreateSubmitter` to the test factory**

In `GitHubReviewServiceFactory.cs`, add (same wiring as `Create`, returning the submitter):
```csharp
    /// <summary>
    /// Canonical github.com wiring for <see cref="GitHubReviewSubmitter"/> — same fake
    /// transport, <c>api.github.com/</c> base, <c>https://github.com</c> host, <c>ghp_test</c>
    /// token as <see cref="Create"/>. Used by the submit/comment suites after the #321 PR2 split.
    /// </summary>
    public static GitHubReviewSubmitter CreateSubmitter(
        HttpMessageHandler handler,
        Func<Task<string?>>? readToken = null) =>
        new(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            readToken ?? (() => Task.FromResult<string?>("ghp_test")),
            "https://github.com");
```
Keep `Create` (read-path tests still use it).

- [ ] **Step 2: Swap the SUT helper type in all 8 submit/comment test files**

In each file below, change the helper's return type `GitHubReviewService` → `GitHubReviewSubmitter` and its body `GitHubReviewServiceFactory.Create(...)` → `GitHubReviewServiceFactory.CreateSubmitter(...)`. **No assertion changes** (same methods, same fakes). The eight files (verified by grepping for moved-method call sites; this is the confirmed complete set):
1. `GitHubReviewServiceSubmitBeginTests.cs` (`private static GitHubReviewService NewService(...)` `:13`)
2. `GitHubReviewServiceSubmitFinalizeTests.cs`
3. `GitHubReviewServiceSubmitAttachThreadTests.cs`
4. `GitHubReviewServiceSubmitAttachReplyTests.cs`
5. `GitHubReviewServiceSubmitDeleteTests.cs`
6. `GitHubReviewServiceSubmitFindOwnTests.cs`
7. `GitHubReviewServiceReviewCommentsContractTests.cs`
8. `GitHubReviewServiceIssueCommentsTests.cs`

For each, the edit is the `NewService` (or equivalently-named) helper only — e.g.:
```csharp
    private static GitHubReviewSubmitter NewService(HttpMessageHandler handler)
        => GitHubReviewServiceFactory.CreateSubmitter(handler);
```
(Test-class file names may stay as-is — renaming is discretionary churn, out of scope.)

**Before editing, re-confirm the set** — grep guards against drift since the spec was written:
```
# PowerShell — files whose helper returns GitHubReviewService AND call a moved method
Select-String -Path tests/PRism.GitHub.Tests/*.cs -Pattern "BeginPendingReviewAsync|AttachThreadAsync|AttachReplyAsync|FinalizePendingReviewAsync|DeletePendingReviewAsync|DeletePendingReviewThreadAsync|FindOwnPendingReviewAsync|CreateIssueCommentAsync|CreateReviewCommentAsync|CreateReviewCommentReplyAsync" |
  Select-Object -ExpandProperty Path -Unique
```
Expect the 8 files above + `GraphQlByteIdentityTests.cs` (handled in Step 3). If any other file appears, swap its SUT helper too and note the addition.

- [ ] **Step 3: Split `GraphQlByteIdentityTests` — re-point `SubmitPath`, strengthen the body assertion**

The two query-const facts (`PrDetailGraphQLQuery_is_byte_identical`, `TimelineQuery_is_byte_identical`) assert against `GitHubReviewService.PrDetailGraphQLQuery` / `.TimelineQuery` — **leave unchanged** (consts stay on the reader).

For `SubmitPath_graphql_request_transport_is_unchanged` (`:66`):
- Change `var svc = GitHubReviewServiceFactory.Create(handler);` (`:70`) → `var svc = GitHubReviewServiceFactory.CreateSubmitter(handler);`. The `FinalizePendingReviewAsync` call (`:72`) now resolves on `GitHubReviewSubmitter` — unchanged otherwise.
- **Keep all five existing assertions** (URI, UserAgent, Accept, no `X-GitHub-Api-Version`, Authorization parameter) — this is the B2 wire-identity guard; do not weaken it.
- **Add body assertions** (the transport move could drift `StringContent` media type/encoding or payload order, which the header-only assertions don't catch). The `CapturingHandler` captures `request` but not its body; **read the body INSIDE the handler, before returning the response** — `GitHubHttp.SendAsync` disposes the request (and its `Content`) when its frame unwinds, so reading `req.Content` after the `await` returns to the test would throw on disposed content. Edit `CapturingHandler.SendAsync` to read the content there, and assert in the test:

```csharp
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        public string? LastBody;
        public string? LastContentType;
        private readonly string _body;
        public CapturingHandler(string body) => _body = body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            LastContentType = request.Content?.Headers.ContentType?.ToString();
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(_body) };
        }
    }
```
(Note the signature changes to `async Task<...>` + `await`.) Then after the existing header asserts, add:
```csharp
        // Body byte-identity: the {query,variables} payload + media type must not drift in the
        // transport move (the header asserts above don't read req.Content). The expected literal
        // is the PRE-MOVE ground truth captured in Task 0 (PRE_MOVE_SUBMIT_BODY) — asserting the
        // post-move output equals it is a genuine before/after regression check.
        Assert.Equal("application/json; charset=utf-8", handler.LastContentType);
        Assert.Equal(PreMoveSubmitBody, handler.LastBody); // <- Task 0's recorded literal, pasted as a const
```

> **The expected literal comes from Task 0, NOT from this code's own output.** Paste Task 0's `PRE_MOVE_SUBMIT_BODY` (captured against the unmodified PR1 transport) as a `private const string PreMoveSubmitBody = "...";` on the test class, and assert the post-move `handler.LastBody` equals it. Do **not** "fill in on first green run" from the post-move output — that would echo whatever the moved code emits and lock in any drift. If the post-move output does not equal the Task 0 literal, the transport drifted: **investigate, do not update the literal.** This is the B2 body contract; the only legitimate way to change `PreMoveSubmitBody` is to re-run Task 0 on `origin/main`.

- [ ] **Step 4: Add the security header-attachment test for `GitHubGraphQL`**

Create `tests/PRism.GitHub.Tests/GitHubGraphQLAuthHeaderTests.cs`. It exercises `GitHubGraphQL.PostAsync` directly (internal, visible via InternalsVisibleTo) to prove the PAT same-host guard stays in the call chain — the grep proves no bare `http.SendAsync`, this proves the resulting behavior. Mirror the existing `GitHubReviewServiceAuthHeaderTests` shape.

```csharp
using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

// #321 PR2 security AC: GitHubGraphQL.PostAsync must route through GitHubHttp.SendAsync so the
// same-host PAT guard (GitHubHttp.ApplyHeaders) stays in the call chain — the Bearer token is
// attached on the trusted host and refused on an off-host absolute endpoint.
public class GitHubGraphQLAuthHeaderTests
{
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent("""{"data":{}}""") });
        }
    }

    [Fact]
    public async Task PostAsync_AttachesBearerToken_OnTrustedHost()
    {
        var handler = new CapturingHandler();
        var http = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")).CreateClient("github");

        await GitHubGraphQL.PostAsync(http, "ghp_test", "https://github.com",
            NullLogger.Instance, "query{viewer{login}}", new { }, CancellationToken.None);

        handler.Last!.Headers.Authorization!.Parameter.Should().Be("ghp_test");
        handler.Last.RequestUri!.ToString().Should().Be("https://api.github.com/graphql");
    }

    [Fact]
    public async Task PostAsync_RefusesToken_WhenHostResolvesOffBaseAddress()
    {
        // BaseAddress is api.github.com, but the GraphQL endpoint resolves from a host that does
        // NOT match it — the backstop against divergence between the two host resolvers
        // (HostUrlResolver.ApiBase sets BaseAddress; .GraphQlEndpoint sets the request URI, both
        // from the same operator-configured host). On mismatch the guard must throw, not leak the PAT.
        var handler = new CapturingHandler();
        var http = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")).CreateClient("github");

        Func<Task> act = () => GitHubGraphQL.PostAsync(http, "ghp_test", "https://evil.example.com",
            NullLogger.Instance, "query{viewer{login}}", new { }, CancellationToken.None);

        await act.Should().ThrowAsync<HttpRequestException>();
        handler.Last?.Headers.Authorization.Should().BeNull();
    }
}
```

> **Verify before trusting this test:** confirm `HostUrlResolver.GraphQlEndpoint("https://evil.example.com")` yields an absolute URL whose host ≠ `api.github.com` (so `ApplyHeaders` throws). If `FakeHttpClientFactory.CreateClient` always sets `BaseAddress` to the ctor URI regardless of name, this holds. If the resolved endpoint is somehow relative, the off-host precedent to mirror is **`GitHubHttpTests.SendAsync_off_host_absolute_url_with_token_throws`** (it exercises the `GitHubHttp.SendAsync` guard directly with an off-host absolute URL) — **not** `GitHubReviewServiceAuthHeaderTests`, which has only bearer-present/null-token cases and no off-host case. Adjust the expected `RequestUri` if `GraphQlEndpoint("https://github.com")` differs from `https://api.github.com/graphql` — read `HostUrlResolver.GraphQlEndpoint` and pin the actual value.

- [ ] **Step 5: Build + full GitHub.Tests green**

```
dotnet build tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --configuration Release
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --no-build --configuration Release --settings .runsettings
```
Expected: all green. If `GraphQlByteIdentityTests.SubmitPath` fails on the body assertion, the post-move output does not equal Task 0's `PRE_MOVE_SUBMIT_BODY` — the transport **drifted**. Investigate and fix the move; do **not** update the literal to match the drifted output.

- [ ] **Step 6: Commit (Tasks 2–4 green checkpoint)**

```
git add -A
git commit -F - <<'EOF'
refactor(github): split IReviewSubmitter into GitHubReviewSubmitter (#321)

Move the three submit partials (pending-review pipeline + comment-create) to a
new internal sealed GitHubReviewSubmitter, bodies byte-identical except the two
submit logger call sites (Define -> [LoggerMessage], EventId 2,3 preserved).
GitHubReviewService is now the documented Reader+Discovery pairing. DI rebinds
only IReviewSubmitter. Tests: add CreateSubmitter, swap SUT type across the 8
submit/comment suites, re-point + strengthen the SubmitPath byte-identity guard
to pin the request body, add a GitHubGraphQL PAT-guard header test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Fold-in 1 — `IsDnsFailure` reads the inner `SocketException`'s message

**Files:**
- Create: `tests/PRism.GitHub.Tests/GitHubAuthValidatorDnsFailureTests.cs`
- Modify: `PRism.GitHub/GitHubAuthValidator.cs`

This is the one genuine behavior change — test-first.

- [ ] **Step 1: Write the failing two-case test**

Create `GitHubAuthValidatorDnsFailureTests.cs`. `IsDnsFailure` is `private static` — exercise it through the public surface that uses it (`ValidateCredentialsAsync`'s `catch (HttpRequestException ex) when (IsDnsFailure(ex))` arm, `:90-93`), mirroring the existing DNS test in `GitHubReviewService_ValidateCredentialsAsyncTests`. The SUT must throw an `HttpRequestException` whose inner `SocketException` carries the message. **Read the existing validate-credentials test first** to copy its exact construction (factory, handler that throws the crafted exception, assertion on `AuthValidationError.DnsError`); replicate its harness, then add the two cases:

```csharp
// Case 1 — SocketErrorCode == HostNotFound (mirrors the existing test): DnsError via the
//          primary-path guard, regardless of which message string is read.
// Case 2 — SocketErrorCode is NON-HostNotFound (SocketError.TryAgain), the "No such host"
//          string present ONLY on se.Message, ex.Message neutral: DnsError ONLY when the code
//          reads se.Message. This is the case that pins fold-in 1.
```
Construct the exceptions:
```csharp
// Case 1
new HttpRequestException("anything", new SocketException((int)SocketError.HostNotFound));
// Case 2
new HttpRequestException(
    "connection failed",                                   // neutral wrapper message
    new SocketException((int)SocketError.TryAgain, "No such host is known"));
```
Assert both classify as `AuthValidationError.DnsError`.

> **Match the existing harness exactly** — the validate path makes a live HTTP call that must throw the crafted `HttpRequestException` at the transport. Read `GitHubReviewService_ValidateCredentialsAsyncTests` (the DNS test) and reuse its fake-handler mechanism (a handler whose `SendAsync` throws the supplied exception) and the `GitHubAuthValidator` construction (3-arg ctor, no logger — per PR1). Do not invent a new harness.

- [ ] **Step 2: Run the new test — Case 2 fails**

```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --configuration Release --settings .runsettings --filter "FullyQualifiedName~GitHubAuthValidatorDnsFailureTests"
```
Expected: Case 1 passes (HostNotFound branch), **Case 2 fails** (current code reads `ex.Message`, which is the neutral "connection failed").

- [ ] **Step 3: Apply the fix**

In `GitHubAuthValidator.cs:110-119`, change the two string checks from `ex.Message` to `se.Message`:
```csharp
    private static bool IsDnsFailure(HttpRequestException ex)
    {
        if (ex.InnerException is SocketException se)
        {
            return se.SocketErrorCode == SocketError.HostNotFound
                || se.Message.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)
                || se.Message.Contains("No such host", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }
```

- [ ] **Step 4: Run the test — both pass**

```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --configuration Release --settings .runsettings --filter "FullyQualifiedName~GitHubAuthValidatorDnsFailureTests"
```
Expected: both cases pass.

- [ ] **Step 5: Commit fold-in 1 on its own**

```
git add PRism.GitHub/GitHubAuthValidator.cs tests/PRism.GitHub.Tests/GitHubAuthValidatorDnsFailureTests.cs
git commit -F - <<'EOF'
fix(github): IsDnsFailure reads the inner SocketException message (#321)

The "Name or service not known" / "No such host" strings originate on the inner
SocketException, not the HttpRequestException wrapper. On platforms where the
wrapper message differs, a non-HostNotFound DNS error was misclassified as a
generic NetworkError. Read se.Message for both fallback checks. Regression test
pins the non-HostNotFound case. Folded into PR2 per owner; isolated commit so
the behavior line is separable from the mechanical submit split.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Full verification gate

**No code changes** — the pre-push gates. One build/test at a time, foreground, timeout ≥ 300000ms.

- [ ] **Step 1: Full-solution build (0 warnings)**

```
dotnet build --configuration Release
```
Expected: 0 warnings (`TreatWarningsAsErrors`), 0 errors. Catches DI/accessibility/downstream breaks and any within-class EventId-duplicate generator error.

- [ ] **Step 2: Backend test suites (all green)**

Run each, one at a time:
```
dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --no-build --configuration Release --settings .runsettings
dotnet test tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj --no-build --configuration Release --settings .runsettings
dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --no-build --configuration Release --settings .runsettings
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --no-build --configuration Release --settings .runsettings
```
Expected: all green. `PRism.GitHub.Tests.Integration` includes the read-side shape-drift test; `PRism.Web.Tests` exercises the submit/comment endpoints through `IReviewSubmitter` fakes (transparent to the rebind). The `SubmitPath_graphql_request_transport_is_unchanged` byte-identity fact must be green (the B2 contract). (Confirm the exact project paths via `Glob` if any path differs.)

**Gate — confirm the body pin is a real `Assert.Equal`, not a `NotNull`:** open `GraphQlByteIdentityTests.cs` and verify `SubmitPath` asserts `Assert.Equal(PreMoveSubmitBody, handler.LastBody)` against Task 0's recorded literal (plus the `application/json; charset=utf-8` content-type). A surviving `Assert.NotNull(handler.LastBody)` without the `Equal` means the B2 body contract is unpinned — the PR is not ready.

- [ ] **Step 3: AC-verification greps**

```
# "one logging style" AC's verifiable form — must be empty:
Select-String -Path PRism.GitHub/*.cs -Pattern "LoggerMessage\.Define"
# Security AC — two complementary greps (a naive `http\.SendAsync` grep is INERT: Select-String
# is case-insensitive by default and the literal dot matches the substring inside
# `GitHubHttp.SendAsync`, so it can neither confirm the guarded call nor isolate a bare bypass):
#   (a) the guarded call MUST be present (>= 1 match):
Select-String -Path PRism.GitHub/GitHubGraphQL.cs -Pattern "GitHubHttp\.SendAsync" -CaseSensitive
#   (b) a BARE raw send (not prefixed by GitHubHttp) MUST be absent (0 matches):
Select-String -Path PRism.GitHub/GitHubGraphQL.cs -Pattern "(?<!GitHubHttp)\bhttp\.SendAsync" -CaseSensitive
```
Expected: the first (LoggerMessage.Define) returns nothing; grep (a) returns ≥ 1 (the guarded call exists); grep (b) returns nothing (no bare `http.SendAsync`). The `GitHubGraphQLAuthHeaderTests` off-host-throw test (Task 4 Step 4) is the **primary** behavioral backstop — cite it first in the PR Proof; these greps are the secondary static guard.

- [ ] **Step 4: Byte-identity diff review**

```
git diff origin/main -- PRism.GitHub/GitHubReviewSubmitter.Submit.cs PRism.GitHub/GitHubReviewSubmitter.ReviewComments.cs PRism.GitHub/GitHubReviewSubmitter.IssueComments.cs
```
Confirm the only differences vs the PR1 partials are: the class name (`GitHubReviewService` → `GitHubReviewSubmitter`), the two `using static` header lines, and the two submit logger call-site conversions in `.Submit.cs`. Any other body change is a regression — investigate.

- [ ] **Step 5: `/simplify` before raising the PR**

Run `/simplify` scoped to this branch's diff vs `origin/main` (it edits the tree; run before the PR). Apply genuine clarity/reuse/dead-code findings introduced by **this** diff (e.g. a now-unused `using`, the `using static GitHubHttp` if `Truncate` is unused in the reader). Do **not** accept anything that re-litigates the owner-approved split or touches a byte-identical body. Commit any cleanup separately, then re-run Steps 1–2 to confirm still green.

---

## Self-review checklist (run after writing, before handoff)

- **Spec coverage:** Split `IReviewSubmitter` (T2), shared transport (T1), shared helpers (T1), logging convergence + EventId pin across 3 touched classes (T1 reader + T2 submitter + T1 graphql), fold-in 1 (T5), `ParseFileChanges` stays (not touched — correct), DI rebind only `IReviewSubmitter` (T3), all 8 test files + `GraphQlByteIdentityTests` split + body strengthen + security test (T4), full verification (T6). ✔ all mapped.
- **Type/name consistency:** `GitHubGraphQL.PostAsync(http, token, host, log, query, variables, ct)` — same signature used in both thin wrappers (T1 reader, T2 submitter) and the security test (T4). `GitHubHttp.Truncate` (T1) used by `GitHubGraphQL.PostAsync` (T1) + comment partials (T2, via `using static`). `CreateSubmitter` returns `GitHubReviewSubmitter` (T4) — matches the SUT-helper return type swaps. `Log.GraphQL{Read,Submit,Transport}*` method names consistent across call-site updates. ✔
- **No placeholders:** the `GraphQlByteIdentityTests` body literal is captured from the **pre-move** tree (Task 0) and asserted as an `Assert.Equal(PreMoveSubmitBody, …)` in T4 Step 3 — a before/after regression pin, not a self-derived echo and not a TODO. ✔
- **Byte-identity honesty:** `using static` + thin same-named wrappers keep moved bodies literally byte-identical except the two enumerated logger lines — the T6 Step 4 diff review enforces it. ✔
