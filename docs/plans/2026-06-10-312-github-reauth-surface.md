# #312 Mid-session GitHub re-auth surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a mid-session GitHub credential 401 at the shared `"github"` HttpClient transport seam, surface it on `/api/auth/state`, and render a non-dismissible red banner that funnels the user into an exit-gated `/setup?replace=1` flow until a valid token is committed.

**Architecture:** A `DelegatingHandler` on the one named `"github"` client flips a process-global `IGitHubCredentialHealth` latch after two consecutive authenticated github.com 401s (epoch- and auth-header-guarded). `/api/auth/state` exposes the latch as `githubCredentialInvalid`. The frontend reads it via `useAuth`, refetches on any failed request, shows a non-dismissible `GitHubAuthBanner`, and route-guards `/setup?replace=1` so the user cannot leave until re-auth succeeds.

**Tech Stack:** .NET (PRism.Core / PRism.GitHub / PRism.Web, xUnit), React + Vite + TypeScript (vitest), Playwright (e2e).

**Spec:** `docs/specs/2026-06-10-312-github-reauth-surface-design.md`. **Tier/Risk:** T3 · gated B2 + B1.

---

## File structure

**Backend (new):**
- `PRism.Core/Auth/IGitHubCredentialHealth.cs` — interface + `GitHubCredentialHealth` default impl (latch: `IsInvalid`, `Epoch`, threshold counter).
- `PRism.GitHub/GitHubAuthHealthHandler.cs` — `DelegatingHandler` observing `"github"` responses.

**Backend (modify):**
- `PRism.GitHub/HostUrlResolver.cs` — add `IsGitHubDotCom(Uri?)`.
- `PRism.GitHub/ServiceCollectionExtensions.cs` — register latch singleton + handler + `.AddHttpMessageHandler<>()`.
- `PRism.Core/<IReviewAuth>.cs` + `PRism.GitHub/GitHubReviewService.cs` — thread `skipCredentialHealth` through `ValidateCredentialsAsync` and the fine-grained probe.
- `PRism.Web/Endpoints/AuthDtos.cs` — add `GithubCredentialInvalid` to `AuthStateResponse`.
- `PRism.Web/Endpoints/AuthEndpoints.cs` — read latch in `/state`; `BumpEpoch()`+`MarkValid()` on connect/replace commit; pass `skipCredentialHealth: true` from connect/replace validation.

**Frontend (new):**
- `frontend/src/components/Snackbar/Snackbar.tsx` + `Snackbar.module.css` — shared presentational primitive.
- `frontend/src/components/GitHubAuthBanner/GitHubAuthBanner.tsx` — the re-auth banner.
- `frontend/src/components/ReauthRouteGuard.tsx` — sticky `/setup` exit-gate.

**Frontend (modify):**
- `frontend/src/api/types.ts` — `githubCredentialInvalid` on `AuthState`.
- `frontend/src/api/client.ts` — dispatch `prism-request-failed` on any failed response.
- `frontend/src/hooks/useAuth.tsx` — debounced refetch on `prism-request-failed`.
- `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.tsx` — re-point at `Snackbar`.
- `frontend/src/App.tsx` — mount `GitHubAuthBanner` + `ReauthRouteGuard`.

**Conventions to follow:** new C# files use file-scoped namespaces; `ConfigureAwait(false)` on awaits in library code; tests are xUnit with `Assert`; frontend tests are vitest + Testing Library; commit per task.

---

## Phase 1 — Backend latch + handler

### Task 1: `IGitHubCredentialHealth` latch with consecutive-401 threshold

**Files:**
- Create: `PRism.Core/Auth/IGitHubCredentialHealth.cs`
- Test: `tests/PRism.Core.Tests/Auth/GitHubCredentialHealthTests.cs`

- [ ] **Step 1: Write the failing tests**

```csharp
using PRism.Core.Auth;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class GitHubCredentialHealthTests
{
    [Fact]
    public void StartsValid()
    {
        var h = new GitHubCredentialHealth();
        Assert.False(h.IsInvalid);
        Assert.Equal(0, h.Epoch);
    }

    [Fact]
    public void SingleFailure_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        Assert.False(h.IsInvalid); // threshold is 2 consecutive
    }

    [Fact]
    public void TwoConsecutiveFailures_Flip()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.RecordAuthFailure();
        Assert.True(h.IsInvalid);
    }

    [Fact]
    public void SuccessBetweenFailures_ResetsCounter()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.MarkValid();
        h.RecordAuthFailure();
        Assert.False(h.IsInvalid); // counter reset by the 2xx
    }

    [Fact]
    public void MarkValid_ClearsInvalid()
    {
        var h = new GitHubCredentialHealth();
        h.RecordAuthFailure();
        h.RecordAuthFailure();
        Assert.True(h.IsInvalid);
        h.MarkValid();
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public void BumpEpoch_Increments()
    {
        var h = new GitHubCredentialHealth();
        h.BumpEpoch();
        Assert.Equal(1, h.Epoch);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter FullyQualifiedName~GitHubCredentialHealthTests`
Expected: FAIL — `GitHubCredentialHealth` / `IGitHubCredentialHealth` do not exist (compile error).

- [ ] **Step 3: Write the implementation**

```csharp
namespace PRism.Core.Auth;

/// <summary>
/// Process-global health of the stored GitHub credential. Flips invalid after
/// <see cref="Threshold"/> consecutive authenticated 401s (so a lone transient
/// 401 cannot raise the non-dismissible re-auth banner) and clears on any
/// authenticated 2xx or an explicit (re)connect commit. Live process state — no
/// persistence; a restart re-validates on the first GitHub call. See
/// docs/specs/2026-06-10-312-github-reauth-surface-design.md §6.1.
/// </summary>
public interface IGitHubCredentialHealth
{
    bool IsInvalid { get; }
    int Epoch { get; }
    void RecordAuthFailure();
    void MarkValid();
    void BumpEpoch();
}

public sealed class GitHubCredentialHealth : IGitHubCredentialHealth
{
    private const int Threshold = 2;
    private readonly object _gate = new();
    private bool _invalid;
    private int _epoch;
    private int _consecutive401;

    public bool IsInvalid { get { lock (_gate) return _invalid; } }
    public int Epoch { get { lock (_gate) return _epoch; } }

    public void RecordAuthFailure()
    {
        lock (_gate)
        {
            if (_consecutive401 < Threshold) _consecutive401++;
            if (_consecutive401 >= Threshold) _invalid = true;
        }
    }

    public void MarkValid()
    {
        lock (_gate)
        {
            _consecutive401 = 0;
            _invalid = false;
        }
    }

    public void BumpEpoch()
    {
        lock (_gate) _epoch++;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter FullyQualifiedName~GitHubCredentialHealthTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Auth/IGitHubCredentialHealth.cs tests/PRism.Core.Tests/Auth/GitHubCredentialHealthTests.cs
git commit -m "feat(#312): GitHub credential-health latch with consecutive-401 threshold"
```

---

### Task 2: `HostUrlResolver.IsGitHubDotCom` helper

**Files:**
- Modify: `PRism.GitHub/HostUrlResolver.cs`
- Test: `tests/PRism.GitHub.Tests/HostUrlResolverTests.cs` (create if absent)

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class HostUrlResolverIsGitHubDotComTests
{
    [Theory]
    [InlineData("https://api.github.com/user", true)]
    [InlineData("https://API.GITHUB.COM/user", true)]
    [InlineData("https://github.example.com/api/v3/user", false)]
    [InlineData(null, false)]
    public void IsGitHubDotCom_ClassifiesHost(string? uri, bool expected)
    {
        var u = uri is null ? null : new Uri(uri);
        Assert.Equal(expected, HostUrlResolver.IsGitHubDotCom(u));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~IsGitHubDotCom`
Expected: FAIL — `IsGitHubDotCom` not defined.

- [ ] **Step 3: Add the helper to `HostUrlResolver`**

Add to the `HostUrlResolver` static class:

```csharp
/// <summary>
/// True when <paramref name="requestUri"/> targets the github.com API host
/// (api.github.com). The "github" HttpClient's BaseAddress is HostUrlResolver.ApiBase,
/// so a github.com request resolves to api.github.com and a GHES request to the
/// enterprise host. Credential-health detection is github.com-only this slice (#312 §11).
/// </summary>
public static bool IsGitHubDotCom(Uri? requestUri) =>
    requestUri is not null && requestUri.Host.Equals("api.github.com", StringComparison.OrdinalIgnoreCase);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~IsGitHubDotCom`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/HostUrlResolver.cs tests/PRism.GitHub.Tests/HostUrlResolverTests.cs
git commit -m "feat(#312): add HostUrlResolver.IsGitHubDotCom for github.com-only scoping"
```

---

### Task 3: `GitHubAuthHealthHandler` delegating handler

**Files:**
- Create: `PRism.GitHub/GitHubAuthHealthHandler.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubAuthHealthHandlerTests.cs`

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Auth;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubAuthHealthHandlerTests
{
    private static HttpRequestMessage Req(bool auth = true, bool skip = false, string url = "https://api.github.com/user")
    {
        var r = new HttpRequestMessage(HttpMethod.Get, url);
        if (auth) r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "t");
        if (skip) r.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);
        return r;
    }

    private static async Task<HttpResponseMessage> Send(IGitHubCredentialHealth health, HttpStatusCode status, HttpRequestMessage req)
    {
        var handler = new GitHubAuthHealthHandler(health)
        {
            InnerHandler = new StubHandler(status)
        };
        var invoker = new HttpMessageInvoker(handler);
        return await invoker.SendAsync(req, CancellationToken.None);
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        public StubHandler(HttpStatusCode status) => _status = status;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(_status));
    }

    [Fact]
    public async Task TwoConsecutive401s_FlipInvalid()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.Unauthorized, Req());
        Assert.True(h.IsInvalid);
    }

    [Fact]
    public async Task Single401_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task Success_ClearsInvalid()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.Unauthorized, Req());
        await Send(h, HttpStatusCode.OK, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task NoAuthHeader_Ignored()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req(auth: false));
        await Send(h, HttpStatusCode.Unauthorized, Req(auth: false));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task SkipOption_Ignored()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Unauthorized, Req(skip: true));
        await Send(h, HttpStatusCode.Unauthorized, Req(skip: true));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task NonGitHubDotComHost_Ignored()
    {
        var h = new GitHubCredentialHealth();
        var url = "https://github.example.com/api/v3/user";
        await Send(h, HttpStatusCode.Unauthorized, Req(url: url));
        await Send(h, HttpStatusCode.Unauthorized, Req(url: url));
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task Forbidden_DoesNotFlip()
    {
        var h = new GitHubCredentialHealth();
        await Send(h, HttpStatusCode.Forbidden, Req());
        await Send(h, HttpStatusCode.Forbidden, Req());
        Assert.False(h.IsInvalid);
    }

    [Fact]
    public async Task EpochChangedDuringRequest_401Ignored()
    {
        // Simulate a replace landing mid-flight: bump epoch via a handler whose stub
        // bumps before returning 401. Easiest: pre-bump is not "during"; instead use a
        // stub that bumps the epoch inside SendAsync so epochBefore != epochAfter.
        var h = new GitHubCredentialHealth();
        var handler = new GitHubAuthHealthHandler(h)
        {
            InnerHandler = new BumpThenStatusHandler(h, HttpStatusCode.Unauthorized)
        };
        var invoker = new HttpMessageInvoker(handler);
        await invoker.SendAsync(Req(), CancellationToken.None);
        await invoker.SendAsync(Req(), CancellationToken.None);
        Assert.False(h.IsInvalid); // both 401s arrived under a bumped epoch → ignored
    }

    private sealed class BumpThenStatusHandler : HttpMessageHandler
    {
        private readonly IGitHubCredentialHealth _h;
        private readonly HttpStatusCode _status;
        public BumpThenStatusHandler(IGitHubCredentialHealth h, HttpStatusCode status) { _h = h; _status = status; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            _h.BumpEpoch(); // epoch moves between the handler's capture-before and check-after
            return Task.FromResult(new HttpResponseMessage(_status));
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubAuthHealthHandlerTests`
Expected: FAIL — `GitHubAuthHealthHandler` not defined.

- [ ] **Step 3: Write the handler**

```csharp
using System.Net;
using PRism.Core.Auth;

namespace PRism.GitHub;

/// <summary>
/// Observes responses on the named "github" HttpClient and feeds
/// <see cref="IGitHubCredentialHealth"/>: an authenticated github.com 401 records a
/// failure (flipping invalid at the threshold); an authenticated 2xx clears it.
/// Never alters the response. See spec §6.2. github.com-only this slice (§11).
/// </summary>
public sealed class GitHubAuthHealthHandler : DelegatingHandler
{
    public static readonly HttpRequestOptionsKey<bool> SkipHealthKey =
        new("prism-skip-credential-health");

    private readonly IGitHubCredentialHealth _health;

    public GitHubAuthHealthHandler(IGitHubCredentialHealth health) => _health = health;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var epochBefore = _health.Epoch;
        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        // Candidate-token validation probes opt out (§6.3).
        if (request.Options.TryGetValue(SkipHealthKey, out var skip) && skip) return response;
        // Only an authenticated request speaks to the stored token's validity.
        if (request.Headers.Authorization is null) return response;
        // Detection is github.com-only this slice (§11).
        if (!HostUrlResolver.IsGitHubDotCom(request.RequestUri)) return response;

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            // Ignore a 401 from a token already replaced mid-flight (epoch moved).
            if (_health.Epoch == epochBefore) _health.RecordAuthFailure();
        }
        else if (response.IsSuccessStatusCode)
        {
            _health.MarkValid();
        }
        return response;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubAuthHealthHandlerTests`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubAuthHealthHandler.cs tests/PRism.GitHub.Tests/GitHubAuthHealthHandlerTests.cs
git commit -m "feat(#312): GitHubAuthHealthHandler — transport-seam 401 detection"
```

---

## Phase 2 — Backend wiring

### Task 4: Register latch singleton + handler on the "github" client

**Files:**
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.GitHub.Tests/ServiceRegistrationTests.cs` (create)

- [ ] **Step 1: Write the failing test**

```csharp
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class ServiceRegistrationTests
{
    [Fact]
    public void RegistersCredentialHealthSingleton()
    {
        var services = new ServiceCollection();
        services.AddPrismGitHub();
        using var sp = services.BuildServiceProvider();

        var a = sp.GetRequiredService<IGitHubCredentialHealth>();
        var b = sp.GetRequiredService<IGitHubCredentialHealth>();
        Assert.Same(a, b); // singleton
        Assert.NotNull(sp.GetRequiredService<GitHubAuthHealthHandler>());
    }
}
```

> Note: no `IConfigStore` registration is needed here. `AddPrismGitHub` registers `IConfigStore`-dependent singletons (`GitHubReviewService`, the inbox pipeline) as **lazy factory** singletons; this test resolves only `IGitHubCredentialHealth` and `GitHubAuthHealthHandler`, neither of which depends on `IConfigStore`, so those factories never fire. (The `AddHttpClient("github", …)` lambda that reads `config.Current.Github.Host` also runs only when a client is created, which this test does not do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~ServiceRegistrationTests`
Expected: FAIL — `IGitHubCredentialHealth` not registered.

- [ ] **Step 3: Register in `AddPrismGitHub`**

In `ServiceCollectionExtensions.cs`, add the singleton + handler registration and chain the handler onto the `"github"` client. Replace the existing `services.AddHttpClient("github", …)` registration block:

```csharp
services.AddSingleton<IGitHubCredentialHealth, GitHubCredentialHealth>();
services.AddTransient<GitHubAuthHealthHandler>();

services.AddHttpClient("github", (sp, client) =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    client.BaseAddress = HostUrlResolver.ApiBase(config.Current.Github.Host);
})
.AddHttpMessageHandler<GitHubAuthHealthHandler>();
```

Ensure `using PRism.Core.Auth;` is present (already imported in `ServiceCollectionExtensions.cs:4` — a duplicate is harmless and IDE-cleaned).

> **Coverage note (production chaining):** `ServiceRegistrationTests` proves the latch is a singleton and the handler *type* resolves, but not that `.AddHttpMessageHandler<GitHubAuthHealthHandler>()` is actually chained onto the `"github"` client — a regression dropping that chain would leave unit tests green while detection is dead in production. The detection *logic* is proven in Task 3/Task 5 (real handler vs real 401), but the *wiring* is verified by the live smoke in Final Verification (a real github.com 401 in the running app must surface the banner). Treat the live-smoke step as required, not optional, for this reason.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~ServiceRegistrationTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/ServiceRegistrationTests.cs
git commit -m "feat(#312): register credential-health latch + handler on the github client"
```

---

### Task 5: Thread `skipCredentialHealth` through `ValidateCredentialsAsync`

**Files:**
- Modify: `PRism.Core/IReviewAuth.cs:9` (the interface method)
- Modify: `PRism.GitHub/GitHubReviewService.cs:69` (`ValidateCredentialsAsync`) + the fine-grained probe chain `ProbeRepoVisibilityAsync` (`:205`) → `SearchHasResultsAsync` (builds the request at `:218`)
- Modify (fakes that re-declare the signature — these BREAK otherwise, CS0535): `tests/PRism.Core.Tests/TestHelpers/StubReviewAuth.cs:24`, `PRism.Web/TestHooks/FakeReviewAuth.cs:10`, `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs:129` (`StubReviewService`), `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs:67`, `tests/PRism.Web.Tests/Endpoints/AuthReplaceEndpointTests.cs:101`, `tests/PRism.Web.Tests/Endpoints/AuthEndpointsLoggingTests.cs:81` (also grep `ValidateCredentialsAsync(CancellationToken ct)` for any other hand-written implementer, e.g. an `AuthEndpointsTests.cs` stub)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceValidateSkipTests.cs` (create)

**Rationale:** `ValidateCredentialsAsync` has three production callers — connect, replace (candidate tokens → skip), and `ViewerLoginHydrator` (stored token → do NOT skip, so a dead stored token contributes a failure at startup). The flag must be a parameter, not hardcoded (spec §6.3).

> **Implementer note (threshold interaction):** with `THRESHOLD = 2`, the hydrator's single startup 401 does NOT flip the latch by itself — it records one failure; the second arrives on the first inbox-poll 401, flipping it within one cadence. This is expected (spec §6.1) — do not "fix" it by lowering the threshold.

- [ ] **Step 1: Write the failing test**

```csharp
using System.Net;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceValidateSkipTests
{
    // Build a GitHubReviewService whose "github" client returns 401 on /user, with the
    // real GitHubAuthHealthHandler wired, then assert the skip flag controls latching.
    [Fact]
    public async Task Validate_WithSkip_DoesNotLatch()
    {
        var (svc, health) = Build(HttpStatusCode.Unauthorized, token: "ghp_bad");
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: true);
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: true);
        Assert.False(health.IsInvalid);
    }

    [Fact]
    public async Task Validate_WithoutSkip_LatchesAfterTwo()
    {
        var (svc, health) = Build(HttpStatusCode.Unauthorized, token: "ghp_bad");
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: false);
        await svc.ValidateCredentialsAsync(CancellationToken.None, skipCredentialHealth: false);
        Assert.True(health.IsInvalid);
    }

    private static (GitHubReviewService, IGitHubCredentialHealth) Build(HttpStatusCode status, string token)
    {
        var health = new GitHubCredentialHealth();
        var services = new ServiceCollection();
        services.AddSingleton<IGitHubCredentialHealth>(health);
        services.AddTransient<GitHubAuthHealthHandler>();
        services.AddHttpClient("github", c => c.BaseAddress = new Uri("https://api.github.com/"))
            .AddHttpMessageHandler<GitHubAuthHealthHandler>()
            .AddHttpMessageHandler(() => new FixedStatusHandler(status));
        var sp = services.BuildServiceProvider();
        var factory = sp.GetRequiredService<IHttpClientFactory>();
        var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>(token), "github.com", null);
        return (svc, health);
    }

    private sealed class FixedStatusHandler : DelegatingHandler
    {
        private readonly HttpStatusCode _status;
        public FixedStatusHandler(HttpStatusCode status) => _status = status;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(_status));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~ValidateSkip`
Expected: FAIL — `ValidateCredentialsAsync` has no `skipCredentialHealth` parameter (compile error).

- [ ] **Step 3: Add the parameter to the interface and implementation**

In `IReviewAuth` (PRism.Core), change the signature to:

```csharp
Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false);
```

In `GitHubReviewService.cs:69`, change the signature and set the option on the probe request:

```csharp
public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false)
{
    var token = await _readToken().ConfigureAwait(false);
    if (string.IsNullOrEmpty(token))
        return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

    var tokenType = ClassifyToken(token);

    using var http = _httpFactory.CreateClient("github");
    using var req = new HttpRequestMessage(HttpMethod.Get, "user");
    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    req.Headers.UserAgent.ParseAdd("PRism/0.1");
    req.Headers.Accept.ParseAdd("application/vnd.github+json");
    if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);
    // ... unchanged from here; pass `skipCredentialHealth` into ProbeRepoVisibilityAsync below.
```

In the fine-grained branch, thread the flag down the probe chain. `ProbeRepoVisibilityAsync` (`:205`) builds **no** request — it delegates to `SearchHasResultsAsync` (`:218`), which constructs the `HttpRequestMessage`. So thread the flag through **both**:

```csharp
// in the fine-grained branch of ValidateCredentialsAsync:
var warning = await ProbeRepoVisibilityAsync(token, ct, skipCredentialHealth).ConfigureAwait(false);
```

- `ProbeRepoVisibilityAsync(string token, CancellationToken ct, bool skipCredentialHealth)` — forward the flag into each `SearchHasResultsAsync(token, query, ct, skipCredentialHealth)` call.
- `SearchHasResultsAsync(string token, string query, CancellationToken ct, bool skipCredentialHealth)` — where it builds the request (`:218`), add `if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);`.

`GitHubAuthHealthHandler.SkipHealthKey` is in the same `PRism.GitHub` namespace — no extra using needed.

- [ ] **Step 3b: Update the hand-written `IReviewAuth` fakes**

The interface method now has two parameters; hand-written implementers declaring `ValidateCredentialsAsync(CancellationToken ct)` will fail with CS0535. Update each (listed in **Files** above) to match the new signature, e.g.:

```csharp
public Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false) => _validate();
```

(Moq-based fakes — e.g. `ViewerLoginHydratorTests` — need no change: `Setup(r => r.ValidateCredentialsAsync(It.IsAny<CancellationToken>()))` still binds via the default.) Run `dotnet build` across the test projects to confirm zero CS0535 errors before moving on.

- [ ] **Step 4: Run the test + full build across all suites**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~ValidateSkip`
Expected: PASS.
Run: `dotnet build` (solution) — Expected: no errors. Existing *callers* keep compiling via the default arg; the *implementer* fakes were fixed in Step 3b. If any CS0535 remains, an implementer fake was missed — grep `ValidateCredentialsAsync(CancellationToken ct)` again.

> **Red-on-main detection proof:** `Validate_WithoutSkip_LatchesAfterTwo` drives the **real** `GitHubAuthHealthHandler` (registered via `AddHttpMessageHandler`) against two real 401 status responses and asserts `health.IsInvalid` — i.e. the genuine end-to-end detection path, not a poked latch. On `origin/main` it cannot compile (`GitHubAuthHealthHandler` / `IGitHubCredentialHealth` absent). This is the headline behavioral proof; Task 7's endpoint test only proves `/api/auth/state` *surfaces* the latch.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewServiceValidateSkipTests.cs
git commit -m "feat(#312): thread skipCredentialHealth through ValidateCredentialsAsync probes"
```

---

### Task 6: Surface the latch on `/api/auth/state` + clear on (re)connect commit

**Files:**
- Modify: `PRism.Web/Endpoints/AuthDtos.cs:5`
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs` (the `/state` GET; the connect commit ~line 88; `/connect/commit`; the replace commit ~line 279; pass `skipCredentialHealth: true` from connect/replace validation)
- Test: covered by Task 7 integration tests; this task is the wiring + a unit-level DTO check.

- [ ] **Step 1: Extend the DTO**

In `AuthDtos.cs`, change `AuthStateResponse`:

```csharp
internal sealed record AuthStateResponse(bool HasToken, string Host, AuthHostMismatch? HostMismatch, bool GithubCredentialInvalid);
```

- [ ] **Step 2: Read the latch in `/api/auth/state`**

In `AuthEndpoints.cs`, the `MapGet("/api/auth/state", …)` delegate — add `IGitHubCredentialHealth credentialHealth` to the delegate parameters and include it in the response:

```csharp
app.MapGet("/api/auth/state", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, IGitHubCredentialHealth credentialHealth, ILogger<Category> log, CancellationToken ct) =>
{
    var hasToken = await tokens.HasTokenAsync(ct).ConfigureAwait(false);
    var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
    var host = config.Current.Github.Host;
    AuthHostMismatch? mismatch = null;
    if (state.LastConfiguredGithubHost is not null
        && !string.Equals(state.LastConfiguredGithubHost, host, StringComparison.OrdinalIgnoreCase))
    {
        mismatch = new AuthHostMismatch(state.LastConfiguredGithubHost, host);
    }
    Log.AuthStateProbed(log, hasToken, host, mismatch is not null);
    return Results.Ok(new AuthStateResponse(hasToken, host, mismatch, credentialHealth.IsInvalid));
});
```

Add `using PRism.Core.Auth;` to `AuthEndpoints.cs`.

- [ ] **Step 3: Pass `skipCredentialHealth: true` from connect + replace validation**

In `/api/auth/connect` (the `review.ValidateCredentialsAsync(ct)` call ~line 63) and `/api/auth/replace` (~line 220), pass the flag:

```csharp
var result = await review.ValidateCredentialsAsync(ct, skipCredentialHealth: true).ConfigureAwait(false);
```

(Both validate a *candidate* token; they must not latch the stored token.)

- [ ] **Step 4: `BumpEpoch()` + `MarkValid()` on successful commit**

Add `IGitHubCredentialHealth credentialHealth` to the `/api/auth/connect`, `/api/auth/connect/commit`, and `/api/auth/replace` delegate parameter lists. After each successful `tokens.CommitAsync(ct)`:

- Connect (after `CommitAsync` ~line 88) and connect/commit (after its `CommitAsync`): add
  ```csharp
  credentialHealth.BumpEpoch();
  credentialHealth.MarkValid();
  ```
- Replace (after `await tokens.CommitAsync(ct)` at ~line 279): add the same two lines.

- [ ] **Step 5: Build + run the existing auth endpoint tests**

Run: `dotnet build PRism.Web` — Expected: no errors.
Run: `dotnet test tests/PRism.Web.Tests --filter FullyQualifiedName~Auth`
Expected: PASS (existing tests still green; the new DTO field defaults are covered next task).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/AuthDtos.cs PRism.Web/Endpoints/AuthEndpoints.cs
git commit -m "feat(#312): surface githubCredentialInvalid on /api/auth/state; clear on (re)connect"
```

---

## Phase 3 — Backend integration tests

### Task 7: Endpoint integration tests (surfacing + mandatory-valid)

**Files:**
- Test: `tests/PRism.Web.Tests/Endpoints/CredentialHealthEndpointTests.cs` (create)

**Division of proof (no test-theater):** the **detection** path (real `GitHubAuthHealthHandler` observing a real 401 status → latch flips) is proven end-to-end in **Task 5** (`Validate_WithoutSkip_LatchesAfterTwo`, the red-on-main proof). The real test host (`PRismWebApplicationFactory`) fakes `IReviewAuth` and does **not** route through the real `"github"` HttpClient, so it cannot drive a transport 401 — and that's fine: Task 7's job is only to prove (a) `/api/auth/state` **surfaces** the latch, and (b) the latch-clear is **validation-gated** (a bad replace token can't clear it). Both use the real singleton latch (`IGitHubCredentialHealth`) resolved from `factory.Services` (the same instance the endpoint reads) plus the fixture's `ValidateOverride`.

- [ ] **Step 1: Write the failing tests**

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Auth;
using PRism.Core.Contracts;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class CredentialHealthEndpointTests
{
    private sealed record AuthStateDto(bool HasToken, string Host, object? HostMismatch, bool GithubCredentialInvalid);

    [Fact]
    public async Task State_DefaultsToValid()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient(); // authed client (session token auto-injected)
        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.False(state!.GithubCredentialInvalid);
    }

    [Fact]
    public async Task State_ReflectsInvalidLatch()
    {
        using var factory = new PRismWebApplicationFactory();
        var client = factory.CreateClient();
        // Poke the SAME singleton the endpoint reads (two failures crosses THRESHOLD).
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.True(state!.GithubCredentialInvalid);
    }

    [Fact]
    public async Task Replace_WithInvalidToken_DoesNotClearLatch()  // mandatory-valid guarantee
    {
        using var factory = new PRismWebApplicationFactory
        {
            // Validation rejects the candidate (simulates a still-bad token).
            ValidateOverride = () => Task.FromResult(
                new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "bad")),
        };
        var client = factory.CreateClient();
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();
        Assert.True(health.IsInvalid);

        var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.True(state!.GithubCredentialInvalid); // failed validation never called MarkValid
    }

    [Fact]
    public async Task Replace_WithValidToken_ClearsLatch()  // positive: MarkValid on success
    {
        using var factory = new PRismWebApplicationFactory
        {
            // Validation accepts the candidate (Ok=true, a login present).
            ValidateOverride = () => Task.FromResult(
                new AuthValidationResult(true, "octocat", null, null, null)),
        };
        var client = factory.CreateClient();
        var health = factory.Services.GetRequiredService<IGitHubCredentialHealth>();
        health.RecordAuthFailure();
        health.RecordAuthFailure();
        Assert.True(health.IsInvalid);

        var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
        resp.EnsureSuccessStatusCode(); // 200 OK

        var state = await client.GetFromJsonAsync<AuthStateDto>("/api/auth/state");
        Assert.False(state!.GithubCredentialInvalid); // successful commit called MarkValid → latch cleared
    }
}
```

> **Why this test matters (adversarial finding):** without it, omitting the `credentialHealth.MarkValid()` line on the commit path (Task 6 Step 4) would pass every other test — the mandatory-valid test only exercises the *failed*-validation branch. This pins the *success* branch that the no-flash recovery depends on.

> Verify the `AuthValidationResult` / `AuthValidationError` constructor shape against `PRism.Core` (grep — the fixture's `StubReviewService` uses the same type). If `ValidateOverride` is not the exact hook name in the current fixture, use the one the fixture exposes (it currently wires `IReviewAuth` from `ValidateOverride`). The `pat` value is an obviously-fake 36-x placeholder (not a real token).

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet test tests/PRism.Web.Tests --filter FullyQualifiedName~CredentialHealthEndpointTests`
Expected: FAIL — `GithubCredentialInvalid` / `IGitHubCredentialHealth` absent (won't compile on a pre-Task-6 tree). On `origin/main` the file cannot compile at all (handler/field/latch absent) — note this in the Proof; the **behavioral** red-on-main proof is Task 5's handler test.

- [ ] **Step 3: Run on the feature branch to verify green**

Run: `dotnet test tests/PRism.Web.Tests --filter FullyQualifiedName~CredentialHealthEndpointTests`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.Web.Tests/Endpoints/CredentialHealthEndpointTests.cs
git commit -m "test(#312): /api/auth/state surfaces latch; replace cannot clear it with a bad token"
```

---

## Phase 4 — Frontend signal plumbing

### Task 8: `AuthState` type + `apiClient` failure signal

**Files:**
- Modify: `frontend/src/api/types.ts:74`
- Modify: `frontend/src/api/client.ts` (the `if (!resp.ok)` block ~line 67)
- Test: `frontend/src/api/client.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient } from './client';

describe('apiClient prism-request-failed', () => {
  beforeEach(() => {
    document.cookie = 'prism-session=test';
  });

  it('dispatches prism-request-failed on a failed response', async () => {
    const spy = vi.fn();
    window.addEventListener('prism-request-failed', spy);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }) as Response,
    );
    await expect(apiClient.get('/api/anything')).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalled();
    window.removeEventListener('prism-request-failed', spy);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: FAIL — event not dispatched.

- [ ] **Step 3: Add the field + dispatch**

In `types.ts`, add to `AuthState`:

```ts
export interface AuthState {
  hasToken: boolean;
  host: string;
  hostMismatch: { old: string; new: string } | null;
  githubCredentialInvalid: boolean;
}
```

In `client.ts`, inside `if (!resp.ok) { … }`, after the existing 401 dispatch, add:

```ts
    window.dispatchEvent(new CustomEvent('prism-request-failed'));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/api/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/client.test.ts
git commit -m "feat(#312): AuthState.githubCredentialInvalid + prism-request-failed signal"
```

---

### Task 9: `useAuth` debounced refetch on `prism-request-failed`

**Files:**
- Modify: `frontend/src/hooks/useAuth.tsx`
- Test: `frontend/src/hooks/useAuth.test.tsx` (create or extend)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './useAuth';
import { apiClient } from '../api/client';

function Probe() {
  const { authState } = useAuth();
  return <div>{authState?.githubCredentialInvalid ? 'invalid' : 'valid'}</div>;
}

describe('useAuth prism-request-failed refetch', () => {
  it('refetches auth state when a request fails', async () => {
    const get = vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ hasToken: true, host: 'github.com', hostMismatch: null, githubCredentialInvalid: false } as never)
      .mockResolvedValue({ hasToken: true, host: 'github.com', hostMismatch: null, githubCredentialInvalid: true } as never);

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent('prism-request-failed'));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/hooks/useAuth.test.tsx`
Expected: FAIL — no refetch on `prism-request-failed`.

- [ ] **Step 3: Add the debounced listener**

In `useAuthState`'s `useEffect`, add a debounced handler for `prism-request-failed` alongside the existing listeners:

```tsx
  useEffect(() => {
    void refetch();
    const handler = () => { void refetch(); };

    // #312: any failed request is a cue to re-read /api/auth/state (the latch is the
    // source of truth). Debounced so frequent benign 4xx bursts don't refetch-storm.
    let debounceId: ReturnType<typeof setTimeout> | undefined;
    const onRequestFailed = () => {
      if (debounceId) clearTimeout(debounceId);
      debounceId = setTimeout(() => { void refetch(); }, 750);
    };

    window.addEventListener('focus', handler);
    window.addEventListener('prism-identity-changed', handler);
    window.addEventListener('prism-events-reconnected', handler);
    window.addEventListener('prism-request-failed', onRequestFailed);
    return () => {
      window.removeEventListener('focus', handler);
      window.removeEventListener('prism-identity-changed', handler);
      window.removeEventListener('prism-events-reconnected', handler);
      window.removeEventListener('prism-request-failed', onRequestFailed);
      if (debounceId) clearTimeout(debounceId);
    };
  }, [refetch]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/hooks/useAuth.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useAuth.tsx frontend/src/hooks/useAuth.test.tsx
git commit -m "feat(#312): useAuth debounced refetch on prism-request-failed"
```

---

## Phase 5 — Shared Snackbar primitive

### Task 10: Extract `Snackbar` primitive + re-point `StreamHealthSnackbar`

**Files:**
- Create: `frontend/src/components/Snackbar/Snackbar.tsx`, `frontend/src/components/Snackbar/Snackbar.module.css`, `frontend/src/components/Snackbar/index.ts`
- Modify: `frontend/src/components/StreamHealthSnackbar/StreamHealthSnackbar.tsx`
- Test: `frontend/src/components/Snackbar/Snackbar.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Snackbar } from './Snackbar';

describe('Snackbar', () => {
  it('renders message and action', async () => {
    const onClick = vi.fn();
    render(<Snackbar tone="danger" message="boom" action={{ label: 'Fix', onClick }} role="status" ariaLive="polite" />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('renders dismiss only when onDismiss is provided', () => {
    const { rerender } = render(<Snackbar tone="warning" message="m" role="status" ariaLive="polite" />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    rerender(<Snackbar tone="warning" message="m" onDismiss={() => {}} role="status" ariaLive="polite" />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('applies the tone class', () => {
    const { container } = render(<Snackbar tone="danger" message="m" role="status" ariaLive="polite" />);
    expect(container.firstChild).toHaveClass('danger');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Snackbar/Snackbar.test.tsx`
Expected: FAIL — `Snackbar` does not exist.

- [ ] **Step 3: Create the primitive**

`Snackbar.tsx`:

```tsx
import type { ReactNode } from 'react';
import styles from './Snackbar.module.css';

export interface SnackbarProps {
  tone: 'warning' | 'danger';
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  // Optional: omit when the consumer announces via its own always-mounted live
  // region (GitHubAuthBanner does this — Task 11) so the visible bar isn't a
  // second live region that double-announces.
  role?: 'status' | 'alert';
  ariaLive?: 'polite' | 'assertive';
}

export function Snackbar({ tone, message, action, onDismiss, role, ariaLive }: SnackbarProps) {
  return (
    <div className={`${styles.snackbar} ${styles[tone]}`} role={role} aria-live={ariaLive} aria-atomic={ariaLive ? 'true' : undefined}>
      <span className={styles.message}>{message}</span>
      {action && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
```

`Snackbar.module.css` (ported from `StreamHealthSnackbar.module.css`, tone-parameterized):

```css
.snackbar {
  position: fixed;
  top: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  font-size: 0.875rem;
  animation: snackbar-in 150ms ease-out;
}
.warning { background: var(--warning-soft); border: 1px solid var(--warning); color: var(--warning-fg); }
.danger  { background: var(--danger-soft);  border: 1px solid var(--danger);  color: var(--danger-fg); }
.message { white-space: nowrap; color: inherit; }
.action {
  background: transparent; color: inherit; border: none; padding: 0; font: inherit;
  font-weight: 600; text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.action:hover { text-decoration: none; }
.dismiss { background: none; border: none; cursor: pointer; color: inherit; font-size: 1.1rem; line-height: 1; padding: 0; opacity: 0.7; }
.dismiss:hover { opacity: 1; }
@keyframes snackbar-in {
  from { opacity: 0; transform: translate(-50%, -8px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) { .snackbar { animation: none; } }
```

`index.ts`:

```ts
export { Snackbar } from './Snackbar';
export type { SnackbarProps } from './Snackbar';
```

- [ ] **Step 4: Re-point `StreamHealthSnackbar` at the primitive (zero visual change)**

Rewrite `StreamHealthSnackbar.tsx` to render `<Snackbar tone="warning" … />`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import { Snackbar } from '../Snackbar';

export function StreamHealthSnackbar() {
  const { healthy, retry } = useStreamHealth();
  const [dismissed, setDismissed] = useState(false);
  const wasHealthy = useRef(healthy);

  useEffect(() => {
    if (wasHealthy.current && !healthy) setDismissed(false);
    wasHealthy.current = healthy;
  }, [healthy]);

  if (healthy || dismissed) return null;

  return (
    <Snackbar
      tone="warning"
      message="Connection lost — reconnecting"
      action={{ label: 'Retry now', onClick: retry }}
      onDismiss={() => setDismissed(true)}
      role="status"
      ariaLive="polite"
    />
  );
}
```

(The old `StreamHealthSnackbar.module.css` can be deleted; its styling now lives in the shared module. Keep its existing test file — it must stay green.)

- [ ] **Step 5: Run Snackbar + StreamHealthSnackbar tests**

Run: `cd frontend && npx vitest run src/components/Snackbar src/components/StreamHealthSnackbar`
Expected: PASS (new Snackbar tests + existing StreamHealthSnackbar test still green).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Snackbar frontend/src/components/StreamHealthSnackbar
git commit -m "refactor(#312): extract shared Snackbar primitive; re-point StreamHealthSnackbar"
```

---

## Phase 6 — Banner + route guard

### Task 11: `GitHubAuthBanner` component

**Files:**
- Create: `frontend/src/components/GitHubAuthBanner/GitHubAuthBanner.tsx`, `index.ts`
- Test: `frontend/src/components/GitHubAuthBanner/GitHubAuthBanner.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GitHubAuthBanner } from './GitHubAuthBanner';

const navigate = vi.fn();
let mockPath = '/';
let mockInvalid = true;
let mockHealthy = true;

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: mockPath }),
}));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    authState: { hasToken: true, host: 'github.com', hostMismatch: null, githubCredentialInvalid: mockInvalid },
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../hooks/useStreamHealth', () => ({ useStreamHealth: () => ({ healthy: mockHealthy, retry: vi.fn() }) }));

// The visible bar is the Reconnect button; the live region (role=status) is always present.
const reconnectButton = () => screen.queryByRole('button', { name: /reconnect/i });

describe('GitHubAuthBanner', () => {
  beforeEach(() => { navigate.mockClear(); mockPath = '/'; mockInvalid = true; mockHealthy = true; });

  it('shows the visible bar when invalid + authed + healthy + not on /setup', () => {
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull(); // non-dismissible
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect');
  });

  it('hides the visible bar on /setup but the live region still reflects the invalid credential', () => {
    mockPath = '/setup';
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull(); // visual bar suppressed on the fix screen
    // Announcement is keyed on the credential edge, not the visible bar, so it does NOT
    // blank-then-refill (re-announce) as the user moves between /setup and app routes.
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect');
  });

  it('hides the visible bar while the SSE stream is unhealthy', () => {
    mockHealthy = false;
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect'); // credential still invalid
  });

  it('clears the live region and shows no banner when the credential is valid', () => {
    mockInvalid = false;
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();       // always mounted
    expect(screen.getByRole('status')).toHaveTextContent('');     // empty when valid
  });

  it('Reconnect navigates to /setup?replace=1', async () => {
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    await userEvent.click(reconnectButton()!);
    expect(navigate).toHaveBeenCalledWith('/setup?replace=1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/GitHubAuthBanner`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create the component**

```tsx
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import { Snackbar } from '../Snackbar';

const MESSAGE = 'GitHub access token invalid — reconnect';

/**
 * #312: non-dismissible re-auth banner. The VISIBLE bar shows whenever the stored
 * GitHub credential is invalid and we're authed, the SSE stream is healthy, and we're
 * not on /setup (which IS the fix). No dismiss — only a valid token clears it.
 *
 * a11y (spec §7.4): the polite live region is ALWAYS mounted (the component never
 * returns null) with its text toggling on the invalid edge, so a screen reader
 * announces once when the banner appears and once when it clears — not on every
 * render, and reliably (region exists in the DOM before text is added). The visible
 * Snackbar carries NO role/aria-live so it isn't a second, double-announcing region.
 */
export function GitHubAuthBanner() {
  const { authState } = useAuth();
  const { healthy } = useStreamHealth();
  const location = useLocation();
  const navigate = useNavigate();

  const invalid = authState?.hasToken === true && authState?.githubCredentialInvalid === true;
  const onSetup = location.pathname === '/setup';
  const show = invalid && healthy && !onSetup;

  return (
    <>
      {/* Announcement keyed on the CREDENTIAL-INVALID edge (not `show`): the text is
          MESSAGE whenever the credential is invalid and '' when valid, so the screen
          reader announces once when the credential goes bad and the content does NOT
          flip on route/stream-health changes (e.g. navigating off /setup) — avoiding the
          repeated re-announce that keying on `show` would cause during the gate flow. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {invalid ? MESSAGE : ''}
      </div>
      {show && (
        <Snackbar
          tone="danger"
          message={MESSAGE}
          action={{ label: 'Reconnect', onClick: () => navigate('/setup?replace=1') }}
        />
      )}
    </>
  );
}
```

(`.sr-only` is the project's existing visually-hidden utility — grep `sr-only` to confirm; if its containing pane could clip an absolutely-positioned variant, this one is a normal-flow hidden `<div>` so it's unaffected.)

`index.ts`:

```ts
export { GitHubAuthBanner } from './GitHubAuthBanner';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/GitHubAuthBanner`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GitHubAuthBanner
git commit -m "feat(#312): GitHubAuthBanner non-dismissible re-auth banner"
```

---

### Task 12: `ReauthRouteGuard` + mount in App

**Files:**
- Create: `frontend/src/components/ReauthRouteGuard.tsx`
- Test: `frontend/src/components/ReauthRouteGuard.test.tsx`
- Modify: `frontend/src/App.tsx` (mount `GitHubAuthBanner` + `ReauthRouteGuard` inside `tree`)

**Behavior:** once the user is on `/setup` while the credential is invalid, they cannot leave until it becomes valid — any navigation away redirects back to `/setup?replace=1`. The banner (Task 11) is the cue on app routes; this guard is the one-way lock.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ReauthRouteGuard } from './ReauthRouteGuard';

const navigate = vi.fn();
let mockPath = '/setup';
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: mockPath }),
}));

function renderAt(path: string, invalid: boolean) {
  mockPath = path;
  return render(<ReauthRouteGuard credentialInvalid={invalid} />);
}

describe('ReauthRouteGuard', () => {
  it('holds the user on /setup once entered under an invalid credential', () => {
    navigate.mockClear();
    const { rerender } = renderAt('/setup', true);     // enter the gate
    mockPath = '/';                                     // try to leave
    rerender(<ReauthRouteGuard credentialInvalid={true} />);
    expect(navigate).toHaveBeenCalledWith('/setup?replace=1', { replace: true });
  });

  it('does not redirect when credential is valid', () => {
    navigate.mockClear();
    const { rerender } = renderAt('/setup', false);
    mockPath = '/';
    rerender(<ReauthRouteGuard credentialInvalid={false} />);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not trap a user who never entered /setup', () => {
    navigate.mockClear();
    renderAt('/', true); // invalid but on an app route, never on /setup
    expect(navigate).not.toHaveBeenCalled();
  });

  it('releases the user when the credential becomes valid (no bounce)', () => {
    // The recovery flow: on /setup with invalid=true, SetupPage commits a valid token,
    // `await refetch()` flips credentialInvalid=false, THEN navigate('/'). The guard must
    // see valid by the time the route is '/', so it releases instead of bouncing back.
    navigate.mockClear();
    const { rerender } = renderAt('/setup', true);            // entered the gate
    mockPath = '/';
    rerender(<ReauthRouteGuard credentialInvalid={false} />); // credential now valid + route changed
    expect(navigate).not.toHaveBeenCalled();                  // released, no infinite bounce
  });
});
```

> **Implementer note (recovery ordering):** this release depends on `SetupPage` doing `await refetch()` *before* `navigate('/')` on a successful replace (so `credentialInvalid` is already `false` when the route changes). Confirm `SetupPage`'s replace-success path awaits the refetch before navigating; if it ever navigates first, the guard would bounce. Do not change the guard to compensate — fix the ordering at the navigation site.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ReauthRouteGuard.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create the guard**

```tsx
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * #312: one-way exit-gate for the replace screen. Once the user is on /setup while
 * the GitHub credential is invalid, they cannot leave until it becomes valid — any
 * away-navigation redirects back to /setup?replace=1. Mirrors the first-run gate but
 * scoped to the re-auth case (we do NOT tear down app state / isAuthed).
 */
export function ReauthRouteGuard({ credentialInvalid }: { credentialInvalid: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const enteredGate = useRef(false);
  const onSetup = location.pathname === '/setup';

  useEffect(() => {
    if (!credentialInvalid) {
      enteredGate.current = false;
      return;
    }
    if (onSetup) {
      enteredGate.current = true;
      return;
    }
    if (enteredGate.current) {
      navigate('/setup?replace=1', { replace: true });
    }
  }, [credentialInvalid, onSetup, navigate]);

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ReauthRouteGuard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount in `App.tsx`**

In `App.tsx`, compute the derived flag near `isAuthed` (line ~101):

```tsx
  const credentialInvalid = authState.hasToken && authState.githubCredentialInvalid === true;
```

Inside the `tree` fragment, next to `<StreamHealthSnackbar />` (line ~184), add:

```tsx
      <StreamHealthSnackbar />
      <GitHubAuthBanner />
      <ReauthRouteGuard credentialInvalid={credentialInvalid} />
```

Add imports at the top of `App.tsx`:

```tsx
import { GitHubAuthBanner } from './components/GitHubAuthBanner';
import { ReauthRouteGuard } from './components/ReauthRouteGuard';
```

- [ ] **Step 6: Typecheck + run the App test suite**

Run: `cd frontend && npm run build` (runs `tsc -b` — catches type errors vitest's esbuild misses)
Expected: no type errors.
Run: `cd frontend && npx vitest run src/App.test.tsx src/components/GitHubAuthBanner src/components/ReauthRouteGuard`
Expected: PASS (existing App tests still green).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ReauthRouteGuard.tsx frontend/src/components/ReauthRouteGuard.test.tsx frontend/src/App.tsx
git commit -m "feat(#312): mount re-auth banner + one-way /setup exit-gate"
```

---

## Phase 7 — Visual baseline (B1)

### Task 13: Playwright visual baseline for the re-auth banner

**Files:**
- Test: add to the existing auth-state-fake e2e suite (grep `e2e` for the fake `/api/auth/state` route; reuse the pattern that lets a test force auth-state values).

- [ ] **Step 1: Add the e2e scenario**

Add a Playwright test that forces `/api/auth/state` to return `githubCredentialInvalid: true` (via the existing fake-mode route override), navigates to `/`, waits for the banner text "GitHub access token invalid — reconnect", and takes a screenshot:

```ts
test('re-auth banner renders when credential invalid', async ({ page }) => {
  await setAuthStateFake(page, { hasToken: true, host: 'github.com', hostMismatch: null, githubCredentialInvalid: true });
  await page.goto('/');
  await expect(page.getByText('GitHub access token invalid — reconnect')).toBeVisible();
  await expect(page).toHaveScreenshot('reauth-banner.png');
});
```

> Use the repo's existing fake-auth-state helper (grep e2e for how other tests stub `/api/auth/state`). If none exists, add a fake-mode override consistent with the existing `PRISM_E2E_FAKE_*` seams.

- [ ] **Step 2: Generate the baseline locally**

Run the e2e suite to create the initial baseline (win32 local). Then regenerate the **Linux** baseline from the CI artifact per the house process (download the CI `e2e-results` actual.png, verify the diff is only the new banner, commit it as the Linux baseline) — see `reference: regen Linux Playwright parity baseline via CI artifact`.

- [ ] **Step 3: Commit**

```bash
git add e2e/ frontend/  # baseline png(s) + spec
git commit -m "test(#312): Playwright visual baseline for the re-auth banner"
```

---

## Self-review checklist (run before handing off)

- [ ] **Spec coverage:** every AC in §4 maps to a task — latch (T1), threshold (T1/T3), surfacing (T6), banner (T11), Reconnect route (T11), transient-no-flip (T1/T3), candidate-skip (T5), epoch race (T1/T3), suppression on /setup + !healthy (T11), exit-gate (T12), github.com-only (T2/T3).
- [ ] **Red-on-main:** T5 (`Validate_WithoutSkip_LatchesAfterTwo`) captures the failing-on-main proof — the real handler observing a real 401. T7's endpoint tests only prove surfacing + mandatory-valid.
- [ ] **Secrets scan:** the handler/latch touch status codes + the *presence* of an Authorization header only — no token material logged or persisted (confirm in the diff at PR time).
- [ ] **Type consistency:** `RecordAuthFailure` / `MarkValid` / `BumpEpoch` / `Epoch` / `IsInvalid` used identically across T1, T3, T5, T6; `githubCredentialInvalid` identical across T6, T8, T9, T11; `SkipHealthKey` shared T3/T5; `prism-request-failed` shared T8/T9.
- [ ] **B1 gate:** banner copy + position go to the owner at green-and-ready (T13 screenshot).

## Final verification (after all tasks)

- [ ] `dotnet test` (Core + GitHub + Web suites) — all green.
- [ ] `cd frontend && npm run build && npx vitest run` — typecheck clean, all green.
- [ ] `cd frontend && npx prettier --check` via `rtk proxy npx prettier --check .` (rtk masks the exit code — verify with the proxy).
- [ ] **Live smoke (required — pins production handler chaining):** run the app, invalidate the stored PAT mid-session (revoke it on GitHub, or point at a token that 401s), and confirm the red banner appears on an app route and the `/setup?replace=1` exit-gate holds until a valid token is committed. This is the only check that proves `.AddHttpMessageHandler<GitHubAuthHealthHandler>()` is actually wired onto the `"github"` client in production (the unit tests can't).
- [ ] Pre-push checklist per `.ai/docs/development-process.md`.
