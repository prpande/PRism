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

- [ ] **Step 7: Run tests to verify green**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~Populates_CheckRunId"`
Expected: PASS.
Run: `& 'C:\Program Files\dotnet\dotnet.exe' build PRism.Web` — Expected: builds (FakePrChecksReader compiles).
Run (FE typecheck): `cd frontend; ./node_modules/.bin/tsc -b` — Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core.Contracts/CheckDto.cs PRism.GitHub/GitHubPrChecksReader.cs PRism.Web/TestHooks/FakePrChecksReader.cs frontend/src/api/types.ts tests/PRism.GitHub.Tests/GitHubPrChecksReaderTests.cs
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

    act(() => result.current.refetch());
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

    act(() => result.current.armRerunWatch(42));
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
```

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
  refetch: () => void;                       // off-timer poll, no loading flash
  armRerunWatch: (checkRunId: number) => void; // keep polling for a rerequested check
  rerunPendingFor: number | null;            // which checkRunId is being watched (reactive)
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

- [ ] **Step 1: Write the failing tests** — add to `ChecksTab.test.tsx` (mirror the existing render harness; mock `rerunCheck`):

```typescript
import * as checksApi from '../../../api/checks';
// ...
  it('enables Re-run only for a completed check-run row', () => {
    // render the tab with the selected check = a completed check-run row (checkRunId set)
    // then assert the Re-run button is enabled; re-render with a status-source row and a
    // non-completed row and assert it is disabled with the matching caption.
    // (Use the existing test harness/sample data builders in this file.)
  });

  it('clicking Re-run posts with the series sha and arms the watch on accepted', async () => {
    const rerun = vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'accepted' });
    // render with a completed check-run row selected; click the Re-run button
    // expect(rerun).toHaveBeenCalledWith(prRef, <checkRunId>, <headSha>, expect.any(AbortSignal));
    // expect the button to show "Re-running…" (rerunPendingFor === checkRunId)
  });

  it('surfaces an inline message per failure outcome', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'auth' });
    // click → expect role="alert" with "...authenticate" copy
    // repeat for 'not-rerunnable' (write-access copy) and 'transient' (+ Retry button)
    // 'superseded' → role="status" neutral "PR was updated" (NOT role="alert")
  });

  it('clears a prior error when a different check is selected', async () => {
    // select A, force an error, select B, reselect A → A shows no stale error
  });
```

> Fill these in concretely against the file's existing render helpers (the suite already
> renders `ChecksTab` and selects rows — reuse that setup; do not invent a new harness).
> Each test must assert real DOM: button `disabled` state, caption text, `role` of the
> message, and the `rerunCheck` call args.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend; ./node_modules/.bin/vitest run src/components/PrDetail/ChecksTab/ChecksTab.test.tsx`
Expected: FAIL — no Re-run button.

- [ ] **Step 3: Thread props + implement the action row.** In `ChecksTab.tsx`:

(a) At the `ChecksTab` level, pull the new hook values and pass them with `prRef`/`headSha` into the rendered `<CheckDetail>`:

```typescript
  const { status, degraded, checks, retry, refetch, armRerunWatch, rerunPendingFor } =
    useCheckRuns(prRef, headSha, active);
  // ...where <CheckDetail check={selected} now={now} /> is rendered:
  <CheckDetail
    check={selected}
    now={now}
    prRef={prRef}
    headSha={headSha}
    rerunPendingFor={rerunPendingFor}
    onArmRerunWatch={armRerunWatch}
  />
```

(b) Replace the `CheckDetail` component with the action-row version:

```typescript
import { rerunCheck } from '../../../api/checks';
import type { PrReference, RerunOutcome } from '../../../api/types';

function rerunDisabledReason(c: CheckRun): string | null {
  if (c.source !== 'check-run') return "Legacy status checks can't be re-run from PRism";
  if (c.status !== 'completed') return 'Check is still running';
  if (c.checkRunId == null) return 'Not re-runnable';
  return null; // eligible
}

function CheckDetail({
  check: c,
  now,
  prRef,
  headSha,
  rerunPendingFor,
  onArmRerunWatch,
}: {
  check: CheckRun;
  now: number;
  prRef: PrReference;
  headSha: string;
  rerunPendingFor: number | null;
  onArmRerunWatch: (checkRunId: number) => void;
}) {
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
    if (c.checkRunId == null) return;
    setPhase('posting');
    setErrorOutcome(null);
    setNote(null);
    const ctrl = new AbortController();
    try {
      const { outcome } = await rerunCheck(prRef, c.checkRunId, headSha, ctrl.signal);
      if (outcome === 'accepted') {
        onArmRerunWatch(c.checkRunId); // hook now drives "Re-running…" via rerunPendingFor
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
          disabled={disabledReason != null || running}
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
1. **FakePrChecksReader keeps 3 check-run rows** (no added status-source row) to avoid churning e2e visual baselines; the disabled-for-status path is covered by the Task-6 unit test instead. (Spec § Testing suggested a status row in the fake.)
2. **Rerequest POST sends no body** (matches the reader's call style; github.com accepts a bodyless rerequest). The spec's "set `Content-Type` explicitly for some GHES versions" is deferred as YAGNI for the github.com target; revisit if GHES support is added.

**Placeholder scan:** Task 6's test bodies are described against the file's existing harness rather than fully written, because the suite's render/selection helpers must be reused (inventing a parallel harness would be wrong). Every other step has complete code. The Task-6 implementer MUST write concrete DOM assertions per the bullet list in Step 1.

**Type consistency:** `RerunOutcome` (C# `Accepted|Auth|NotRerunnable|Superseded|Transient`) ↔ wire (`accepted|auth|not-rerunnable|superseded|transient`) ↔ FE union — consistent. `armRerunWatch(checkRunId: number)`, `rerunPendingFor: number | null`, `refetch(): void` match between Task 5 (producer) and Task 6 (consumer). `rerunCheck(prRef, checkRunId, headSha, signal)` matches between Task 4 and Task 6.

**Open copy question (non-blocking, from spec):** whether a GitHub-Actions check-run rerequest re-runs the whole workflow or one job — resolve during Task 6 implementation when live behavior is observable; affects button/tooltip copy only.
