# Checks Tab Per-Check Re-run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-check "Re-run" action to the read-only Checks tab that re-triggers a GitHub check-run via the `rerequest` API, with a server-side SHA guard and bounded poll-convergence.

**Architecture:** A new write path (`IPrChecksRerunner` → `GitHubPrChecksRerunner` → `POST /api/pr/{o}/{r}/{n}/checks/{checkRunId}/rerun?sha=`) sits alongside the untouched read path. The backend SHA-guards (GETs the check-run, compares `head_sha`) before rerequesting; a dedicated `RerunOutcome` enum carries the result. The frontend adds a Re-run button to `CheckDetail` and an armed, visible-time "rerun-watch" in `useCheckRuns` that keeps the poll alive (GitHub does not reset the individual check-run on rerequest).

**Tech Stack:** .NET 10 minimal APIs, System.Text.Json, raw `HttpClient` (no Octokit) for GitHub; React 18 + Vite + TypeScript + vitest/Testing-Library; xUnit for backend.

**Spec:** `docs/specs/2026-06-26-checks-rerun-design.md` (T3, gated B2).

## Global Constraints

- **Enums are kebab-case on the wire** — serialized via `JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())` (in `JsonSerializerOptionsFactory.Api`). C# `NotRerunnable` → wire `not-rerunnable`. FE union members must match exactly.
- **GitHub HTTP goes through `GitHubHttp.SendAsync(http, method, url, token, ct, content?, accept?, apiVersion?)`** on the `"github"` named `HttpClient`; token via the `Func<Task<string?>>` closure; call `GitHubHttp.ThrowIfRateLimited(resp)` after each response. Mirror `GitHubPrChecksReader` exactly.
- **Endpoint validation order:** owner/repo (`SharedRegexes.OwnerRepo()`) before query `sha` (`IsValidGitOid`); each failure → `Results.Problem(statusCode: 422)`. Mirror the GET checks endpoint.
- **`CheckDto.CheckRunId` is `long?` and nullable** — non-null only for `source == "check-run"`; `null` for legacy `status`. Additive, optional wire field.
- **Do NOT reuse `GitHubPrChecksReader.DegradedFor`** on the write path — the write path has its own status→`RerunOutcome` mapping (rerequest's 403/422 are overloaded).
- **`refetch()` uses a reactive `useState` nonce** added to the polling effect's dep array — never a ref, never `retry()` (which flashes `loading`).
- **TDD throughout:** failing test → run-red → minimal impl → run-green → commit. Run backend tests with `& 'C:\Program Files\dotnet\dotnet.exe' test`; FE tests with the local vitest binary (NOT `npx vitest`).

---

### Task 1: Wire-shape — `CheckDto.CheckRunId` end-to-end

**Files:**
- Modify: `PRism.Core.Contracts/CheckDto.cs` (add field)
- Modify: `PRism.GitHub/GitHubPrChecksReader.cs` (populate in `ReadCheckRunsAsync`; `null` in `ReadStatusesAsync`)
- Modify: `PRism.Web/TestHooks/FakePrChecksReader.cs` (add ids to the 3 rows)
- Modify: `frontend/src/api/types.ts` (add to `CheckRun`)
- Test: `tests/PRism.GitHub.Tests/GitHubPrChecksReaderTests.cs` (add assertions)
- Modify (FE — existing `CheckRun` literals break once the field is required; Step 6b):
  - `frontend/src/hooks/useCheckRuns.test.ts` (~10 inline `CheckRun` literals)
  - `frontend/src/components/PrDetail/checksGlyphState.test.ts` (`run` factory, line ~5)
  - `frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx` (`run` factory, line ~11)
  - `frontend/src/components/PrDetail/PrDetailView.test.tsx` (the `inProgress` `CheckRun` literal, line ~352)

> **Why `checkRunId` is required (not `checkRunId?:`):** `CheckRun` is the FE mirror of the
> `CheckDto` wire record; modeling a wire field optional understates the contract and lets
> a Playwright `route.fulfill` JSON / `as any` fixture omit it silently (typed FE mocks would
> stop catching the gap). The 4 files above are exactly the `CheckRun`-constructing test
> files, so the churn is confined and the `tsc -b` gate (Step 7) names any miss.

**Interfaces:**
- Produces: `CheckDto(..., long? CheckRunId)` (last positional param); FE `CheckRun.checkRunId: number | null`.

- [ ] **Step 1: Write the failing test** — add to `GitHubPrChecksReaderTests.cs` (alongside the existing `Reads_check_runs_and_legacy_statuses_into_one_list`):

```csharp
    [Fact]
    public async Task Populates_CheckRunId_from_check_run_id_and_null_for_legacy_status()
    {
        var reader = ReaderFor(req =>
        {
            if (req.RequestUri!.AbsolutePath.EndsWith("/check-runs", StringComparison.Ordinal))
                return Json(
                    """{"check_runs":[{"id":987654321,"name":"build","status":"completed","conclusion":"success"}]}""");
            return Json(
                """{"state":"failure","total_count":1,"statuses":[{"context":"ci/legacy","state":"failure"}]}""");
        });

        var resp = await reader.ReadAsync(Pr, Sha, CancellationToken.None);

        var run = Assert.Single(resp.Checks, c => c.Source == "check-run");
        Assert.Equal(987654321L, run.CheckRunId);
        var status = Assert.Single(resp.Checks, c => c.Source == "status");
        Assert.Null(status.CheckRunId);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~Populates_CheckRunId"`
Expected: FAIL — compile error, `CheckDto` has no `CheckRunId` member.

- [ ] **Step 3: Add the field to `CheckDto`** — append a new positional parameter (keep the existing doc-comment style):

```csharp
public sealed record CheckDto(
    string Name,
    CheckRunStatus Status,
    CheckConclusion? Conclusion,
    string Source,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    string? DetailsUrl,
    string? Summary,
    string? Body,
    string? AppName,
    long? CheckRunId);            // check-run "id"; null for legacy status (no rerun API)
```

- [ ] **Step 4: Populate it in the reader** — in `GitHubPrChecksReader.ReadCheckRunsAsync`, extend the `new CheckDto(...)` with the id; in `ReadStatusesAsync`, pass `null`.

In `ReadCheckRunsAsync` (add as the last argument of the `checks.Add(new CheckDto(...))`):
```csharp
                    AppName: NestedStringProp(r, "app", "name"),
                    CheckRunId: r.TryGetProperty("id", out var idEl)
                        && idEl.ValueKind == JsonValueKind.Number
                        && idEl.TryGetInt64(out var id)
                        ? id
                        : null));
```

In `ReadStatusesAsync` (last argument of its `checks.Add(new CheckDto(...))`):
```csharp
                        AppName: null,
                        CheckRunId: null)); // legacy status has no check-run id / rerun API
```

- [ ] **Step 5: Fix the `FakePrChecksReader` construction** — append `CheckRunId:` to each of the 3 rows so it compiles and the e2e fake exercises the enabled button. (Deliberate deviation from the spec's "add a status-source row": we keep the existing 3 check-run rows to avoid churning e2e visual baselines; the disabled-for-status path is covered by the FE unit test in Task 6.)

```csharp
            new("build", CheckRunStatus.Completed, CheckConclusion.Failure, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
                DateTimeOffset.Parse("2026-06-25T10:02:10Z", System.Globalization.CultureInfo.InvariantCulture),
                "https://github.com/o/r/runs/1",
                Summary: "2 errors, 0 warnings",
                Body: "### Build failed\n\n- `src/Calc.cs(12)`: CS1002 expected `;`\n- `src/Calc.cs(40)`: CS0103 name not found",
                AppName: "GitHub Actions",
                CheckRunId: 1001),
            new("lint", CheckRunStatus.InProgress, null, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:05Z", System.Globalization.CultureInfo.InvariantCulture),
                null,
                "https://github.com/o/r/runs/2",
                Summary: "Running eslint...",
                Body: "Running eslint over 42 files...",
                AppName: "GitHub Actions",
                CheckRunId: 1002),
            new("test", CheckRunStatus.Completed, CheckConclusion.Success, "check-run",
                DateTimeOffset.Parse("2026-06-25T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
                DateTimeOffset.Parse("2026-06-25T10:00:45Z", System.Globalization.CultureInfo.InvariantCulture),
                "https://github.com/o/r/runs/3",
                Summary: "128 passed",
                Body: "**128 passed**, 0 failed in 41s.",
                AppName: "CircleCI",
                CheckRunId: 1003),
```

- [ ] **Step 6: Add the FE type field** — in `frontend/src/api/types.ts`, add to the `CheckRun` interface (after `appName`):

```typescript
export interface CheckRun {
  name: string;
  status: CheckRunStatus;
  conclusion: CheckConclusion | null;
  source: 'check-run' | 'status';
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  summary: string | null;
  appName: string | null;
  body: string | null;
  checkRunId: number | null; // check-run id for re-run; null for legacy status
}
```

- [ ] **Step 6b: Update existing `CheckRun` test literals** — making the field required breaks every existing `CheckRun` object that omits it (TS2741). Add `checkRunId` to each:

  - `frontend/src/components/PrDetail/checksGlyphState.test.ts` — in the `run` factory default (after `body: null,`), add `checkRunId: null,`. (Glyph derivation never reads it; `null` keeps these literals honest as "value not under test".)
  - `frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx` — in the `run` factory default (after `body: null,`), add `checkRunId: 1,`. A numeric id makes the factory's default row **rerun-eligible** so Task 6's enabled-button test can use it without extra setup; the status-source and non-completed rows in Task 6 override it explicitly.
  - `frontend/src/hooks/useCheckRuns.test.ts` — these tests build ~10 inline `CheckRun` literals (no shared factory). Add `checkRunId: null,` after the `body: null,` line of **each** one. None of these tests arm a rerun-watch, so the value is irrelevant — `null` is fine and type-valid. (Run `tsc -b` to enumerate any missed literal by line number.)
  - `frontend/src/components/PrDetail/PrDetailView.test.tsx` — in the `inProgress` constant's single `CheckRun` literal (the object inside `checks: [ … ]`, line ~352), add `checkRunId: null,` after `body: null,`. (Do **not** touch the surrounding `CheckRunsResult` literals here — those gain their new members in Task 5, which keeps them optional.)

- [ ] **Step 7: Run tests to verify green**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~Populates_CheckRunId"`
Expected: PASS.
Run: `& 'C:\Program Files\dotnet\dotnet.exe' build PRism.Web` — Expected: builds (FakePrChecksReader compiles).
Run (FE typecheck): `cd frontend; ./node_modules/.bin/tsc -b` — Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core.Contracts/CheckDto.cs PRism.GitHub/GitHubPrChecksReader.cs PRism.Web/TestHooks/FakePrChecksReader.cs frontend/src/api/types.ts tests/PRism.GitHub.Tests/GitHubPrChecksReaderTests.cs frontend/src/hooks/useCheckRuns.test.ts frontend/src/components/PrDetail/checksGlyphState.test.ts frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx frontend/src/components/PrDetail/PrDetailView.test.tsx
git commit -m "feat(#636): add CheckDto.CheckRunId (wire-shape for re-run)"
```

---

### Task 2: Backend write service — `RerunOutcome`, `RerunResultDto`, `IPrChecksRerunner`, `GitHubPrChecksRerunner`

**Files:**
- Create: `PRism.Core.Contracts/RerunOutcome.cs`, `PRism.Core.Contracts/RerunResultDto.cs`
- Create: `PRism.Core/IPrChecksRerunner.cs`
- Create: `PRism.GitHub/GitHubPrChecksRerunner.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (DI)
- Test: `tests/PRism.GitHub.Tests/GitHubPrChecksRerunnerTests.cs`

**Interfaces:**
- Produces: `RerunOutcome` (`Accepted|Auth|NotRerunnable|Superseded|Transient`); `RerunResultDto(RerunOutcome Outcome)`; `IPrChecksRerunner.RerunAsync(PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct)`.
- Consumes: `GitHubHttp.SendAsync`/`ThrowIfRateLimited`, the `"github"` named client (Task-independent; already exists).

- [ ] **Step 1: Write the failing tests** — `tests/PRism.GitHub.Tests/GitHubPrChecksRerunnerTests.cs`:

```csharp
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubPrChecksRerunnerTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef01234567";
    private static readonly PrReference Pr = new("o", "r", 1);
    private const long CheckRunId = 555;

    // Records each request path so a test can assert the rerequest POST did / did not fire.
    private sealed class Recorder
    {
        public readonly System.Collections.Generic.List<(HttpMethod Method, string Path)> Calls = new();
    }

    private static (GitHubPrChecksRerunner Rerunner, Recorder Rec) RerunnerFor(
        Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var rec = new Recorder();
        var rerunner = new GitHubPrChecksRerunner(
            new FakeHttpClientFactory(
                new FakeHttpMessageHandler(req =>
                {
                    rec.Calls.Add((req.Method, req.RequestUri!.AbsolutePath));
                    return respond(req);
                }),
                new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("tok"));
        return (rerunner, rec);
    }

    private static HttpResponseMessage Json(HttpStatusCode code, string body) =>
        new(code) { Content = new StringContent(body) };

    private static bool IsGet(HttpRequestMessage r) => r.Method == HttpMethod.Get;

    [Fact]
    public async Task Matching_head_sha_reruns_and_returns_accepted()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            IsGet(req)
                ? Json(HttpStatusCode.OK, $$"""{"id":{{CheckRunId}},"head_sha":"{{Sha}}"}""")
                : Json(HttpStatusCode.Created, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Accepted, result.Outcome);
        Assert.Contains(rec.Calls, c => c.Method == HttpMethod.Post && c.Path.EndsWith("/rerequest", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Mismatched_head_sha_returns_superseded_and_does_NOT_rerequest()
    {
        var (rerunner, rec) = RerunnerFor(req =>
            Json(HttpStatusCode.OK, """{"id":555,"head_sha":"ffffffffffffffffffffffffffffffffffffffff"}"""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Superseded, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, RerunOutcome.Auth)]
    [InlineData(HttpStatusCode.Forbidden, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.NotFound, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.UnprocessableEntity, RerunOutcome.NotRerunnable)]
    [InlineData(HttpStatusCode.InternalServerError, RerunOutcome.Transient)]
    public async Task Get_failure_maps_to_outcome_without_rerequest(HttpStatusCode code, RerunOutcome expected)
    {
        var (rerunner, rec) = RerunnerFor(_ => Json(code, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(expected, result.Outcome);
        Assert.DoesNotContain(rec.Calls, c => c.Method == HttpMethod.Post);
    }

    [Fact]
    public async Task Rerequest_500_maps_to_transient()
    {
        var (rerunner, _) = RerunnerFor(req =>
            IsGet(req)
                ? Json(HttpStatusCode.OK, $$"""{"id":555,"head_sha":"{{Sha}}"}""")
                : Json(HttpStatusCode.InternalServerError, ""));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Transient, result.Outcome);
    }

    [Fact]
    public async Task Network_exception_maps_to_transient()
    {
        var rerunner = new GitHubPrChecksRerunner(
            new FakeHttpClientFactory(
                new FakeHttpMessageHandler(_ => throw new HttpRequestException("boom")),
                new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("tok"));

        var result = await rerunner.RerunAsync(Pr, CheckRunId, Sha, CancellationToken.None);

        Assert.Equal(RerunOutcome.Transient, result.Outcome);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubPrChecksRerunnerTests"`
Expected: FAIL — `RerunOutcome`, `RerunResultDto`, `IPrChecksRerunner`, `GitHubPrChecksRerunner` don't exist.

- [ ] **Step 3: Create the contracts** — `PRism.Core.Contracts/RerunOutcome.cs`:

```csharp
namespace PRism.Core.Contracts;

/// <summary>Outcome of a per-check re-run. Kebab-case on the wire
/// (accepted | auth | not-rerunnable | superseded | transient).</summary>
public enum RerunOutcome
{
    Accepted,       // rerequest sent (GitHub 2xx)
    Auth,           // GitHub 401 — couldn't authenticate
    NotRerunnable,  // GitHub 403/404/422 — not re-runnable or token lacks write access
    Superseded,     // SHA guard: the head advanced since the poll; no rerequest sent
    Transient,      // 5xx / network — retryable
}
```

`PRism.Core.Contracts/RerunResultDto.cs`:
```csharp
namespace PRism.Core.Contracts;

public sealed record RerunResultDto(RerunOutcome Outcome);
```

`PRism.Core/IPrChecksRerunner.cs`:
```csharp
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Contracts;

namespace PRism.Core;

public interface IPrChecksRerunner
{
    /// <param name="expectedHeadSha">The SHA the check-run was read under; a mismatch
    /// (the head advanced since the poll) returns <see cref="RerunOutcome.Superseded"/>
    /// without rerequesting.</param>
    Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct);
}
```

- [ ] **Step 4: Create `GitHubPrChecksRerunner`** — `PRism.GitHub/GitHubPrChecksRerunner.cs`:

```csharp
using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

/// <summary>Write path for the Checks tab: SHA-guard then rerequest a check-run.
/// Mirrors GitHubPrChecksReader's HTTP/token substrate but owns its status→outcome
/// map (do NOT reuse the reader's DegradedFor — rerequest's 403/422 are overloaded).</summary>
public sealed class GitHubPrChecksRerunner : IPrChecksRerunner
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;

    public GitHubPrChecksRerunner(IHttpClientFactory httpFactory, Func<Task<string?>> readToken)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
    }

    public async Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");

        try
        {
            // 1) SHA guard — GET the check-run, compare head_sha. A stale-but-completed id
            //    would otherwise 2xx-rerun the superseded commit's check (a silent wrong-action).
            var getUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}";
            using var getResp = await GitHubHttp.SendAsync(http, HttpMethod.Get, getUrl, token, ct).ConfigureAwait(false);
            GitHubHttp.ThrowIfRateLimited(getResp);
            if (!getResp.IsSuccessStatusCode)
                return new RerunResultDto(OutcomeFor(getResp.StatusCode));

            var body = await getResp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            var headSha = doc.RootElement.TryGetProperty("head_sha", out var hs)
                && hs.ValueKind == JsonValueKind.String ? hs.GetString() : null;
            if (!string.Equals(headSha, expectedHeadSha, StringComparison.OrdinalIgnoreCase))
                return new RerunResultDto(RerunOutcome.Superseded);

            // 2) Rerequest — no body (GitHub takes no parameters).
            var postUrl = $"repos/{pr.Owner}/{pr.Repo}/check-runs/{checkRunId}/rerequest";
            using var postResp = await GitHubHttp.SendAsync(http, HttpMethod.Post, postUrl, token, ct).ConfigureAwait(false);
            GitHubHttp.ThrowIfRateLimited(postResp);
            return new RerunResultDto(
                postResp.IsSuccessStatusCode ? RerunOutcome.Accepted : OutcomeFor(postResp.StatusCode));
        }
        catch (HttpRequestException)
        {
            return new RerunResultDto(RerunOutcome.Transient);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new RerunResultDto(RerunOutcome.Transient); // request timeout, not a user cancel
        }
    }

    // Write-path mapping (distinct from the reader's DegradedFor): 401 = auth;
    // 403/404/422 = not-rerunnable (overloaded — scope OR not-rerunnable state);
    // everything else = transient.
    private static RerunOutcome OutcomeFor(HttpStatusCode code) => code switch
    {
        HttpStatusCode.Unauthorized => RerunOutcome.Auth,
        HttpStatusCode.Forbidden => RerunOutcome.NotRerunnable,
        HttpStatusCode.NotFound => RerunOutcome.NotRerunnable,
        HttpStatusCode.UnprocessableEntity => RerunOutcome.NotRerunnable,
        _ => RerunOutcome.Transient,
    };
}
```

- [ ] **Step 5: Register in DI** — in `PRism.GitHub/ServiceCollectionExtensions.cs`, immediately after the `AddSingleton<IPrChecksReader>(...)` block, add:

```csharp
        services.AddSingleton<IPrChecksRerunner>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubPrChecksRerunner(
                factory,
                () => tokens.ReadAsync(CancellationToken.None));
        });
```

- [ ] **Step 6: Run tests to verify green**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubPrChecksRerunnerTests"`
Expected: PASS (all 5 facts/theories, 9 cases).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core.Contracts/RerunOutcome.cs PRism.Core.Contracts/RerunResultDto.cs PRism.Core/IPrChecksRerunner.cs PRism.GitHub/GitHubPrChecksRerunner.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/GitHubPrChecksRerunnerTests.cs
git commit -m "feat(#636): GitHubPrChecksRerunner with SHA guard + rerequest"
```

---

### Task 3: Rerun endpoint + `FakePrChecksRerunner`

**Files:**
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs` (add `MapPost` rerun route)
- Create: `PRism.Web/TestHooks/FakePrChecksRerunner.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/ChecksRerunEndpointTests.cs`

**Interfaces:**
- Consumes: `IPrChecksRerunner` (Task 2), `SharedRegexes.OwnerRepo()`, `IsValidGitOid` (existing private in PrDetailEndpoints).
- Produces: `POST /api/pr/{owner}/{repo}/{number:int}/checks/{checkRunId:long}/rerun?sha=<headSha>` → `200` + `RerunResultDto`.

- [ ] **Step 1: Write the failing tests** — `tests/PRism.Web.Tests/Endpoints/ChecksRerunEndpointTests.cs`:

```csharp
using System;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Web.TestHooks;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class ChecksRerunEndpointTests : IClassFixture<PRismWebApplicationFactory>
{
    private const string Sha = "0123456789abcdef0123456789abcdef01234567";
    private readonly PRismWebApplicationFactory _base;

    public ChecksRerunEndpointTests(PRismWebApplicationFactory baseFactory) => _base = baseFactory;

    private WebApplicationFactory<Program> FactoryWith(RerunOutcome outcome) =>
        _base.WithWebHostBuilder(b => b.ConfigureServices(s =>
        {
            s.RemoveAll<IPrChecksRerunner>();
            s.AddSingleton<IPrChecksRerunner>(new FakePrChecksRerunner { Outcome = outcome });
        }));

    [Fact]
    public async Task Accepted_outcome_returns_200_with_kebab_body()
    {
        var client = FactoryWith(RerunOutcome.Accepted).CreateAuthenticatedClient();
        var resp = await client.PostAsync(
            new Uri($"/api/pr/octo/repo/1/checks/555/rerun?sha={Sha}", UriKind.Relative), null);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var dto = await resp.Content.ReadFromJsonAsync<RerunResultDto>(
            PRism.Core.Json.JsonSerializerOptionsFactory.Api);
        Assert.Equal(RerunOutcome.Accepted, dto!.Outcome);
        // kebab wire check
        var raw = await (await FactoryWith(RerunOutcome.NotRerunnable).CreateAuthenticatedClient()
            .PostAsync(new Uri($"/api/pr/octo/repo/1/checks/555/rerun?sha={Sha}", UriKind.Relative), null))
            .Content.ReadAsStringAsync();
        Assert.Contains("not-rerunnable", raw, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("bad..owner", "repo", Sha)]
    [InlineData("octo", "repo", "")]
    [InlineData("octo", "repo", "not-a-sha")]
    public async Task Invalid_params_return_422(string owner, string repo, string sha)
    {
        var client = FactoryWith(RerunOutcome.Accepted).CreateAuthenticatedClient();
        var url = $"/api/pr/{owner}/{repo}/1/checks/555/rerun?sha={sha}";
        var resp = await client.PostAsync(new Uri(url, UriKind.Relative), null);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, resp.StatusCode);
    }
}
```

(`Sha` in `[InlineData]` references the const — if the analyzer rejects a const in an attribute from a non-literal, inline the 40-char literal in the three rows.)

- [ ] **Step 2: Run to verify it fails**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter "FullyQualifiedName~ChecksRerunEndpointTests"`
Expected: FAIL — `FakePrChecksRerunner` missing; route returns 404.

- [ ] **Step 3: Create the fake** — `PRism.Web/TestHooks/FakePrChecksRerunner.cs`:

```csharp
using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

/// <summary>Deterministic rerun double for endpoint tests. Returns a settable outcome.</summary>
internal sealed class FakePrChecksRerunner : IPrChecksRerunner
{
    public RerunOutcome Outcome { get; set; } = RerunOutcome.Accepted;

    public Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct) =>
        Task.FromResult(new RerunResultDto(Outcome));
}
```

- [ ] **Step 4: Add the endpoint** — in `PRism.Web/Endpoints/PrDetailEndpoints.cs`, directly after the `MapGet(".../checks", ...)` block:

```csharp
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/checks/{checkRunId:long}/rerun",
            async (string owner, string repo, int number, long checkRunId,
                   [FromQuery] string? sha,
                   IPrChecksRerunner rerunner, CancellationToken ct) =>
            {
                if (!SharedRegexes.OwnerRepo().IsMatch(owner) || !SharedRegexes.OwnerRepo().IsMatch(repo))
                    return Results.Problem(type: "/owner-repo/invalid", statusCode: 422);
                if (string.IsNullOrEmpty(sha))
                    return Results.Problem(type: "/checks/missing-sha", statusCode: 422);
                if (!IsValidGitOid(sha))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var result = await rerunner.RerunAsync(prRef, checkRunId, sha, ct).ConfigureAwait(false);
                return Results.Ok(result); // ambient API JsonSerializerOptions → kebab enum
            });
```

- [ ] **Step 5: Run tests to verify green**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter "FullyQualifiedName~ChecksRerunEndpointTests"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/PrDetailEndpoints.cs PRism.Web/TestHooks/FakePrChecksRerunner.cs tests/PRism.Web.Tests/Endpoints/ChecksRerunEndpointTests.cs
git commit -m "feat(#636): POST checks/{id}/rerun endpoint"
```

---

### Task 4: Frontend API fn `rerunCheck` + outcome types

**Files:**
- Modify: `frontend/src/api/types.ts` (add `RerunOutcome`, `RerunResponse`)
- Modify: `frontend/src/api/checks.ts` (add `rerunCheck`)
- Test: `frontend/src/api/checks.test.ts` (create if absent)

**Interfaces:**
- Produces: `RerunOutcome` union; `rerunCheck(prRef, checkRunId, headSha, signal): Promise<RerunResponse>`.
- Consumes: `apiClient.post` (verify its signature in `frontend/src/api/client.ts` — used by comment posting; this plan assumes `post<T>(url, body?, opts?)`).

- [ ] **Step 1: Write the failing test** — `frontend/src/api/checks.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest';
import { rerunCheck } from './checks';
import { apiClient } from './client';

const PR = { owner: 'o', repo: 'r', number: 7 };

describe('rerunCheck', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to the rerun route with the sha query param', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValue({ outcome: 'accepted' });
    const ctrl = new AbortController();

    const res = await rerunCheck(PR, 555, 'abc123', ctrl.signal);

    expect(res).toEqual({ outcome: 'accepted' });
    expect(post).toHaveBeenCalledWith(
      '/api/pr/o/r/7/checks/555/rerun?sha=abc123',
      undefined,
      { signal: ctrl.signal },
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend; ./node_modules/.bin/vitest run src/api/checks.test.ts`
Expected: FAIL — `rerunCheck` is not exported.

- [ ] **Step 3: Add the types** — in `frontend/src/api/types.ts`, after the `DegradedReason` type:

```typescript
export type RerunOutcome =
  | 'accepted'
  | 'auth'
  | 'not-rerunnable'
  | 'superseded'
  | 'transient';

export interface RerunResponse {
  outcome: RerunOutcome;
}
```

- [ ] **Step 4: Add `rerunCheck`** — in `frontend/src/api/checks.ts`:

```typescript
import { apiClient } from './client';
import type { ChecksResponse, PrReference, RerunResponse } from './types';

export function getCheckRuns(
  prRef: PrReference,
  headSha: string,
  signal: AbortSignal,
): Promise<ChecksResponse> {
  return apiClient.get<ChecksResponse>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/checks?sha=${encodeURIComponent(headSha)}`,
    { signal },
  );
}

export function rerunCheck(
  prRef: PrReference,
  checkRunId: number,
  headSha: string,
  signal: AbortSignal,
): Promise<RerunResponse> {
  return apiClient.post<RerunResponse>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/checks/${checkRunId}/rerun?sha=${encodeURIComponent(headSha)}`,
    undefined,
    { signal },
  );
}
```

- [ ] **Step 5: Run to verify green**

Run: `cd frontend; ./node_modules/.bin/vitest run src/api/checks.test.ts`
Expected: PASS. (If the assertion on `post` args fails, adjust to match the real `apiClient.post(url, body, opts)` shape from `client.ts` — keep the URL + signal assertions.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/checks.ts frontend/src/api/checks.test.ts
git commit -m "feat(#636): rerunCheck API client fn + RerunOutcome types"
```

---

### Task 5: `useCheckRuns` — `refetch`, `armRerunWatch`, per-check rerun-watch

**Files:**
- Modify: `frontend/src/hooks/useCheckRuns.ts`
- Test: `frontend/src/hooks/useCheckRuns.test.ts`

> **No other files change in this task.** Because the three new `CheckRunsResult` members are
> declared **optional** (see the interface comment in Step 3), the ~10 unrelated test files
> that build `PrDetailContextValue` inline with an idle `checks` stub (`testUtils.tsx`,
> `PrDetailView.test.tsx`'s hoisted mock + `inProgress`/`empty`/`beforeEach`, `FilesTab*`,
> `OverviewTab`, `DraftsTab` ×2, `PrDetailView.freshness`) stay type-valid untouched. Had the
> members been required, every one would need a mechanical 3-line edit — the reason the
> optional modelling was chosen.

**Interfaces:**
- Produces (added to `CheckRunsResult`): `refetch: () => void`; `armRerunWatch: (checkRunId: number) => void`; `rerunPendingFor: number | null` (the checkRunId currently watched, or null).
- Consumes: nothing new.

**Design:** A rerun arms a watch on a specific `checkRunId`. `shouldKeepPolling` returns true while the watch is active and inside its window, so the loop survives an all-terminal list (GitHub does not reset the run). The window is re-armed on `onVisible` so it measures *visible* time. The watch clears when the watched check is next seen non-terminal, or the window expires on a visible tick. `rerunPendingFor` is reactive so `CheckDetail` can render "Re-running…" only for the watched check.

- [ ] **Step 1: Write the failing tests** — append to `frontend/src/hooks/useCheckRuns.test.ts`:

```typescript
  it('refetch() fetches off-timer WITHOUT flipping status to loading (stale-while-revalidate)', async () => {
    const list = [
      {
        name: 'build', status: 'completed', conclusion: 'success', source: 'check-run',
        startedAt: null, completedAt: null, detailsUrl: null, summary: null, appName: null,
        body: null, checkRunId: 1,
      },
    ] as const;
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: list as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.refetch!()); // `!`: the hook always returns it (optional on the type)
    // status stays 'ok' (never transitions through 'loading')
    expect(result.current.status).toBe('ok');
    expect(result.current.checks).toHaveLength(1);
  });

  it('armRerunWatch keeps polling across the window even when all checks are terminal', async () => {
    const terminal = [
      {
        name: 'build', status: 'completed', conclusion: 'failure', source: 'check-run',
        startedAt: null, completedAt: null, detailsUrl: null, summary: null, appName: null,
        body: null, checkRunId: 42,
      },
    ];
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: terminal as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    const callsAfterFirst = spy.mock.calls.length;

    act(() => result.current.armRerunWatch!(42)); // `!`: always returned (optional on the type)
    expect(result.current.rerunPendingFor).toBe(42);

    // advance one poll interval — without the watch, an all-terminal list stops polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst + 1);

    // advance past the watch window — the watch clears and polling stops
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(result.current.rerunPendingFor).toBeNull();
  });

  it('clears a stuck rerun-watch even when polls FAIL across the window (AC#3, failure path)', async () => {
    const terminal = [
      {
        name: 'build', status: 'completed', conclusion: 'failure', source: 'check-run',
        startedAt: null, completedAt: null, detailsUrl: null, summary: null, appName: null,
        body: null, checkRunId: 42,
      },
    ];
    // First poll succeeds (warm series), every poll thereafter throws.
    vi.spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(resp({ checks: terminal as never }))
      .mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.armRerunWatch!(42)); // `!`: always returned (optional on the type)
    expect(result.current.rerunPendingFor).toBe(42);

    // Every poll from here throws; advance past the 90s window. The expiry must fire on a
    // FAILING tick (the catch-branch updateRerunWatch), not only on a succeeding one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(result.current.rerunPendingFor).toBeNull(); // would stay 42 without the catch fix
    expect(result.current.status).toBe('ok'); // warm series → stale list retained, NOT 'error'
  });
```

> The failure-path test is the regression guard for the catch-branch expiry: run it RED
> against an implementation whose `catch` omits `updateRerunWatch(checksRef.current)` to
> confirm it actually catches the hang (it should leave `rerunPendingFor === 42`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend; ./node_modules/.bin/vitest run src/hooks/useCheckRuns.test.ts`
Expected: FAIL — `refetch`, `armRerunWatch`, `rerunPendingFor` don't exist.

- [ ] **Step 3: Implement** — replace `frontend/src/hooks/useCheckRuns.ts` with (additions marked by comments; the read-path body is preserved verbatim):

```typescript
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCheckRuns } from '../api/checks';
import { ApiError } from '../api/client';
import type { CheckRun, DegradedReason, PrReference } from '../api/types';

const POLL_MS = 15_000;
const LATE_REGISTRATION_MS = 120_000;
const RERUN_WATCH_MS = 90_000; // bounded, visible-time window kept alive after a rerequest

export interface CheckRunsResult {
  status: 'idle' | 'loading' | 'ok' | 'empty' | 'error';
  degraded: DegradedReason;
  checks: CheckRun[];
  retry: () => void;
  // The three rerun members are OPTIONAL on the interface even though the hook ALWAYS
  // returns them. Rationale: `CheckRunsResult` is carried by `PrDetailContextValue`, and
  // ~10 unrelated test files build that context inline with an idle `checks` stub
  // (`{ status: 'idle', degraded: 'none', checks: [], retry }`) for tabs that never touch
  // rerun. Required members would force a mechanical 3-line edit in every one of them for
  // zero behavioural reason. Optional confines the change to the hook (which populates them)
  // and the single consumer (CheckDetail, which null-guards). These are internal result
  // members, NOT a wire field — so the wire-honesty argument that keeps `CheckRun.checkRunId`
  // required (Task 1) does not apply here.
  refetch?: () => void;                        // off-timer poll, no loading flash
  armRerunWatch?: (checkRunId: number) => void; // keep polling for a rerequested check
  rerunPendingFor?: number | null;             // which checkRunId is being watched (reactive)
}

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';

export function useCheckRuns(
  prRef: PrReference,
  headSha: string | undefined,
  active: boolean,
): CheckRunsResult {
  const [status, setStatus] = useState<CheckRunsResult['status']>('idle');
  const [degraded, setDegraded] = useState<DegradedReason>('none');
  const [checks, setChecks] = useState<CheckRun[]>([]);
  const [retryNonce, setRetryNonce] = useState(0);
  const [refetchNonce, setRefetchNonce] = useState(0); // NEW: drives an off-timer poll
  const [rerunPendingFor, setRerunPendingFor] = useState<number | null>(null); // NEW: reactive

  const seriesShaRef = useRef<string | undefined>(undefined);
  const windowOpenedAtRef = useRef<number>(0);
  const checksRef = useRef<CheckRun[]>([]);
  const hadSuccessRef = useRef(false);
  // NEW: rerun-watch state read inside the tick closure (refs, fresh across renders).
  const watchedIdRef = useRef<number | null>(null);
  const watchUntilRef = useRef<number>(0);

  const refKey = `${prRef.owner}/${prRef.repo}/${prRef.number}`;

  const retry = useCallback(() => {
    setStatus('loading');
    setRetryNonce((n) => n + 1);
  }, []);

  // NEW: off-timer poll that preserves the list (no setStatus('loading')).
  const refetch = useCallback(() => {
    setRefetchNonce((n) => n + 1);
  }, []);

  // NEW: arm a watch on a specific check so the loop stays alive after a rerequest.
  const armRerunWatch = useCallback((checkRunId: number) => {
    watchedIdRef.current = checkRunId;
    watchUntilRef.current = Date.now() + RERUN_WATCH_MS;
    setRerunPendingFor(checkRunId);
    setRefetchNonce((n) => n + 1); // kick an immediate poll
  }, []);

  useEffect(() => {
    const gateOpen = active && headSha != null && document.visibilityState === 'visible';
    if (!gateOpen) return;

    if (seriesShaRef.current !== headSha) {
      seriesShaRef.current = headSha;
      windowOpenedAtRef.current = Date.now();
      setChecks([]);
      checksRef.current = [];
      hadSuccessRef.current = false;
      setDegraded('none');
      setStatus('loading');
      // A new head invalidates any in-flight rerun-watch (its checkRunId belongs to the
      // old series); drop it silently so the new series isn't held open by a dead watch.
      watchedIdRef.current = null;
      watchUntilRef.current = 0;
      setRerunPendingFor(null);
    }

    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();

    const shouldKeepPolling = (list: CheckRun[]): boolean => {
      // NEW: a live rerun-watch keeps the loop alive even when all checks are terminal.
      if (watchedIdRef.current != null && Date.now() < watchUntilRef.current) return true;
      if (list.some(isNonTerminal)) return true;
      if (list.length === 0) {
        return Date.now() - windowOpenedAtRef.current < LATE_REGISTRATION_MS;
      }
      return false;
    };

    // NEW: clear the watch when the watched check transitions or the window expires.
    const updateRerunWatch = (list: CheckRun[]) => {
      if (watchedIdRef.current == null) return;
      const watched = list.find((c) => c.checkRunId === watchedIdRef.current);
      const transitioned = watched != null && isNonTerminal(watched);
      if (transitioned || Date.now() >= watchUntilRef.current) {
        watchedIdRef.current = null;
        watchUntilRef.current = 0;
        setRerunPendingFor(null);
      }
    };

    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await getCheckRuns(prRef, headSha!, ctrl.signal);
        if (cancelled || res.headSha !== headSha) return;
        setChecks(res.checks);
        checksRef.current = res.checks;
        hadSuccessRef.current = true;
        setDegraded(res.degraded);
        setStatus(res.checks.length === 0 ? 'empty' : 'ok');
        updateRerunWatch(res.checks); // NEW
        if (shouldKeepPolling(res.checks)) {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled || ctrl.signal.aborted) return;
        setDegraded(
          err instanceof ApiError && (err.status === 401 || err.status === 403)
            ? 'auth'
            : 'transient',
        );
        // Expire the rerun-watch on a FAILING tick too. Without this, a poll that throws
        // while crossing the watch-window boundary never runs the window-expiry clear; the
        // watch then stays armed, shouldKeepPolling can return false (window elapsed + list
        // terminal), the loop stops, and rerunPendingFor is stuck non-null → the button hangs
        // "Re-running…" forever. updateRerunWatch over the stale list won't clear early (a
        // still-terminal watched check hasn't transitioned) but DOES clear once the window has
        // elapsed — exactly the expiry semantics the success path gets. (AC#3: never hangs.)
        updateRerunWatch(checksRef.current);
        if (!hadSuccessRef.current) {
          setStatus('error');
        } else {
          setStatus(checksRef.current.length === 0 ? 'empty' : 'ok');
          if (shouldKeepPolling(checksRef.current)) {
            timer = setTimeout(tick, POLL_MS);
          }
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        // NEW: re-arm the watch window on resume so it measures visible time, not wall-clock.
        if (watchedIdRef.current != null) watchUntilRef.current = Date.now() + RERUN_WATCH_MS;
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refKey captures prRef's identity
  }, [active, headSha, refKey, retryNonce, refetchNonce]); // NEW: refetchNonce drives off-timer polls

  return { status, degraded, checks, retry, refetch, armRerunWatch, rerunPendingFor };
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `cd frontend; ./node_modules/.bin/vitest run src/hooks/useCheckRuns.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useCheckRuns.ts frontend/src/hooks/useCheckRuns.test.ts
git commit -m "feat(#636): useCheckRuns refetch + per-check rerun-watch"
```

---

### Task 6: `CheckDetail` Re-run button + states + a11y

**Files:**
- Modify: `frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx` (thread props from `ChecksTab` → `CheckDetail`; add the action row + state)
- Modify: `frontend/src/components/PrDetail/ChecksTab/ChecksTab.module.css` (button + caption + note styles — match existing `detailLink` look)
- Test: `frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx`

**Interfaces:**
- Consumes: `rerunCheck` (Task 4); `armRerunWatch`, `rerunPendingFor` from `useCheckRuns` (Task 5); `prRef`, `headSha`.

**Eligibility:** `source === 'check-run' && status === 'completed' && checkRunId != null`.
**Button "Re-running…":** `phase === 'posting' || rerunPendingFor === check.checkRunId`.

- [ ] **Step 1: Write the failing tests** — extend `ChecksTab.test.tsx`. First widen the imports and add a rerun-aware render helper (the existing `run` factory now defaults `checkRunId: 1` from Task 1 Step 6b; the existing `renderTab` only sets `checks`, but rerun reads `prDetail.pr.headSha`, so these tests render with a `prDetail` override too):

```typescript
// widen the existing imports:
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as checksApi from '../../../api/checks';
import type { PrDetailContextValue } from '../prDetailContext';
import type { CheckRunsResult } from '../../../hooks/useCheckRuns';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const DEFAULT_PR_REF = { owner: 'acme', repo: 'api', number: 123 }; // from makePrDetailContextValue
const prDetailWithSha = { pr: { headSha: HEAD_SHA } } as PrDetailContextValue['prDetail'];

// Render the tab with one selected check + a rerun-aware checks result and a real headSha.
function renderRerun(checkOver: Partial<CheckRun>, resultOver: Partial<CheckRunsResult> = {}) {
  const checks: CheckRunsResult = {
    ...base,
    status: 'ok',
    checks: [run(checkOver)],
    refetch: vi.fn(),
    armRerunWatch: vi.fn(),
    rerunPendingFor: null,
    ...resultOver,
  };
  return render(
    <PrDetailContextProvider
      value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
    >
      <ChecksTab />
    </PrDetailContextProvider>,
  );
}

describe('ChecksTab — Re-run action', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enables Re-run for an eligible completed check-run, disables it for ineligible rows', () => {
    // eligible: check-run + completed + checkRunId (run() defaults checkRunId: 1)
    const eligible = renderRerun({ name: 'build' });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeEnabled();
    eligible.unmount();

    // legacy status source → disabled with caption (this is the path that lets
    // FakePrChecksReader keep 3 check-run rows — see the deviation note)
    const legacy = renderRerun({ name: 'legacy', source: 'status', checkRunId: null });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeDisabled();
    expect(screen.getByText(/legacy status checks can't be re-run/i)).toBeInTheDocument();
    legacy.unmount();

    // still-running check-run → disabled with "still running"
    renderRerun({ name: 'running', status: 'in-progress', conclusion: null });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeDisabled();
    expect(screen.getByText(/still running/i)).toBeInTheDocument();
  });

  it('clicking Re-run posts with the head sha + checkRunId and arms the watch on accepted', async () => {
    const rerun = vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'accepted' });
    const armRerunWatch = vi.fn();
    renderRerun({ name: 'build', checkRunId: 77 }, { armRerunWatch });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(rerun).toHaveBeenCalledWith(DEFAULT_PR_REF, 77, HEAD_SHA, expect.any(AbortSignal));
    await waitFor(() => expect(armRerunWatch).toHaveBeenCalledWith(77));
  });

  it('shows "Re-running…" and disables the button while the watch is pending for this check', () => {
    renderRerun({ name: 'build', checkRunId: 77 }, { rerunPendingFor: 77 });
    expect(screen.getByRole('button', { name: /re-running/i })).toBeDisabled();
  });

  it('does NOT show "Re-running…" when the pending watch is for a DIFFERENT check', () => {
    renderRerun({ name: 'build', checkRunId: 77 }, { rerunPendingFor: 999 });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeEnabled();
  });

  it('surfaces an inline alert per failure outcome (auth / not-rerunnable / transient+Retry)', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'auth' });
    const a = renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/authenticate/i);
    a.unmount();
    vi.restoreAllMocks();

    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'not-rerunnable' });
    const b = renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/write access/i);
    b.unmount();
    vi.restoreAllMocks();

    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'transient' });
    renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again/i);
    expect(within(alert).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('superseded shows a neutral status note, not an alert', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'superseded' });
    renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByText(/PR was updated/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the rerun error when a different check is selected (per-check isolation)', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'transient' });
    const checks: CheckRunsResult = {
      ...base,
      status: 'ok',
      checks: [run({ name: 'aaa', checkRunId: 1 }), run({ name: 'bbb', checkRunId: 2 })],
      refetch: vi.fn(),
      armRerunWatch: vi.fn(),
      rerunPendingFor: null,
    };
    render(
      <PrDetailContextProvider
        value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
      >
        <ChecksTab />
      </PrDetailContextProvider>,
    );
    // aaa auto-selects (same tier, alphabetical) → trigger an error on it
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // select bbb → identity change resets phase/error; no stale alert
    const bbbRow = screen.getAllByRole('option').find((o) => o.textContent?.includes('bbb'));
    await userEvent.click(bbbRow!);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
```

> These are concrete because the disabled-status assertion (test 1) is the coverage the
> spec's Testing AC wanted from a status-source row in the fake — proving it at the unit level
> is what lets `FakePrChecksReader` keep its 3 check-run rows (no e2e baseline churn). The
> `name: /^re-run$/i` anchor avoids matching the "Re-running…" label; `role="alert"` is unique
> here (the tab's error card only renders in `status:'error'`, not `'ok'`). Note `afterEach`
> already exists at the file's top-level `describe` only if added — this new `describe` adds its
> own `afterEach(vi.restoreAllMocks)`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend; ./node_modules/.bin/vitest run src/components/PrDetail/ChecksTab/ChecksTab.test.tsx`
Expected: FAIL — no Re-run button.

- [ ] **Step 3: Implement the action row.** In `ChecksTab.tsx`:

(a) **Do NOT call `useCheckRuns` here.** `ChecksTab` does not own the hook — it reads the
shared result from context (`const { checks: state } = usePrDetailContext();`, line 103), and
`PrDetailView` is the sole owner that calls `useCheckRuns(prRef, data?.pr.headSha, …)` and
publishes the result. `ChecksBody`/`CheckDetail` keep their existing `{ check, now }` call
signatures — **no prop-threading**. Instead, `CheckDetail` reads what it needs directly from
`usePrDetailContext()` (it already renders inside the provider in both prod and the tests).
The values it needs:
- `prRef` — `usePrDetailContext().prRef`.
- `headSha` — `usePrDetailContext().prDetail.pr?.headSha ?? null`. (`?.` + `?? null` because
  the sub-tab tests stub `prDetail` as `{}`; in prod `prDetail.pr.headSha` is always present.
  This is the SAME SHA `PrDetailView` fed to `useCheckRuns`, so the SHA guard compares
  apples to apples.)
- `armRerunWatch` / `rerunPendingFor` — off the context's `checks` result
  (`usePrDetailContext().checks`), null-guarded since they are optional on the interface.

(b) Replace the `CheckDetail` component with the action-row version:

```typescript
import { useEffect, useState } from 'react'; // add to the file's existing React import
import { rerunCheck } from '../../../api/checks';
import { usePrDetailContext } from '../prDetailContext'; // already imported by ChecksTab
import type { RerunOutcome } from '../../../api/types';

function rerunDisabledReason(c: CheckRun): string | null {
  if (c.source !== 'check-run') return "Legacy status checks can't be re-run from PRism";
  if (c.status !== 'completed') return 'Check is still running';
  if (c.checkRunId == null) return 'Not re-runnable';
  return null; // eligible
}

function CheckDetail({ check: c, now }: { check: CheckRun; now: number }) {
  // Read everything from the shared PrDetail context — ChecksTab does NOT own useCheckRuns,
  // so there is no prop to thread. headSha is null-safe (sub-tab tests stub prDetail as {}).
  const { prRef, prDetail, checks: state } = usePrDetailContext();
  const headSha = prDetail.pr?.headSha ?? null;
  const rerunPendingFor = state.rerunPendingFor ?? null; // optional on the interface
  const duration = formatDuration(c, now);
  const sourceLabel = c.source === 'check-run' ? 'GitHub check' : 'Status';
  const metaParts: string[] = [];
  if (c.appName != null) metaParts.push(c.appName);
  metaParts.push(sourceLabel);
  if (duration != null) metaParts.push(duration);

  const disabledReason = rerunDisabledReason(c);
  const [phase, setPhase] = useState<'idle' | 'posting' | 'error'>('idle');
  const [errorOutcome, setErrorOutcome] = useState<RerunOutcome | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Per-check isolation: reset rerun UI when the selected check changes.
  const identity = c.checkRunId ?? c.name;
  useEffect(() => {
    setPhase('idle');
    setErrorOutcome(null);
    setNote(null);
  }, [identity]);

  const watching = rerunPendingFor != null && rerunPendingFor === c.checkRunId;
  const running = phase === 'posting' || watching;

  const handleRerun = async () => {
    if (c.checkRunId == null || headSha == null) return; // also narrows headSha to string
    setPhase('posting');
    setErrorOutcome(null);
    setNote(null);
    const ctrl = new AbortController();
    try {
      const { outcome } = await rerunCheck(prRef, c.checkRunId, headSha, ctrl.signal);
      if (outcome === 'accepted') {
        state.armRerunWatch?.(c.checkRunId); // hook drives "Re-running…" via rerunPendingFor
        setPhase('idle');
      } else if (outcome === 'superseded') {
        setPhase('idle');
        setNote('The PR was updated — re-run from the latest checks.');
      } else {
        setErrorOutcome(outcome); // auth | not-rerunnable | transient
        setPhase('error');
      }
    } catch {
      setErrorOutcome('transient');
      setPhase('error');
    }
  };

  const errorText =
    errorOutcome === 'auth'
      ? "Couldn't re-run — PRism couldn't authenticate to GitHub. Reconnect your token."
      : errorOutcome === 'not-rerunnable'
        ? "Couldn't re-run this check — it may not be re-runnable, or your token may lack write access to checks."
        : "Couldn't re-run — try again.";

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <RowGlyphIcon glyph={glyphFor(c)} />
        <span className={styles.detailName}>{c.name}</span>
        <span className={styles.detailStatus}>{statusLabel(c)}</span>
      </div>

      <p className={styles.detailMeta}>{metaParts.join(' · ')}</p>
      {c.summary != null && <p className={styles.detailSummary}>{c.summary}</p>}
      {c.body != null ? (
        <MarkdownRenderer source={c.body} className={styles.body} dataTestId="check-body" />
      ) : (
        <p className={styles.detailNoBody}>No additional details from this check.</p>
      )}
      {c.detailsUrl != null && (
        <a className={styles.detailLink} href={c.detailsUrl} target="_blank" rel="noopener noreferrer">
          View on GitHub ↗
        </a>
      )}

      {/* Re-run action row (footer; header stays read-only) */}
      <div className={styles.rerunRow}>
        <button
          type="button"
          className={styles.rerunButton}
          disabled={disabledReason != null || running || headSha == null}
          onClick={handleRerun}
        >
          {running ? (
            <>
              <RowGlyphIcon glyph="spinner" /> Re-running…
            </>
          ) : (
            'Re-run'
          )}
        </button>
        {disabledReason != null && <span className={styles.rerunCaption}>{disabledReason}</span>}
      </div>

      {/* Live regions: alert for failures, status for the neutral superseded note */}
      {phase === 'error' && (
        <p role="alert" className={styles.rerunError}>
          {errorText}
          {errorOutcome === 'transient' && (
            <button type="button" className={styles.rerunRetry} onClick={handleRerun}>
              Retry
            </button>
          )}
        </p>
      )}
      {note != null && (
        <p role="status" className={styles.rerunNote}>
          {note}
        </p>
      )}
      {/* SR-only running announcement */}
      <span role="status" className="sr-only">
        {running ? `Re-running ${c.name}` : ''}
      </span>
    </div>
  );
}
```

> Ensure `useEffect`/`useState` are imported in this file (add to the existing React import).

- [ ] **Step 4: Add styles** — in `ChecksTab.module.css`, add `.rerunRow`, `.rerunButton`, `.rerunCaption`, `.rerunError`, `.rerunRetry`, `.rerunNote`. Reuse the existing button/link tokens (mirror `.detailLink` and any existing `btn-secondary` token for `.rerunButton`; muted text token for `.rerunCaption`/`.rerunNote`; the error/alert color used by the tab's error card for `.rerunError`). Keep the spinner glyph sized 14×14 to match in-progress rows.

- [ ] **Step 5: Run tests to verify green**

Run: `cd frontend; ./node_modules/.bin/vitest run src/components/PrDetail/ChecksTab/ChecksTab.test.tsx`
Expected: PASS. Then `./node_modules/.bin/tsc -b` — Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx frontend/src/components/PrDetail/ChecksTab/ChecksTab.module.css frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx
git commit -m "feat(#636): per-check Re-run button + states in CheckDetail"
```

---

### Task 7: Token-scope documentation

**Files:**
- Modify: the doc where PRism documents PAT scopes (locate in Step 1)

- [ ] **Step 1: Locate the scope doc**

Run (Grep tool, not bash): search for `read:org` and `repo` scope guidance across `*.md` (README, `docs/`, `.ai/docs/`) and note the file that lists required PAT scopes for setup.
Expected: one user-facing scope section (README setup or a docs page). If none exists, target the Checks-tab user doc or README "Authentication / token" section.

- [ ] **Step 2: Add the rerun-write note** — insert (adapt heading to the found doc):

```markdown
### Re-running checks (write access)

The Checks tab is read-only with a read-scoped token. **Re-running a check** is a
write action and needs a write-capable token:

- **Classic PAT:** the `repo` scope (covers both reading checks and re-running them).
- **Fine-grained PAT:** write access to the repository's checks (and, for some
  Actions-backed runs, Actions). GitHub does not pin a single permission name for the
  re-run endpoint — grant write access for checks/Actions and verify in the token's
  permission settings.

A read-only token still shows all checks; the **Re-run** button will report
"may not be re-runnable, or your token may lack write access" if the token can't write.
```

- [ ] **Step 3: Verify** — re-read the edited section; confirm it states read-vs-write clearly and names the classic `repo` scope. No automated test.

- [ ] **Step 4: Commit**

```bash
git add <the-doc-file>
git commit -m "docs(#636): document write scope required to re-run checks"
```

---

### Task 8: e2e route-mock parity + full-suite sanity

**Files:**
- Modify (if present): `frontend/e2e/**` route-mock JSON that fulfills the checks endpoint

- [ ] **Step 1: Find checks route mocks** — Grep `frontend/e2e` for `checks` and `route.fulfill`/`check-run` JSON fixtures (typed FE mocks are `tsc`-checked, but `route.fulfill` JSON and `as any` fixtures are not — a missing `checkRunId` there is silent).

- [ ] **Step 2: Add `checkRunId`** — for any check-run-shaped fixture object, add `"checkRunId": <number>` (and `null` on any status-source fixture). If no e2e fixture hardcodes checks (the prod e2e uses `FakePrChecksReader` via `PRISM_E2E_FAKE_REVIEW=1`, already updated in Task 1), record "no e2e route mocks to update" and skip.

- [ ] **Step 3: Run the affected suites green**

Run (backend, full affected projects): `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests tests/PRism.Web.Tests`
Run (FE unit): `cd frontend; ./node_modules/.bin/vitest run`
Run (typecheck): `cd frontend; ./node_modules/.bin/tsc -b`
Expected: all green.

- [ ] **Step 4: Commit** (only if files changed)

```bash
git add frontend/e2e
git commit -m "test(#636): add checkRunId to e2e checks route mocks"
```

---

## Self-Review

**Spec coverage (each spec section → task):**
- Wire-shape `CheckDto.CheckRunId` + FE type → **Task 1** ✅
- `RerunOutcome` (incl. `superseded`) + `RerunResultDto` + `IPrChecksRerunner` + `GitHubPrChecksRerunner` (SHA guard + rerequest, own outcome map) + DI → **Task 2** ✅
- Endpoint `POST .../rerun?sha=` + validation + `FakePrChecksRerunner` → **Task 3** ✅
- FE `rerunCheck` + outcome types → **Task 4** ✅
- `useCheckRuns` `refetch` (no loading flash) + `armRerunWatch` + window + visible-time re-arm + `rerunPendingFor` → **Task 5** ✅
- `CheckDetail` button, eligibility, disabled caption, running/error/superseded states, Retry re-invokes, per-check isolation, SR `role=alert`/`status`, footer placement, spinner glyph → **Task 6** ✅
- Token-scope doc → **Task 7** ✅
- e2e route-mock parity + full-suite sanity → **Task 8** ✅
- AC#3 "never hangs" (watch clears on transition OR expiry; visible-time) → **Tasks 5 + 6** ✅
- B2 access-control (existing middleware, no new gate) → no code change required; the endpoint inherits the stack (recorded in spec) ✅

**Deliberate deviations from the spec (documented):**
1. **FakePrChecksReader keeps 3 check-run rows** (no added status-source row) to avoid churning e2e visual baselines; the disabled-for-status path is covered concretely by Task 6 Step 1's first test (`enables Re-run … disables it for ineligible rows`, which renders a `source:'status'` row and asserts the disabled button + caption). (Spec § Testing suggested a status row in the fake.)
2. **Rerequest POST sends no body** (matches the reader's call style; github.com accepts a bodyless rerequest). The spec's "set `Content-Type` explicitly for some GHES versions" is deferred as YAGNI for the github.com target; revisit if GHES support is added.
3. **`CheckRunsResult.refetch`/`armRerunWatch`/`rerunPendingFor` are typed OPTIONAL** even though the hook always returns them (Task 5 Step 3 interface comment). Keeps the ~10 unrelated inline `PrDetailContextValue` test stubs valid untouched; the single consumer null-guards. **This is a typing judgment, not a spec requirement — flag it at the plan gate.** Alternative (required members) is honest-but-churns-10-files; recommendation is optional. `CheckRun.checkRunId` stays **required** (it is a wire field, not an internal result member).

**Placeholder scan:** **No placeholders remain.** Task 6 Step 1 is now fully concrete (real DOM assertions, `rerunCheck` call-arg checks, role checks) against the existing `ChecksTab.test.tsx` harness (`run` factory + `makePrDetailContextValue`). Every code step has complete code.

**Type consistency:** `RerunOutcome` (C# `Accepted|Auth|NotRerunnable|Superseded|Transient`) ↔ wire (`accepted|auth|not-rerunnable|superseded|transient`) ↔ FE union — consistent. `armRerunWatch(checkRunId: number)`, `rerunPendingFor: number | null`, `refetch(): void` match between Task 5 (producer) and Task 6 (consumer); the consumer reads them off `usePrDetailContext().checks` (NOT props — `ChecksTab` does not own the hook) and null-guards the optional members. `rerunCheck(prRef, checkRunId, headSha, signal)` matches between Task 4 and Task 6. `headSha` is sourced as `prDetail.pr?.headSha ?? null` (null-safe for stubbed `prDetail`).

**Round-1 `ce-doc-review` dispositions (4 reviewers):**
- **Adversarial P2** (rerun-watch never expires on a failing tick → button hangs "Re-running…") → **Applied**: Task 5 `catch` now calls `updateRerunWatch(checksRef.current)`; added the failure-path regression test.
- **Feasibility P2a** (required `checkRunId` breaks 4 existing FE `CheckRun` literals) → **Applied**: Task 1 Step 6b enumerates the literal updates + adds the 4 files.
- **Feasibility P2b** (`CheckRunsResult` widening breaks `PrDetailView.test.tsx` mocks) → **Resolved by design**: the three members are now optional, so those literals (and ~8 more inline stubs feasibility didn't enumerate) stay valid untouched.
- **Coherence P1** (Task-1 deviation leans on placeholder Task-6 test) → **Applied**: Task-6 tests are now concrete, including the disabled-status path that backs the deviation.
- **Security** (zero findings; one spec-text nit on owner/repo escaping) → **Applied to the spec** (the `Uri.EscapeDataString` parenthetical was corrected — owner/repo are regex-gated; #604 escaped the SHA).
- **Self-found wiring bug** (plan had `ChecksTab` calling `useCheckRuns` + prop-drilling; real `ChecksTab` reads the shared result from context) → **Applied**: Task 6 Step 3 corrected to read from `usePrDetailContext()`.

**Open copy question (non-blocking, from spec):** whether a GitHub-Actions check-run rerequest re-runs the whole workflow or one job — resolve during Task 6 implementation when live behavior is observable; affects button/tooltip copy only.
