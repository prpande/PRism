# Real-flow Playwright e2e Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4-scenario real-flow Playwright e2e suite for PRism's submit pipeline against live GitHub (`prpande/prism-sandbox`), with a gated `DelegatingHandler` seam in `PRism.Web/TestHooks` for in-flight failure injection.

**Architecture:** Separate Playwright config (`playwright.real.config.ts`) drives PRism in real-GitHub mode on port 5181 against per-teammate fixture PRs on the shared private sandbox repo. A DI-registered `DelegatingHandler` intercepts the GraphQL `HttpClient` pipeline, consulting a singleton failure injector keyed on the top-level GraphQL selection-field name (e.g., `addPullRequestReviewThread`). The PAT comes from `gh auth token --hostname github.com` at `globalSetup`-time and is committed through PRism's real `/api/auth/connect` flow into the keychain-backed `TokenStore`. Four long-lived fixture PRs per teammate, idempotently created by a one-time setup script; per-test `resetSandboxFixture` force-resets the branch + deletes leftover pending reviews + clears PRism's PR session via `/test/clear-pr-session`.

**Tech Stack:** C# .NET 10, ASP.NET Core minimal APIs, `Microsoft.Extensions.Http` `DelegatingHandler`, MSAL.NET `TokenStore`. Frontend: React 19 + Vite + TypeScript, Playwright, `tsx`, `dotenv`, `gh` CLI.

**Origin spec:** [`docs/specs/2026-05-18-real-flow-e2e-playwright-design.md`](../specs/2026-05-18-real-flow-e2e-playwright-design.md). Read it first — this plan implements §4-§7 of that spec verbatim.

---

## Pre-implementation prereqs

These need to land BEFORE the implementation starts. Verify each is satisfied — `npm run test:e2e:real` will fail in confusing ways if any is missing.

1. **Sandbox-repo Actions disabled:**
   ```bash
   gh api -X PUT repos/prpande/prism-sandbox/actions/permissions -F enabled=false
   gh api repos/prpande/prism-sandbox/actions/permissions  # verify: {"enabled":false}
   ```

2. **Sandbox-repo `master` has no branch protection blocking force-push from collaborators:**
   ```bash
   gh api repos/prpande/prism-sandbox/branches/master/protection
   # expected: 404 (no protection rule)
   ```

3. **Worktree on the docs branch:** Verify `git -C D:/src/PRism-real-flow-e2e branch --show-current` returns `docs/real-flow-e2e`. The spec was committed there as commits 1-3 of this branch.

---

## File structure

Three modification surfaces:

| Project | New files | Modified |
|---|---|---|
| `PRism.Web` | `TestHooks/TestFailureInjectionHandler.cs`, `TestHooks/RealTransportFailureInjector.cs`, `TestHooks/RealInjectEndpoints.cs` | `TestHooks/TestEndpoints.cs` (+`/test/clear-pr-session`), `Program.cs` (3 blocks + UseStaticWebAssets gate widen) |
| `tests/PRism.Web.Tests` | `TestHooks/RealTransportFailureInjectorTests.cs`, `TestHooks/TestFailureInjectionHandlerTests.cs`, `TestHooks/RealInjectEndpointsTests.cs`, `TestHooks/ClearPrSessionEndpointTests.cs`, `TestHooks/ProgramMutexCheckTests.cs` | — |
| `frontend` | `playwright.real.config.ts`, `scripts/setup-real-e2e-fixtures.ts`, `e2e/real/global-setup.ts`, `e2e/real/helpers/{gh-sandbox,real-inject,reset-sandbox-fixture}.ts`, `e2e/real/s5-real-{happy-path,foreign-pending-review,lost-response-adoption,stale-commit-oid}.spec.ts` | `package.json` (scripts + devDeps), `.gitignore` (+`e2e/real/fixtures.json`, `.env.local`) |
| `docs` | `e2e/real-flow.md` | `specs/2026-05-11-s5-submit-pipeline-deferrals.md` (revisions-log + status update) |

Order: backend (Tasks 1-5) → frontend infra (Tasks 6-12) → specs (Tasks 13-16) → docs + deferral closeout (Tasks 17-18) → pre-push + regression-net attestation (Task 19).

---

## Phase 1: Backend seam + endpoints

### Task 1: `RealTransportFailureInjector` (failure-state container)

**Files:**
- Create: `PRism.Web/TestHooks/RealTransportFailureInjector.cs`
- Test: `tests/PRism.Web.Tests/TestHooks/RealTransportFailureInjectorTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/TestHooks/RealTransportFailureInjectorTests.cs`:

```csharp
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class RealTransportFailureInjectorTests
{
    [Fact]
    public void TryConsume_Pre_ReturnsArmedException_AndConsumes()
    {
        var injector = new RealTransportFailureInjector();
        var ex = new HttpRequestException("simulated");
        injector.InjectFailure("addPullRequestReviewThread", ex, afterEffect: false);

        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out var taken));
        Assert.Same(ex, taken);

        // One-shot: second call returns false.
        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
    }

    [Fact]
    public void TryConsume_AfterEffectMismatch_DoesNotConsume()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("simulated"), afterEffect: true);

        // Arming an afterEffect=true should NOT be consumed by an afterEffectWanted=false probe.
        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
        // Still armed for the matching probe.
        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: true, out _));
    }

    [Fact]
    public void TryConsume_DifferentFieldName_DoesNotMatch()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("simulated"), afterEffect: false);

        Assert.False(injector.TryConsume("submitPullRequestReview", afterEffectWanted: false, out _));
    }

    [Fact]
    public void Reset_ClearsAllArmedFailures()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("a"), afterEffect: false);
        injector.InjectFailure("submitPullRequestReview", new HttpRequestException("b"), afterEffect: true);

        injector.Reset();

        Assert.False(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: false, out _));
        Assert.False(injector.TryConsume("submitPullRequestReview", afterEffectWanted: true, out _));
    }
}
```

- [ ] **Step 2: Verify the test fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~RealTransportFailureInjectorTests"`

Expected: build FAIL ("type or namespace `RealTransportFailureInjector` could not be found").

- [ ] **Step 3: Implement `RealTransportFailureInjector`**

Create `PRism.Web/TestHooks/RealTransportFailureInjector.cs`:

```csharp
namespace PRism.Web.TestHooks;

// Companion to TestFailureInjectionHandler (sibling file). Stores one-shot failure
// arms keyed on the top-level GraphQL selection-field name (e.g. "addPullRequestReviewThread").
// Engaged only when both ASPNETCORE_ENVIRONMENT=Test and PRISM_E2E_REAL_INJECT=1 are set
// — registration site is Program.cs.
//
// Why field-name key (not C# method name like the fake-side FakeReviewSubmitter): this
// injector sits at the HTTP transport layer below GitHubReviewService, where the C# method
// boundary is not visible — only the outgoing GraphQL request body is. The key space is
// intentionally different from the fake-side because the layers are different.
internal sealed class RealTransportFailureInjector
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (Exception Ex, bool AfterEffect)> _armed = new(StringComparer.Ordinal);

    public void InjectFailure(string graphQLFieldName, Exception ex, bool afterEffect)
    {
        ArgumentException.ThrowIfNullOrEmpty(graphQLFieldName);
        ArgumentNullException.ThrowIfNull(ex);
        lock (_gate) _armed[graphQLFieldName] = (ex, afterEffect);
    }

    // Returns true (and the exception) iff a one-shot is armed for graphQLFieldName whose
    // afterEffect flag equals afterEffectWanted; consumes the arm in that case.
    public bool TryConsume(string graphQLFieldName, bool afterEffectWanted, out Exception ex)
    {
        lock (_gate)
        {
            if (_armed.TryGetValue(graphQLFieldName, out var entry) && entry.AfterEffect == afterEffectWanted)
            {
                _armed.Remove(graphQLFieldName);
                ex = entry.Ex;
                return true;
            }
        }
        ex = null!;
        return false;
    }

    public void Reset()
    {
        lock (_gate) _armed.Clear();
    }
}
```

- [ ] **Step 4: Verify the test passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~RealTransportFailureInjectorTests"`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add PRism.Web/TestHooks/RealTransportFailureInjector.cs tests/PRism.Web.Tests/TestHooks/RealTransportFailureInjectorTests.cs
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add RealTransportFailureInjector

One-shot failure-arm container keyed on GraphQL selection-field name.
Mirror of FakeReviewSubmitter.InjectFailure but for the real GraphQL
transport layer (different key space because it sits below the C# method
boundary).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `TestFailureInjectionHandler` (DelegatingHandler)

**Files:**
- Create: `PRism.Web/TestHooks/TestFailureInjectionHandler.cs`
- Test: `tests/PRism.Web.Tests/TestHooks/TestFailureInjectionHandlerTests.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Web.Tests/TestHooks/TestFailureInjectionHandlerTests.cs`:

```csharp
using System.Net;
using System.Text;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class TestFailureInjectionHandlerTests
{
    // The handler chain ends with this stub so we can assert pass-through and observe
    // whether the inner SendAsync ran (proxy for "the real GitHub call would have landed").
    private sealed class StubInnerHandler : HttpMessageHandler
    {
        public int CallCount { get; private set; }
        public HttpResponseMessage Response { get; set; } = new(HttpStatusCode.OK)
        {
            Content = new StringContent("""{"data":{}}""", Encoding.UTF8, "application/json"),
        };

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            CallCount++;
            return Task.FromResult(Response);
        }
    }

    private static HttpRequestMessage Mutation(string body) => new(HttpMethod.Post, "https://api.github.com/graphql")
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    // The simplest realistic GraphQL POST body PRism emits.
    private const string AddThreadBody = """
        {
          "query": "\n            mutation($prReviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {\n              addPullRequestReviewThread(input: { pullRequestReviewId: $prReviewId, body: $body, path: $path, line: $line, side: $side }) {\n                thread { id }\n              }\n            }\n          ",
          "variables": {"prReviewId":"PRR_1","body":"x","path":"src/Calc.cs","line":3,"side":"RIGHT"}
        }
        """;

    [Fact]
    public async Task PreEffect_ThrowsBeforeInner()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("pre"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.SendAsync(Mutation(AddThreadBody)));
        Assert.Equal(0, stub.CallCount);   // inner did NOT run
    }

    [Fact]
    public async Task PostEffect_ThrowsAfterInnerRan()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThread", new HttpRequestException("post"), afterEffect: true);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        await Assert.ThrowsAsync<HttpRequestException>(() => client.SendAsync(Mutation(AddThreadBody)));
        Assert.Equal(1, stub.CallCount);   // inner DID run (simulated lost-response window)
    }

    [Fact]
    public async Task NoArm_PassesThrough()
    {
        var injector = new RealTransportFailureInjector();
        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }

    [Fact]
    public async Task ArmForDifferentField_DoesNotMatch()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("submitPullRequestReview", new HttpRequestException("wrong"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));   // addPullRequestReviewThread body
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }

    [Fact]
    public async Task PrefixCollision_AddThread_DoesNotConsumeAddThreadReply_Arm()
    {
        // addPullRequestReviewThread is a STRICT PREFIX of addPullRequestReviewThreadReply.
        // A naive .Contains() impl would match both. Verify identifier-boundary parsing.
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("addPullRequestReviewThreadReply", new HttpRequestException("wrong"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation(AddThreadBody));   // body's field name is addPullRequestReviewThread
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
        // The Reply arm is still pending (not consumed by the prefix-matching call).
        Assert.True(injector.TryConsume("addPullRequestReviewThreadReply", afterEffectWanted: false, out _));
    }

    [Fact]
    public async Task NonGraphQLBody_PassesThrough_SafeAgainstMalformedJson()
    {
        var injector = new RealTransportFailureInjector();
        injector.InjectFailure("anything", new HttpRequestException("should not fire"), afterEffect: false);

        var stub = new StubInnerHandler();
        var handler = new TestFailureInjectionHandler(injector) { InnerHandler = stub };
        var client = new HttpClient(handler);

        var resp = await client.SendAsync(Mutation("not json at all"));
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        Assert.Equal(1, stub.CallCount);
    }
}
```

- [ ] **Step 2: Verify the tests fail**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~TestFailureInjectionHandlerTests"`

Expected: build FAIL.

- [ ] **Step 3: Implement `TestFailureInjectionHandler`**

Create `PRism.Web/TestHooks/TestFailureInjectionHandler.cs`:

```csharp
using System.Text.RegularExpressions;

namespace PRism.Web.TestHooks;

// DelegatingHandler that intercepts the GraphQL HttpClient pipeline (the "github" named client
// configured in PRism.GitHub/ServiceCollectionExtensions.cs). For each outgoing request we:
//   1. sniff the top-level GraphQL selection-field name from the request body,
//   2. consult RealTransportFailureInjector for a pre-effect arm — throw BEFORE forwarding,
//   3. forward to the inner handler (real GitHub call lands),
//   4. consult RealTransportFailureInjector for an after-effect arm — throw AFTER receiving
//      the response (simulates the "lost response" window: GitHub committed, client never saw it).
//
// Gating: registered into the chain only when ASPNETCORE_ENVIRONMENT=Test AND PRISM_E2E_REAL_INJECT=1
// (see Program.cs). Cannot engage in production.
//
// Sniff scope: works for the mutations PRism emits — all anonymous form
// "mutation($vars) { selectionField(...) { ... } }". The regex captures the first identifier
// after the outer brace. Match using exact string equality — addPullRequestReviewThread is a
// strict prefix of addPullRequestReviewThreadReply, so substring/prefix matching would silently
// mis-route. Read queries wrap their data in repository { pullRequest { ... } }; the sniff
// yields "repository" for those, not useful as an injection key. None of the four real-flow
// scenarios inject into queries today; if a future scenario needs to, the handler grows a
// per-query-name lookup.
internal sealed partial class TestFailureInjectionHandler : DelegatingHandler
{
    private readonly RealTransportFailureInjector _injector;

    public TestFailureInjectionHandler(RealTransportFailureInjector injector)
    {
        _injector = injector ?? throw new ArgumentNullException(nameof(injector));
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var fieldName = await TrySniffFieldNameAsync(request, cancellationToken).ConfigureAwait(false);
        if (fieldName is null)
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }

        if (_injector.TryConsume(fieldName, afterEffectWanted: false, out var preEx))
        {
            throw preEx;
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);

        if (_injector.TryConsume(fieldName, afterEffectWanted: true, out var postEx))
        {
            throw postEx;
        }

        return response;
    }

    // Reads the request body (StringContent — safe to re-read; buffered). Parses the JSON envelope
    // to extract the "query" string, then regex-matches the top-level selection-field inside the
    // query. Parsing the JSON envelope first (instead of scanning the raw body) avoids false
    // matches in the "variables" sub-object — `{ "variables": { "prReviewId": ...` could land
    // confusing matches under a naive raw-body regex.
    private static async Task<string?> TrySniffFieldNameAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (request.Content is null) return null;

        string body;
        try
        {
            body = await request.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch
        {
            return null;
        }

        string? query;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("query", out var queryElement)) return null;
            query = queryElement.GetString();
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
        if (string.IsNullOrEmpty(query)) return null;

        var match = FieldNameRegex().Match(query);
        return match.Success ? match.Groups[1].Value : null;
    }

    // Matches the first { followed by an identifier followed by ( — the top-level GraphQL
    // selection-field of an anonymous mutation/query body. Identifier-boundary parsing is
    // load-bearing: addPullRequestReviewThread is a strict prefix of addPullRequestReviewThreadReply.
    [GeneratedRegex(@"\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(")]
    private static partial Regex FieldNameRegex();
}
```

- [ ] **Step 4: Verify the tests pass**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~TestFailureInjectionHandlerTests"`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add PRism.Web/TestHooks/TestFailureInjectionHandler.cs tests/PRism.Web.Tests/TestHooks/TestFailureInjectionHandlerTests.cs
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add TestFailureInjectionHandler DelegatingHandler

Intercepts the GraphQL HttpClient pipeline; sniffs the top-level GraphQL
selection-field name; consults RealTransportFailureInjector for pre-effect
and after-effect arms. Identifier-boundary regex match — addPullRequestReviewThread
is a strict prefix of addPullRequestReviewThreadReply so substring matching
would mis-route.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `RealInjectEndpoints` — `/test/real-inject/inject-failure`

**Files:**
- Create: `PRism.Web/TestHooks/RealInjectEndpoints.cs`
- Test: `tests/PRism.Web.Tests/TestHooks/RealInjectEndpointsTests.cs`

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/TestHooks/RealInjectEndpointsTests.cs`:

```csharp
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PRism.Web.TestHooks;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class RealInjectEndpointsTests : IClassFixture<RealInjectAppFactory>
{
    private readonly RealInjectAppFactory _factory;
    public RealInjectEndpointsTests(RealInjectAppFactory factory) => _factory = factory;

    [Fact]
    public async Task PostInjectFailure_WhenGateEngaged_ArmsInjector()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", _factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/real-inject/inject-failure", new
        {
            graphQLFieldName = "addPullRequestReviewThread",
            afterEffect = true,
            message = "simulated post-effect",
        });

        Assert.True(resp.IsSuccessStatusCode, $"status={resp.StatusCode} body={await resp.Content.ReadAsStringAsync()}");

        var injector = _factory.Services.GetRequiredService<RealTransportFailureInjector>();
        Assert.True(injector.TryConsume("addPullRequestReviewThread", afterEffectWanted: true, out _));
    }

    [Fact]
    public async Task PostInjectFailure_WhenFieldNameMissing_Returns400()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", _factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/real-inject/inject-failure", new
        {
            afterEffect = true,
            message = "simulated",
        });
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, resp.StatusCode);
    }
}

// WebApplicationFactory that turns ON Test env + REAL_INJECT for these tests. The env-var-driven
// gate in Program.cs reads at startup, so we set the var BEFORE the factory creates the host.
//
// CRITICAL: per-test DataDir isolation. Without UseSetting("DataDir", …) the host falls back to
// %LOCALAPPDATA%/PRism on the developer's machine and the test mutates the developer's live
// state.json. See the existing PRismWebApplicationFactory.cs for the established pattern.
//
// Env-var mutation is process-wide; xUnit parallelizes test classes by default. The
// EnvVarMutating collection (see Collections.cs) serializes the env-touching tests so they
// don't race with one another.
[Collection("EnvVarMutating")]
public sealed class RealInjectAppFactory : WebApplicationFactory<Program>
{
    private readonly string _dataDir;

    public RealInjectAppFactory()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), $"PRism-real-inject-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dataDir);
        Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", "1");
    }

    protected override IHostBuilder? CreateHostBuilder()
    {
        var builder = base.CreateHostBuilder();
        builder?.UseEnvironment("Test");
        builder?.ConfigureWebHost(b => b.UseSetting("DataDir", _dataDir));
        return builder;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", null);
            try { Directory.Delete(_dataDir, recursive: true); } catch { /* best-effort cleanup */ }
        }
        base.Dispose(disposing);
    }
}
```

You also need a tiny collections file once. Create `tests/PRism.Web.Tests/TestHooks/Collections.cs`:

```csharp
using Xunit;

namespace PRism.Web.Tests.TestHooks;

// Serializes test classes that mutate process-wide env vars. xUnit parallelizes test classes
// by default; without a shared CollectionDefinition, RealInjectAppFactory and
// ProgramMutexCheckTests can race on PRISM_E2E_REAL_INJECT / PRISM_E2E_FAKE_REVIEW.
[CollectionDefinition("EnvVarMutating", DisableParallelization = true)]
public sealed class EnvVarMutatingCollection { }
```

- [ ] **Step 2: Verify the test fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~RealInjectEndpointsTests"`

Expected: build FAIL ("type or namespace `RealInjectEndpoints` could not be found") or runtime FAIL (404).

- [ ] **Step 3: Implement `RealInjectEndpoints`**

Create `PRism.Web/TestHooks/RealInjectEndpoints.cs`:

```csharp
namespace PRism.Web.TestHooks;

// Test-only endpoint for arming RealTransportFailureInjector from a Playwright spec.
// Symmetric to TestEndpoints' /test/submit/inject-failure (fake-side equivalent).
//
// Self-gates inside the extension method on (Test env + PRISM_E2E_REAL_INJECT=1) — Program.cs
// can call MapRealInjectEndpoints() unconditionally without worrying about exposure in
// Production. Matches the pattern TestEndpoints.cs already uses.
internal static class RealInjectEndpoints
{
    internal sealed record InjectFailureRequest(string? GraphQLFieldName, bool AfterEffect = false, string? Message = null);

    public static IEndpointRouteBuilder MapRealInjectEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        var env = app.ServiceProvider.GetRequiredService<IHostEnvironment>();
        var realInjectEnabled = Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1";
        if (!env.IsEnvironment("Test") || !realInjectEnabled) return app;

        app.MapPost("/test/real-inject/inject-failure", (InjectFailureRequest req, RealTransportFailureInjector injector) =>
        {
            if (string.IsNullOrEmpty(req.GraphQLFieldName))
                return Results.BadRequest(new { error = "graphQLFieldName-missing" });

            injector.InjectFailure(req.GraphQLFieldName, new HttpRequestException(req.Message ?? "simulated transport failure"), req.AfterEffect);
            return Results.Ok(new { ok = true });
        });

        return app;
    }
}
```

Note: `RealTransportFailureInjector` must be registered as a singleton in DI. That happens in Task 5 (Program.cs). For the test to pass standalone, the test factory needs both the env vars set AND the registration; the env-var-driven block in Task 5 takes care of both because the same gate guards the AddSingleton and the MapRealInjectEndpoints.

- [ ] **Step 4: Verify the test passes**

Tasks 3 and 5 are interlocked: Task 5's Program.cs changes provide the DI registration that the Task 3 endpoint needs. Run Task 5 implementation first if Task 3 alone doesn't have a clean target, OR keep Task 3 unfinished until Task 5 lands and run both test suites at the end of Task 5.

Pragmatic order: skip the Step 4 verify for Task 3 here; verify both Task 3 and Task 5 together at the end of Task 5.

- [ ] **Step 5: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add PRism.Web/TestHooks/RealInjectEndpoints.cs tests/PRism.Web.Tests/TestHooks/RealInjectEndpointsTests.cs
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add /test/real-inject/inject-failure endpoint

Self-gates on Test env + PRISM_E2E_REAL_INJECT. Mirrors the fake-side
/test/submit/inject-failure shape. Tests provisional — full verification
in Task 5 once Program.cs DI registration lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `/test/clear-pr-session` endpoint

**Files:**
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs` (add `MapPost` for `/test/clear-pr-session` inside `MapTestEndpoints`)
- Test: `tests/PRism.Web.Tests/TestHooks/ClearPrSessionEndpointTests.cs`

- [ ] **Step 1: Read the existing `TestEndpoints.cs` to find the right insertion point**

Read `PRism.Web/TestHooks/TestEndpoints.cs`. The handler goes inside the `MapTestEndpoints` method, anywhere after the existing `app.MapPost("/test/reset", ...)` block. Follow the same shape (StoreMissing / Origin / Origin header etc).

- [ ] **Step 2: Write the failing test**

Create `tests/PRism.Web.Tests/TestHooks/ClearPrSessionEndpointTests.cs`:

```csharp
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Web;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

public class ClearPrSessionEndpointTests
{
    [Fact]
    public async Task ClearPrSession_NukesSession_AndRemovesSubscribers()
    {
        var factory = new TestEnvAppFactory();
        using var scope = factory.Services.CreateScope();
        var stateStore = scope.ServiceProvider.GetRequiredService<IAppStateStore>();
        var registry = scope.ServiceProvider.GetRequiredService<ActivePrSubscriberRegistry>();

        // Pre-arrange: write a session for acme/api/123 with stamped LastViewedHeadSha, register a subscriber.
        var prRef = new PrReference("acme", "api", 123);
        await stateStore.UpdateAsync(state =>
        {
            var session = new ReviewSessionState(
                LastViewedHeadSha: "abc123",
                LastSeenCommentId: null,
                PendingReviewId: "PRR_x",
                PendingReviewCommitOid: "abc123",
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: new List<DraftComment>(),
                DraftReplies: new List<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft);
            var sessions = new Dictionary<string, ReviewSessionState> { ["acme/api/123"] = session };
            return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
        }, CancellationToken.None);
        registry.Add("test-subscriber-1", prRef);

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("Origin", factory.Server.BaseAddress!.ToString().TrimEnd('/'));

        var resp = await client.PostAsJsonAsync("/test/clear-pr-session", new
        {
            owner = "acme",
            repo = "api",
            number = 123,
        });

        Assert.Equal(System.Net.HttpStatusCode.NoContent, resp.StatusCode);

        var after = await stateStore.LoadAsync(CancellationToken.None);
        Assert.False(after.Reviews.Sessions.ContainsKey("acme/api/123"));
        Assert.Empty(registry.SubscribersFor(prRef));
    }
}

internal sealed class TestEnvAppFactory : WebApplicationFactory<Program>, IDisposable
{
    private readonly string _dataDir;

    public TestEnvAppFactory()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), $"PRism-clear-prsess-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dataDir);
    }

    protected override Microsoft.Extensions.Hosting.IHostBuilder? CreateHostBuilder()
    {
        var builder = base.CreateHostBuilder();
        builder?.UseEnvironment("Test");
        builder?.ConfigureWebHost(b => b.UseSetting("DataDir", _dataDir));
        return builder;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            try { Directory.Delete(_dataDir, recursive: true); } catch { /* best-effort */ }
        }
        base.Dispose(disposing);
    }
}
```

- [ ] **Step 3: Verify the test fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~ClearPrSessionEndpointTests"`

Expected: 404 (endpoint not registered yet).

- [ ] **Step 4: Implement the endpoint**

Open `PRism.Web/TestHooks/TestEndpoints.cs`. Add this record near the top with the other internal records:

```csharp
internal sealed record ClearPrSessionRequest(string Owner, string Repo, int Number);
```

Inside `MapTestEndpoints`, after the `/test/mark-pr-viewed` block, add:

```csharp
// Nukes the PR's session in state.json (drafts, PendingReviewId, LastViewedHeadSha,
// DraftSummary, DraftVerdict) without touching auth state, AND removes every subscriber
// for this PR from ActivePrSubscriberRegistry so the ActivePrPoller stops ticking it
// between specs. Required by the real-flow Playwright suite's resetSandboxFixture;
// reusable elsewhere if a future fake-mode spec wants per-PR session reset.
app.MapPost("/test/clear-pr-session", async (ClearPrSessionRequest req, IAppStateStore stateStore, ActivePrSubscriberRegistry registry) =>
{
    if (string.IsNullOrEmpty(req.Owner) || string.IsNullOrEmpty(req.Repo))
        return Results.BadRequest(new { error = "owner-or-repo-missing" });

    var key = $"{req.Owner}/{req.Repo}/{req.Number}";
    var prRef = new PrReference(req.Owner, req.Repo, req.Number);

    await stateStore.UpdateAsync(state =>
    {
        if (!state.Reviews.Sessions.ContainsKey(key)) return state;
        var sessions = state.Reviews.Sessions
            .Where(kv => kv.Key != key)
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
    }, CancellationToken.None).ConfigureAwait(false);

    // Subscriber-registry mutation is concurrent-dict; iterate snapshot and Remove each.
    // ActivePrPoller takes UniquePrRefs() at tick-start, so any Remove between ticks is
    // observed on the next tick — no shared lock needed across state-store and registry.
    foreach (var subscriberId in registry.SubscribersFor(prRef))
    {
        registry.Remove(subscriberId, prRef);
    }

    return Results.NoContent();
});
```

- [ ] **Step 5: Verify the test passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~ClearPrSessionEndpointTests"`

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add PRism.Web/TestHooks/TestEndpoints.cs tests/PRism.Web.Tests/TestHooks/ClearPrSessionEndpointTests.cs
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add /test/clear-pr-session endpoint

Clears a PR's session (drafts + pending-review stamps + LastViewedHeadSha)
in state.json AND removes every ActivePrSubscriberRegistry subscriber for
that PR so the poller stops ticking it during inter-spec quiesce. Required
by resetSandboxFixture in the real-flow Playwright suite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `Program.cs` wiring — mutex + handler registration + endpoint map + UseStaticWebAssets widen

**Files:**
- Modify: `PRism.Web/Program.cs`
- Test: `tests/PRism.Web.Tests/TestHooks/ProgramMutexCheckTests.cs`

- [ ] **Step 1: Read the existing `Program.cs` to identify insertion points**

Read `PRism.Web/Program.cs` lines 1-100. Note the existing `UseStaticWebAssets` block (~line 21-25) and the `PRISM_E2E_FAKE_REVIEW` block (~line 50-67). Identify where `builder.Services.AddPrismGitHub()` is called — the REAL_INJECT handler block must run AFTER that call.

- [ ] **Step 2: Write the failing test for the mutex check**

Create `tests/PRism.Web.Tests/TestHooks/ProgramMutexCheckTests.cs`:

```csharp
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web;
using Xunit;

namespace PRism.Web.Tests.TestHooks;

[Collection("EnvVarMutating")]
public class ProgramMutexCheckTests
{
    [Fact]
    public void Startup_RejectsBothEnvVarsSetSimultaneously()
    {
        Environment.SetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW", "1");
        Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", "1");
        try
        {
            var factory = new WebApplicationFactory<Program>();
            // WebApplicationFactory may wrap the startup exception (TargetInvocationException,
            // host-bootstrap aggregation). Use ThrowsAny and walk inner exceptions.
            var ex = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
            var found = false;
            for (var e = (Exception?)ex; e is not null; e = e.InnerException)
            {
                if (e is InvalidOperationException
                    && e.Message.Contains("mutually exclusive", StringComparison.OrdinalIgnoreCase))
                {
                    found = true;
                    break;
                }
            }
            Assert.True(found, $"Expected InvalidOperationException with 'mutually exclusive' message in chain; got: {ex}");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW", null);
            Environment.SetEnvironmentVariable("PRISM_E2E_REAL_INJECT", null);
        }
    }
}
```

- [ ] **Step 3: Verify the test fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~ProgramMutexCheckTests"`

Expected: FAIL (no exception thrown — both env vars are happily ignored by current Program.cs).

- [ ] **Step 4: Edit Program.cs — mutex check, UseStaticWebAssets widen, handler registration, endpoint map**

Make four edits to `PRism.Web/Program.cs`:

**4a. Widen the existing `UseStaticWebAssets()` gate** (replace the existing block):

```csharp
// Static Web Assets manifest gating — see existing comment for full context.
// Engages under Test env + EITHER fake-review OR real-inject (both modes need wwwroot).
if (builder.Environment.IsEnvironment("Test")
    && (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
     || Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1"))
{
    builder.WebHost.UseStaticWebAssets();
}
```

**4b. Add the mutex check immediately after the UseStaticWebAssets block:**

```csharp
// FAKE_REVIEW and REAL_INJECT are mutually exclusive — fake backend with injection
// would intercept calls that never reach GitHub, producing confusing behavior.
if (Environment.GetEnvironmentVariable("PRISM_E2E_FAKE_REVIEW") == "1"
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    throw new InvalidOperationException(
      "PRISM_E2E_FAKE_REVIEW and PRISM_E2E_REAL_INJECT are mutually exclusive — " +
      "injection only makes sense against the real GitHub backend.");
}
```

**4c. Add the REAL_INJECT handler-registration block AFTER `builder.Services.AddPrismGitHub()` and AFTER the existing FAKE_REVIEW block:**

```csharp
// Test env + REAL_INJECT: attach TestFailureInjectionHandler to the "github" named HttpClient.
// MUST run after AddPrismGitHub() so the named "github" client is already configured by
// PRism.GitHub.ServiceCollectionExtensions.AddPrismGitHub; this call is additive on the
// same client name (preserves BaseAddress).
if (builder.Environment.IsEnvironment("Test")
 && Environment.GetEnvironmentVariable("PRISM_E2E_REAL_INJECT") == "1")
{
    builder.Services.AddSingleton<RealTransportFailureInjector>();
    builder.Services.AddTransient<TestFailureInjectionHandler>();
    builder.Services.AddHttpClient("github")
        .AddHttpMessageHandler<TestFailureInjectionHandler>();
}
```

You need a `using PRism.Web.TestHooks;` at the top of Program.cs if it's not already there.

**4d. Add the `MapRealInjectEndpoints` call near the existing `MapTestEndpoints` call:**

Find the line `app.MapTestEndpoints();` and add immediately after:

```csharp
app.MapRealInjectEndpoints();   // self-gates on Test env + REAL_INJECT
```

- [ ] **Step 5: Run all Phase 1 tests together**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~TestHooks"`

Expected: All Phase 1 tests pass (RealTransportFailureInjectorTests + TestFailureInjectionHandlerTests + RealInjectEndpointsTests + ClearPrSessionEndpointTests + ProgramMutexCheckTests).

- [ ] **Step 6: Run full backend test suite to ensure nothing regressed**

Run: `dotnet test --configuration Debug` from the repo root.

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add PRism.Web/Program.cs tests/PRism.Web.Tests/TestHooks/ProgramMutexCheckTests.cs
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): wire REAL_INJECT seam in Program.cs

- Widen UseStaticWebAssets gate to engage under REAL_INJECT=1 too
- Mutex check: FAKE_REVIEW + REAL_INJECT both set → InvalidOperationException
- Register TestFailureInjectionHandler into the 'github' HttpClient chain
  AFTER AddPrismGitHub (named-client additive semantics)
- Map /test/real-inject/* endpoints (extension method self-gates)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2: Frontend test infrastructure

### Task 6: `package.json` scripts + devDeps + `.gitignore`

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/.gitignore`

- [ ] **Step 1: Add `tsx` and `dotenv` to devDependencies + add the two npm scripts**

In `frontend/package.json`, under `"scripts"`:

```json
"setup-real-e2e-fixtures": "tsx scripts/setup-real-e2e-fixtures.ts",
"test:e2e:real": "playwright test --config=playwright.real.config.ts"
```

Under `"devDependencies"`, add (use the latest stable versions current at impl time):

```json
"tsx": "^4.19.0",
"dotenv": "^16.4.5"
```

Run `npm install` from `frontend/` to fetch them.

- [ ] **Step 2: Add `.gitignore` entries**

Append to `frontend/.gitignore`:

```
# Real-flow e2e suite — locally-generated state
e2e/real/fixtures.json
.env.local
```

- [ ] **Step 3: Verify npm scripts resolve**

Run: `cd frontend && npm run setup-real-e2e-fixtures -- --help 2>&1 | head -5`

Expected: `tsx`-driven error like `Cannot find module 'scripts/setup-real-e2e-fixtures.ts'` (script doesn't exist yet — that's Task 11). The point is that `tsx` and `npm run` resolved the script entry.

- [ ] **Step 4: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/package.json frontend/package-lock.json frontend/.gitignore
git -C D:/src/PRism-real-flow-e2e commit -m "chore(real-flow-e2e): add tsx + dotenv devDeps; npm scripts; gitignore entries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `playwright.real.config.ts`

**Files:**
- Create: `frontend/playwright.real.config.ts`

- [ ] **Step 1: Create the config**

Create `frontend/playwright.real.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// .env.local is optional today (gh CLI is the primary PAT source per design §7.5).
// Loaded for forward-compat in case future overrides need it.
dotenv.config({ path: '.env.local' });

// Per-run DataDir keeps the suite hermetic — no leakage from a developer's local
// %LOCALAPPDATA%/PRism state.json. globalSetup will commit the PAT into this DataDir's
// PRism.tokens.cache via the real /api/auth/connect flow.
const e2eDataDir = path.join(os.tmpdir(), `PRism-e2e-real-${Date.now()}`);
fs.mkdirSync(e2eDataDir, { recursive: true });

const backend = {
  command:
    'cd .. && dotnet run --project PRism.Web --no-launch-profile --urls http://localhost:5181 -- --no-browser',
  url: 'http://localhost:5181/api/health',
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    // PRISM_E2E_FAKE_REVIEW deliberately NOT set — Program.cs rejects the combo.
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '1',
  },
};

export default defineConfig({
  testDir: './e2e/real',
  fullyParallel: false,
  workers: 1,
  retries: 0, // see design §7.6 — flake-loudly is intentional for real-flow
  globalSetup: './e2e/real/global-setup.ts',
  webServer: [backend],
  use: {
    browserName: 'chromium' as const,
    baseURL: 'http://localhost:5181',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'real' }],
});
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/playwright.real.config.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add playwright.real.config.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `helpers/gh-sandbox.ts`

**Files:**
- Create: `frontend/e2e/real/helpers/gh-sandbox.ts`
- Create: `frontend/e2e/real/helpers/sandbox-fixture.ts` (the shared TypeScript types)

- [ ] **Step 1: Create the shared types file**

Create `frontend/e2e/real/helpers/sandbox-fixture.ts`:

```typescript
// Per-fixture metadata recorded in fixtures.json (locally generated, gitignored).
// One entry per fixture name (happy / foreign / lost-response / stale-oid). Fields
// are populated by setup-real-e2e-fixtures.ts (Task 11) and consumed by every spec.
export interface SandboxFixture {
  name: 'happy' | 'foreign' | 'lost-response' | 'stale-oid';
  branch: string;       // e.g. "e2e-real-happy-fixture-pratyush"
  prNumber: number;
  prNodeId: string;
  baseOid: string;      // commit at which the fixture branch was seeded
  anchorFile: string;   // e.g. "src/Calc.cs" — file in the diff specs can comment on
  anchorLine: number;
}
```

- [ ] **Step 2: Create the gh-sandbox helper**

Create `frontend/e2e/real/helpers/gh-sandbox.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import type { SandboxFixture } from './sandbox-fixture';

// Hardcoded per design §5.1. YAGNI parameterization until a teammate actually needs a
// different sandbox — at which point the seam is a one-line config object.
const OWNER = 'prpande';
const REPO = 'prism-sandbox';

// gh CLI argv-style invocation — no shell interpolation. Output is JSON; throws on non-zero exit.
function gh<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out) as T;
}

function ghText(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

let _viewerLogin: string | null = null;
export function viewerLogin(): string {
  if (_viewerLogin !== null) return _viewerLogin;
  const result = gh<{ data: { viewer: { login: string } } }>([
    'api',
    'graphql',
    '-f',
    'query={ viewer { login } }',
  ]);
  _viewerLogin = result.data.viewer.login;
  return _viewerLogin;
}

export function getPrHeadOid(prNumber: number): string {
  const result = gh<{ data: { repository: { pullRequest: { headRefOid: string } } } }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { headRefOid } } }`,
  ]);
  return result.data.repository.pullRequest.headRefOid;
}

export interface OwnPendingReview {
  id: string;
  commitOid: string;
}

export function listOwnPendingReviews(prNumber: number): OwnPendingReview[] {
  const me = viewerLogin();
  const result = gh<{
    data: { repository: { pullRequest: { reviews: { nodes: Array<{ id: string; commit: { oid: string }; author: { login: string } | null }> } } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { reviews(states: PENDING, first: 5) { nodes { id author { login } commit { oid } } } } } }`,
  ]);
  return result.data.repository.pullRequest.reviews.nodes
    .filter((r) => r.author?.login === me)
    .map((r) => ({ id: r.id, commitOid: r.commit.oid }));
}

export interface SubmittedReview {
  id: string;
  state: string;
  body: string;
  submittedAt: string;
  commitOid: string;
  threadCount: number;
}

// Filtered by viewer.login AND submittedAt >= sinceTs so prior runs' reviews don't pollute counts.
// sinceTs comes from GitHub server clock (see reset-sandbox-fixture.ts), not test-runner clock.
export function listSubmittedReviewsSince(prNumber: number, sinceTs: string): SubmittedReview[] {
  const me = viewerLogin();
  const result = gh<{
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<{
              id: string;
              state: string;
              body: string;
              submittedAt: string | null;
              author: { login: string } | null;
              commit: { oid: string };
              comments: { totalCount: number };
            }>;
          };
        };
      };
    };
  }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { pullRequest(number: ${prNumber}) { reviews(first: 10, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) { nodes { id state body submittedAt author { login } commit { oid } comments(first: 1) { totalCount } } } } } }`,
  ]);
  const since = new Date(sinceTs).getTime();
  return result.data.repository.pullRequest.reviews.nodes
    .filter((r) => r.author?.login === me)
    .filter((r) => r.submittedAt && new Date(r.submittedAt).getTime() >= since)
    .map((r) => ({
      id: r.id,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt!,
      commitOid: r.commit.oid,
      threadCount: r.comments.totalCount,
    }));
}

export interface CreatePendingReviewResult {
  pullRequestReviewId: string;
  threadId: string;
}

export function createPendingReview(fixture: SandboxFixture, opts: { threadBody: string }): CreatePendingReviewResult {
  // Step 1: addPullRequestReview (creates the PENDING review at the PR's current head).
  const created = gh<{
    data: { addPullRequestReview: { pullRequestReview: { id: string; commit: { oid: string } } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { addPullRequestReview(input: { pullRequestId: "${fixture.prNodeId}", commitOID: "${getPrHeadOid(fixture.prNumber)}" }) { pullRequestReview { id commit { oid } } } }`,
  ]);
  const pullRequestReviewId = created.data.addPullRequestReview.pullRequestReview.id;

  // Step 2: addPullRequestReviewThread (attach one thread at the fixture's anchor line).
  // Body literal contains the user's text; we don't include the PRism HTML-comment marker
  // intentionally — the foreign-pending-review spec relies on the seeded thread having no marker.
  const body = opts.threadBody.replaceAll('"', '\\"');
  const thread = gh<{
    data: { addPullRequestReviewThread: { thread: { id: string } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { addPullRequestReviewThread(input: { pullRequestReviewId: "${pullRequestReviewId}", body: "${body}", path: "${fixture.anchorFile}", line: ${fixture.anchorLine}, side: RIGHT }) { thread { id } } }`,
  ]);

  return {
    pullRequestReviewId,
    threadId: thread.data.addPullRequestReviewThread.thread.id,
  };
}

export function deletePendingReview(reviewId: string): void {
  gh<unknown>([
    'api',
    'graphql',
    '-f',
    `query=mutation { deletePullRequestReview(input: { pullRequestReviewId: "${reviewId}" }) { pullRequestReview { id } } }`,
  ]);
}

export interface AdvanceHeadResult {
  newHeadOid: string;
}

export function advanceHead(
  fixture: SandboxFixture,
  opts: { fileChanges: Array<{ path: string; contentBase64: string }>; commitMessage: string },
): AdvanceHeadResult {
  const expectedHeadOid = getPrHeadOid(fixture.prNumber);
  const additions = opts.fileChanges
    .map((f) => `{ path: "${f.path}", contents: "${f.contentBase64}" }`)
    .join(', ');
  const result = gh<{
    data: { createCommitOnBranch: { commit: { oid: string } } };
  }>([
    'api',
    'graphql',
    '-f',
    `query=mutation { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: "${OWNER}/${REPO}", branchName: "${fixture.branch}" }, message: { headline: "${opts.commitMessage}" }, fileChanges: { additions: [${additions}] }, expectedHeadOid: "${expectedHeadOid}" }) { commit { oid } } }`,
  ]);
  return { newHeadOid: result.data.createCommitOnBranch.commit.oid };
}

// REST API force-reset. Returns the Date header value so callers can use it as sinceTs.
export function forceResetBranch(fixture: SandboxFixture): { serverTs: string } {
  // gh api -i prints headers. We extract Date: line.
  const raw = ghText([
    'api',
    '-i',
    '-X',
    'PATCH',
    `repos/${OWNER}/${REPO}/git/refs/heads/${fixture.branch}`,
    '-F',
    `sha=${fixture.baseOid}`,
    '-F',
    'force=true',
  ]);
  const dateHeader = raw.split('\n').find((line) => line.toLowerCase().startsWith('date:'));
  const dateValue = dateHeader?.substring('date:'.length).trim() ?? new Date().toUTCString();
  return { serverTs: new Date(dateValue).toISOString() };
}
```

- [ ] **Step 3: Verify the file compiles (no lint errors)**

Run: `cd frontend && npx tsc --noEmit e2e/real/helpers/gh-sandbox.ts e2e/real/helpers/sandbox-fixture.ts 2>&1 | head -10`

Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/helpers/gh-sandbox.ts frontend/e2e/real/helpers/sandbox-fixture.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add gh-sandbox helper + fixture types

Typed wrappers around gh api for: list pending/submitted reviews, create/delete
pending reviews, advance head via createCommitOnBranch, force-reset branch.
listSubmittedReviewsSince filters by viewer.login + sinceTs to scope assertions
to the current test. forceResetBranch returns the Date response header as the
sinceTs source (server clock, not test-runner clock).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `helpers/real-inject.ts`

**Files:**
- Create: `frontend/e2e/real/helpers/real-inject.ts`

- [ ] **Step 1: Create the helper**

```typescript
import type { APIRequestContext } from '@playwright/test';

// Arms the RealTransportFailureInjector for one in-flight GraphQL call to GitHub.
// Key is the top-level GraphQL selection-field name (e.g. "addPullRequestReviewThread"),
// NOT a C# method name — see design §4.1 + §4.2 for the layer-key rationale.
export async function injectRealFailure(
  request: APIRequestContext,
  opts: { graphQLFieldName: string; afterEffect: boolean; message?: string },
): Promise<void> {
  const resp = await request.post('http://localhost:5181/test/real-inject/inject-failure', {
    data: opts,
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) {
    throw new Error(`POST /test/real-inject/inject-failure failed: ${resp.status()} ${await resp.text()}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/helpers/real-inject.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add real-inject helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `helpers/reset-sandbox-fixture.ts`

**Files:**
- Create: `frontend/e2e/real/helpers/reset-sandbox-fixture.ts`

- [ ] **Step 1: Create the helper**

```typescript
import type { APIRequestContext } from '@playwright/test';
import * as gh from './gh-sandbox';
import type { SandboxFixture } from './sandbox-fixture';

export interface ResetResult {
  // GitHub server clock at the end of the reset — used by listSubmittedReviewsSince
  // to scope assertions to this test only. Read from the forceResetBranch response's
  // Date header rather than test-runner clock to defend against clock skew.
  sinceTs: string;
}

export async function resetSandboxFixture(
  request: APIRequestContext,
  fixture: SandboxFixture,
): Promise<ResetResult> {
  // 1. Delete any leftover viewer-owned pending reviews (crash recovery from prior run).
  for (const p of gh.listOwnPendingReviews(fixture.prNumber)) {
    gh.deletePendingReview(p.id);
  }

  // 2. Force-reset the fixture branch to its baseOid; capture server clock from response.
  const { serverTs } = gh.forceResetBranch(fixture);

  // 3. Clear PRism's local PR session AND unsubscribe from IActivePrCache via /test/clear-pr-session.
  const resp = await request.post('http://localhost:5181/test/clear-pr-session', {
    data: { owner: 'prpande', repo: 'prism-sandbox', number: fixture.prNumber },
    headers: { Origin: 'http://localhost:5181' },
  });
  if (!resp.ok()) {
    throw new Error(`/test/clear-pr-session failed: ${resp.status()} ${await resp.text()}`);
  }

  return { sinceTs: serverTs };
}
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/helpers/reset-sandbox-fixture.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add resetSandboxFixture helper

Per-test reset: delete viewer-owned pending reviews → force-reset branch →
clear PRism PR session. Returns sinceTs from server clock (response Date
header) for assertion scoping.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `scripts/setup-real-e2e-fixtures.ts` (one-time setup)

**Files:**
- Create: `frontend/scripts/setup-real-e2e-fixtures.ts`

- [ ] **Step 1: Create the setup script**

```typescript
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
// Import the shared type instead of redeclaring — keeps the strict union from
// helpers/sandbox-fixture.ts authoritative across the script and the consumers.
import type { SandboxFixture } from '../e2e/real/helpers/sandbox-fixture';

const OWNER = 'prpande';
const REPO = 'prism-sandbox';
const FIXTURE_NAMES = ['happy', 'foreign', 'lost-response', 'stale-oid'] as const;

function gh<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8' });
  return JSON.parse(out) as T;
}

function ghText(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: unknown) {
    return '';
  }
}

function viewerLogin(): string {
  const result = gh<{ data: { viewer: { login: string } } }>([
    'api',
    'graphql',
    '-f',
    'query={ viewer { login } }',
  ]);
  return result.data.viewer.login;
}

function masterHeadOid(): string {
  const result = gh<{ data: { repository: { ref: { target: { oid: string } } } } }>([
    'api',
    'graphql',
    '-f',
    `query={ repository(owner: "${OWNER}", name: "${REPO}") { ref(qualifiedName: "refs/heads/master") { target { oid } } } }`,
  ]);
  return result.data.repository.ref.target.oid;
}

function branchExists(branch: string): boolean {
  const result = ghText([
    'api',
    `repos/${OWNER}/${REPO}/branches/${branch}`,
    '--silent',
  ]);
  return result.length > 0 || ghText(['api', `repos/${OWNER}/${REPO}/branches/${branch}`]).includes('"name"');
}

function ensureBranchAtSeed(branch: string, _name: string): { baseOid: string; anchorFile: string; anchorLine: number } {
  const anchorFile = 'src/Calc.cs';
  const anchorLine = 3;
  // Seed content — a 5-line C# stub with line 3 as the anchorable line. base64-encoded for createCommitOnBranch.
  const seedContent = `namespace Sandbox;
public static class Calc
{
    public static int Add(int a, int b) => a + b;
    public static int Sub(int a, int b) => a - b;
}
`;
  const contentBase64 = Buffer.from(seedContent, 'utf8').toString('base64');

  if (!branchExists(branch)) {
    // Create branch from master head, then commit the anchor file via createCommitOnBranch.
    const head = masterHeadOid();
    gh<unknown>([
      'api',
      '-X',
      'POST',
      `repos/${OWNER}/${REPO}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${head}`,
    ]);
    gh<unknown>([
      'api',
      'graphql',
      '-f',
      `query=mutation { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: "${OWNER}/${REPO}", branchName: "${branch}" }, message: { headline: "seed: fixture anchor" }, fileChanges: { additions: [{ path: "${anchorFile}", contents: "${contentBase64}" }] }, expectedHeadOid: "${head}" }) { commit { oid } } }`,
    ]);
  }

  // Read the current branch tip — that's the fixture's baseOid going forward.
  const branchInfo = gh<{ commit: { sha: string } }>([
    'api',
    `repos/${OWNER}/${REPO}/branches/${branch}`,
  ]);
  return { baseOid: branchInfo.commit.sha, anchorFile, anchorLine };
}

function ensurePr(branch: string, name: string, login: string): { number: number; nodeId: string } {
  // List PRs targeting master from this branch.
  const list = gh<Array<{ number: number; node_id: string }>>([
    'api',
    `repos/${OWNER}/${REPO}/pulls?head=${OWNER}:${branch}&state=open`,
  ]);
  if (list.length > 0) {
    return { number: list[0].number, nodeId: list[0].node_id };
  }
  // Create.
  const created = gh<{ number: number; node_id: string }>([
    'api',
    '-X',
    'POST',
    `repos/${OWNER}/${REPO}/pulls`,
    '-f',
    `title=[e2e fixture, ${login}] ${name}`,
    '-f',
    `head=${branch}`,
    '-f',
    'base=master',
    '-f',
    'body=Generated by setup-real-e2e-fixtures.ts. Safe to delete if no longer needed.',
  ]);
  return { number: created.number, nodeId: created.node_id };
}

function main(): void {
  const login = viewerLogin();
  console.log(`[setup-real-e2e-fixtures] viewer=${login} repo=${OWNER}/${REPO}`);

  const fixtures: SandboxFixture[] = [];
  for (const name of FIXTURE_NAMES) {
    const branch = `e2e-real-${name}-fixture-${login}`;
    console.log(`[setup] processing ${branch}`);
    const { baseOid, anchorFile, anchorLine } = ensureBranchAtSeed(branch, name);
    const pr = ensurePr(branch, name, login);
    fixtures.push({
      name,
      branch,
      prNumber: pr.number,
      prNodeId: pr.nodeId,
      baseOid,
      anchorFile,
      anchorLine,
    });
    console.log(`[setup]   → pr=#${pr.number} baseOid=${baseOid.slice(0, 8)}`);
  }

  const outPath = path.join('e2e', 'real', 'fixtures.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));
  console.log(`[setup] wrote ${outPath} (${fixtures.length} fixtures)`);
}

main();
```

- [ ] **Step 2: Verify (dry-run check)**

Run: `cd frontend && npx tsc --noEmit scripts/setup-real-e2e-fixtures.ts 2>&1 | head -10`

Expected: no output.

Run the script ONCE to actually create the four fixtures:

```bash
cd frontend && npm run setup-real-e2e-fixtures
```

Expected output: 4 lines `processing e2e-real-{name}-fixture-{login}` followed by `wrote e2e/real/fixtures.json (4 fixtures)`. After completion, `cat frontend/e2e/real/fixtures.json` shows 4 fixture records with valid PR numbers + node IDs.

- [ ] **Step 3: Commit (the script only — fixtures.json is gitignored)**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/scripts/setup-real-e2e-fixtures.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add setup-real-e2e-fixtures script

Idempotent per-teammate fixture provisioner: creates/reuses 4 branches
(e2e-real-{name}-fixture-{login}) + their PRs on prpande/prism-sandbox.
Writes locally-generated fixtures.json (gitignored).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `e2e/real/global-setup.ts`

**Files:**
- Create: `frontend/e2e/real/global-setup.ts`

- [ ] **Step 1: Create global-setup**

```typescript
import { chromium, request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const BACKEND = 'http://localhost:5181';

export default async function globalSetup(): Promise<void> {
  // 1. Read fixtures.json.
  const fxPath = path.join('e2e', 'real', 'fixtures.json');
  if (!fs.existsSync(fxPath)) {
    throw new Error(
      `fixtures.json not found at ${fxPath}. Run \`npm run setup-real-e2e-fixtures\` first; see docs/e2e/real-flow.md.`,
    );
  }
  const fixtures = JSON.parse(fs.readFileSync(fxPath, 'utf8')) as SandboxFixture[];

  // 2. Validate gh auth.
  try {
    execFileSync('gh', ['api', '/user'], { stdio: 'ignore' });
  } catch {
    throw new Error('gh CLI is not authenticated. Run `gh auth login --scopes repo` first.');
  }

  // 3. Capture PAT.
  const pat = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' }).trim();
  if (!pat) throw new Error('gh auth token returned empty.');

  // 4. Verify viewer.login matches fixtures' owning login (defense against accidental wrong-identity run).
  const viewer = JSON.parse(
    execFileSync('gh', ['api', 'graphql', '-f', 'query={ viewer { login } }'], { encoding: 'utf8' }),
  ) as { data: { viewer: { login: string } } };
  const myLogin = viewer.data.viewer.login;
  const fixtureLogin = fixtures[0].branch.split('-').slice(-1)[0]; // e.g. "pratyush" from "...-fixture-pratyush"
  if (myLogin !== fixtureLogin) {
    throw new Error(
      `gh auth identity mismatch: current login is "${myLogin}" but fixtures.json was generated for "${fixtureLogin}". Re-run setup-real-e2e-fixtures or switch gh auth context.`,
    );
  }

  // 5. Rebuild frontend + backend so wwwroot manifest matches built assets (mirrors fake-mode global-setup).
  console.log('[real-flow-setup] building frontend bundle…');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('[real-flow-setup] rebuilding PRism.Web so static-assets manifest matches wwwroot…');
  execSync('dotnet build PRism.Web --nologo --verbosity minimal', { stdio: 'inherit', cwd: '..' });

  // 6. Wait for backend health (the webServer block starts it; this is just a courtesy poll).
  const apiCtx = await request.newContext();
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await apiCtx.get(`${BACKEND}/api/health`);
      if (r.ok()) {
        healthy = true;
        break;
      }
    } catch {
      // backend still booting
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  await apiCtx.dispose();
  if (!healthy) throw new Error('backend never reached /api/health within 60s');

  // 7. Bootstrap an auth-eligible request context: launch chromium, GET /, capture the prism-session
  //    cookie. SessionTokenMiddleware enforces auth on /api/* under Test env; OriginCheckMiddleware
  //    rejects POSTs without Origin. A page.request bound to a navigated browser context satisfies both
  //    (cookie jar + auto-Origin). A bare APIRequestContext does neither.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BACKEND });
  const page = await context.newPage();
  await page.goto('/'); // stamps prism-session cookie via text/html cookie-stamping middleware

  // 8. POST PAT via /api/auth/connect. /commit only fires on warning (NoReposSelected).
  //    PRism serializes JSON in camelCase (PRism.Core/Json/JsonSerializerOptionsFactory.cs sets
  //    PropertyNamingPolicy = JsonNamingPolicy.CamelCase) — read camelCase keys, not PascalCase.
  const connectResp = await page.request.post('/api/auth/connect', {
    data: { pat },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!connectResp.ok()) {
    throw new Error(`POST /api/auth/connect failed: ${connectResp.status()} ${await connectResp.text()}`);
  }
  const connectBody = (await connectResp.json()) as { ok: boolean; error?: string; warning?: string; login?: string };
  if (!connectBody.ok) {
    throw new Error(`/api/auth/connect rejected PAT: error=${connectBody.error ?? '(unknown)'}`);
  }
  if (connectBody.warning) {
    // Soft warning (NoReposSelected, typical for fine-grained PATs). Accept by calling /commit.
    const commitResp = await page.request.post('/api/auth/connect/commit', {});
    if (!commitResp.ok()) {
      throw new Error(`POST /api/auth/connect/commit failed: ${commitResp.status()} ${await commitResp.text()}`);
    }
    console.log(`[real-flow-setup] PAT committed with warning=${connectBody.warning}`);
  } else {
    console.log('[real-flow-setup] PAT committed inline (no warning)');
  }

  await browser.close();
  console.log('[real-flow-setup] ready.');
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd frontend && npx tsc --noEmit e2e/real/global-setup.ts 2>&1 | head -10`

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/global-setup.ts
git -C D:/src/PRism-real-flow-e2e commit -m "feat(real-flow-e2e): add real-flow globalSetup

Validates gh auth + viewer.login matches fixtures; rebuilds bundle so
wwwroot manifest is current; bootstraps prism-session cookie via chromium
GET /; POSTs PAT through real /api/auth/connect (and /commit if warning)
so it lands in keychain-backed TokenStore per architectural invariant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: The four specs

### Task 13: `s5-real-happy-path.spec.ts`

**Files:**
- Create: `frontend/e2e/real/s5-real-happy-path.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

// Regression net for the PR#55 "/mark-viewed never called by usePrDetail" bug class.
// Drives the full chain — setup, draft, mark-viewed, submit, finalize — through real GitHub
// with no backend shortcuts. If the FE wire-up regresses, this fails with head-sha-not-stamped.

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const happyFixture = fixtures.find((f) => f.name === 'happy')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, happyFixture));
  await ctx.dispose();
});

test('S5 real flow — happy path drives mark-viewed → submit → finalize through real GitHub', async ({ page }) => {
  // 1. Navigate to the fixture PR. usePrDetail's mark-viewed fires here.
  const markViewedResp = page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}`);
  await markViewedResp; // ← the regression net

  // 2. Goto Files tab and add an inline comment on the anchor line.
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(happyFixture.anchorFile), 'i') }).click();
  const addBtn = page.getByRole('button', { name: new RegExp(`add comment on line ${happyFixture.anchorLine}`, 'i') });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill('Real-flow happy-path body.');
  await draftSave;

  // 3. Back to PR detail, click Submit Review.
  await page.goto(`/pr/prpande/prism-sandbox/${happyFixture.prNumber}`);
  const submitBtn = page.getByRole('button', { name: /^submit review$/i });
  await expect(submitBtn).toBeEnabled({ timeout: 10_000 });
  await submitBtn.click();

  // 4. Fill summary; verdict=Comment; click Confirm Submit.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/pr-level summary/i).fill('Real-flow happy-path summary.');
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // 5. Expect "Review submitted" heading and Finalize step in done state.
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('[data-step="Finalize"]')).toHaveAttribute('data-state', 'done');

  // 6. GitHub-side assertions.
  const reviews = listSubmittedReviewsSince(happyFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].body).toBe('Real-flow happy-path summary.');
  expect(reviews[0].threadCount).toBe(1);
  expect(listOwnPendingReviews(happyFixture.prNumber)).toHaveLength(0);
});
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/s5-real-happy-path.spec.ts
git -C D:/src/PRism-real-flow-e2e commit -m "test(real-flow-e2e): s5-real-happy-path spec

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: `s5-real-foreign-pending-review.spec.ts`

**Files:**
- Create: `frontend/e2e/real/s5-real-foreign-pending-review.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import {
  createPendingReview,
  listSubmittedReviewsSince,
  listOwnPendingReviews,
} from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const foreignFixture = fixtures.find((f) => f.name === 'foreign')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, foreignFixture));
  // Seed a pending review out-of-band — PRism's session has never stamped this PendingReviewId,
  // so it will be classified as foreign on submit-attempt.
  createPendingReview(foreignFixture, { threadBody: 'Pre-seeded foreign thread.' });
  // Load-bearing ordering invariant — a refactor that moves this seed before resetSandboxFixture
  // would delete it. Assert immediately so the failure is loud and locally explained.
  expect(listOwnPendingReviews(foreignFixture.prNumber)).toHaveLength(1);
  await ctx.dispose();
});

test('S5 real flow — foreign pending review prompt fires; Resume imports + submit lands', async ({ page }) => {
  const markViewedResp = page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}`);
  await markViewedResp;

  // Add an inline draft of our own.
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(foreignFixture.anchorFile), 'i') }).click();
  const addBtn = page.getByRole('button', { name: new RegExp(`add comment on line ${foreignFixture.anchorLine}`, 'i') });
  await addBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await addBtn.click();
  const textarea = page.getByRole('textbox', { name: /comment body/i });
  await textarea.waitFor({ state: 'visible' });
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await textarea.fill('Own draft for foreign-pending scenario.');
  await draftSave;

  // Submit. The pipeline will detect the foreign pending review via FindOwnPendingReviewAsync
  // (the seeded review's ID doesn't match session.PendingReviewId, which is null).
  await page.goto(`/pr/prpande/prism-sandbox/${foreignFixture.prNumber}`);
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /^confirm submit$/i }).click();

  // Foreign-pending-review modal should appear.
  const modal = page.getByRole('dialog', { name: /pending review|existing pending|already have a pending/i });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(modal.getByText(/pre-seeded foreign thread/i)).toBeVisible();

  // Click Resume.
  await modal.getByRole('button', { name: /resume/i }).click();

  // Expect the imported draft to appear in the composer with the foreign body.
  await expect(page.getByText(/pre-seeded foreign thread/i)).toBeVisible({ timeout: 10_000 });

  // Click Submit again.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const finalDialog = page.getByRole('dialog');
  await finalDialog.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 20_000 });

  // GitHub-side assertions.
  const reviews = listSubmittedReviewsSince(foreignFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].threadCount).toBe(2); // imported foreign + own
  expect(listOwnPendingReviews(foreignFixture.prNumber)).toHaveLength(0);
});
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/s5-real-foreign-pending-review.spec.ts
git -C D:/src/PRism-real-flow-e2e commit -m "test(real-flow-e2e): s5-real-foreign-pending-review spec (Resume path)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: `s5-real-lost-response-adoption.spec.ts`

**Files:**
- Create: `frontend/e2e/real/s5-real-lost-response-adoption.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { injectRealFailure } from './helpers/real-inject';
import { listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const lostFixture = fixtures.find((f) => f.name === 'lost-response')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, lostFixture));
  await ctx.dispose();
});

test('S5 real flow — lost-response adoption skips re-attach and finalizes cleanly', async ({ page }) => {
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}`);
  await page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );

  // Draft.
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(lostFixture.anchorFile), 'i') }).click();
  await page.getByRole('button', { name: new RegExp(`add comment on line ${lostFixture.anchorLine}`, 'i') }).click();
  const draftSave1 = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('Body — first attempt should fail mid-stream.');
  await draftSave1;

  // Arm afterEffect on addPullRequestReviewThread — GitHub commits the thread, PRism throws on response.
  await injectRealFailure(page.request, {
    graphQLFieldName: 'addPullRequestReviewThread',
    afterEffect: true,
    message: 'simulated lost-response window',
  });

  // First submit → expect Failed.
  await page.goto(`/pr/prpande/prism-sandbox/${lostFixture.prNumber}`);
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog1 = page.getByRole('dialog');
  await dialog1.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(dialog1.getByText(/submit failed|failed/i).first()).toBeVisible({ timeout: 20_000 });

  // Close dialog.
  const closeBtn = dialog1.getByRole('button', { name: /close|dismiss|cancel/i }).first();
  if (await closeBtn.isVisible()) await closeBtn.click();

  // Second submit → adoption: FindOwnPendingReviewAsync finds the previously-attached pending review,
  // marker-matches the existing thread, skips re-attach, finalizes.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog2 = page.getByRole('dialog');
  await expect(dialog2).toBeVisible();
  await dialog2.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 25_000 });

  // GitHub-side: exactly ONE Comment review with EXACTLY ONE thread (no duplicate from re-attach).
  const reviews = listSubmittedReviewsSince(lostFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].threadCount).toBe(1);
  expect(listOwnPendingReviews(lostFixture.prNumber)).toHaveLength(0);
});
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/s5-real-lost-response-adoption.spec.ts
git -C D:/src/PRism-real-flow-e2e commit -m "test(real-flow-e2e): s5-real-lost-response-adoption spec

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: `s5-real-stale-commit-oid.spec.ts`

**Files:**
- Create: `frontend/e2e/real/s5-real-stale-commit-oid.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect, request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSandboxFixture } from './helpers/reset-sandbox-fixture';
import { injectRealFailure } from './helpers/real-inject';
import { advanceHead, listSubmittedReviewsSince, listOwnPendingReviews } from './helpers/gh-sandbox';
import type { SandboxFixture } from './helpers/sandbox-fixture';

const fixtures = JSON.parse(
  fs.readFileSync(path.join('e2e', 'real', 'fixtures.json'), 'utf8'),
) as SandboxFixture[];
const staleFixture = fixtures.find((f) => f.name === 'stale-oid')!;

let sinceTs: string;

test.beforeEach(async () => {
  const ctx = await request.newContext();
  ({ sinceTs } = await resetSandboxFixture(ctx, staleFixture));
  await ctx.dispose();
});

test('S5 real flow — stale commit OID triggers recreate on second submit', async ({ page }) => {
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
  await page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );

  // Draft.
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}/files`);
  await page.getByRole('treeitem', { name: new RegExp(path.basename(staleFixture.anchorFile), 'i') }).click();
  await page.getByRole('button', { name: new RegExp(`add comment on line ${staleFixture.anchorLine}`, 'i') }).click();
  const draftSave = page.waitForResponse(
    (r) => r.url().includes('/draft') && r.request().method() === 'PUT' && r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole('textbox', { name: /comment body/i }).fill('Body for stale-oid scenario.');
  await draftSave;

  // Inject pre-effect failure on AttachThread so Begin lands but AttachThread doesn't.
  // Session stamps PendingReviewId=X@baseOid; GitHub has the pending review at baseOid.
  await injectRealFailure(page.request, {
    graphQLFieldName: 'addPullRequestReviewThread',
    afterEffect: false,
    message: 'pre-effect AttachThread failure for stale-oid setup',
  });
  await page.goto(`/pr/prpande/prism-sandbox/${staleFixture.prNumber}`);
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog1 = page.getByRole('dialog');
  await dialog1.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(dialog1.getByText(/submit failed|failed/i).first()).toBeVisible({ timeout: 20_000 });
  const closeBtn = dialog1.getByRole('button', { name: /close|dismiss|cancel/i }).first();
  if (await closeBtn.isVisible()) await closeBtn.click();

  // Advance head on the fixture branch. Set up to wait for the SSE pr-updated event BEFORE advancing.
  const prUpdated = page.waitForEvent('console', { timeout: 30_000 }).catch(() => undefined); // placeholder; use SSE-specific wait if available
  // Push a real commit to the branch via createCommitOnBranch.
  const newContent = `// advanced ${Date.now()}\n` + 'public static int Mul(int a, int b) => a * b;\n';
  advanceHead(staleFixture, {
    fileChanges: [{ path: staleFixture.anchorFile, contentBase64: Buffer.from(newContent, 'utf8').toString('base64') }],
    commitMessage: 'advance head for stale-oid spec',
  });

  // Wait for the Reload banner to appear (driven by SSE pr-updated; ActivePrPoller cadence 1s + replica propagation).
  const reloadBanner = page.getByRole('button', { name: /reload pr|reload/i });
  await expect(reloadBanner).toBeVisible({ timeout: 30_000 });
  await reloadBanner.click();
  // After reload, mark-viewed re-stamps LastViewedHeadSha=newOid.
  await page.waitForResponse(
    (r) => r.url().endsWith('/mark-viewed') && r.status() === 204,
    { timeout: 15_000 },
  );

  // Second submit. Pipeline: FindOwnPendingReviewAsync finds review at baseOid;
  // session.PendingReviewId matches → own; pending.CommitOid != newOid → stale; recreate.
  await page.getByRole('button', { name: /^submit review$/i }).click();
  const dialog2 = page.getByRole('dialog');
  await dialog2.getByRole('button', { name: /^confirm submit$/i }).click();
  await expect(page.getByRole('heading', { name: /review submitted/i })).toBeVisible({ timeout: 30_000 });

  // GitHub-side: one finalized review at newOid (not baseOid).
  const reviews = listSubmittedReviewsSince(staleFixture.prNumber, sinceTs);
  expect(reviews).toHaveLength(1);
  expect(reviews[0].state).toBe('COMMENTED');
  expect(reviews[0].commitOid).not.toBe(staleFixture.baseOid);
  expect(listOwnPendingReviews(staleFixture.prNumber)).toHaveLength(0);

  await prUpdated; // best-effort: don't fail the test on console wait
});
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add frontend/e2e/real/s5-real-stale-commit-oid.spec.ts
git -C D:/src/PRism-real-flow-e2e commit -m "test(real-flow-e2e): s5-real-stale-commit-oid spec

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16.5: Run the full real-flow suite end-to-end

- [ ] **Step 1: Verify sandbox prereqs are in place**

```bash
gh api repos/prpande/prism-sandbox/actions/permissions
# expected: {"enabled":false}
gh api repos/prpande/prism-sandbox/branches/master/protection 2>&1 | head -3
# expected: 404 with "Branch not protected" message
```

- [ ] **Step 2: Run the full real-flow suite**

```bash
cd frontend && npm run test:e2e:real
```

Expected: 4 specs pass on first attempt. Wall-clock ~5-8 minutes total (real GitHub round-trips, no parallelism, retries=0). If any spec flakes on a transient GitHub blip, re-run by hand — see design §7.6.

- [ ] **Step 3: Run the default (fake-mode) Playwright suite to confirm no regression**

```bash
cd frontend && CI=1 npx playwright test --project=prod
```

Expected: all 15 fake-mode specs pass — unchanged from before this PR.

---

## Phase 4: Documentation and deferral closeout

### Task 17: `docs/e2e/real-flow.md` operator runbook

**Files:**
- Create: `docs/e2e/real-flow.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Real-flow Playwright e2e tests

The real-flow suite is an additional test layer on top of PRism's fake-mode e2e suite (`frontend/playwright.config.ts`). It drives PRism against live GitHub at `prpande/prism-sandbox` and catches FE→BE wire-up regressions, live-GitHub mutation acceptance, marker durability, and transport-failure modes the fake elides. It is **local-dev / pre-release only** — not wired into CI.

Design doc: [`docs/specs/2026-05-18-real-flow-e2e-playwright-design.md`](../specs/2026-05-18-real-flow-e2e-playwright-design.md).

## Prereqs (per teammate)

1. **gh CLI authenticated:** `gh auth login --scopes repo`. Fine-grained PATs scoped to `prism-sandbox` with `contents:write` + `pull_requests:write` + `metadata:read` are recommended over classic `repo`-scoped tokens (smaller blast radius if leaked).
2. **Collaborator access on `prpande/prism-sandbox`** (the owner adds you):
   ```bash
   gh api -X PUT repos/prpande/prism-sandbox/collaborators/<your-login> -F permission=push
   ```
3. **GitHub Actions disabled on the sandbox** (one-time, owner-managed):
   ```bash
   gh api -X PUT repos/prpande/prism-sandbox/actions/permissions -F enabled=false
   ```
4. **No branch protection on `master`** that blocks force-push from collaborators.
5. **One-time fixture provisioning:**
   ```bash
   cd frontend && npm run setup-real-e2e-fixtures
   ```
   This creates 4 long-lived branches+PRs on the sandbox under `e2e-real-{happy,foreign,lost-response,stale-oid}-fixture-<your-login>`. The script is idempotent; re-run any time to repair drift.

## Running

```bash
cd frontend && npm run test:e2e:real
```

To run a single spec:

```bash
cd frontend && npx playwright test --config=playwright.real.config.ts s5-real-happy-path
```

Wall-clock ~5-8 minutes for the full suite. `retries: 0` is intentional — see "Known flake surfaces" below.

## What each spec catches

| Spec | Surface |
|---|---|
| `s5-real-happy-path` | FE `/mark-viewed` wire-up regression net; `addPullRequestReview` + `addPullRequestReviewThread` + `submitPullRequestReview` GitHub acceptance |
| `s5-real-foreign-pending-review` | `FindOwnPendingReviewAsync` GraphQL shape; TOCTOU re-fetch; draft-import flow; anchored-line enrichment from a real file blob |
| `s5-real-lost-response-adoption` | `TestFailureInjectionHandler` seam itself; adoption-vs-foreign branching; **HTML-comment marker durability on live GitHub** (running C7 empirical gate) |
| `s5-real-stale-commit-oid` | `addPullRequestReview` at a non-head OID; `deletePullRequestReview` orphan cleanup; full stale-recreation pipeline against real GraphQL |

## Verifying the regression nets

Per design §8 DoD: before merging a PR that touches the submit pipeline, run each one-line edit below, confirm the named spec fails, restore, and attest in the PR description.

| Spec | Edit to introduce | Expected failure surface |
|---|---|---|
| `s5-real-happy-path` | Comment out `postMarkViewed(...)` in `frontend/src/hooks/usePrDetail.ts:66-79` | `waitForResponse(/mark-viewed/)` times out → 400 `head-sha-not-stamped` |
| `s5-real-foreign-pending-review` | Force `FindOwnPendingReviewAsync` to return `null` | Pipeline reaches Begin without foreign-detection; GitHub refuses second pending review → dialog Failed |
| `s5-real-lost-response-adoption` | Remove marker prefix from `DraftThreadRequest.BodyMarkdown` | Adoption can't match on second submit → 2 threads (expected 1) |
| `s5-real-stale-commit-oid` | Replace `StaleCommitOidRecreating` branch with `throw` | Second submit Failed; spec times out on "Review submitted" |

## Known flake surfaces

- **stale-oid spec, SSE-wait timeout:** GitHub read-replica propagation + `ActivePrPoller` 1s cadence. 30s budget. If a slow-API window exceeds it, the spec fails with a clear timeout message — re-run by hand.
- **Transient GitHub 5xx / rate-limit edge:** Fails one spec; re-run by hand. Repeated failures = real regression.

## Troubleshooting

- **"fixtures.json not found"** → run `npm run setup-real-e2e-fixtures`.
- **"gh: not authenticated"** → `gh auth login --scopes repo`.
- **"viewer login mismatch"** → your `gh` is authed as a different account than the one that generated `fixtures.json`. Re-run setup or switch context.
- **PR exists but branch is at unexpected SHA** → re-run setup script (idempotent: force-resets the branch).
- **Dangling pending review you can't delete via PRism** → `gh api graphql -f query='mutation { deletePullRequestReview(input: { pullRequestReviewId: "PRR_..." }) { pullRequestReview { id } } }'`

## Operator runbook (owner)

- **Onboarding a new teammate:** `gh api -X PUT repos/prpande/prism-sandbox/collaborators/<login> -F permission=push`. Share this doc.
- **Refreshing master if anchor file drifts:** any teammate's setup-script run handles it (the script reads master's current head as the new fixture base).
- **GC'ing stale fixtures for a teammate who left:** list their `e2e-real-*-fixture-<login>` branches via `gh api repos/prpande/prism-sandbox/branches` and delete via `gh api -X DELETE`.

## Pre-release sanity gate

For any version-tag release, run `npm run test:e2e:real` and confirm all 4 specs pass on first attempt. This is the rot-mitigation per design §10.
```

- [ ] **Step 2: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add docs/e2e/real-flow.md
git -C D:/src/PRism-real-flow-e2e commit -m "docs(real-flow-e2e): operator runbook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Update the s5 deferrals doc

**Files:**
- Modify: `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`

- [ ] **Step 1: Add a revisions-log entry**

Open `docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md`. In the `revisions:` frontmatter block, append:

```yaml
  - 2026-05-18: real-flow Playwright e2e suite landed — closes [Defer] e2e Playwright test driving real usePrDetail → mark-viewed → submit → Finalize chain. See docs/specs/2026-05-18-real-flow-e2e-playwright-design.md + frontend/e2e/real/s5-real-*.spec.ts (4 specs).
```

- [ ] **Step 2: Update the deferral entry's status**

Find the entry `[Defer] e2e Playwright test driving the real usePrDetail → mark-viewed → submit → Finalize chain.` Add a status update line immediately after the entry title:

```markdown
**Status update (2026-05-18):** Resolved — scope expanded during brainstorm to 4-scenario real-flow suite (happy-path + foreign-pending-review + lost-response-adoption + stale-commit-oid). See `docs/specs/2026-05-18-real-flow-e2e-playwright-design.md` for the design and `frontend/e2e/real/s5-real-*.spec.ts` for the implementation. The mark-viewed deferral closes as a side-effect of the happy-path spec, which catches the original PR#55 bug class through the real FE wire-up.
```

- [ ] **Step 3: Commit**

```bash
git -C D:/src/PRism-real-flow-e2e add docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md
git -C D:/src/PRism-real-flow-e2e commit -m "docs(s5-deferrals): mark real-flow e2e test deferral resolved

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5: Pre-push verification + regression-net attestation

### Task 19: Run the pre-push checklist + collect regression-net attestation

- [ ] **Step 1: Run the full pre-push checklist** per `.ai/docs/development-process.md`. Verbatim — every step.

  - `npm run lint` (frontend)
  - `npm run build` (frontend)
  - `dotnet build` (root)
  - `dotnet test` (root) — all xUnit suites pass
  - `cd frontend && CI=1 npx playwright test --project=prod` — fake-mode suite passes
  - `cd frontend && npm run test:e2e:real` — real-flow suite passes

- [ ] **Step 2: Perform the regression-net attestation per design §8** — one spec at a time:

  For each of `s5-real-happy-path`, `s5-real-foreign-pending-review`, `s5-real-lost-response-adoption`, `s5-real-stale-commit-oid`:

  1. Apply the corresponding one-line edit from §8's table.
  2. Re-run that single spec: `npx playwright test --config=playwright.real.config.ts <spec-name>`.
  3. Confirm it fails with the expected failure surface (see the table).
  4. `git checkout -- <edited-file>` to restore.
  5. Re-run the spec to confirm it passes again.

  Note: this can land cumulative state on the sandbox (a partial pending-review from a failed-mid-flow run). Each spec's `beforeEach` cleans up before the next run, so you don't need manual cleanup between regression-net checks.

- [ ] **Step 3: Capture regression-net outcomes for the PR description**

  Write a four-row attestation table (mirroring §8) in your notes. Format:

  ```
  | Spec | Edit | Failure surface observed | Restored & passing |
  |---|---|---|---|
  | s5-real-happy-path | Commented out usePrDetail postMarkViewed block | mark-viewed waitForResponse timeout → 400 head-sha-not-stamped | ✓ |
  | … (3 more rows) |
  ```

- [ ] **Step 4: Push the branch**

```bash
git -C D:/src/PRism-real-flow-e2e push -u origin docs/real-flow-e2e
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create \
  --title "Real-flow Playwright e2e suite (closes s5 [Defer] e2e Playwright test)" \
  --body "$(cat <<'EOF'
## Summary

Adds a 4-scenario real-flow Playwright e2e suite that drives PRism against live GitHub at `prpande/prism-sandbox`, on top of the existing 15-spec fake-mode suite. Closes the [Defer] e2e Playwright test entry from the s5 deferrals doc as a side-effect of the happy-path spec.

**Specs:** `s5-real-happy-path`, `s5-real-foreign-pending-review`, `s5-real-lost-response-adoption`, `s5-real-stale-commit-oid`. Run with `npm run test:e2e:real`. Not in CI — local-dev / pre-release gate. Default `npx playwright test` is unchanged (still fake-mode, fast, deterministic).

**Production-code surface:** ~90 LOC of gated code in `PRism.Web/TestHooks/` — `TestFailureInjectionHandler` (DelegatingHandler on the GraphQL HttpClient pipeline) + `RealTransportFailureInjector` (one-shot failure-arm container) + endpoint registration. Co-gated on `ASPNETCORE_ENVIRONMENT=Test` AND `PRISM_E2E_REAL_INJECT=1` — cannot engage in production.

**Design:** [`docs/specs/2026-05-18-real-flow-e2e-playwright-design.md`](docs/specs/2026-05-18-real-flow-e2e-playwright-design.md) (two `ce-doc-review` rounds applied).
**Plan:** [`docs/plans/2026-05-18-real-flow-e2e-playwright.md`](docs/plans/2026-05-18-real-flow-e2e-playwright.md).
**Runbook:** [`docs/e2e/real-flow.md`](docs/e2e/real-flow.md).

## Regression-net attestation (design §8 DoD)

<!-- paste the four-row table from Task 19 step 3 -->

## Test plan

- [x] xUnit suite passes (`dotnet test`).
- [x] Fake-mode Playwright suite passes (`CI=1 npx playwright test --project=prod`).
- [x] Real-flow suite passes (`npm run test:e2e:real`) on first attempt against freshly-set-up sandbox.
- [x] Each spec's regression-net edit verified locally (see attestation above).
- [x] Sandbox prereqs verified: `gh api repos/prpande/prism-sandbox/actions/permissions` returns `{"enabled":false}`; no branch protection on master.
- [x] Pre-push checklist clean per `.ai/docs/development-process.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Capture the PR URL from the output.

---

## Self-review

Run after the plan is complete; fix issues inline.

### Spec coverage

Walk each section of the spec and confirm there's a task that implements it:

- ✓ §4.1 TestFailureInjectionHandler — Task 2
- ✓ §4.2 RealTransportFailureInjector — Task 1
- ✓ §4.3 RealInjectEndpoints — Task 3
- ✓ §4.4 /test/clear-pr-session — Task 4
- ✓ §4.5 Program.cs (mutex + handler reg + endpoint + UseStaticWebAssets widen) — Task 5
- ✓ §4.6 production-engagement-impossibility properties — covered by gating in Tasks 3+5 + mutex test in Task 5
- ✓ §5.1 gh-sandbox.ts — Task 8
- ✓ §5.2 real-inject.ts — Task 9
- ✓ §5.3 reset-sandbox-fixture.ts with sinceTs from server clock — Task 10
- ✓ §5.4 fixtures.json — generated by Task 11
- ✓ §6.1-6.4 four specs — Tasks 13-16
- ✓ §7.2 setup-real-e2e-fixtures.ts — Task 11
- ✓ §7.3 order-of-operations — documented in Task 17 runbook
- ✓ §7.4 playwright.real.config.ts — Task 7
- ✓ §7.5 globalSetup with browser-page-bound bootstrap + correct /connect vs /commit branching — Task 12
- ✓ §7.6 retries:0 + flake-vs-regression — covered in Task 7 config + Task 17 runbook
- ✓ §7.7 crash recovery — covered by per-test resetSandboxFixture (Task 10)
- ✓ §8 regression-catch attestation — Task 19 step 2
- ✓ §9 trade-offs accepted — documented in spec, no plan task needed
- ✓ §10 risks — documented in spec, no plan task needed
- ✓ §11 DoD — Task 19 covers all DoD items
- ✓ §12 files created/changed — Tasks 1-18 cover every row

### Placeholder scan

No "TBD" / "TODO" / "implement later" in any task. Every code step shows actual code.

### Type consistency

- `SandboxFixture` interface: same shape in `sandbox-fixture.ts` (Task 8) and consumed by Tasks 10-16 + the setup script.
- `ResetResult.sinceTs: string`: declared in Task 10, consumed in Tasks 13-16.
- `RealTransportFailureInjector.InjectFailure(graphQLFieldName, ex, afterEffect)`: signature consistent across Tasks 1, 2, 3.
- `injectRealFailure({ graphQLFieldName, afterEffect, message })`: shape consistent between Task 9 helper and Tasks 15-16 callers.
- Endpoint paths: `/test/real-inject/inject-failure` (Tasks 3+9), `/test/clear-pr-session` (Tasks 4+10) consistent.

---

## Execution choice

Plan complete and saved to `docs/plans/2026-05-18-real-flow-e2e-playwright.md`. Two execution options for the engineer who picks this up:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Uses `superpowers:subagent-driven-development`.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Choose per the engineer's preference.
