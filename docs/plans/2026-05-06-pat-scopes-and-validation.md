# PAT Scopes + Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align PAT validation and Setup-screen instructions with GitHub's fine-grained PAT model. Accept fine-grained tokens (which never carry `X-OAuth-Scopes`), surface a soft "no repos selected" warning before commit, and ask the user for the full set of fine-grained permissions PRism's PoC actually needs (Pull requests, Contents, Checks, Commit statuses).

**Architecture:** `GitHubReviewService.ValidateCredentialsAsync` branches on the token prefix (`ghp_…` vs everything else). Classic tokens keep the existing `X-OAuth-Scopes` check. Fine-grained tokens skip the header check and instead probe `GET /search/issues` twice to detect zero-repo-visibility, returning a `NoReposSelected` warning the connect endpoint surfaces to the frontend before committing the token. The Setup screen swaps its three classic-style scope pills for four fine-grained permission rows plus a one-line classic-PAT footnote.

**Tech Stack:** .NET 10 minimal API, xUnit + FluentAssertions, FakeHttpMessageHandler for HTTP isolation, MSAL Extensions TokenStore (already wired). Frontend: React 19 + Vite + TypeScript, Vitest + Testing Library + MSW for HTTP isolation.

**Spec:** `docs/specs/2026-05-06-pat-scopes-and-validation-design.md`

---

### Files

**Backend — modify:**
- `PRism.Core.Contracts/AuthValidationResult.cs` — add `AuthValidationWarning` enum and a `Warning` field with default `None`.
- `PRism.GitHub/GitHubReviewService.cs` — token-type branch; fine-grained Search probe.
- `PRism.Web/Endpoints/AuthEndpoints.cs` — defer commit when `Warning != None`; add `POST /api/auth/connect/commit`.

**Backend — modify tests:**
- `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs` — fine-grained acceptance, probe behavior.
- `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs` — warning response, commit endpoint.

**Frontend — modify:**
- `frontend/src/components/Setup/SetupForm.tsx` — replace ScopePill triplet with permission rows + classic footnote.
- `frontend/src/components/Setup/SetupForm.module.css` — styles for `.permissions` table-like rows + `.footnote`.
- `frontend/src/api/types.ts` — extend `ConnectResponse` with optional `warning` field.
- `frontend/src/pages/SetupPage.tsx` — handle warning response by rendering modal; wire commit/dismiss actions.

**Frontend — create:**
- `frontend/src/components/Setup/NoReposWarningModal.tsx` — small modal component.
- `frontend/src/components/Setup/NoReposWarningModal.module.css` — modal styles.

**Frontend — modify tests:**
- `frontend/__tests__/setup-form.test.tsx` — replace scope-pill assertions with permission-row + footnote assertions.
- `frontend/__tests__/setup-page.test.tsx` — modal flow for warning response.

**Docs — modify:**
- `docs/spec/03-poc-features.md` § 1 — replace scope-string description with fine-grained permission list + classic footnote.
- `docs/spec/00-verification-notes.md` — append PAT-type detection entry.
- `docs/specs/2026-05-05-foundations-and-setup-design.md` § 5.3 / table at line 256 — note token-type branch.
- `design/handoff/README.md` lines 118–119 — update Setup-screen description.

---

### Task 1: Extend `AuthValidationResult` with `Warning` field

**Files:**
- Modify: `PRism.Core.Contracts/AuthValidationResult.cs`

This is a structural type change with no behavior of its own. Existing tests transitively cover it once Task 2 starts using the new field. Per CLAUDE.md, refactors with no behavior change don't require new tests; the field's behavior is exercised by Task 2.

- [ ] **Step 1: Add the enum and the property**

Replace the file contents with:

```csharp
namespace PRism.Core.Contracts;

public sealed record AuthValidationResult(
    bool Ok,
    string? Login,
    IReadOnlyList<string>? Scopes,
    AuthValidationError? Error,
    string? ErrorDetail,
    AuthValidationWarning Warning = AuthValidationWarning.None);

public enum AuthValidationError
{
    None,
    InvalidToken,
    InsufficientScopes,
    NetworkError,
    DnsError,
    ServerError,
}

public enum AuthValidationWarning
{
    None,
    NoReposSelected,
}
```

Default value on the positional record means every existing 5-arg construction still compiles.

- [ ] **Step 2: Build the solution to verify nothing broke**

Run: `dotnet build PRism.sln --nologo`
Expected: build succeeds with no errors. Existing call sites in `PRism.GitHub/GitHubReviewService.cs` and tests still construct `AuthValidationResult` with 5 positional args; the 6th defaults to `None`.

- [ ] **Step 3: Run the existing test suite to confirm green baseline**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Expected: all existing GitHub tests still pass.

- [ ] **Step 4: Commit**

```bash
git add PRism.Core.Contracts/AuthValidationResult.cs
git commit -m "feat(auth): add Warning field to AuthValidationResult"
```

---

### Task 2: Validator — fine-grained PAT skips `X-OAuth-Scopes` check

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`

The current validator parses `X-OAuth-Scopes` for every token, so fine-grained PATs (which do not carry the header) always fail with `InsufficientScopes`. Add a token-type branch that only does the header check for `ghp_…` tokens.

- [ ] **Step 1: Write the failing test for the fine-grained acceptance path**

Append to `GitHubReviewService_ValidateCredentialsAsyncTests.cs` (before the closing brace):

```csharp
[Fact]
public async Task Returns_ok_for_fine_grained_pat_with_no_scopes_header()
{
    // Fine-grained PATs do not return X-OAuth-Scopes. The validator must accept them.
    // Search probe is stubbed to return >0 results so no warning is raised in this test.
    var firstCall = true;
    var handler = new FakeHttpMessageHandler(req =>
    {
        if (firstCall)
        {
            firstCall = false;
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"login\":\"octocat\"}", System.Text.Encoding.UTF8, "application/json"),
            };
        }
        return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent("{\"total_count\":1,\"items\":[]}", System.Text.Encoding.UTF8, "application/json"),
        };
    });
    var sut = BuildSut(handler, token: "github_pat_abcDEF123_xyz");
    var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
    result.Ok.Should().BeTrue();
    result.Login.Should().Be("octocat");
    result.Warning.Should().Be(AuthValidationWarning.None);
}
```

- [ ] **Step 2: Run the test to confirm RED**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Returns_ok_for_fine_grained_pat_with_no_scopes_header" --nologo`
Expected: FAIL — current code returns `InsufficientScopes` for tokens without the header.

- [ ] **Step 3: Implement the token-type branch**

Edit `PRism.GitHub/GitHubReviewService.cs`. Replace the `ValidateCredentialsAsync` method and the `InterpretAsync` method with:

```csharp
public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct)
{
    var token = await _readToken().ConfigureAwait(false);
    if (string.IsNullOrEmpty(token))
        return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "no token");

    var tokenType = ClassifyToken(token);

    using var req = new HttpRequestMessage(HttpMethod.Get, "user");
    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    req.Headers.UserAgent.ParseAdd("PRism/0.1");
    req.Headers.Accept.ParseAdd("application/vnd.github+json");

    try
    {
        using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var primary = await InterpretAsync(resp, tokenType, ct).ConfigureAwait(false);
        if (!primary.Ok || tokenType != TokenType.FineGrained) return primary;

        // Fine-grained: probe Search to detect the no-repos-selected case.
        var warning = await ProbeRepoVisibilityAsync(token, ct).ConfigureAwait(false);
        return primary with { Warning = warning };
    }
    catch (HttpRequestException ex) when (ex.StatusCode is { } code && (int)code >= 500)
    {
        return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)code}.");
    }
    catch (HttpRequestException ex) when (IsDnsFailure(ex))
    {
        return new AuthValidationResult(false, null, null, AuthValidationError.DnsError, $"Couldn't reach {_host}.");
    }
    catch (HttpRequestException ex)
    {
        return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, ex.Message);
    }
}

private enum TokenType { Classic, FineGrained }

private static TokenType ClassifyToken(string token) =>
    token.StartsWith("ghp_", StringComparison.Ordinal) ? TokenType.Classic : TokenType.FineGrained;
```

Replace the existing `InterpretAsync` signature and body with:

```csharp
private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, TokenType tokenType, CancellationToken ct)
{
    if (resp.StatusCode == HttpStatusCode.Unauthorized)
        return new AuthValidationResult(false, null, null, AuthValidationError.InvalidToken, "GitHub rejected this token.");

    if ((int)resp.StatusCode >= 500)
        return new AuthValidationResult(false, null, null, AuthValidationError.ServerError, $"GitHub returned {(int)resp.StatusCode}.");

    if (!resp.IsSuccessStatusCode)
        return new AuthValidationResult(false, null, null, AuthValidationError.NetworkError, $"unexpected status {(int)resp.StatusCode}");

    var scopesHeader = resp.Headers.TryGetValues("X-OAuth-Scopes", out var values) ? string.Join(",", values) : "";
    var scopes = scopesHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    if (tokenType == TokenType.Classic)
    {
        var missing = RequiredScopes.Except(scopes).ToArray();
        if (missing.Length > 0)
            return new AuthValidationResult(false, null, scopes, AuthValidationError.InsufficientScopes,
                $"missing scopes: {string.Join(", ", missing)}");
    }

    var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    string? login;
    try
    {
        using var doc = JsonDocument.Parse(body);
        login = doc.RootElement.TryGetProperty("login", out var l) ? l.GetString() : null;
    }
    catch (JsonException)
    {
        return new AuthValidationResult(false, null, scopes, AuthValidationError.ServerError,
            "GitHub returned an unparseable response body.");
    }

    return new AuthValidationResult(true, login, scopes, AuthValidationError.None, null);
}

private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, CancellationToken ct)
{
    if (await SearchHasResultsAsync(token, "is:pr author:@me", ct).ConfigureAwait(false))
        return AuthValidationWarning.None;
    if (await SearchHasResultsAsync(token, "is:pr review-requested:@me", ct).ConfigureAwait(false))
        return AuthValidationWarning.None;
    return AuthValidationWarning.NoReposSelected;
}

private async Task<bool> SearchHasResultsAsync(string token, string query, CancellationToken ct)
{
    var url = $"search/issues?q={Uri.EscapeDataString(query)}&per_page=1";
    using var req = new HttpRequestMessage(HttpMethod.Get, url);
    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    req.Headers.UserAgent.ParseAdd("PRism/0.1");
    req.Headers.Accept.ParseAdd("application/vnd.github+json");

    using var resp = await _http.SendAsync(req, ct).ConfigureAwait(false);
    resp.EnsureSuccessStatusCode();
    var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
    using var doc = JsonDocument.Parse(body);
    return doc.RootElement.TryGetProperty("total_count", out var tc)
        && tc.ValueKind == JsonValueKind.Number
        && tc.GetInt32() > 0;
}
```

Note: `EnsureSuccessStatusCode()` throws `HttpRequestException` with `.StatusCode` populated on failure. The 5xx catch in `ValidateCredentialsAsync` handles probe-time server errors uniformly with `/user`-time server errors.

- [ ] **Step 4: Run the new test to confirm GREEN**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Returns_ok_for_fine_grained_pat_with_no_scopes_header" --nologo`
Expected: PASS.

- [ ] **Step 5: Run all GitHub tests to confirm classic path is unchanged**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Expected: all 18+ tests pass (the existing `Returns_ok_with_login_and_scopes_on_200`, `Returns_insufficient_scopes_on_403_when_required_scope_missing`, etc. still pass because `ghp_test` is the default test token and routes through the Classic branch unchanged).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs
git commit -m "feat(auth): branch validator on token prefix; fine-grained skips X-OAuth-Scopes"
```

---

### Task 3: Validator — Search probe surfaces `NoReposSelected` and probe failures

**Files:**
- Modify: `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`

Task 2 already implemented the probe code. This task adds the missing test coverage so future regressions are caught.

- [ ] **Step 1: Write the failing test for `NoReposSelected`**

Append to `GitHubReviewService_ValidateCredentialsAsyncTests.cs`:

```csharp
[Fact]
public async Task Returns_no_repos_selected_warning_when_both_search_probes_are_empty()
{
    var calls = 0;
    var handler = new FakeHttpMessageHandler(req =>
    {
        calls++;
        var body = calls switch
        {
            1 => "{\"login\":\"octocat\"}",                   // /user
            _ => "{\"total_count\":0,\"items\":[]}",           // both probes
        };
        return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
    });
    var sut = BuildSut(handler, token: "github_pat_zero_repos");
    var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
    result.Ok.Should().BeTrue();
    result.Warning.Should().Be(AuthValidationWarning.NoReposSelected);
    calls.Should().Be(3);  // /user + 2 probes
}
```

- [ ] **Step 2: Run the test to confirm GREEN (the implementation already exists)**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Returns_no_repos_selected_warning" --nologo`
Expected: PASS — Task 2's `ProbeRepoVisibilityAsync` returns `NoReposSelected` when both probes' `total_count` is `0`.

- [ ] **Step 3: Write the failing test for short-circuit on first non-empty probe**

Append:

```csharp
[Fact]
public async Task Skips_second_probe_when_first_probe_returns_results()
{
    var calls = 0;
    var handler = new FakeHttpMessageHandler(req =>
    {
        calls++;
        var body = calls switch
        {
            1 => "{\"login\":\"octocat\"}",
            2 => "{\"total_count\":4,\"items\":[]}",   // first probe non-empty
            _ => throw new InvalidOperationException("Second probe must not run."),
        };
        return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
    });
    var sut = BuildSut(handler, token: "github_pat_has_repos");
    var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
    result.Ok.Should().BeTrue();
    result.Warning.Should().Be(AuthValidationWarning.None);
    calls.Should().Be(2);  // /user + first probe only
}
```

- [ ] **Step 4: Run the test to confirm GREEN**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Skips_second_probe_when_first_probe_returns_results" --nologo`
Expected: PASS.

- [ ] **Step 5: Write the failing test for fine-grained PAT + 401 (probe must not run)**

Append:

```csharp
[Fact]
public async Task Returns_invalid_token_for_fine_grained_pat_on_401_without_running_probe()
{
    var calls = 0;
    var handler = new FakeHttpMessageHandler(req =>
    {
        calls++;
        return new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized)
        {
            Content = new StringContent("{\"message\":\"Bad credentials\"}", System.Text.Encoding.UTF8, "application/json"),
        };
    });
    var sut = BuildSut(handler, token: "github_pat_revoked");
    var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
    result.Ok.Should().BeFalse();
    result.Error.Should().Be(AuthValidationError.InvalidToken);
    calls.Should().Be(1);  // /user only — probe must not run after auth failure
}
```

- [ ] **Step 6: Run the test to confirm GREEN**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Returns_invalid_token_for_fine_grained_pat_on_401" --nologo`
Expected: PASS — `ValidateCredentialsAsync` returns the failed `InterpretAsync` result without entering the fine-grained probe branch.

- [ ] **Step 7: Write the failing test for probe 5xx surfacing as ServerError**

Append:

```csharp
[Fact]
public async Task Surfaces_probe_5xx_as_server_error()
{
    var calls = 0;
    var handler = new FakeHttpMessageHandler(req =>
    {
        calls++;
        if (calls == 1)
        {
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"login\":\"octocat\"}", System.Text.Encoding.UTF8, "application/json"),
            };
        }
        return new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError);
    });
    var sut = BuildSut(handler, token: "github_pat_probe_5xx");
    var result = await sut.ValidateCredentialsAsync(CancellationToken.None);
    result.Ok.Should().BeFalse();
    result.Error.Should().Be(AuthValidationError.ServerError);
}
```

- [ ] **Step 8: Run the test to confirm GREEN**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Surfaces_probe_5xx_as_server_error" --nologo`
Expected: PASS — `EnsureSuccessStatusCode()` throws `HttpRequestException` with `StatusCode = 500`, caught by the 5xx clause in `ValidateCredentialsAsync`.

- [ ] **Step 9: Run the full GitHub test suite**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs
git commit -m "test(auth): cover fine-grained Search probe outcomes"
```

---

### Task 4: AuthEndpoints — defer commit when `Warning != None`

**Files:**
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`

When `ValidateCredentialsAsync` returns success with a warning, the connect endpoint must keep the token in `_transient` (not commit) and surface `warning` in the response body so the frontend can show its modal.

- [ ] **Step 1: Write the failing test**

Append to `AuthEndpointsTests.cs` (above the `public sealed record AuthStateResponse` declaration):

```csharp
[Fact]
public async Task Connect_with_no_repos_warning_returns_warning_and_does_not_commit()
{
    using var factory = new PRismWebApplicationFactory
    {
        ValidateOverride = () => Task.FromResult(new AuthValidationResult(
            true, "octocat", null, AuthValidationError.None, null,
            AuthValidationWarning.NoReposSelected)),
    };
    var client = factory.CreateClient();
    var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

    using var req = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
    {
        Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
    };
    req.Headers.Add("Origin", origin);

    var resp = await client.SendAsync(req);
    resp.IsSuccessStatusCode.Should().BeTrue();
    var body = await resp.Content.ReadFromJsonAsync<ConnectResponse>();
    body!.Ok.Should().BeTrue();
    body.Warning.Should().Be("no-repos-selected");

    // Token must NOT be committed — auth/state still says hasToken: false.
    var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
    stateResp!.HasToken.Should().BeFalse();
}
```

Update the `ConnectResponse` record at the bottom of the file to include `Warning`:

```csharp
public sealed record ConnectResponse(bool Ok, string? Login, string? Host, string? Error, string? Detail, string? Warning);
```

- [ ] **Step 2: Run the test to confirm RED**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Connect_with_no_repos_warning_returns_warning_and_does_not_commit" --nologo`
Expected: FAIL — current endpoint always commits on `Ok = true` and does not include `warning` in the response.

- [ ] **Step 3: Update the connect endpoint**

In `PRism.Web/Endpoints/AuthEndpoints.cs`, replace the `MapPost("/api/auth/connect", ...)` handler with:

```csharp
app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewService review, IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin, CancellationToken ct) =>
{
    JsonDocument doc;
    try
    {
        doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false);
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { ok = false, error = "invalid-json" });
    }
    using var _doc = doc;
    var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
    if (string.IsNullOrWhiteSpace(pat))
        return Results.BadRequest(new { ok = false, error = "pat-required" });

    await tokens.WriteTransientAsync(pat, ct).ConfigureAwait(false);
    var result = await review.ValidateCredentialsAsync(ct).ConfigureAwait(false);
    if (!result.Ok)
    {
        await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
#pragma warning disable CA1308 // Lowercase enum names are part of the auth contract surfaced to the renderer.
        var errorName = result.Error?.ToString().ToLowerInvariant();
#pragma warning restore CA1308
        return Results.Ok(new { ok = false, error = errorName, detail = result.ErrorDetail });
    }

    if (result.Warning != AuthValidationWarning.None)
    {
        // Soft warning: do NOT commit. Stash the validated login so the eventual
        // commit endpoint can populate IViewerLoginProvider. Frontend collects
        // user confirmation and calls POST /api/auth/connect/commit to finalize.
        await tokens.SetTransientLoginAsync(result.Login ?? "", ct).ConfigureAwait(false);
        return Results.Ok(new
        {
            ok = true,
            login = result.Login,
            host = config.Current.Github.Host,
            warning = WarningToWire(result.Warning),
        });
    }

    await tokens.CommitAsync(ct).ConfigureAwait(false);
    var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
    await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
    viewerLogin.Set(result.Login ?? "");
    return Results.Ok(new { ok = true, login = result.Login, host = config.Current.Github.Host });
});
```

If the warning enum gets new values later, the literal mapping above must grow. For PoC, `NoReposSelected` is the only one.

- [ ] **Step 4: Run the test to confirm GREEN**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Connect_with_no_repos_warning_returns_warning_and_does_not_commit" --nologo`
Expected: PASS.

- [ ] **Step 5: Run all auth-endpoint tests to confirm no regression**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~AuthEndpointsTests" --nologo`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/AuthEndpoints.cs tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs
git commit -m "feat(auth): defer commit when validator returns a warning"
```

---

### Task 5: AuthEndpoints — `POST /api/auth/connect/commit`

**Files:**
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs`

After the user clicks "Continue anyway" on the warning modal, the frontend POSTs to `/api/auth/connect/commit` to commit the existing transient. If no transient is pending (e.g., the process restarted between calls), respond 409.

- [ ] **Step 1: Write the failing happy-path test**

Append to `AuthEndpointsTests.cs`:

```csharp
[Fact]
public async Task Connect_commit_after_warning_persists_token_and_sets_host()
{
    using var factory = new PRismWebApplicationFactory
    {
        ValidateOverride = () => Task.FromResult(new AuthValidationResult(
            true, "octocat", null, AuthValidationError.None, null,
            AuthValidationWarning.NoReposSelected)),
    };
    var client = factory.CreateClient();
    var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

    // First call: connect returns warning, transient stays pending.
    using var connectReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect", UriKind.Relative))
    {
        Content = JsonContent.Create(new { pat = "github_pat_zero_repos" }),
    };
    connectReq.Headers.Add("Origin", origin);
    var connectResp = await client.SendAsync(connectReq);
    connectResp.IsSuccessStatusCode.Should().BeTrue();

    // Second call: confirm via commit.
    using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
    commitReq.Headers.Add("Origin", origin);
    var commitResp = await client.SendAsync(commitReq);
    commitResp.IsSuccessStatusCode.Should().BeTrue();

    // Token now committed.
    var stateResp = await client.GetFromJsonAsync<AuthStateResponse>(new Uri("/api/auth/state", UriKind.Relative));
    stateResp!.HasToken.Should().BeTrue();
}
```

- [ ] **Step 2: Run the test to confirm RED**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Connect_commit_after_warning_persists_token" --nologo`
Expected: FAIL — endpoint does not exist; 404.

- [ ] **Step 3: Implement the commit endpoint**

In `PRism.Web/Endpoints/AuthEndpoints.cs`, add this map call inside `MapAuth` after the existing `MapPost("/api/auth/connect", ...)` and before `MapPost("/api/auth/host-change-resolution", ...)`:

```csharp
app.MapPost("/api/auth/connect/commit", async (ITokenStore tokens, IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin, CancellationToken ct) =>
{
    // Read the validated login BEFORE CommitAsync clears the transient.
    var login = await tokens.ReadTransientLoginAsync(ct).ConfigureAwait(false);
    try
    {
        await tokens.CommitAsync(ct).ConfigureAwait(false);
    }
    catch (InvalidOperationException)
    {
        // No transient pending — process restart, or commit called twice.
        return Results.Conflict(new { ok = false, error = "no-pending-token" });
    }

    var state = await stateStore.LoadAsync(ct).ConfigureAwait(false);
    await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
    if (!string.IsNullOrEmpty(login)) viewerLogin.Set(login);
    return Results.Ok(new { ok = true, host = config.Current.Github.Host });
});
```

`TokenStore.CommitAsync` already throws `InvalidOperationException("No transient token to commit.")` when `_transient` is null — see `PRism.Core/Auth/TokenStore.cs:91`. The catch maps that to 409.

The login is threaded through `ITokenStore` as a paired transient (`SetTransientLoginAsync` / `ReadTransientLoginAsync`). The connect endpoint stashes it on the warning path right after validation, and the commit endpoint reads it before `CommitAsync` clears both transients, then populates the `IViewerLoginProvider` cache so the awaiting-author inbox section finds the viewer's login for the rest of the process session.

- [ ] **Step 4: Run the happy-path test to confirm GREEN**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Connect_commit_after_warning_persists_token" --nologo`
Expected: PASS.

- [ ] **Step 5: Write the failing 409 test**

Append:

```csharp
[Fact]
public async Task Connect_commit_returns_409_when_no_transient_pending()
{
    using var factory = new PRismWebApplicationFactory();
    var client = factory.CreateClient();
    var origin = client.BaseAddress!.GetLeftPart(UriPartial.Authority);

    using var commitReq = new HttpRequestMessage(HttpMethod.Post, new Uri("/api/auth/connect/commit", UriKind.Relative));
    commitReq.Headers.Add("Origin", origin);
    var resp = await client.SendAsync(commitReq);

    resp.StatusCode.Should().Be(System.Net.HttpStatusCode.Conflict);
}
```

- [ ] **Step 6: Run the test to confirm GREEN**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~Connect_commit_returns_409_when_no_transient_pending" --nologo`
Expected: PASS.

- [ ] **Step 7: Run all auth-endpoint tests**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~AuthEndpointsTests" --nologo`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add PRism.Web/Endpoints/AuthEndpoints.cs tests/PRism.Web.Tests/Endpoints/AuthEndpointsTests.cs
git commit -m "feat(auth): add POST /api/auth/connect/commit for warning confirmation"
```

---

### Task 6: SetupForm — fine-grained permission rows + classic footnote

**Files:**
- Modify: `frontend/src/components/Setup/SetupForm.tsx`
- Modify: `frontend/src/components/Setup/SetupForm.module.css`
- Test: `frontend/__tests__/setup-form.test.tsx`

Replace the three classic-style scope pills (`repo`, `read:user`, `read:org`) with four fine-grained permission rows and a single muted footnote that mentions the classic `repo` scope. The "Generate a token" link, the placeholder, and the masked input are unchanged.

- [ ] **Step 1: Update the failing tests for the new permission rows**

Replace the contents of `frontend/__tests__/setup-form.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SetupForm } from '../src/components/Setup/SetupForm';

describe('SetupForm', () => {
  it('disables Continue when input is empty', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('toggles mask/unmask on click of the eye', async () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    const input = screen.getByLabelText(/personal access token/i) as HTMLInputElement;
    await userEvent.type(input, 'ghp_xx');
    expect(input.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: /show token/i }));
    expect(input.type).toBe('text');
  });

  it('renders the four fine-grained permission rows', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.getByText(/^Read and write$/)).toBeInTheDocument();
    expect(screen.getByText('Contents')).toBeInTheDocument();
    expect(screen.getByText('Checks')).toBeInTheDocument();
    expect(screen.getByText('Commit statuses')).toBeInTheDocument();
  });

  it('mentions Metadata: Read as auto-included', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText(/Metadata: Read is auto-included/i)).toBeInTheDocument();
  });

  it('shows a classic-PAT footnote', () => {
    render(<SetupForm host="https://github.com" onSubmit={vi.fn()} />);
    expect(screen.getByText(/Already have a classic PAT/i)).toBeInTheDocument();
    // The `repo` scope is referenced in inline code.
    const codeNodes = screen.getAllByText('repo');
    expect(codeNodes.some(n => n.tagName === 'CODE')).toBe(true);
  });

  it('renders error pill when error prop is set', () => {
    render(
      <SetupForm
        host="https://github.com"
        onSubmit={vi.fn()}
        error="GitHub rejected this token."
      />,
    );
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it('calls onSubmit with the typed PAT when submit is clicked', async () => {
    const onSubmit = vi.fn();
    render(<SetupForm host="https://github.com" onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/personal access token/i);
    await userEvent.type(input, 'ghp_test_token');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onSubmit).toHaveBeenCalledWith('ghp_test_token');
  });
});
```

- [ ] **Step 2: Run the tests to confirm RED**

Run: `cd frontend && npm test -- setup-form`
Expected: the new "renders the four fine-grained permission rows", "mentions Metadata: Read", and "classic-PAT footnote" tests fail. Other tests still pass.

- [ ] **Step 3: Update `SetupForm.tsx`**

Replace the body of `frontend/src/components/Setup/SetupForm.tsx` with:

```tsx
import { useState, type FormEvent } from 'react';
import { MaskedInput } from './MaskedInput';
import styles from './SetupForm.module.css';

interface Props {
  host: string;
  onSubmit: (pat: string) => void | Promise<void>;
  error?: string;
  busy?: boolean;
}

const PERMISSIONS: ReadonlyArray<{ name: string; level: string }> = [
  { name: 'Pull requests', level: 'Read and write' },
  { name: 'Contents', level: 'Read' },
  { name: 'Checks', level: 'Read' },
  { name: 'Commit statuses', level: 'Read' },
];

export function SetupForm({ host, onSubmit, error, busy }: Props) {
  const [pat, setPat] = useState('');
  const patPageUrl = `${host.replace(/\/$/, '')}/settings/personal-access-tokens/new`;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pat.trim().length === 0) return;
    void onSubmit(pat);
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h1>Connect to GitHub</h1>
      <p>PRism is local-first. Your token never leaves this machine.</p>
      <div>
        <strong>1.</strong>{' '}
        <a href={patPageUrl} target="_blank" rel="noreferrer">
          Generate a token
        </a>
        <dl className={styles.permissions}>
          {PERMISSIONS.map((p) => (
            <div key={p.name} className={styles.permissionRow}>
              <dt>{p.name}</dt>
              <dd>{p.level}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.permissionsNote}>
          Metadata: Read is auto-included by GitHub. For Repository access, choose
          <em> All repositories</em> or <em>Select repositories</em>.
        </p>
        <p className={styles.footnote}>
          Already have a classic PAT? It needs the <code>repo</code>, <code>read:user</code>,
          and <code>read:org</code> scopes.
        </p>
      </div>
      <div>
        <strong>2.</strong> Paste it below
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder="ghp_… or github_pat_…"
          ariaLabel="Personal access token"
        />
      </div>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      <button type="submit" className={styles.continue} disabled={pat.trim().length === 0 || busy}>
        {busy ? 'Validating…' : 'Continue'}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Add CSS for the new layout**

Append to `frontend/src/components/Setup/SetupForm.module.css`:

```css
.permissions {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: var(--s-4, 16px);
  row-gap: var(--s-2, 8px);
  margin: var(--s-3, 12px) 0;
  font-size: 0.95em;
}
.permissionRow {
  display: contents;
}
.permissionRow > dt {
  font-weight: 500;
}
.permissionRow > dd {
  margin: 0;
  color: var(--text-1);
}
.permissionsNote {
  margin: var(--s-2, 8px) 0;
  font-size: 0.85em;
  color: var(--text-2);
}
.footnote {
  margin-top: var(--s-2, 8px);
  font-size: 0.85em;
  color: var(--text-2);
}
.footnote code {
  background: var(--surface-2, rgba(0, 0, 0, 0.05));
  padding: 0 4px;
  border-radius: 3px;
  font-size: 0.95em;
}
```

The existing `.scopes` rule is no longer used by the primary path; leave it in place for now (it is still referenced via `ScopePill`'s wrapper if anything else imports it). It will be cleaned up in a future pass when the component is removed.

- [ ] **Step 5: Run the tests to confirm GREEN**

Run: `cd frontend && npm test -- setup-form`
Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Setup/SetupForm.tsx frontend/src/components/Setup/SetupForm.module.css frontend/__tests__/setup-form.test.tsx
git commit -m "feat(setup): show fine-grained permissions + classic footnote"
```

---

### Task 7: API types — extend `ConnectResponse` with `warning`

**Files:**
- Modify: `frontend/src/api/types.ts`

Frontend type alignment with the backend wire format change from Task 4.

- [ ] **Step 1: Add the `warning` field**

In `frontend/src/api/types.ts`, replace the `ConnectResponse` interface with:

```ts
export interface ConnectResponse {
  ok: boolean;
  login?: string;
  host?: string;
  error?: string;
  detail?: string;
  warning?: 'no-repos-selected';
}
```

The literal-string union keeps `result.warning === 'no-repos-selected'` checks type-safe.

- [ ] **Step 2: Build the frontend to confirm no type errors**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json`
Expected: zero errors. (`SetupPage.tsx` already destructures `result` loosely — it does not break.)

If `tsconfig.app.json` does not exist, fall back to: `cd frontend && npx tsc --noEmit`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(api): add warning to ConnectResponse"
```

---

### Task 8: SetupPage — modal flow for `no-repos-selected` warning

**Files:**
- Create: `frontend/src/components/Setup/NoReposWarningModal.tsx`
- Create: `frontend/src/components/Setup/NoReposWarningModal.module.css`
- Modify: `frontend/src/pages/SetupPage.tsx`
- Test: `frontend/__tests__/setup-page.test.tsx`

When `/api/auth/connect` returns `{ ok: true, warning: 'no-repos-selected' }`, the page renders a modal blocking navigation. **Continue anyway** POSTs to `/api/auth/connect/commit` then routes to `/`. **Edit token scope** dismisses the modal (the user remains on Setup; the in-memory transient on the backend stays around until process exit or the next `/connect`).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `frontend/__tests__/setup-page.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SetupPage } from '../src/pages/SetupPage';

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderRouted() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<div>InboxMock</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SetupPage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
      ),
    );
  });

  it('routes to / on successful PAT submission', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({ ok: true, login: 'octocat', host: 'https://github.com' }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_test');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText('InboxMock')).toBeInTheDocument();
  });

  it('renders the error pill on validation failure', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: false,
          error: 'invalidtoken',
          detail: 'GitHub rejected this token.',
        }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'ghp_bad');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/rejected/i)).toBeInTheDocument();
  });

  it('builds the PAT link from the configured GHES host', async () => {
    server.use(
      http.get('/api/auth/state', () =>
        HttpResponse.json({
          hasToken: false,
          host: 'https://github.acme.com',
          hostMismatch: null,
        }),
      ),
    );
    renderRouted();
    const link = await screen.findByRole('link', { name: /generate a token/i });
    expect(link.getAttribute('href')).toBe(
      'https://github.acme.com/settings/personal-access-tokens/new',
    );
  });

  it('renders a warning modal when connect returns no-repos-selected', async () => {
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/no repos selected/i)).toBeInTheDocument();
    // Did NOT auto-redirect.
    expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
  });

  it('Continue anyway commits and routes to /', async () => {
    let commitCalled = false;
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
      http.post('/api/auth/connect/commit', () => {
        commitCalled = true;
        return HttpResponse.json({ ok: true, host: 'https://github.com' });
      }),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(await screen.findByRole('button', { name: /continue anyway/i }));
    expect(await screen.findByText('InboxMock')).toBeInTheDocument();
    expect(commitCalled).toBe(true);
  });

  it('Edit token scope dismisses the modal without commit', async () => {
    let commitCalled = false;
    server.use(
      http.post('/api/auth/connect', () =>
        HttpResponse.json({
          ok: true,
          login: 'octocat',
          host: 'https://github.com',
          warning: 'no-repos-selected',
        }),
      ),
      http.post('/api/auth/connect/commit', () => {
        commitCalled = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderRouted();
    await userEvent.type(await screen.findByLabelText(/personal access token/i), 'github_pat_zero');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await userEvent.click(await screen.findByRole('button', { name: /edit token scope/i }));
    expect(screen.queryByText(/no repos selected/i)).not.toBeInTheDocument();
    expect(commitCalled).toBe(false);
    expect(screen.queryByText('InboxMock')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to confirm RED**

Run: `cd frontend && npm test -- setup-page`
Expected: the three new tests fail; the three pre-existing tests still pass.

- [ ] **Step 3: Create `NoReposWarningModal.tsx`**

Create `frontend/src/components/Setup/NoReposWarningModal.tsx`:

```tsx
import styles from './NoReposWarningModal.module.css';

interface Props {
  onContinue: () => void | Promise<void>;
  onEdit: () => void;
  busy?: boolean;
}

export function NoReposWarningModal({ onContinue, onEdit, busy }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="no-repos-title" className={styles.backdrop}>
      <div className={styles.modal}>
        <h2 id="no-repos-title">No repos selected</h2>
        <p>
          Your token has no repositories selected. You&apos;ll see an empty inbox until
          you add repos in your GitHub token settings.
        </p>
        <p>Continue anyway, or go back and edit the token scope?</p>
        <div className={styles.actions}>
          <button type="button" onClick={onEdit} disabled={busy}>
            Edit token scope
          </button>
          <button type="button" onClick={() => void onContinue()} disabled={busy}>
            {busy ? 'Saving…' : 'Continue anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `NoReposWarningModal.module.css`**

Create `frontend/src/components/Setup/NoReposWarningModal.module.css`:

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 100;
}
.modal {
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-4, 12px);
  padding: var(--s-8, 32px);
  max-width: 480px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.3);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-3, 12px);
  margin-top: var(--s-4, 16px);
}
```

- [ ] **Step 5: Update `SetupPage.tsx` to drive the modal**

Replace `frontend/src/pages/SetupPage.tsx` with:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { NoReposWarningModal } from '../components/Setup/NoReposWarningModal';
import { apiClient } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import type { ConnectResponse } from '../api/types';

export function SetupPage() {
  const { authState } = useAuth();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
      if (!result.ok) {
        setError(result.detail ?? result.error ?? 'Validation failed.');
        return;
      }
      if (result.warning === 'no-repos-selected') {
        setShowWarning(true);
        return;
      }
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onContinueAnyway = async () => {
    setBusy(true);
    try {
      await apiClient.post<{ ok: boolean }>('/api/auth/connect/commit');
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
      setShowWarning(false);
    } finally {
      setBusy(false);
    }
  };

  const onEdit = () => setShowWarning(false);

  if (authState === null) return <div aria-busy="true">Loading…</div>;

  return (
    <>
      <SetupForm host={authState.host} onSubmit={onSubmit} error={error} busy={busy} />
      {showWarning && <NoReposWarningModal onContinue={onContinueAnyway} onEdit={onEdit} busy={busy} />}
    </>
  );
}
```

- [ ] **Step 6: Run the tests to confirm GREEN**

Run: `cd frontend && npm test -- setup-page`
Expected: all 6 tests pass.

- [ ] **Step 7: Run the full frontend test suite for regressions**

Run: `cd frontend && npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/Setup/NoReposWarningModal.tsx frontend/src/components/Setup/NoReposWarningModal.module.css frontend/src/pages/SetupPage.tsx frontend/__tests__/setup-page.test.tsx
git commit -m "feat(setup): show no-repos-selected warning modal before commit"
```

---

### Task 9: Documentation updates

**Files:**
- Modify: `docs/spec/03-poc-features.md` (the Setup section, around the existing scope list)
- Modify: `docs/spec/00-verification-notes.md` (append new entry)
- Modify: `docs/specs/2026-05-05-foundations-and-setup-design.md` (line ~256 row in the error table)
- Modify: `design/handoff/README.md` (lines 118–119)

These updates align the canonical docs with what was actually built.

- [ ] **Step 1: Update `docs/spec/03-poc-features.md`**

Find the Setup section (around line 24). The current text mentions classic-style scope strings. Replace the scope-pill list with:

```
- A link to the **PAT generation page** templated against the host: `<host>/settings/personal-access-tokens/new`. Updates live as the user types in the host field.
- The Setup screen lists the **fine-grained permissions** PRism requires:
  - Pull requests: Read and write
  - Contents: Read
  - Checks: Read
  - Commit statuses: Read

  Metadata: Read is auto-included by GitHub. For Repository access, the user picks "All repositories" or "Select repositories" (the public-only mode does not expose private repos PRism needs).

  A muted footnote covers users with an existing classic PAT: *"Already have a classic PAT? It needs the `repo`, `read:user`, and `read:org` scopes."* (Matches `RequiredScopes`; mismatch surfaces as `InsufficientScopes`.)
```

Find the validator behavior text (around line 28 — the existing line about probing search). Confirm the wording matches: *"On 200: backend then probes `GET /search/issues?q=is:pr+author:@me&per_page=1` and `GET /search/issues?q=is:pr+review-requested:@me&per_page=1` to detect the fine-grained-PAT-with-no-repos-selected failure mode. If both probes return zero results, surface the soft warning before navigation; otherwise commit the token immediately."* (Edit only if the existing text predates this design — leave alone if already accurate.)

- [ ] **Step 2: Update `docs/spec/00-verification-notes.md`**

Append a new entry at the end of the doc (after the last existing checkbox/section), under a new heading `## PAT type detection`:

```
## PAT type detection

**Implementation pattern (informational).** PRism's Setup-time validator branches on the token prefix:
- `ghp_…` → classic PAT; `X-OAuth-Scopes` is parsed and diffed against `["repo", "read:user", "read:org"]`.
- Anything else (`github_pat_…`, `gho_…`, etc.) → fine-grained / OAuth-style; `X-OAuth-Scopes` is empty for these tokens, so the header check is skipped.

For fine-grained tokens, a follow-up Search probe (`GET /search/issues?q=is:pr+author:@me`/`review-requested:@me`) detects the no-repos-selected failure mode. If both return `total_count: 0`, the connect endpoint returns `warning: "no-repos-selected"` without committing the token; the frontend gates the commit behind a confirmation modal.

This was added in `docs/specs/2026-05-06-pat-scopes-and-validation-design.md` after the original adversarial-review pass missed the `X-OAuth-Scopes` shape difference between classic and fine-grained PATs.
```

- [ ] **Step 3: Update `docs/specs/2026-05-05-foundations-and-setup-design.md`**

Open the file and find the row in the error table (around line 256) that says "PAT validation: 403 / missing scopes". Replace with two rows:

```
| PAT validation: classic PAT, missing scopes | Roll back transient; parse `X-OAuth-Scopes`; diff against required set. | Setup inline error: *"This token is missing scopes: `<missing>`. Regenerate with the listed scopes and try again."* |
| PAT validation: fine-grained PAT, no repos selected | Keep transient pending; both Search probes return zero. | Setup modal: *"Your token has no repos selected. You'll see an empty inbox until you add repos at GitHub. Continue anyway?"* with **Continue anyway** / **Edit token scope** actions. |
```

- [ ] **Step 4: Update `design/handoff/README.md`**

Find lines 118–119 (the Setup screen description). Replace:

```
   - External link button "Open the PAT page (fine-grained, repo-scoped)"
   - "Required scopes" row with three mono pills, each with a copy button: `repo`, `read:user`, `read:org`
```

with:

```
   - External link button "Open the PAT page (fine-grained)"
   - "Required permissions" block listing four fine-grained permissions: Pull requests (Read and write), Contents (Read), Checks (Read), Commit statuses (Read). Metadata: Read note is auto-included.
   - Muted classic-PAT footnote referencing the `repo` (and `read:org` for SSO orgs) scope.
```

- [ ] **Step 5: Verify `docs/spec/02-architecture.md` is permission-shaped, not scope-shaped**

Open `docs/spec/02-architecture.md` and re-read line 120 (the "Setup screen's Generate a PAT link" bullet). The current text says it templates against `github.host`. Confirm it does not list classic scope strings; if it does, replace any scope-string list with: *"The screen lists the fine-grained permissions PRism requires (Pull requests, Contents, Checks, Commit statuses); see `03-poc-features.md` § 1 for the full enumeration."*

If no edit was needed, no file is staged for this step.

- [ ] **Step 6: Commit**

```bash
git add docs/spec/03-poc-features.md docs/spec/00-verification-notes.md docs/specs/2026-05-05-foundations-and-setup-design.md design/handoff/README.md docs/spec/02-architecture.md
git commit -m "docs: align spec/handoff with new PAT validation model"
```

If `02-architecture.md` was not modified, the matching `git add` argument is a no-op — git silently ignores unchanged files in a multi-file `git add`.

---

### Task 10: Final verification

**Files:** none (read-only verification).

- [ ] **Step 1: Build everything**

Run: `dotnet build PRism.sln --nologo`
Expected: zero errors, zero new warnings.

- [ ] **Step 2: Full .NET test suite**

Run: `dotnet test PRism.sln --nologo`
Expected: all tests pass except the two pre-existing failures already characterized in the worktree:
- `AppStateStoreTests.SaveAsync_serializes_concurrent_writes` — Windows `File.Move` flake under parallel test execution.
- `StaticFilesAndFallbackTests.GET_root_does_not_404_due_to_missing_SPA_fallback` — depends on a built `wwwroot/`.

If `npm run build` was run earlier in the session (Task 6's UI changes are best smoke-checked via `./run.ps1`), the SPA fallback test should also pass. If `wwwroot/` is not built, that single failure is acceptable.

- [ ] **Step 3: Full frontend test suite**

Run: `cd frontend && npm test`
Expected: all tests pass.

- [ ] **Step 4: Frontend type check**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json`
Expected: zero errors.

- [ ] **Step 5: Manual smoke (UI)**

Clear any previously committed token to force the Setup screen:

```powershell
Remove-Item -Path "$env:LOCALAPPDATA\PRism\PRism.tokens.cache" -ErrorAction SilentlyContinue
```

Then run: `./run.ps1`

In the browser:
- Setup screen shows four fine-grained permission rows + Metadata note + classic footnote.
- Pasting a valid fine-grained PAT with permissions and at least one repo selected → routes to `/`.
- Pasting a valid fine-grained PAT scoped to **no** repos → modal appears. **Continue anyway** routes to `/`. **Edit token scope** dismisses the modal.
- Pasting an invalid PAT → inline "GitHub rejected this token" pill (unchanged).
- Pasting a valid classic `ghp_…` PAT with `repo` + `read:user` + `read:org` → routes immediately (no probe).

If the manual smoke surfaces issues, debug via the systematic-debugging skill before declaring done.

- [ ] **Step 6: Final commit (only if anything was tweaked during smoke)**

```bash
git status                  # confirm clean if smoke passed without edits
# If you edited anything during smoke:
git add -p                  # review changes
git commit -m "fix: <short description of smoke-driven fix>"
```

---

## Out of scope

- Removing the now-unused `ScopePill` component from the codebase. Keeping it removes dead code, but it's not blocking; defer to a future cleanup pass.
- Server-side rate-limit awareness for the Search probe. The probe runs once per Setup attempt, far below the 30 req/min ceiling.
- Localizing the modal copy.
- Updating any classic-PAT-only docs that don't impact PoC.
