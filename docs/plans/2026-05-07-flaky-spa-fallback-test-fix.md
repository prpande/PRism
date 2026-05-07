# Flaky SPA-fallback test fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate flakiness in `StaticFilesAndFallbackTests.GET_root_does_not_404_due_to_missing_SPA_fallback` by stubbing `wwwroot/index.html` from the test factory and replacing the broken test with two positive assertions.

**Architecture:** Override the ASP.NET Core web root in `PRismWebApplicationFactory` (via `builder.UseWebRoot(...)`) to point at a per-test temp directory containing a recognizable `index.html` stub. Rewrite the broken test as two positive tests that assert 200 + `text/html`, with the client-side route additionally asserting the stub marker is in the body to prove the SPA fallback was the path that served it. Production code (`PRism.Web/Program.cs`) is not touched.

**Tech Stack:** xUnit, FluentAssertions, `Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory<TEntryPoint>`, .NET 10, ASP.NET Core minimal APIs.

**Spec:** `docs/specs/2026-05-07-flaky-spa-fallback-test-fix-design.md`

---

## File Structure

- **Modify:** `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs` — add web-root override + stub `index.html` write inside `ConfigureWebHost`. Cleanup is already handled by the existing `Dispose` (recursive delete of `DataDir`).
- **Modify:** `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs` — replace `GET_root_does_not_404_due_to_missing_SPA_fallback` with two positive tests; leave `Unknown_api_route_returns_404_not_SPA_fallback` unchanged.

No new files. No production-code changes.

---

## Task 1: TDD the new positive tests + factory stub

**Files:**
- Modify: `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs`
- Modify: `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`

This task follows red → green → refactor: add the new tests first (red), then the factory change (green), then remove the obsolete test (refactor — the new tests cover its intent).

### Step 1.1: Add the two new failing tests alongside the existing test

Open `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs`. Inside the `StaticFilesAndFallbackTests` class, **add** the two new `[Fact]` methods below. Do **not** delete the existing `GET_root_does_not_404_due_to_missing_SPA_fallback` test yet. Do **not** modify `Unknown_api_route_returns_404_not_SPA_fallback`.

- [ ] **Step 1.1: Add new tests**

```csharp
[Fact]
public async Task GET_root_serves_SPA_index_html()
{
    // The SPA fallback (or MapStaticAssets, depending on which has a manifest entry)
    // must serve an HTML response for GET /. We don't assert on the body here because
    // GET / can be served by either the static-asset manifest (real wwwroot index.html
    // when the frontend has been built) or by MapFallbackToFile (the test-factory stub).
    // The body marker check belongs on /inbox-shell, where only MapFallbackToFile can match.
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();

    var resp = await client.GetAsync(new Uri("/", UriKind.Relative));

    resp.StatusCode.Should().Be(HttpStatusCode.OK);
    resp.Content.Headers.ContentType?.MediaType.Should().Be("text/html");
}

[Fact]
public async Task Client_side_route_falls_back_to_SPA_index_html()
{
    // /inbox-shell is not in the static-asset manifest and not an API route, so the only
    // path that can serve a 200 text/html response is MapFallbackToFile("index.html").
    // Asserting the stub marker proves the SPA fallback ran and read the file from the
    // overridden web root.
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();

    var resp = await client.GetAsync(new Uri("/inbox-shell", UriKind.Relative));

    resp.StatusCode.Should().Be(HttpStatusCode.OK);
    resp.Content.Headers.ContentType?.MediaType.Should().Be("text/html");
    var body = await resp.Content.ReadAsStringAsync();
    body.Should().Contain("PRism test stub");
}
```

### Step 1.2: Run the new tests and confirm they fail for the right reason

- [ ] **Step 1.2: Run new tests, confirm red**

Run from the repo root:

```
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~StaticFilesAndFallbackTests.GET_root_serves_SPA_index_html|FullyQualifiedName~StaticFilesAndFallbackTests.Client_side_route_falls_back_to_SPA_index_html"
```

Expected: both tests **FAIL**.

Likely failure modes (any of these is acceptable as "red for the right reason"):
- `GET_root_serves_SPA_index_html`: status is `404` (no `wwwroot/index.html`) or content-type is `application/problem+json`.
- `Client_side_route_falls_back_to_SPA_index_html`: status is `404` or content-type is `application/problem+json`, OR (if a real built `wwwroot/index.html` happens to exist on this machine) the body assertion fails because the real index.html does not contain "PRism test stub".

If both tests pass at this point, stop — that means the environment already has a `wwwroot/index.html` containing "PRism test stub", which shouldn't be possible. Investigate before proceeding.

### Step 1.3: Add the web-root stub to the test factory

Open `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`. Locate the `ConfigureWebHost` method. Currently it reads:

```csharp
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    ArgumentNullException.ThrowIfNull(builder);
    Directory.CreateDirectory(DataDir);
    builder.UseSetting("DataDir", DataDir);
    builder.UseEnvironment("Test");

    builder.ConfigureServices(services =>
    {
        // ... unchanged
    });
}
```

- [ ] **Step 1.3: Stub wwwroot + UseWebRoot in the factory**

Change `ConfigureWebHost` to:

```csharp
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    ArgumentNullException.ThrowIfNull(builder);
    Directory.CreateDirectory(DataDir);

    // Provide a deterministic wwwroot/index.html so MapFallbackToFile("index.html")
    // can serve SPA routes during tests, regardless of whether the frontend bundle
    // has been built. The stub marker lets tests prove the fallback path served the
    // response. DataDir is deleted recursively in Dispose, so wwwroot/ goes with it.
    var webRoot = Path.Combine(DataDir, "wwwroot");
    Directory.CreateDirectory(webRoot);
    File.WriteAllText(
        Path.Combine(webRoot, "index.html"),
        "<!DOCTYPE html><html><body>PRism test stub</body></html>");
    builder.UseWebRoot(webRoot);

    builder.UseSetting("DataDir", DataDir);
    builder.UseEnvironment("Test");

    builder.ConfigureServices(services =>
    {
        // Replace IReviewService with a stub when ValidateOverride is set.
        if (ValidateOverride is not null)
        {
            var existing = services.FirstOrDefault(d => d.ServiceType == typeof(IReviewService));
            if (existing is not null) services.Remove(existing);
            services.AddSingleton<IReviewService>(new StubReviewService(ValidateOverride));
        }
    });
}
```

The `ConfigureServices` block is unchanged — repeat it verbatim so the file's behavior for other tests is preserved.

### Step 1.4: Run the new tests and confirm they pass

- [ ] **Step 1.4: Run new tests, confirm green**

Run:

```
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~StaticFilesAndFallbackTests.GET_root_serves_SPA_index_html|FullyQualifiedName~StaticFilesAndFallbackTests.Client_side_route_falls_back_to_SPA_index_html"
```

Expected: both tests **PASS**.

If `GET_root_serves_SPA_index_html` still fails, the production `MapStaticAssets()` endpoint may be claiming `GET /` and returning a status other than 200 or a content-type other than `text/html` from the build-time manifest. Inspect the response (e.g., temporarily add a `Console.WriteLine($"{resp.StatusCode} {resp.Content.Headers.ContentType}");` line, run again, then remove it) and report back — the spec's risk section anticipates this and offers a fallback (Approach C, custom `IFileProvider`).

If `Client_side_route_falls_back_to_SPA_index_html` still fails, the most likely cause is `UseWebRoot(...)` not being honored after `MapStaticAssets()` runs. Same fallback applies — switch to a custom `IFileProvider`. Stop and report rather than guessing.

### Step 1.5: Delete the obsolete broken test

The new tests cover the original test's intent (and more). Remove the obsolete one.

- [ ] **Step 1.5: Delete the broken test**

In `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs`, delete the entire `GET_root_does_not_404_due_to_missing_SPA_fallback` method (the `[Fact]` attribute and the method body). The two new tests and `Unknown_api_route_returns_404_not_SPA_fallback` remain.

### Step 1.6: Run the full StaticFilesAndFallbackTests class and confirm all green

- [ ] **Step 1.6: Run the whole test class**

Run:

```
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~StaticFilesAndFallbackTests"
```

Expected: 3 tests, all **PASS** (`GET_root_serves_SPA_index_html`, `Client_side_route_falls_back_to_SPA_index_html`, `Unknown_api_route_returns_404_not_SPA_fallback`).

### Step 1.7: Run the full PRism.Web.Tests project to check for regressions

`PRismWebApplicationFactory` is shared by 9 other test files. The only behavior change is adding a stub `wwwroot/index.html` and overriding `WebRootPath`. None of the other tests assert on static files, but run the whole project to be sure.

- [ ] **Step 1.7: Run full test project**

Run:

```
dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj
```

Expected: all tests **PASS**, including those in `OriginCheckMiddlewareTests`, `RequestIdMiddlewareTests`, `ProgramSmokeTests`, `ProblemDetailsTests`, `AuthEndpointsTests`, `CapabilitiesEndpointsTests`, `HealthEndpointsTests`, `PreferencesEndpointsTests`, and `NoBrowserFlagTests`.

If any previously-passing test now fails, the factory change is the suspect — investigate before committing.

### Step 1.8: Commit

- [ ] **Step 1.8: Commit**

```
git add tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs
git commit -m "$(cat <<'EOF'
test(web): fix flaky SPA-fallback test with deterministic wwwroot stub

PRismWebApplicationFactory now writes a stub wwwroot/index.html under DataDir
and points the host's web root at it via UseWebRoot. StaticFilesAndFallbackTests
replaces the broken GET_root_does_not_404_due_to_missing_SPA_fallback (whose
name lied about what it tested and whose assertion silently passed when
ContentType was null) with two positive tests:
GET_root_serves_SPA_index_html and Client_side_route_falls_back_to_SPA_index_html.
The latter asserts the stub marker to prove the fallback path served the response.

Eliminates the local-flakiness-vs-CI-green split caused by tests depending on
whether `npm run build` had populated wwwroot/index.html before `dotnet test`.

Spec: docs/specs/2026-05-07-flaky-spa-fallback-test-fix-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

1. **Spec coverage:** Both spec changes (factory web-root override + test rewrite) are implemented in Task 1, steps 1.3 and 1.1/1.5. The "leave `Unknown_api_route_returns_404_not_SPA_fallback` unchanged" requirement is enforced explicitly in Step 1.1 and Step 1.5. The risks section's fallback (custom `IFileProvider`) is referenced in Step 1.4's failure-handling guidance.
2. **Placeholders:** None.
3. **Type consistency:** Test method names match the spec verbatim. Stub marker string `"PRism test stub"` is identical in the factory write and the body assertion.
