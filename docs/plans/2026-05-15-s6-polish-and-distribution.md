# S6 Polish + distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the PoC binary that clears the validation gate (`docs/spec/01-vision-and-acceptance.md` DoD § Cross-platform, § Tests, § Quality). Adds Settings page + Replace token + identity-change rule + cheatsheet + branded loading + a11y audit + publish workflow + screenshot regression + README graduation.

**Architecture:** Nine PRs, sequenced as backend (PR1–PR2) → frontend Settings + auth surfaces (PR3–PR4) → frontend polish (PR5–PR6) → audit + distribution + docs (PR7–PR9). Source spec: [`docs/specs/2026-05-15-s6-polish-and-distribution-design.md`](../specs/2026-05-15-s6-polish-and-distribution-design.md).

**Tech Stack:** .NET 10 + C# 14 (`PRism.Core`, `PRism.Web`), xUnit + FluentAssertions, React 18 + Vite + TypeScript (`frontend/`), Vitest + Playwright, axe-core/playwright, GitHub Actions for publish.

---

## Source-spec sections this plan implements

| Spec § | Implements via |
|---|---|
| § 2 Settings page | PR1 (backend) + PR3 (frontend) |
| § 3 Replace token + identity-change | PR1 (`/api/submit/in-flight`) + PR2 (`/api/auth/replace`, identity-change rule, SSE wiring, structured log) + PR4 (frontend UX) |
| § 4 Cheatsheet overlay | PR5 |
| § 5 Icon assets + LoadingScreen | PR6 |
| § 6 Accessibility audit | PR7 |
| § 7 Publish workflow + first-run trust copy | PR8 |
| § 8 Viewport screenshot regression test | PR9 |
| § 9 README updates | PR9 |
| § 10 v2 multi-account touch-point register | (no code; spec doc) |
| § 12 Project standards updates | PR9 (spec doc updates) |

---

## File structure preview

### New files

- `PRism.Web/Endpoints/PreferencesDtos.cs` (modified — richer response shape) — extend wire shape
- `PRism.Web/Endpoints/SubmitInFlightEndpoint.cs` — new `GET /api/submit/in-flight`
- `PRism.Web/Endpoints/AuthEndpoints.cs` (modified — new `POST /api/auth/replace`)
- `PRism.Core/Events/IdentityChanged.cs` — new global `IReviewEvent`
- `PRism.Web/Sse/SseChannel.cs` (modified — `IdentityChanged` handler + dispose)
- `PRism.Core/PrDetail/IActivePrCache.cs` + `ActivePrCache.cs` (modified — `Clear()`)
- `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs` (modified — `RemoveAll()`)
- `PRism.Core/Inbox/InboxPoller.cs` (modified — `RequestImmediateRefresh()` + `WhenAny` loop)
- `PRism.Core/Config/ConfigStore.cs` (modified — allowlist + dotted-path dispatch)
- `frontend/src/pages/SettingsPage.tsx` + `frontend/src/components/Settings/*` — Settings UI
- `frontend/src/components/Cheatsheet/*` — cheatsheet overlay
- `frontend/src/components/LoadingScreen/*` — branded loading
- `frontend/src/components/Toast/Toast.tsx` (modified — add `'success'` kind)
- `frontend/public/prism-logo.png`, `frontend/public/favicon.ico` — icon assets
- `frontend/e2e/a11y-audit.spec.ts` — axe-core audit
- `frontend/e2e/no-layout-shift-on-banner.spec.ts` — screenshot regression
- `.github/workflows/publish.yml` — manual-dispatch publish workflow
- `.github/dependabot.yml` — Actions dependency hygiene
- `PRism.Web/PRism.Web.csproj` (modified — publish properties gated on `$(PublishProfile)`)
- `README.md` (modified — Download + Troubleshooting sections)
- `docs/spec/03-poc-features.md` (modified — § 11 Settings reflects UI shipped)
- `docs/spec/02-architecture.md` (modified — § Distribution notes `publish.yml`)
- `docs/roadmap.md` (modified — S6 row Shipped)
- `docs/specs/README.md` (modified — move S6 spec entry to Implemented)

---

## PR1 — Backend: preferences allowlist + `/api/submit/in-flight`

**Goal:** Extend `ConfigStore.PatchAsync` allowlist to dotted-path `inbox.sections.*` keys; enrich `GET /api/preferences` shape; add `GET /api/submit/in-flight` endpoint backed by a new `SubmitLockRegistry.AnyHeld()` method.

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` (allowlist + dotted-path switch)
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs` (GET response shape)
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs` (response record)
- Modify: `PRism.Web/Submit/SubmitLockRegistry.cs` (add `AnyHeld()` + held-set tracking)
- Create: `PRism.Web/Endpoints/SubmitInFlightEndpoint.cs`
- Modify: `PRism.Web/Composition/ServiceCollectionExtensions.cs` (register endpoint)
- Modify: `PRism.Web/Program.cs` (map endpoint)
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncTests.cs` (new file or extend existing)
- Test: `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/SubmitInFlightEndpointTests.cs`
- Test: `tests/PRism.Web.Tests/Submit/SubmitLockRegistryAnyHeldTests.cs`

### Task 1.1: `SubmitLockRegistry.AnyHeld()` — RED

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Submit/SubmitLockRegistryAnyHeldTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.Submit;
using Xunit;

namespace PRism.Web.Tests.Submit;

public class SubmitLockRegistryAnyHeldTests
{
    private static readonly PrReference Pr1 = new("octocat", "Hello-World", 1);
    private static readonly PrReference Pr2 = new("octocat", "Hello-World", 2);

    [Fact]
    public async Task AnyHeld_NoLocksEverAcquired_ReturnsFalseNull()
    {
        var registry = new SubmitLockRegistry();

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeFalse();
        prRef.Should().BeNull();
    }

    [Fact]
    public async Task AnyHeld_LockHeld_ReturnsTrueWithRef()
    {
        var registry = new SubmitLockRegistry();
        await using var handle = await registry.TryAcquireAsync(Pr1, TestContext.Current.CancellationToken);
        handle.Should().NotBeNull();

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeTrue();
        prRef.Should().Be(Pr1.ToString());
    }

    [Fact]
    public async Task AnyHeld_LockAcquiredAndReleased_ReturnsFalseNull()
    {
        // Defends against the naive `_locks.Any()` regression: the entry stays in _locks
        // forever after release, but AnyHeld must report not-held.
        var registry = new SubmitLockRegistry();
        var handle = await registry.TryAcquireAsync(Pr1, TestContext.Current.CancellationToken);
        handle.Should().NotBeNull();
        await handle!.DisposeAsync();

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeFalse();
        prRef.Should().BeNull();
    }

    [Fact]
    public async Task AnyHeld_MultipleLocksHeld_ReturnsOneOfThem()
    {
        var registry = new SubmitLockRegistry();
        await using var h1 = await registry.TryAcquireAsync(Pr1, TestContext.Current.CancellationToken);
        await using var h2 = await registry.TryAcquireAsync(Pr2, TestContext.Current.CancellationToken);

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeTrue();
        prRef.Should().BeOneOf(Pr1.ToString(), Pr2.ToString());
    }
}
```

- [ ] **Step 2: Run to verify failure**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitLockRegistryAnyHeldTests" --no-restore
```

Expected: FAIL — `SubmitLockRegistry` does not contain `AnyHeld()`.

### Task 1.2: `SubmitLockRegistry.AnyHeld()` — GREEN

- [ ] **Step 1: Add held-set field and `AnyHeld()` method**

Modify `PRism.Web/Submit/SubmitLockRegistry.cs`. Add a `ConcurrentDictionary<string, byte> _heldLocks` populated on acquire success and cleared in the handle's `Dispose`. Add the public method:

```csharp
// Cheap, TOCTOU-safe "is any submit lock currently held?" probe.
// See docs/specs/2026-05-15-s6-polish-and-distribution-design.md § 3.5 for the
// implementation alternatives and the rationale for the held-set approach.
public (bool Held, string? PrRef) AnyHeld()
{
    foreach (var key in _heldLocks.Keys)
    {
        return (true, key);
    }
    return (false, null);
}
```

Update the existing `TryAcquireAsync` to add `_heldLocks[prRef.ToString()] = 0` on successful acquire, and the disposable handle's `DisposeAsync` to call `_heldLocks.TryRemove(prRef.ToString(), out _)`.

- [ ] **Step 2: Run tests to verify pass**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitLockRegistryAnyHeldTests" --no-restore
```

Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add PRism.Web/Submit/SubmitLockRegistry.cs tests/PRism.Web.Tests/Submit/SubmitLockRegistryAnyHeldTests.cs
git commit -m "feat(s6-pr1): add SubmitLockRegistry.AnyHeld() with held-set tracking"
```

### Task 1.3: `GET /api/submit/in-flight` endpoint — RED

- [ ] **Step 1: Write the failing endpoint test**

Create `tests/PRism.Web.Tests/Endpoints/SubmitInFlightEndpointTests.cs`. Use the existing `WebApplicationFactory` test pattern from `PreferencesEndpointsTests` (extend its base test-host setup):

```csharp
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Web.Submit;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

public class SubmitInFlightEndpointTests : EndpointTestBase   // shared test base; see existing
{
    [Fact]
    public async Task GET_inFlight_EmptyRegistry_ReturnsFalse()
    {
        using var client = Host.CreateClient();

        var resp = await client.GetAsync("/api/submit/in-flight", TestContext.Current.CancellationToken);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<SubmitInFlightResponse>(TestContext.Current.CancellationToken);
        body!.InFlight.Should().BeFalse();
        body.PrRef.Should().BeNull();
    }

    [Fact]
    public async Task GET_inFlight_LockHeld_ReturnsTrueWithRef()
    {
        var registry = Host.Services.GetRequiredService<SubmitLockRegistry>();
        await using var handle = await registry.TryAcquireAsync(
            new PrReference("octocat", "Hello-World", 1),
            TestContext.Current.CancellationToken);

        using var client = Host.CreateClient();
        var resp = await client.GetAsync("/api/submit/in-flight", TestContext.Current.CancellationToken);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<SubmitInFlightResponse>(TestContext.Current.CancellationToken);
        body!.InFlight.Should().BeTrue();
        body.PrRef.Should().Be("octocat/Hello-World/1");
    }
}

internal sealed record SubmitInFlightResponse(bool InFlight, string? PrRef);
```

- [ ] **Step 2: Run to verify failure**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitInFlightEndpointTests" --no-restore
```

Expected: FAIL — endpoint doesn't exist (404 or routing error).

### Task 1.4: `GET /api/submit/in-flight` endpoint — GREEN

- [ ] **Step 1: Create the endpoint file**

Create `PRism.Web/Endpoints/SubmitInFlightEndpoint.cs`:

```csharp
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

internal static class SubmitInFlightEndpoint
{
    public static IEndpointRouteBuilder MapSubmitInFlight(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/submit/in-flight", (SubmitLockRegistry registry) =>
        {
            var (held, prRef) = registry.AnyHeld();
            return Results.Ok(new SubmitInFlightResponse(held, prRef));
        });

        return app;
    }
}

internal sealed record SubmitInFlightResponse(bool InFlight, string? PrRef);
```

- [ ] **Step 2: Wire endpoint in `Program.cs`**

In `PRism.Web/Program.cs`, after the existing endpoint mappings, add:

```csharp
app.MapSubmitInFlight();
```

- [ ] **Step 3: Run tests to verify pass**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SubmitInFlightEndpointTests" --no-restore
```

Expected: 2 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add PRism.Web/Endpoints/SubmitInFlightEndpoint.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Endpoints/SubmitInFlightEndpointTests.cs
git commit -m "feat(s6-pr1): add GET /api/submit/in-flight endpoint"
```

### Task 1.5: `ConfigStore.PatchAsync` allowlist extension — RED

- [ ] **Step 1: Write the failing tests**

Add to `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncTests.cs` (create if absent):

```csharp
using FluentAssertions;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStorePatchAsyncDottedPathTests : IAsyncLifetime
{
    private string _dir = null!;
    private ConfigStore _store = null!;

    public async ValueTask InitializeAsync()
    {
        _dir = Path.Combine(Path.GetTempPath(), "prism-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _store = new ConfigStore(_dir);
        await _store.InitAsync(TestContext.Current.CancellationToken);
    }

    public ValueTask DisposeAsync()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
        return ValueTask.CompletedTask;
    }

    [Theory]
    [InlineData("inbox.sections.review-requested")]
    [InlineData("inbox.sections.awaiting-author")]
    [InlineData("inbox.sections.authored-by-me")]
    [InlineData("inbox.sections.mentioned")]
    [InlineData("inbox.sections.ci-failing")]
    public async Task PatchAsync_InboxSectionsKey_PersistsToCorrectField(string key)
    {
        await _store.PatchAsync(
            new Dictionary<string, object?> { [key] = false },
            TestContext.Current.CancellationToken);

        var sections = _store.Current.Inbox.Sections;
        var actual = key switch
        {
            "inbox.sections.review-requested" => sections.ReviewRequested,
            "inbox.sections.awaiting-author"  => sections.AwaitingAuthor,
            "inbox.sections.authored-by-me"   => sections.AuthoredByMe,
            "inbox.sections.mentioned"        => sections.Mentioned,
            "inbox.sections.ci-failing"       => sections.CiFailing,
            _ => throw new InvalidOperationException("test key not handled")
        };
        actual.Should().BeFalse();
    }

    [Fact]
    public async Task PatchAsync_UnknownDottedKey_ThrowsConfigPatchException()
    {
        var act = async () => await _store.PatchAsync(
            new Dictionary<string, object?> { ["inbox.sections.unknown"] = true },
            TestContext.Current.CancellationToken);

        await act.Should().ThrowAsync<ConfigPatchException>();
    }

    [Fact]
    public async Task PatchAsync_LegacyUiKeys_StillAccepted_BackCompat()
    {
        await _store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" },
            TestContext.Current.CancellationToken);

        _store.Current.Ui.Theme.Should().Be("dark");
    }
}
```

- [ ] **Step 2: Run to verify failure**

```
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests" --no-restore
```

Expected: 5 parameterized tests FAIL (`ConfigPatchException: unknown field: inbox.sections.*`); the legacy-`theme` test PASSes.

### Task 1.6: `ConfigStore.PatchAsync` allowlist extension — GREEN

- [ ] **Step 1: Extend the allowlist and add dotted-path switch arms**

Modify `PRism.Core/Config/ConfigStore.cs`. Replace `_allowedUiFields` with the broader `_allowedFields` set:

```csharp
private static readonly HashSet<string> _allowedFields = new(StringComparer.Ordinal)
{
    // ui.* (existing — bare keys for back-compat with S0+S1 wire shape)
    "theme",
    "accent",
    "aiPreview",
    // inbox.sections.* (new in S6) — keys map to InboxSectionsConfig in
    // PRism.Core/Config/AppConfig.cs. Canonical section set: docs/spec/03-poc-features.md § 11.
    "inbox.sections.review-requested",
    "inbox.sections.awaiting-author",
    "inbox.sections.authored-by-me",
    "inbox.sections.mentioned",
    "inbox.sections.ci-failing",
};
```

Replace the switch in `PatchAsync`:

```csharp
var (key, value) = patch.Single();
if (!_allowedFields.Contains(key))
    throw new ConfigPatchException($"unknown field: {key}");

await _gate.WaitAsync(ct).ConfigureAwait(false);
try
{
    var ui = _current.Ui;
    var sections = _current.Inbox.Sections;
    _current = key switch
    {
        "theme"     => _current with { Ui = ui with { Theme  = (string)value! } },
        "accent"    => _current with { Ui = ui with { Accent = (string)value! } },
        "aiPreview" => _current with { Ui = ui with { AiPreview = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } },
        "inbox.sections.review-requested" =>
            _current with { Inbox = _current.Inbox with { Sections = sections with { ReviewRequested = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } } },
        "inbox.sections.awaiting-author" =>
            _current with { Inbox = _current.Inbox with { Sections = sections with { AwaitingAuthor  = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } } },
        "inbox.sections.authored-by-me" =>
            _current with { Inbox = _current.Inbox with { Sections = sections with { AuthoredByMe    = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } } },
        "inbox.sections.mentioned" =>
            _current with { Inbox = _current.Inbox with { Sections = sections with { Mentioned       = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } } },
        "inbox.sections.ci-failing" =>
            _current with { Inbox = _current.Inbox with { Sections = sections with { CiFailing       = Convert.ToBoolean(value, CultureInfo.InvariantCulture) } } },
        _ => throw new ConfigPatchException($"unknown field: {key}")
    };
    await WriteToDiskAsync(ct).ConfigureAwait(false);
}
finally
{
    _gate.Release();
}
RaiseChanged();
```

- [ ] **Step 2: Run tests to verify pass**

```
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ConfigStorePatchAsyncDottedPathTests" --no-restore
```

Expected: 7 tests PASS (5 parameterized + unknown-key + back-compat).

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(s6-pr1): extend ConfigStore.PatchAsync allowlist to inbox.sections.* dotted keys"
```

### Task 1.7: Richer `GET /api/preferences` response shape — RED

- [ ] **Step 1: Write the failing test**

Extend `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` (or create a new file):

```csharp
[Fact]
public async Task GET_preferences_ReturnsRicherShape_WithInboxAndGithub()
{
    using var client = Host.CreateClient();

    var resp = await client.GetAsync("/api/preferences", TestContext.Current.CancellationToken);

    resp.StatusCode.Should().Be(HttpStatusCode.OK);
    var body = await resp.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);

    body.GetProperty("ui").GetProperty("theme").GetString().Should().Be("system");
    body.GetProperty("ui").GetProperty("accent").GetString().Should().Be("indigo");
    body.GetProperty("ui").GetProperty("aiPreview").GetBoolean().Should().BeFalse();

    var sections = body.GetProperty("inbox").GetProperty("sections");
    sections.GetProperty("review-requested").GetBoolean().Should().BeTrue();
    sections.GetProperty("awaiting-author").GetBoolean().Should().BeTrue();
    sections.GetProperty("authored-by-me").GetBoolean().Should().BeTrue();
    sections.GetProperty("mentioned").GetBoolean().Should().BeTrue();
    sections.GetProperty("ci-failing").GetBoolean().Should().BeTrue();

    var github = body.GetProperty("github");
    github.GetProperty("host").GetString().Should().Be("https://github.com");
    github.GetProperty("configPath").GetString().Should().EndWith("config.json");
}
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — response is still the flat `PreferencesResponse(Theme, Accent, AiPreview)` shape.

### Task 1.8: Richer GET shape — GREEN

- [ ] **Step 1: Update `PreferencesDtos.cs`**

Modify `PRism.Web/Endpoints/PreferencesDtos.cs`:

```csharp
namespace PRism.Web.Endpoints;

internal sealed record PreferencesResponse(
    UiPreferencesDto Ui,
    InboxPreferencesDto Inbox,
    GithubPreferencesDto Github);

internal sealed record UiPreferencesDto(string Theme, string Accent, bool AiPreview);

internal sealed record InboxPreferencesDto(InboxSectionsDto Sections);

internal sealed record InboxSectionsDto(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool CiFailing);

internal sealed record GithubPreferencesDto(string Host, string ConfigPath);

internal sealed record PreferencesError(string Error);
```

Note: the existing `JsonSerializerOptionsFactory.Web` should already apply the kebab-case policy so `ReviewRequested` serializes as `review-requested`, etc. If not, add explicit `[JsonPropertyName("review-requested")]` attributes.

- [ ] **Step 2: Compute `configPath` and expose it via `IConfigStore`**

Modify `PRism.Core/Config/IConfigStore.cs` to add a read-only property:

```csharp
public interface IConfigStore
{
    AppConfig Current { get; }
    string ConfigPath { get; }   // NEW — absolute path to config.json
    Exception? LastLoadError { get; }
    // ... rest unchanged
}
```

Modify `PRism.Core/Config/ConfigStore.cs` to expose the existing `_path` field via the new property:

```csharp
public string ConfigPath => _path;
```

- [ ] **Step 3: Update `GET /api/preferences` to return the richer shape**

Modify `PRism.Web/Endpoints/PreferencesEndpoints.cs`. Replace the `MapGet` handler:

```csharp
app.MapGet("/api/preferences", (IConfigStore config) =>
{
    var ui = config.Current.Ui;
    var sections = config.Current.Inbox.Sections;
    return Results.Ok(new PreferencesResponse(
        Ui: new UiPreferencesDto(ui.Theme, ui.Accent, ui.AiPreview),
        Inbox: new InboxPreferencesDto(new InboxSectionsDto(
            ReviewRequested: sections.ReviewRequested,
            AwaitingAuthor:  sections.AwaitingAuthor,
            AuthoredByMe:    sections.AuthoredByMe,
            Mentioned:       sections.Mentioned,
            CiFailing:       sections.CiFailing)),
        Github: new GithubPreferencesDto(
            Host: config.Current.Github.Host,
            ConfigPath: config.ConfigPath)));
});
```

The POST handler stays unchanged for the single-field contract; it already reads any allowed key via `PatchAsync`.

- [ ] **Step 4: Run tests to verify pass**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PreferencesEndpoints" --no-restore
```

Expected: all PASS, including the new richer-shape test. Existing tests should adapt to the new response (the existing test may need a small update to read from `Ui.Theme` instead of top-level `Theme`).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/IConfigStore.cs PRism.Core/Config/ConfigStore.cs PRism.Web/Endpoints/PreferencesEndpoints.cs PRism.Web/Endpoints/PreferencesDtos.cs tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs
git commit -m "feat(s6-pr1): enrich GET /api/preferences with inbox.sections + github sections"
```

### Task 1.9: PR1 verification + open PR

- [ ] **Step 1: Run full test suite**

```
dotnet test --configuration Release
```

Expected: all PASS (existing + new). If any prior tests fail due to the response-shape change, update them inline.

- [ ] **Step 2: Pre-push checklist**

Per README.md "Pre-push checklist": frontend lint + build + test, then backend build + test. PR1 is backend-only; the frontend pieces stay current.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin spec/s6-polish-distribution
gh pr create --title "feat(s6-pr1): backend preferences allowlist + /api/submit/in-flight" --body "$(cat <<'EOF'
## Summary

S6 PR1 of 9. Backend foundations for the Settings page and Replace token flow:

- `ConfigStore.PatchAsync` allowlist extended to dotted-path `inbox.sections.*` keys.
- `GET /api/preferences` returns the richer shape (Ui / Inbox.Sections / Github.{Host, ConfigPath}).
- `GET /api/submit/in-flight` endpoint added; backed by new `SubmitLockRegistry.AnyHeld()` that uses a held-set rather than the naive `_locks.Any()` (entries never evict).

Implements spec § 2.3 (allowlist), § 2.4 (wire shape), § 3.5 (in-flight endpoint).

Spec: `docs/specs/2026-05-15-s6-polish-and-distribution-design.md`.

## Test plan

- [x] xUnit tests for SubmitLockRegistry.AnyHeld() — empty, held, released, multiple.
- [x] xUnit tests for /api/submit/in-flight — empty + held.
- [x] xUnit tests for ConfigStore.PatchAsync — five dotted keys + unknown + legacy back-compat.
- [x] xUnit test for richer /api/preferences shape.
- [x] dotnet test --configuration Release passes.
EOF
)"
```

---

## PR2 — Backend: `/api/auth/replace` + identity-change rule + SSE wiring + structured log

**Goal:** Implement the lazy validate-before-swap Replace token endpoint with the identity-change rule (clear Node IDs, preserve drafts on different login). Introduce the global `IdentityChanged` `IReviewEvent` with bespoke `SseChannel` wiring per spec § 3.2.1. Add `IActivePrCache.Clear()`, `ActivePrSubscriberRegistry.RemoveAll()`, `InboxPoller.RequestImmediateRefresh()`. Emit structured-log forensic record per spec § 3.6.

**Depends on:** PR1 (soft — uses `SubmitLockRegistry.AnyHeld()` internally; PR1 first is the cheaper sequencing).

**Files:**
- Create: `PRism.Core/Events/IdentityChanged.cs`
- Modify: `PRism.Web/Sse/SseChannel.cs` (subscribe + handler + dispose for `IdentityChanged`)
- Modify: `PRism.Core/PrDetail/IActivePrCache.cs` + `ActivePrCache.cs` (add `Clear()`)
- Modify: `PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs` (add `RemoveAll()`)
- Modify: `PRism.Core/Inbox/InboxPoller.cs` (race `Task.Delay` against signal)
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs` (add `POST /api/auth/replace` + `LogIdentityChanged`)
- Modify: `PRism.Web/Endpoints/AuthDtos.cs` (request/response shapes)
- Test: `tests/PRism.Core.Tests/Events/IdentityChangedTests.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrCacheClearTests.cs`
- Test: `tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryRemoveAllTests.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxPollerImmediateRefreshTests.cs`
- Test: `tests/PRism.Web.Tests/Sse/SseChannelIdentityChangedTests.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/AuthReplaceEndpointTests.cs`

### Task 2.1: `IdentityChanged` event type — RED → GREEN

- [ ] **Step 1: Write test**

Create `tests/PRism.Core.Tests/Events/IdentityChangedTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Events;
using Xunit;

namespace PRism.Core.Tests.Events;

public class IdentityChangedTests
{
    [Fact]
    public void Construct_StoresFields()
    {
        var evt = new IdentityChanged("default", "alice", "bob");
        evt.AccountKey.Should().Be("default");
        evt.PriorLogin.Should().Be("alice");
        evt.NewLogin.Should().Be("bob");
    }

    [Fact]
    public void ImplementsIReviewEvent()
    {
        IReviewEvent evt = new IdentityChanged("default", "alice", "bob");
        evt.Should().NotBeNull();
    }
}
```

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~IdentityChangedTests"`. Expected: compile error.

- [ ] **Step 3: Create the event type**

Create `PRism.Core/Events/IdentityChanged.cs`:

```csharp
namespace PRism.Core.Events;

// Global identity-change event: published when /api/auth/replace swaps to a PAT
// whose login differs from the prior login. Carries account key + login names
// for forensic reconstruction. No PrRef because this is global, not per-PR.
// SseChannel.OnIdentityChanged fans out to every connected subscriber. The wire
// frame is `event: identity-changed` with minimal payload `{ "type": "identity-change" }`
// — login fields stay server-side (spec § 3.2.1 wire-shape rationale).
public sealed record IdentityChanged(
    string AccountKey,
    string PriorLogin,
    string NewLogin) : IReviewEvent;
```

- [ ] **Step 4: Run + commit**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~IdentityChangedTests" --no-restore
git add PRism.Core/Events/IdentityChanged.cs tests/PRism.Core.Tests/Events/IdentityChangedTests.cs
git commit -m "feat(s6-pr2): add IdentityChanged global IReviewEvent"
```

### Task 2.2: `IActivePrCache.Clear()` — RED → GREEN

- [ ] **Step 1: Test**

Create `tests/PRism.Core.Tests/PrDetail/ActivePrCacheClearTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrCacheClearTests
{
    [Fact]
    public void Clear_RemovesAllEntries()
    {
        var cache = new ActivePrCache();
        var pr1 = new PrReference("octocat", "Hello-World", 1);
        var pr2 = new PrReference("octocat", "Hello-World", 2);
        cache.Update(pr1, new ActivePrSnapshot("sha-a", null, DateTimeOffset.UtcNow));
        cache.Update(pr2, new ActivePrSnapshot("sha-b", null, DateTimeOffset.UtcNow));

        cache.Clear();

        cache.GetCurrent(pr1).Should().BeNull();
        cache.GetCurrent(pr2).Should().BeNull();
    }

    [Fact]
    public void Clear_EmptyCache_DoesNotThrow()
    {
        var act = () => new ActivePrCache().Clear();
        act.Should().NotThrow();
    }
}
```

- [ ] **Step 2: Implement** — add `void Clear()` to `IActivePrCache` interface (XML doc references spec § 3.3); implementation calls `_snapshots.Clear()` on `ActivePrCache`.

- [ ] **Step 3: Run + commit**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivePrCacheClearTests" --no-restore
git add PRism.Core/PrDetail/IActivePrCache.cs PRism.Core/PrDetail/ActivePrCache.cs tests/PRism.Core.Tests/PrDetail/ActivePrCacheClearTests.cs
git commit -m "feat(s6-pr2): add IActivePrCache.Clear()"
```

### Task 2.3: `ActivePrSubscriberRegistry.RemoveAll()` — RED → GREEN

- [ ] **Step 1: Test**

Create `tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryRemoveAllTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

public class ActivePrSubscriberRegistryRemoveAllTests
{
    [Fact]
    public void RemoveAll_ClearsBothMaps()
    {
        var reg = new ActivePrSubscriberRegistry();
        var pr1 = new PrReference("o", "r", 1);
        var pr2 = new PrReference("o", "r", 2);
        reg.Add("sub-a", pr1);
        reg.Add("sub-b", pr1);
        reg.Add("sub-b", pr2);

        reg.RemoveAll();

        reg.SubscribersFor(pr1).Should().BeEmpty();
        reg.SubscribersFor(pr2).Should().BeEmpty();
        reg.UniquePrRefs().Should().BeEmpty();
    }
}
```

- [ ] **Step 2: Implement** — add `public void RemoveAll() { _bySubscriber.Clear(); _byPr.Clear(); }`.

- [ ] **Step 3: Run + commit**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~ActivePrSubscriberRegistryRemoveAllTests" --no-restore
git add PRism.Core/PrDetail/ActivePrSubscriberRegistry.cs tests/PRism.Core.Tests/PrDetail/ActivePrSubscriberRegistryRemoveAllTests.cs
git commit -m "feat(s6-pr2): add ActivePrSubscriberRegistry.RemoveAll()"
```

### Task 2.4: `InboxPoller.RequestImmediateRefresh()` — RED → GREEN

- [ ] **Step 1: Timing test**

Create `tests/PRism.Core.Tests/Inbox/InboxPollerImmediateRefreshTests.cs` using the existing test patterns (`IInboxOrchestrator` fake, `InboxSubscriberCount`, a `TestConfigStore`). Assert: configured cadence is 60s; signal fires; next `RefreshAsync` lands within 500ms — well under the cadence. Bound the test runtime via `CancellationTokenSource(TimeSpan.FromSeconds(5))`.

- [ ] **Step 2: Implement** — Modify `PRism.Core/Inbox/InboxPoller.cs`:
  - Add `private readonly SemaphoreSlim _refreshSignal = new(0, 1);`
  - Replace `await Task.Delay(nextDelay, stoppingToken)` with `Task.WhenAny(Task.Delay(nextDelay, linkedCt.Token), _refreshSignal.WaitAsync(linkedCt.Token))`; linked CTS so the losing branch cancels.
  - Add `public void RequestImmediateRefresh()` that calls `_refreshSignal.Release()` inside a `try/catch (SemaphoreFullException)` to coalesce duplicate signals.

- [ ] **Step 3: Run + commit**

```bash
dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxPollerImmediateRefreshTests" --no-restore
git add PRism.Core/Inbox/InboxPoller.cs tests/PRism.Core.Tests/Inbox/InboxPollerImmediateRefreshTests.cs
git commit -m "feat(s6-pr2): InboxPoller.RequestImmediateRefresh races Task.Delay against signal"
```

### Task 2.5: `SseChannel` wiring for `IdentityChanged` — RED → GREEN

- [ ] **Step 1: Test**

Create `tests/PRism.Web.Tests/Sse/SseChannelIdentityChangedTests.cs`. Use the existing SSE test harness pattern from `tests/PRism.Web.Tests/Sse/` (mock subscribers + capture written frames). Assert: every connected subscriber receives an `event: identity-changed` frame with data `{"type":"identity-change"}`; the payload contains NO `priorLogin`/`newLogin` strings.

- [ ] **Step 2: Implement** — Modify `PRism.Web/Sse/SseChannel.cs`:
  - Add `private readonly IDisposable _busIdentityChanged;` field.
  - In constructor: `_busIdentityChanged = bus.Subscribe<IdentityChanged>(OnIdentityChanged);`
  - In `Dispose()`: `_busIdentityChanged.Dispose();`
  - New handler:

```csharp
private void OnIdentityChanged(IdentityChanged evt)
{
    const string payload = """{"type":"identity-change"}""";
    foreach (var sub in _subscribers.Values)
    {
        TryWriteFrame(sub, eventName: "identity-changed", data: payload);
    }
}
```

(`TryWriteFrame` is the helper used by the existing handlers — extract one if the codebase doesn't yet have it, named after the existing `OnInboxUpdated` write idiom.)

- [ ] **Step 3: Run + commit**

```bash
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~SseChannelIdentityChangedTests" --no-restore
git add PRism.Web/Sse/SseChannel.cs tests/PRism.Web.Tests/Sse/SseChannelIdentityChangedTests.cs
git commit -m "feat(s6-pr2): SseChannel fans out IdentityChanged to all subscribers"
```

### Task 2.6: `LogIdentityChanged` source-generator method

- [ ] **Step 1: Add `[LoggerMessage]` partial method**

In `PRism.Web/Endpoints/AuthEndpoints.cs`, extend the existing nested `Log` partial class:

```csharp
[LoggerMessage(
    Level = LogLevel.Information,
    Message = "Identity changed accountKey={AccountKey} priorLogin={PriorLogin} newLogin={NewLogin} sessions={SessionsAffected} drafts={DraftsAffected} replies={RepliesAffected}")]
internal static partial void LogIdentityChanged(
    ILogger logger,
    string accountKey,
    string priorLogin,
    string newLogin,
    int sessionsAffected,
    int draftsAffected,
    int repliesAffected);
```

- [ ] **Step 2: Compile-check**

```
dotnet build PRism.Web --no-restore
```

Expected: SUCCESS.

### Task 2.7: `POST /api/auth/replace` endpoint — RED

- [ ] **Step 1: Endpoint tests**

Create `tests/PRism.Web.Tests/Endpoints/AuthReplaceEndpointTests.cs` covering every spec § 3.8 row:

1. Same login → `identityChanged: false`, no mutation.
2. Same login case-insensitive (`Alice` → `alice`) → `identityChanged: false`.
3. Different login → `identityChanged: true`; for a seeded session with `PendingReviewId`, draft `ThreadId`, reply `ReplyCommentId`: all Node IDs null after; draft + reply body bytes preserved verbatim; `DraftReply.ParentThreadId` preserved.
4. Structured-log emission: `Identity changed` line captured with `priorLogin=alice newLogin=bob sessions=N drafts=N replies=N`.
5. PAT-not-logged discipline: capture all log entries during a happy-path call with `secretPat = "ghp_super_secret_xyz123"`; assert no entry contains the secret as a substring.
6. Validation failure → `RollbackTransientAsync` called; old PAT readable from `TokenStore`; no state mutation; no `Identity changed` log line.
7. `SubmitLockRegistry.AnyHeld() == true` → 409 with body `{ ok: false, error: "submit-in-flight", prRef: "<owner>/<repo>/<n>" }`; no transient written.

Use the existing `EndpointTestBase` + seed helpers; add new seed helpers (`SeedPriorLogin`, `SeedReviewSession`) as needed.

- [ ] **Step 2: Run to verify failure** — endpoint doesn't exist.

### Task 2.8: `POST /api/auth/replace` endpoint — GREEN

- [ ] **Step 1: Add the handler in `AuthEndpoints.cs`**

Inside `MapAuth`, add the `POST /api/auth/replace` handler. Sketch (full code in spec § 3 and the spec's identity-change pseudocode at § 3.2):

```csharp
app.MapPost("/api/auth/replace", async (
    HttpContext ctx,
    ITokenStore tokens,
    IReviewAuth review,
    IAppStateStore stateStore,
    IConfigStore config,
    IViewerLoginProvider viewerLogin,
    SubmitLockRegistry submitLocks,
    IReviewEventBus bus,
    IActivePrCache activePrCache,
    ActivePrSubscriberRegistry activeRegistry,
    InboxPoller inboxPoller,
    ILogger<Category> log,
    CancellationToken ct) =>
{
    // 1) In-flight submit guard
    var (held, heldRef) = submitLocks.AnyHeld();
    if (held) return Results.Conflict(new AuthReplaceError(false, "submit-in-flight", heldRef));

    // 2) Parse body
    JsonDocument doc;
    try { doc = await JsonDocument.ParseAsync(ctx.Request.Body, cancellationToken: ct).ConfigureAwait(false); }
    catch (JsonException) { return Results.BadRequest(new AuthReplaceError(false, "invalid-json")); }
    using var _doc = doc;
    var pat = doc.RootElement.TryGetProperty("pat", out var p) ? p.GetString() : null;
    if (string.IsNullOrWhiteSpace(pat)) return Results.BadRequest(new AuthReplaceError(false, "pat-required"));

    // 3) Snapshot priorLogin (pre-mutation)
    var priorLogin = config.Current.Github.Accounts[0].Login;

    // 4) Transient + validate
    Log.ConnectValidating(log, pat.Length, config.Current.Github.Host);
    await tokens.WriteTransientAsync(pat, ct).ConfigureAwait(false);
    var result = await review.ValidateCredentialsAsync(ct).ConfigureAwait(false);
    if (!result.Ok)
    {
        await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
        return Results.BadRequest(new AuthReplaceError(false, result.Error?.ToString()?.ToLowerInvariant() ?? "validation-failed"));
    }
    var newLogin = result.Login ?? "";

    // 5) TOCTOU re-check (lock may have been acquired between step 1 and now)
    (held, heldRef) = submitLocks.AnyHeld();
    if (held)
    {
        await tokens.RollbackTransientAsync(ct).ConfigureAwait(false);
        return Results.Conflict(new AuthReplaceError(false, "submit-in-flight", heldRef));
    }

    // 6) Commit
    await tokens.CommitAsync(ct).ConfigureAwait(false);
    viewerLogin.Set(newLogin);
    await config.SetDefaultAccountLoginAsync(newLogin, ct).ConfigureAwait(false);

    // 7) Identity-change rule (case-insensitive compare; null priorLogin is first-launch only)
    var identityChanged = !string.IsNullOrEmpty(priorLogin)
        && !string.Equals(priorLogin, newLogin, StringComparison.OrdinalIgnoreCase);

    if (identityChanged)
    {
        var sessionsAffected = 0;
        var draftsAffected   = 0;
        var repliesAffected  = 0;

        await stateStore.UpdateAsync(state =>
        {
            // Reset closure-captured counters at top of every transform invocation.
            // UpdateAsync's last-transform-wins may re-run the lambda; without reset,
            // losing-run mutations accumulate (spec § 3.2 retry-safety note).
            sessionsAffected = 0;
            draftsAffected   = 0;
            repliesAffected  = 0;

            var sessions = state.Reviews.Sessions;
            var newSessions = new Dictionary<string, ReviewSessionState>(sessions.Count);
            foreach (var (refKey, session) in sessions)
            {
                var hadIds = session.PendingReviewId is not null
                    || session.DraftComments.Any(d => d.ThreadId is not null)
                    || session.DraftReplies.Any(r => r.ReplyCommentId is not null);
                var clearedDrafts  = session.DraftComments.Select(d => d.ThreadId is null ? d : d with { ThreadId = null }).ToImmutableList();
                var clearedReplies = session.DraftReplies.Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null }).ToImmutableList();
                newSessions[refKey] = session with
                {
                    PendingReviewId        = null,
                    PendingReviewCommitOid = null,
                    DraftComments          = clearedDrafts,
                    DraftReplies           = clearedReplies,
                };
                if (hadIds) sessionsAffected++;
                draftsAffected  += session.DraftComments.Count(d => d.ThreadId is not null);
                repliesAffected += session.DraftReplies.Count(r => r.ReplyCommentId is not null);
            }
            return state.WithDefaultReviews(state.Reviews with { Sessions = newSessions.ToImmutableDictionary() });
        }, ct).ConfigureAwait(false);

        // Forensic log (wrapped per spec § 14 OQ 4: forensic-log loss < partial state)
        try
        {
            Log.LogIdentityChanged(log, AccountKeys.Default, priorLogin!, newLogin,
                sessionsAffected, draftsAffected, repliesAffected);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException and not StackOverflowException)
        {
            // Swallow so cache eviction + SSE fan-out still run.
        }

        activePrCache.Clear();
        inboxPoller.RequestImmediateRefresh();
        activeRegistry.RemoveAll();
        bus.Publish(new IdentityChanged(AccountKeys.Default, priorLogin!, newLogin));
    }

    return Results.Ok(new AuthReplaceResponse(true, newLogin, config.Current.Github.Host, identityChanged));
});
```

Add DTOs to `PRism.Web/Endpoints/AuthDtos.cs`:

```csharp
internal sealed record AuthReplaceResponse(bool Ok, string Login, string Host, bool IdentityChanged);
internal sealed record AuthReplaceError(bool Ok, string Error, string? PrRef = null);
```

- [ ] **Step 2: Run endpoint tests**

```
dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~AuthReplaceEndpointTests" --no-restore
```

Expected: 7 tests PASS.

- [ ] **Step 3: Run full backend suite**

```
dotnet test --configuration Release --no-restore
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add PRism.Web/Endpoints/AuthEndpoints.cs PRism.Web/Endpoints/AuthDtos.cs tests/PRism.Web.Tests/Endpoints/AuthReplaceEndpointTests.cs
git commit -m "feat(s6-pr2): POST /api/auth/replace with identity-change rule, structured log, SSE fan-out"
```

### Task 2.9: PR2 push + PR

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(s6-pr2): backend /api/auth/replace + identity-change rule + IdentityChanged SSE" --body "$(cat <<'EOF'
## Summary

S6 PR2 of 9. Backend Replace-token + identity-change rule. Implements spec § 3 in full.

- `POST /api/auth/replace` with TOCTOU-defended submit-lock check, lazy validate-before-swap, identity-change rule clearing Node IDs while preserving draft text.
- New `IdentityChanged` global IReviewEvent + bespoke `SseChannel` wiring (handler + `event: identity-changed` wire frame + minimal `{"type":"identity-change"}` payload — no login leakage).
- `IActivePrCache.Clear()`, `ActivePrSubscriberRegistry.RemoveAll()`, `InboxPoller.RequestImmediateRefresh()`.
- `LogIdentityChanged` structured-log emission per spec § 3.6.

## Test plan

- [x] IdentityChanged event-type unit tests
- [x] IActivePrCache.Clear() unit tests
- [x] ActivePrSubscriberRegistry.RemoveAll() unit tests
- [x] InboxPoller.RequestImmediateRefresh() timing test (signal-fires-refresh < 500ms)
- [x] SseChannel.OnIdentityChanged fan-out (minimal payload; no login leakage)
- [x] /api/auth/replace happy-path same login (case-sensitive + case-insensitive)
- [x] /api/auth/replace different login: Node IDs cleared, bodies preserved
- [x] Structured-log `Identity changed` line capture
- [x] PAT-not-logged: secret PAT never in any log entry
- [x] Validation failure rolls back; old PAT intact
- [x] Submit-lock 409 path with prRef
EOF
)"
```

---

## PR3 — Frontend: Settings page

**Goal:** Settings page at `/settings` with four sections (Appearance, Inbox sections, GitHub, Auth). Extends `usePreferences` for the richer GET shape; reuses existing `Toast` (extends with `'success'` kind). Adds Header nav link with three-tab active-state logic.

**Depends on:** PR1 (richer GET shape + dotted-path PATCH allowlist).

**Files:**
- Modify: `frontend/src/App.tsx` (route + nav)
- Modify: `frontend/src/components/Header/Header.tsx` (Settings tab + first-run `·` indicator)
- Modify: `frontend/src/api/types.ts` (extend `UiPreferences` shape)
- Modify: `frontend/src/hooks/usePreferences.ts` (read richer shape; expose `inbox.sections` + `github.configPath`)
- Modify: `frontend/src/components/Toast/Toast.tsx` (add `'success'` kind)
- Modify: `frontend/src/components/Toast/Toast.module.css` (add `.success` rule)
- Create: `frontend/src/pages/SettingsPage.tsx`
- Create: `frontend/src/components/Settings/SettingsPage.module.css`
- Create: `frontend/src/components/Settings/AppearanceSection.tsx`
- Create: `frontend/src/components/Settings/InboxSectionsSection.tsx`
- Create: `frontend/src/components/Settings/GithubSection.tsx`
- Create: `frontend/src/components/Settings/AuthSection.tsx`
- Test: `frontend/__tests__/Settings/SettingsPage.test.tsx`
- Test: `frontend/__tests__/Settings/InboxSectionsSection.test.tsx`
- Test: `frontend/__tests__/Settings/GithubSection.test.tsx`
- Test: `frontend/e2e/settings-flow.spec.ts`

### Task 3.1: Extend `UiPreferences` type + `usePreferences` hook — RED → GREEN

- [ ] **Step 1: Test**

Add to `frontend/__tests__/hooks/usePreferences.test.tsx` (extend existing file):

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePreferences } from '../../src/hooks/usePreferences';

describe('usePreferences — richer GET shape', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ui: { theme: 'dark', accent: 'amber', aiPreview: true },
        inbox: { sections: {
          'review-requested': true,
          'awaiting-author': false,
          'authored-by-me': true,
          'mentioned': true,
          'ci-failing': false,
        }},
        github: { host: 'https://github.com', configPath: '/Users/x/AppData/Local/PRism/config.json' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });

  it('exposes ui, inbox.sections, and github fields from the richer GET shape', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());

    expect(result.current.preferences!.ui.theme).toBe('dark');
    expect(result.current.preferences!.inbox.sections['review-requested']).toBe(true);
    expect(result.current.preferences!.inbox.sections['awaiting-author']).toBe(false);
    expect(result.current.preferences!.github.configPath).toContain('config.json');
  });
});
```

- [ ] **Step 2: Update types**

In `frontend/src/api/types.ts`:

```ts
export type Theme = 'system' | 'light' | 'dark';
export type Accent = 'indigo' | 'amber' | 'teal';

export interface UiPreferences {
  ui: { theme: Theme; accent: Accent; aiPreview: boolean };
  inbox: { sections: {
    'review-requested': boolean;
    'awaiting-author':  boolean;
    'authored-by-me':   boolean;
    'mentioned':        boolean;
    'ci-failing':       boolean;
  }};
  github: { host: string; configPath: string };
}
```

- [ ] **Step 3: Update `usePreferences.ts`**

Replace the hook body so `preferences` returns the new shape; `set(key, value)` accepts either the bare `ui.*` keys (back-compat) or the dotted `inbox.sections.*` keys:

```ts
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { UiPreferences } from '../api/types';

type PreferenceKey =
  | 'theme' | 'accent' | 'aiPreview'
  | `inbox.sections.${'review-requested' | 'awaiting-author' | 'authored-by-me' | 'mentioned' | 'ci-failing'}`;

export function usePreferences() {
  const [preferences, setPreferences] = useState<UiPreferences | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try { setPreferences(await apiClient.get<UiPreferences>('/api/preferences')); }
    catch (e) { setError(e as Error); }
  }, []);

  useEffect(() => {
    void refetch();
    const handler = () => { void refetch(); };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refetch]);

  const set = useCallback(async (key: PreferenceKey, value: unknown) => {
    const next = await apiClient.post<UiPreferences>('/api/preferences', { [key]: value });
    setPreferences(next);
    return next;
  }, []);

  return { preferences, error, refetch, set };
}
```

- [ ] **Step 4: Update existing `HeaderControls.tsx` callers**

Header chips currently access `preferences.theme` / `preferences.accent` / `preferences.aiPreview` directly. Update to read from `preferences.ui.theme` etc.:

```tsx
// In HeaderControls.tsx
applyToDocument(preferences.ui.theme, preferences.ui.accent);
const cycleTheme = () => { const next = THEMES[(THEMES.indexOf(preferences.ui.theme) + 1) % THEMES.length]; void set('theme', next); };
const cycleAccent = () => { /* mirror */ };
const toggleAi = async () => { await set('aiPreview', !preferences.ui.aiPreview); void refetchCapabilities(); };
```

- [ ] **Step 5: Run + commit**

```bash
cd frontend && npm test -- usePreferences
cd .. && git add frontend/src/api/types.ts frontend/src/hooks/usePreferences.ts frontend/src/components/Header/HeaderControls.tsx frontend/__tests__/hooks/usePreferences.test.tsx
git commit -m "feat(s6-pr3): usePreferences exposes richer GET shape (ui, inbox.sections, github.configPath)"
```

### Task 3.2: Extend `Toast` with `'success'` kind — RED → GREEN

- [ ] **Step 1: Test**

Add to `frontend/__tests__/Toast/Toast.test.tsx`:

```tsx
import { render, screen, act } from '@testing-library/react';
import { Toast } from '../../src/components/Toast/Toast';
import { describe, it, expect, vi } from 'vitest';

describe('Toast success kind', () => {
  it('renders kind=success with the success CSS class', () => {
    render(<Toast toast={{ id: 't1', kind: 'success', message: 'Done!' }} onDismiss={() => {}} />);
    expect(screen.getByText('Done!')).toBeInTheDocument();
    expect(screen.getByText('Done!').closest('[class*="success"]')).not.toBeNull();
  });

  it('auto-dismisses success toast at 5s (matches info)', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast toast={{ id: 't1', kind: 'success', message: 'Done!' }} onDismiss={onDismiss} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onDismiss).toHaveBeenCalledWith('t1');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Implement**

Modify `frontend/src/components/Toast/Toast.tsx`:

```tsx
export interface ToastSpec {
  id: string;
  kind: 'info' | 'error' | 'success';   // add 'success'
  message: string;
  requestId?: string;
}

export function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    if (toast.kind === 'info' || toast.kind === 'success') {   // both auto-dismiss at 5s
      const timer = setTimeout(() => onDismiss(toast.id), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.kind, onDismiss]);
  // ... rest unchanged
}
```

Modify `frontend/src/components/Toast/Toast.module.css`:

```css
.success {
  border-left: 3px solid var(--success, oklch(0.65 0.14 145));
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- Toast
cd .. && git add frontend/src/components/Toast/Toast.tsx frontend/src/components/Toast/Toast.module.css frontend/__tests__/Toast/Toast.test.tsx
git commit -m "feat(s6-pr3): Toast supports kind='success' with 5s auto-dismiss"
```

### Task 3.3: Settings page route + Header nav — RED → GREEN

- [ ] **Step 1: Test**

Create `frontend/__tests__/Settings/SettingsPage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false },
      inbox: { sections: {
        'review-requested': true, 'awaiting-author': true, 'authored-by-me': true,
        'mentioned': true, 'ci-failing': true,
      }},
      github: { host: 'https://github.com', configPath: '/path/to/config.json' },
    },
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  }),
}));

describe('SettingsPage', () => {
  it('renders all four section groups', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /inbox sections/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /github/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /auth/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Create section components**

Create `frontend/src/components/Settings/AppearanceSection.tsx` — three rows: theme dropdown (system/light/dark), accent radio (indigo/amber/teal), AI preview toggle. Each control calls `set(key, value)` from `usePreferences`.

Create `frontend/src/components/Settings/InboxSectionsSection.tsx` — five toggle rows. Render a single `<span id="inbox-section-help">Inbox section changes apply on the next inbox refresh (within 2 minutes).</span>`; every toggle sets `aria-describedby="inbox-section-help"`.

Create `frontend/src/components/Settings/GithubSection.tsx` — read-only host display + a "Copy `config.json` path" button alongside an always-visible read-only `<input type="text" readOnly value={configPath} aria-label="Path to config.json">`. Clicking the button calls `navigator.clipboard.writeText(configPath)`; on success calls `useToast().show({ kind: 'success', message: 'Path copied — paste into your editor' })`; on rejection calls `useToast().show({ kind: 'error', message: 'Could not copy path. Select it from the field next to the button.' })`.

Create `frontend/src/components/Settings/AuthSection.tsx` — placeholder "Replace token" link (full logic lands in PR4). For PR3, render a disabled link with text "Replace token (lands in PR4)" so the section is structurally present.

Create `frontend/src/pages/SettingsPage.tsx`:

```tsx
import { AppearanceSection } from '../components/Settings/AppearanceSection';
import { InboxSectionsSection } from '../components/Settings/InboxSectionsSection';
import { GithubSection } from '../components/Settings/GithubSection';
import { AuthSection } from '../components/Settings/AuthSection';
import styles from '../components/Settings/SettingsPage.module.css';

export function SettingsPage() {
  return (
    <main className={styles.page}>
      <h1>Settings</h1>
      <AppearanceSection />
      <InboxSectionsSection />
      <GithubSection />
      <AuthSection />
    </main>
  );
}
```

Create `frontend/src/components/Settings/SettingsPage.module.css`:

```css
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
```

- [ ] **Step 3: Add route in `App.tsx`**

```tsx
<Route
  path="/settings"
  element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />}
/>
```

- [ ] **Step 4: Add Header nav link with three-tab active-state logic**

Modify `frontend/src/components/Header/Header.tsx`:

```tsx
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';

export function Header() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');

  // Custom active rules per spec § 2.1
  const inboxActive = pathname === '/' || pathname === '/inbox';
  const settingsActive = pathname === '/settings' || (pathname === '/setup' && isReplaceMode);
  const setupActive = pathname === '/setup' && !isReplaceMode;

  // ... and the rest of Header reads hasToken to render the · indicator on Setup tab
}
```

- [ ] **Step 5: Run + commit**

```bash
cd frontend && npm test -- Settings
cd .. && git add frontend/src/pages/SettingsPage.tsx frontend/src/components/Settings/ frontend/src/App.tsx frontend/src/components/Header/Header.tsx frontend/__tests__/Settings/
git commit -m "feat(s6-pr3): Settings page route + Header nav with three-tab active-state logic"
```

### Task 3.4: Inbox sections toggles persistence — RED → GREEN

- [ ] **Step 1: Test**

Create `frontend/__tests__/Settings/InboxSectionsSection.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InboxSectionsSection } from '../../src/components/Settings/InboxSectionsSection';

const setMock = vi.fn();
vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false },
      inbox: { sections: {
        'review-requested': true, 'awaiting-author': true, 'authored-by-me': true,
        'mentioned': true, 'ci-failing': true,
      }},
      github: { host: 'https://github.com', configPath: '/x/config.json' },
    },
    error: null, refetch: vi.fn(), set: setMock,
  }),
}));

describe('InboxSectionsSection', () => {
  it('renders five toggles with aria-describedby pointing at the helper span', () => {
    render(<InboxSectionsSection />);
    const toggles = screen.getAllByRole('switch');
    expect(toggles).toHaveLength(5);
    toggles.forEach(t => expect(t).toHaveAttribute('aria-describedby', 'inbox-section-help'));
    expect(screen.getByText(/within 2 minutes/i)).toBeInTheDocument();
  });

  it('clicking a toggle posts the matching dotted-path key', async () => {
    const user = userEvent.setup();
    render(<InboxSectionsSection />);
    const reviewToggle = screen.getByRole('switch', { name: /review requested/i });
    await user.click(reviewToggle);
    expect(setMock).toHaveBeenCalledWith('inbox.sections.review-requested', false);
  });
});
```

- [ ] **Step 2: Implement (already sketched in Task 3.3 Step 2; expand to call `set` correctly)**

```tsx
import { usePreferences } from '../../hooks/usePreferences';

const ROWS = [
  { key: 'review-requested' as const, label: 'Review requested' },
  { key: 'awaiting-author'  as const, label: 'Awaiting author'  },
  { key: 'authored-by-me'   as const, label: 'Authored by me'   },
  { key: 'mentioned'        as const, label: 'Mentioned'        },
  { key: 'ci-failing'       as const, label: 'CI failing on my PRs' },
];

export function InboxSectionsSection() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;
  const sections = preferences.inbox.sections;

  return (
    <section aria-labelledby="inbox-sections-heading">
      <h2 id="inbox-sections-heading">Inbox sections</h2>
      <span id="inbox-section-help">
        Inbox section changes apply on the next inbox refresh (within 2 minutes).
      </span>
      {ROWS.map(({ key, label }) => (
        <label key={key}>
          <input
            type="checkbox"
            role="switch"
            aria-describedby="inbox-section-help"
            aria-label={label}
            checked={sections[key]}
            onChange={(e) => void set(`inbox.sections.${key}` as const, e.target.checked)}
          />
          {label}
        </label>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- InboxSectionsSection
cd .. && git add frontend/src/components/Settings/InboxSectionsSection.tsx frontend/__tests__/Settings/InboxSectionsSection.test.tsx
git commit -m "feat(s6-pr3): InboxSectionsSection — five toggles with aria-describedby helper"
```

### Task 3.5: GithubSection Copy-path button + clipboard failure UX — RED → GREEN

- [ ] **Step 1: Test**

Create `frontend/__tests__/Settings/GithubSection.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GithubSection } from '../../src/components/Settings/GithubSection';

const showMock = vi.fn();
vi.mock('../../src/components/Toast', () => ({ useToast: () => ({ show: showMock }) }));
vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false },
      inbox: { sections: { 'review-requested': true, 'awaiting-author': true, 'authored-by-me': true, 'mentioned': true, 'ci-failing': true } },
      github: { host: 'https://github.com', configPath: '/Users/x/AppData/Local/PRism/config.json' },
    },
    error: null, refetch: vi.fn(), set: vi.fn(),
  }),
}));

describe('GithubSection', () => {
  beforeEach(() => { showMock.mockReset(); });

  it('always renders the path as a read-only input', () => {
    render(<GithubSection />);
    const input = screen.getByRole('textbox', { name: /path to config.json/i });
    expect(input).toHaveAttribute('readOnly');
    expect(input).toHaveValue('/Users/x/AppData/Local/PRism/config.json');
  });

  it('clicking Copy-path surfaces success toast on clipboard.writeText resolve', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const user = userEvent.setup();
    render(<GithubSection />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });

  it('clicking Copy-path surfaces error toast on clipboard.writeText reject', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    const user = userEvent.setup();
    render(<GithubSection />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});
```

- [ ] **Step 2: Implement**

```tsx
import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../Toast';

export function GithubSection() {
  const { preferences } = usePreferences();
  const { show } = useToast();
  if (!preferences) return null;
  const { host, configPath } = preferences.github;

  const onCopy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(configPath);
        show({ kind: 'success', message: 'Path copied — paste into your editor' });
      } catch {
        show({ kind: 'error', message: 'Could not copy path. Select it from the field next to the button.' });
      }
    })();
  };

  return (
    <section aria-labelledby="github-heading">
      <h2 id="github-heading">GitHub</h2>
      <div>Host: <code>{host}</code></div>
      <label>
        <span>Path to <code>config.json</code></span>
        <input type="text" readOnly value={configPath} aria-label="Path to config.json" />
      </label>
      <button type="button" onClick={onCopy}>Copy config.json path</button>
    </section>
  );
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- GithubSection
cd .. && git add frontend/src/components/Settings/GithubSection.tsx frontend/__tests__/Settings/GithubSection.test.tsx
git commit -m "feat(s6-pr3): GithubSection — Copy-path button + always-visible read-only input"
```

### Task 3.6: Playwright e2e — Settings flow

- [ ] **Step 1: Spec**

Create `frontend/e2e/settings-flow.spec.ts`. Reuses the existing test backend (token already configured). Asserts: page renders all four sections; toggling an inbox section persists across reload; toggling theme/accent/AI applies immediately; Copy-path button writes to clipboard (use `page.context().grantPermissions(['clipboard-write'])` + read back via `page.evaluate(() => navigator.clipboard.readText())`).

- [ ] **Step 2: Run + commit**

```bash
cd frontend && npx playwright test settings-flow
cd .. && git add frontend/e2e/settings-flow.spec.ts
git commit -m "test(s6-pr3): e2e Settings flow — toggle persistence + Copy-path"
```

### Task 3.7: PR3 push + PR

- [ ] **Step 1: Pre-push checklist** (frontend lint + build + unit tests + e2e from README)

- [ ] **Step 2: Push + PR**

```bash
git push
gh pr create --title "feat(s6-pr3): frontend Settings page" --body "$(cat <<'EOF'
## Summary

S6 PR3 of 9. Settings page at `/settings` with four sections:

- Appearance (theme / accent / AI preview — same controls as header chips, comprehensive home)
- Inbox sections (five toggles with `aria-describedby` helper for the 2-minute propagation caveat)
- GitHub (read-only host + always-visible read-only `<input>` with Copy-path button)
- Auth (Replace token placeholder — full UX lands in PR4)

Header gains a Settings nav link; three-tab active-state logic ensures `/setup?replace=1` highlights Settings, not Setup.

Toast component extended with `'success'` kind (5s auto-dismiss like `'info'`).

## Test plan

- [x] usePreferences exposes richer GET shape (ui / inbox.sections / github.configPath)
- [x] Toast renders kind=success and auto-dismisses at 5s
- [x] SettingsPage renders all four sections
- [x] InboxSectionsSection: 5 toggles with aria-describedby + correct dotted-path POSTs
- [x] GithubSection: always-visible input + clipboard success / failure toasts
- [x] Playwright settings-flow e2e
EOF
)"
```

---

## PR4 — Frontend: Replace token UX

**Goal:** Replace token affordance lives in Settings Auth section. Click → check `/api/submit/in-flight` → navigate to `/setup?replace=1` (with Cancel link) → SetupForm submits to `/api/auth/replace` → on success, surface identity-change toast and navigate to `/`.

**Depends on:** PR2 (`/api/auth/replace`), PR3 (Settings page + Toast 'success' kind).

**Files:**
- Modify: `frontend/src/components/Settings/AuthSection.tsx` (Replace link + in-flight guard)
- Modify: `frontend/src/components/Setup/SetupForm.tsx` (Cancel link in replace mode)
- Modify: `frontend/src/pages/SetupPage.tsx` (handle `?replace=1` query param)
- Modify: `frontend/src/App.tsx` (loosen `/setup` route guard for `?replace=1`)
- Modify: `frontend/src/hooks/useAuth.ts` (subscribe to `identity-changed` SSE event; refetch on reconnect)
- Modify: `frontend/src/hooks/useEventSource.tsx` (handle `identity-changed` event name)
- Create: `frontend/src/hooks/useSubmitInFlight.ts`
- Create: `frontend/src/api/replaceToken.ts`
- Test: `frontend/__tests__/Settings/AuthSection.test.tsx`
- Test: `frontend/e2e/replace-token-same-login.spec.ts`
- Test: `frontend/e2e/replace-token-different-login.spec.ts`
- Test: `frontend/e2e/replace-token-submit-in-flight.spec.ts`

### Task 4.1: `useSubmitInFlight` hook

- [ ] **Step 1: Test**

```tsx
// frontend/__tests__/hooks/useSubmitInFlight.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useSubmitInFlight } from '../../src/hooks/useSubmitInFlight';

describe('useSubmitInFlight', () => {
  it('polls /api/submit/in-flight and exposes the result', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ inFlight: true, prRef: 'o/r/1' }), { status: 200 }),
    );
    const { result } = renderHook(() => useSubmitInFlight());
    await waitFor(() => expect(result.current.inFlight).toBe(true));
    expect(result.current.prRef).toBe('o/r/1');
  });
});
```

- [ ] **Step 2: Implement**

```ts
// frontend/src/hooks/useSubmitInFlight.ts
import { useEffect, useState } from 'react';
import { apiClient } from '../api/client';

interface InFlightResponse { inFlight: boolean; prRef: string | null; }

export function useSubmitInFlight() {
  const [state, setState] = useState<InFlightResponse>({ inFlight: false, prRef: null });

  useEffect(() => {
    const fetchOnce = async () => {
      try { setState(await apiClient.get<InFlightResponse>('/api/submit/in-flight')); }
      catch { /* tolerated; the in-flight guard is best-effort */ }
    };
    void fetchOnce();
    // Refetch on every state-changed SSE event so the Replace link re-enables when the lock clears.
    const handler = () => { void fetchOnce(); };
    window.addEventListener('prism-state-changed', handler);
    return () => window.removeEventListener('prism-state-changed', handler);
  }, []);

  return state;
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- useSubmitInFlight
cd .. && git add frontend/src/hooks/useSubmitInFlight.ts frontend/__tests__/hooks/useSubmitInFlight.test.tsx
git commit -m "feat(s6-pr4): useSubmitInFlight hook polls /api/submit/in-flight"
```

### Task 4.2: AuthSection Replace token link with in-flight guard

- [ ] **Step 1: Test**

```tsx
// frontend/__tests__/Settings/AuthSection.test.tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthSection } from '../../src/components/Settings/AuthSection';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/hooks/useSubmitInFlight', () => ({
  useSubmitInFlight: vi.fn(),
}));

import { useSubmitInFlight } from '../../src/hooks/useSubmitInFlight';

describe('AuthSection Replace link', () => {
  it('enabled when no submit is in flight', () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: false, prRef: null });
    render(<MemoryRouter><AuthSection /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /replace token/i });
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disabled with prRef tooltip when a submit is in flight', () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: true, prRef: 'octocat/Hello-World/42' });
    render(<MemoryRouter><AuthSection /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /replace token/i });
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/octocat\/Hello-World\/42/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `AuthSection`**

```tsx
import { Link } from 'react-router-dom';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';

export function AuthSection() {
  const { inFlight, prRef } = useSubmitInFlight();

  return (
    <section aria-labelledby="auth-heading">
      <h2 id="auth-heading">Auth</h2>
      {inFlight ? (
        <>
          <Link
            to="/setup?replace=1"
            aria-disabled="true"
            tabIndex={-1}
            style={{ pointerEvents: 'none', opacity: 0.5 }}
          >
            Replace token
          </Link>
          <span role="note">A submit is in progress on {prRef}. Replace token after it finishes.</span>
        </>
      ) : (
        <Link to="/setup?replace=1">Replace token</Link>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- AuthSection
cd .. && git add frontend/src/components/Settings/AuthSection.tsx frontend/__tests__/Settings/AuthSection.test.tsx
git commit -m "feat(s6-pr4): AuthSection Replace token link with in-flight submit guard"
```

### Task 4.3: SetupForm Cancel link in replace mode + route gate

- [ ] **Step 1: Test** — Vitest test asserting that when `searchParams.has('replace') === true`, SetupForm renders a Cancel link with `to="/settings"`.

- [ ] **Step 2: Update `SetupForm.tsx`**

```tsx
import { useSearchParams, Link } from 'react-router-dom';

export function SetupForm({ host, onSubmit, error, busy }: Props) {
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');
  // ... existing form rendering ...
  // After the Continue button:
  {isReplaceMode && (
    <Link to="/settings" style={{ marginTop: 'var(--space-3)' }}>Cancel</Link>
  )}
}
```

- [ ] **Step 3: Loosen `/setup` route guard in `App.tsx`**

Currently `isAuthed` redirects `/setup` → `/`. Allow `/setup?replace=1` when authed:

```tsx
<Route
  path="/setup"
  element={(() => {
    const params = new URLSearchParams(window.location.search);
    if (isAuthed && !params.has('replace')) return <Navigate to="/" replace />;
    return <SetupPage />;
  })()}
/>
```

(Or use a small `<SetupGate>` wrapper component that reads `useSearchParams` to make this React-idiomatic.)

- [ ] **Step 4: Run + commit**

```bash
cd frontend && npm run build && npm test -- SetupForm
cd .. && git add frontend/src/components/Setup/SetupForm.tsx frontend/src/App.tsx frontend/__tests__/Setup/SetupForm.test.tsx
git commit -m "feat(s6-pr4): SetupForm Cancel link in replace mode + route gate"
```

### Task 4.4: `replaceToken` API + `SetupPage` wires it up

- [ ] **Step 1: Test** — mock `/api/auth/replace` returning `{ ok: true, login: 'bob', host, identityChanged: true }`; assert SetupPage in replace mode calls the right endpoint and dispatches the identity-changed toast.

- [ ] **Step 2: Implement**

Create `frontend/src/api/replaceToken.ts`:

```ts
import { apiClient } from './client';

export interface ReplaceTokenResponse {
  ok: true;
  login: string;
  host: string;
  identityChanged: boolean;
}

export async function replaceToken(pat: string): Promise<ReplaceTokenResponse> {
  return apiClient.post<ReplaceTokenResponse>('/api/auth/replace', { pat });
}
```

Update `SetupPage.tsx` to branch on replace mode: if `?replace=1`, call `replaceToken(pat)` instead of `connect(pat)`; on success, if `identityChanged`, fire `useToast().show({ kind: 'success', message: \`Connected as \${result.login}. Drafts preserved; pending review IDs cleared so the new login can re-submit.\` })`; navigate('/').

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test
cd .. && git add frontend/src/api/replaceToken.ts frontend/src/pages/SetupPage.tsx frontend/__tests__/SetupPage.test.tsx
git commit -m "feat(s6-pr4): SetupPage replace-mode posts to /api/auth/replace + identity-change toast"
```

### Task 4.5: `useAuth` subscribes to `identity-changed` SSE event

- [ ] **Step 1: Update event-source handling**

Modify `frontend/src/hooks/useEventSource.tsx` to register a listener for the `identity-changed` event name. On receipt, dispatch a `window.dispatchEvent(new CustomEvent('prism-identity-changed'))` so consumers can wire up.

Modify `frontend/src/hooks/useAuth.ts` to listen for `prism-identity-changed` and call `refetch()` (re-fetches `/api/auth/state` to pick up the new login). Also call `refetch()` on every EventSource reconnect (use the existing reconnect handler).

- [ ] **Step 2: Test**

```tsx
// frontend/__tests__/hooks/useAuth.test.tsx — extend
it('refetches /api/auth/state when prism-identity-changed fires', async () => {
  const { result } = renderHook(() => useAuth());
  // Set up fetch mock counters; dispatch the event
  window.dispatchEvent(new CustomEvent('prism-identity-changed'));
  await waitFor(() => {
    expect(/* fetch count */).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- useAuth useEventSource
cd .. && git add frontend/src/hooks/useAuth.ts frontend/src/hooks/useEventSource.tsx frontend/__tests__/hooks/useAuth.test.tsx
git commit -m "feat(s6-pr4): useAuth refetches on identity-changed SSE + reconnect"
```

### Task 4.6: Playwright e2e specs

- [ ] **Step 1: `replace-token-same-login.spec.ts`** — Setup with PAT-A → Replace token to a PAT that validates as the same login → assert no identity-change toast surfaces; Settings page re-renders with same login.

- [ ] **Step 2: `replace-token-different-login.spec.ts`** — Setup with PAT-A validating to `alice` → seed a draft on a PR → Replace token to a PAT validating to `bob` → assert toast surfaces with "Connected as bob"; navigate to PR detail; draft body still visible.

- [ ] **Step 3: `replace-token-submit-in-flight.spec.ts`** — Setup; trigger a `/test/submit/hold` test hook to acquire a SubmitLockRegistry lock; navigate to Settings; assert Replace link is `aria-disabled`. Add the test hook in `PRism.Web/TestHooks/TestEndpoints.cs` if it doesn't already exist.

- [ ] **Step 4: Run + commit**

```bash
cd frontend && npx playwright test replace-token
cd .. && git add frontend/e2e/replace-token-*.spec.ts PRism.Web/TestHooks/
git commit -m "test(s6-pr4): e2e Replace token — same login, different login, submit-in-flight"
```

### Task 4.7: PR4 push + PR

- [ ] **Step 1: Pre-push checklist**

- [ ] **Step 2: Push + PR**

```bash
git push
gh pr create --title "feat(s6-pr4): frontend Replace token UX" --body "$(cat <<'EOF'
## Summary

S6 PR4 of 9. Replace token UX wires the Settings Auth section to the PR2 `/api/auth/replace` backend:

- `useSubmitInFlight` hook polls `/api/submit/in-flight`; refetches on state-changed SSE.
- AuthSection Replace link disables with prRef tooltip when a submit is in flight.
- `/setup?replace=1` route gate allows authed re-entry; SetupForm renders a Cancel link in replace mode.
- SetupPage in replace mode POSTs to `/api/auth/replace`; on `identityChanged: true`, surfaces a `'success'` toast.
- `useAuth` subscribes to the new `identity-changed` SSE event + refetches `/api/auth/state` on every EventSource reconnect (reconnect-replay defense per spec § 3.2.1).

## Test plan

- [x] useSubmitInFlight unit test (polls + refetches on event)
- [x] AuthSection enabled/disabled paths
- [x] SetupForm Cancel link in replace mode
- [x] SetupPage posts to /api/auth/replace and surfaces identity-changed toast
- [x] useAuth refetches on prism-identity-changed
- [x] Playwright e2e: same-login, different-login, submit-in-flight
EOF
)"
```

---

## PR5 — Frontend: Cheatsheet overlay

**Goal:** Non-modal cheatsheet at `role="dialog"` + `aria-modal="false"` opened via `?` (outside text inputs) or `Cmd/Ctrl+/` (anywhere). Visible × close button + ARIA APG focus management + focus-return liveness guard per spec § 4.1.

**Depends on:** none (independent of PR1-PR4).

**Files:**
- Create: `frontend/src/components/Cheatsheet/Cheatsheet.tsx`
- Create: `frontend/src/components/Cheatsheet/CheatsheetProvider.tsx`
- Create: `frontend/src/components/Cheatsheet/shortcuts.ts`
- Create: `frontend/src/components/Cheatsheet/Cheatsheet.module.css`
- Create: `frontend/src/components/Cheatsheet/index.ts`
- Create: `frontend/src/hooks/useCheatsheetShortcut.ts`
- Modify: `frontend/src/App.tsx` (mount `<CheatsheetProvider>` sibling to `<ToastProvider>`)
- Modify: various composer components to add `data-composer="true"` marker (Composer, ReplyComposer, PR-summary textarea)
- Test: `frontend/__tests__/Cheatsheet/Cheatsheet.test.tsx`
- Test: `frontend/__tests__/hooks/useCheatsheetShortcut.test.tsx`
- Test: `frontend/e2e/cheatsheet.spec.ts`

### Task 5.1: `shortcuts.ts` static content

- [ ] **Step 1: Create the constant**

`frontend/src/components/Cheatsheet/shortcuts.ts`:

```ts
export interface ShortcutRow {
  keys: string;
  context: string;
  action: string;
}

export interface ShortcutGroup {
  group: string;
  rows: ShortcutRow[];
}

export const SHORTCUTS: ReadonlyArray<ShortcutGroup> = [
  { group: 'Global', rows: [
    { keys: 'Cmd/Ctrl + R', context: 'Anywhere',                action: 'Reload current view' },
    { keys: 'Cmd/Ctrl + /', context: 'Anywhere',                action: 'Toggle this cheatsheet' },
    { keys: '?',            context: 'Outside text inputs',     action: 'Toggle this cheatsheet' },
    { keys: 'Esc',          context: 'Cheatsheet open',         action: 'Close cheatsheet' },
  ]},
  { group: 'File tree', rows: [
    { keys: 'j',            context: 'File tree',                action: 'Next file' },
    { keys: 'k',            context: 'File tree',                action: 'Previous file' },
    { keys: 'v',            context: 'File tree (file focused)', action: 'Toggle "Viewed" checkbox' },
  ]},
  { group: 'Diff', rows: [
    { keys: 'n',            context: 'Diff',                     action: 'Next comment thread' },
    { keys: 'p',            context: 'Diff',                     action: 'Previous comment thread' },
    { keys: 'c',            context: 'Diff (line focused)',      action: 'Open comment composer' },
  ]},
  { group: 'Composer', rows: [
    { keys: 'Cmd/Ctrl + Enter', context: 'Composer',             action: 'Save draft' },
    { keys: 'Esc',              context: 'Composer (non-empty)', action: 'Cancel (with discard confirm)' },
  ]},
  { group: 'Submit dialog', rows: [
    { keys: 'Cmd/Ctrl + Enter', context: 'Submit dialog focused', action: 'Confirm submit' },
  ]},
];
```

### Task 5.2: `useCheatsheetShortcut` hook — RED → GREEN

- [ ] **Step 1: Test**

```tsx
// frontend/__tests__/hooks/useCheatsheetShortcut.test.tsx
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useCheatsheetShortcut } from '../../src/hooks/useCheatsheetShortcut';

describe('useCheatsheetShortcut', () => {
  it('toggles on `?` when target is the document body', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: '?', bubbles: true });
      document.body.dispatchEvent(ev);
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT toggle on `?` when target is a <textarea>', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); });
    expect(toggle).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  it('toggles on Cmd+/ regardless of focused element', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true })); });
    expect(toggle).toHaveBeenCalledTimes(1);
    document.body.removeChild(ta);
  });

  it('Esc when open calls close + stops propagation', () => {
    const close = vi.fn();
    const stopProp = vi.fn();
    renderHook(() => useCheatsheetShortcut(() => {}, true, close));
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      Object.defineProperty(ev, 'stopPropagation', { value: stopProp });
      document.body.dispatchEvent(ev);
    });
    expect(close).toHaveBeenCalled();
    expect(stopProp).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// frontend/src/hooks/useCheatsheetShortcut.ts
import { useEffect } from 'react';

function isTextEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT' && target.getAttribute('type') === 'text') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[data-composer="true"]')) return true;
  return false;
}

export function useCheatsheetShortcut(toggle: () => void, isOpen: boolean, close: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      if (e.key === '?' && !isTextEditingContext(e.target)) {
        e.preventDefault();
        toggle();
        return;
      }
      if (isMeta && e.key === '/') {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggle, isOpen, close]);
}
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npm test -- useCheatsheetShortcut
cd .. && git add frontend/src/hooks/useCheatsheetShortcut.ts frontend/__tests__/hooks/useCheatsheetShortcut.test.tsx
git commit -m "feat(s6-pr5): useCheatsheetShortcut hook with focus-aware routing"
```

### Task 5.3: `Cheatsheet` overlay + provider — RED → GREEN

- [ ] **Step 1: Test**

```tsx
// frontend/__tests__/Cheatsheet/Cheatsheet.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { CheatsheetProvider, Cheatsheet, useCheatsheet } from '../../src/components/Cheatsheet';

function TestApp() {
  const { toggle } = useCheatsheet();
  return (
    <>
      <button onClick={toggle}>open</button>
      <Cheatsheet />
    </>
  );
}

describe('Cheatsheet', () => {
  it('renders dialog with labelled heading + close button when open', async () => {
    const user = userEvent.setup();
    render(<CheatsheetProvider><TestApp /></CheatsheetProvider>);
    await user.click(screen.getByText('open'));

    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(screen.getByRole('button', { name: /close cheatsheet/i })).toBeInTheDocument();
  });

  it('shows shortcut table grouped by section', async () => {
    const user = userEvent.setup();
    render(<CheatsheetProvider><TestApp /></CheatsheetProvider>);
    await user.click(screen.getByText('open'));

    expect(screen.getByRole('heading', { name: /file tree/i })).toBeInTheDocument();
    expect(screen.getByText(/Toggle "Viewed" checkbox/i)).toBeInTheDocument();
  });

  it('focus returns to previously-focused element on close — with liveness guard', async () => {
    const user = userEvent.setup();
    render(<CheatsheetProvider><TestApp /></CheatsheetProvider>);
    const opener = screen.getByText('open');
    opener.focus();
    await user.click(opener); // opens; focus moves to heading
    await user.click(screen.getByRole('button', { name: /close cheatsheet/i }));
    expect(document.activeElement).toBe(opener);
  });
});
```

- [ ] **Step 2: Implement provider + overlay**

`frontend/src/components/Cheatsheet/CheatsheetProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, createElement } from 'react';

interface CheatsheetApi {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
  returnFocusRef: React.MutableRefObject<HTMLElement | null>;
}

const NOOP: CheatsheetApi = {
  isOpen: false, toggle: () => {}, close: () => {},
  returnFocusRef: { current: null } as React.MutableRefObject<HTMLElement | null>,
};

const CheatsheetContext = createContext<CheatsheetApi>(NOOP);

export function CheatsheetProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) { returnFocusRef.current = document.activeElement as HTMLElement | null; }
      return !prev;
    });
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  return createElement(CheatsheetContext.Provider, { value: { isOpen, toggle, close, returnFocusRef } }, children);
}

export function useCheatsheet(): CheatsheetApi {
  return useContext(CheatsheetContext);
}
```

`frontend/src/components/Cheatsheet/Cheatsheet.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { useCheatsheet } from './CheatsheetProvider';
import { useCheatsheetShortcut } from '../../hooks/useCheatsheetShortcut';
import { SHORTCUTS } from './shortcuts';
import styles from './Cheatsheet.module.css';

export function Cheatsheet() {
  const { isOpen, toggle, close, returnFocusRef } = useCheatsheet();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useCheatsheetShortcut(toggle, isOpen, close);

  // Focus moves to heading on open (ARIA APG)
  useEffect(() => {
    if (isOpen) {
      headingRef.current?.focus();
    } else {
      // Focus-return with liveness guard (spec § 4.1)
      const target = returnFocusRef.current;
      if (target && document.contains(target)) target.focus();
      else document.body.focus();
    }
  }, [isOpen, returnFocusRef]);

  if (!isOpen) return null;

  return (
    <div className={styles.backdrop}>
      <div role="dialog" aria-modal="false" aria-labelledby="cheatsheet-heading" className={styles.panel}>
        <button
          type="button"
          aria-label="Close cheatsheet"
          className={styles.close}
          onClick={close}
        >×</button>
        <h2 id="cheatsheet-heading" ref={headingRef} tabIndex={-1}>Keyboard shortcuts</h2>
        {SHORTCUTS.map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            <table>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={`${g.group}-${r.keys}-${r.context}`}>
                    <td><kbd>{r.keys}</kbd></td>
                    <td>{r.context}</td>
                    <td>{r.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
```

`frontend/src/components/Cheatsheet/Cheatsheet.module.css`:

```css
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.1);
  pointer-events: none;   /* clicks fall through */
  z-index: 1000;
}
.panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(640px, calc(100vw - 32px));
  max-height: 80vh;
  overflow-y: auto;
  pointer-events: auto;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: var(--space-5);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.2);
}
.close {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  width: 32px; height: 32px;
  background: transparent;
  border: 1px solid var(--border-1);
  border-radius: 50%;
  font-size: 1.25rem;
  cursor: pointer;
}
```

`frontend/src/components/Cheatsheet/index.ts`:

```ts
export { Cheatsheet } from './Cheatsheet';
export { CheatsheetProvider, useCheatsheet } from './CheatsheetProvider';
```

- [ ] **Step 3: Mount in `App.tsx`** — wrap `<EventStreamProvider>` (or top-level tree) with `<CheatsheetProvider>` and render `<Cheatsheet />` as a sibling to `<ToastContainer />`.

- [ ] **Step 4: Add `data-composer="true"` marker to composers**

Add the attribute to the outer wrapper of each composer: `frontend/src/components/PrDetail/Drafts/...` and any inline-comment composer. Quick grep: `frontend/src/components/PrDetail/` for components with `<textarea>`.

- [ ] **Step 5: Run + commit**

```bash
cd frontend && npm test -- Cheatsheet
cd .. && git add frontend/src/components/Cheatsheet/ frontend/src/App.tsx frontend/src/components/PrDetail/
git commit -m "feat(s6-pr5): Cheatsheet overlay with ARIA APG focus + visible close + composer markers"
```

### Task 5.4: Playwright e2e

- [ ] **Step 1: Spec**

`frontend/e2e/cheatsheet.spec.ts`:
- Open via `?` outside composer → overlay visible.
- `?` inside a textarea → literal `?` typed, overlay NOT visible.
- `Cmd+/` inside a textarea → overlay visible; composer text unchanged.
- `Esc` with overlay open and a composer also open → overlay closes; composer untouched.
- `Cmd+R` with overlay open → reload runs; overlay still visible after reload.

- [ ] **Step 2: Run + commit**

```bash
cd frontend && npx playwright test cheatsheet
cd .. && git add frontend/e2e/cheatsheet.spec.ts
git commit -m "test(s6-pr5): e2e cheatsheet open/close + composer focus preservation"
```

### Task 5.5: PR5 push + PR

```bash
git push
gh pr create --title "feat(s6-pr5): cheatsheet overlay" --body "Implements spec § 4. Non-modal role=dialog cheatsheet with × close button + ARIA APG focus management + composer-aware `?` routing. Vitest + Playwright coverage."
```

---

## PR6 — Frontend: icon assets + branded `<LoadingScreen>`

**Goal:** Replace the plain "Loading…" divs in App.tsx + SetupPage with a branded `<LoadingScreen>` showing the PRism logo (pulse animation + low-opacity watermark) per spec § 5. Also: header logo swap + favicon.

**Depends on:** none.

**Files:**
- Copy: `assets/icons/PRismOG.png` → `frontend/public/prism-logo.png`
- Copy: `assets/icons/PRism256.ico` → `frontend/public/favicon.ico`
- Modify: `frontend/index.html` (`<link rel="icon">`)
- Modify: `frontend/src/components/Header/Logo.tsx` (use the new image)
- Create: `frontend/src/components/LoadingScreen/LoadingScreen.tsx`
- Create: `frontend/src/components/LoadingScreen/LoadingScreen.module.css`
- Create: `frontend/src/components/LoadingScreen/index.ts`
- Modify: `frontend/src/App.tsx` + `frontend/src/pages/SetupPage.tsx` (swap "Loading…" divs)
- Test: `frontend/__tests__/LoadingScreen/LoadingScreen.test.tsx`

### Task 6.1: Copy icon assets + favicon wire-up

- [ ] **Step 1: Copy files** (shell command, not via test):

```bash
cp assets/icons/PRismOG.png frontend/public/prism-logo.png
cp assets/icons/PRism256.ico frontend/public/favicon.ico
```

- [ ] **Step 2: Update `frontend/index.html`**

```html
<link rel="icon" href="/favicon.ico" type="image/x-icon">
```

- [ ] **Step 3: Update `Logo.tsx`**

```tsx
import styles from './Logo.module.css';

export function Logo() {
  return <img src="/prism-logo.png" alt="PRism" width={28} height={28} className={styles.logo} />;
}
```

(Add a minimal `Logo.module.css` with `.logo { display: block; }` if styling is needed.)

- [ ] **Step 4: Commit**

```bash
git add frontend/public/prism-logo.png frontend/public/favicon.ico frontend/index.html frontend/src/components/Header/Logo.tsx frontend/src/components/Header/Logo.module.css
git commit -m "feat(s6-pr6): copy icon assets to frontend/public + favicon + Header Logo swap"
```

### Task 6.2: `<LoadingScreen>` component — RED → GREEN

- [ ] **Step 1: Test**

```tsx
// frontend/__tests__/LoadingScreen/LoadingScreen.test.tsx
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LoadingScreen } from '../../src/components/LoadingScreen';

describe('LoadingScreen', () => {
  it('renders default label "Loading…"', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders accepts a custom label', () => {
    render(<LoadingScreen label="Booting…" />);
    expect(screen.getByText('Booting…')).toBeInTheDocument();
  });

  it('marks both logo images aria-hidden', () => {
    const { container } = render(<LoadingScreen />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    imgs.forEach(img => expect(img).toHaveAttribute('aria-hidden', 'true'));
  });

  it('uses role=status with aria-busy + aria-live=polite', () => {
    const { container } = render(<LoadingScreen />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).toHaveAttribute('aria-live', 'polite');
  });

  it('after timeoutMs elapses, swaps label to timeoutLabel', () => {
    vi.useFakeTimers();
    render(<LoadingScreen timeoutMs={1000} timeoutLabel="Still working…" />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('Still working…')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/components/LoadingScreen/LoadingScreen.tsx
import { useEffect, useState } from 'react';
import styles from './LoadingScreen.module.css';

interface Props {
  label?: string;
  timeoutMs?: number;
  timeoutLabel?: string;
}

export function LoadingScreen({
  label = 'Loading…',
  timeoutMs = 10000,
  timeoutLabel = 'Taking longer than expected — check the terminal output.',
}: Props) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), timeoutMs);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  return (
    <div className={styles.screen} role="status" aria-busy="true" aria-live="polite">
      <img src="/prism-logo.png" alt="" aria-hidden="true" className={styles.watermark} />
      <div className={styles.center}>
        <img src="/prism-logo.png" alt="" aria-hidden="true"
             className={timedOut ? styles.logoStill : styles.pulseLogo} />
        <span className={styles.label}>{timedOut ? timeoutLabel : label}</span>
        {timedOut && (
          <button type="button" onClick={() => window.location.reload()} className={styles.reload}>
            Reload
          </button>
        )}
      </div>
    </div>
  );
}
```

```css
/* frontend/src/components/LoadingScreen/LoadingScreen.module.css */
.screen {
  position: relative;
  width: 100vw; height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background: var(--surface-base, white);
  overflow: hidden;
}
.watermark {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: 60vmin; opacity: 0.06; pointer-events: none; z-index: 0;
}
.center {
  position: relative; z-index: 1;
  display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
}
.pulseLogo { width: 96px; height: 96px; animation: prism-pulse 1.5s ease-in-out infinite; }
.logoStill { width: 96px; height: 96px; }
.label { color: var(--text-muted); font-size: var(--font-size-sm); }
.reload { padding: var(--space-2) var(--space-4); }
@keyframes prism-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
@media (prefers-reduced-motion: reduce) { .pulseLogo { animation: none; } }
```

`frontend/src/components/LoadingScreen/index.ts`:

```ts
export { LoadingScreen } from './LoadingScreen';
```

- [ ] **Step 3: Swap call sites in `App.tsx` and `SetupPage.tsx`**

Replace `<div aria-busy="true">Loading…</div>` with `<LoadingScreen />`. Two call sites: App.tsx initial auth-state-loading + SetupPage authState-null branch.

- [ ] **Step 4: Run + commit**

```bash
cd frontend && npm test -- LoadingScreen
cd .. && git add frontend/src/components/LoadingScreen/ frontend/src/App.tsx frontend/src/pages/SetupPage.tsx frontend/__tests__/LoadingScreen/LoadingScreen.test.tsx
git commit -m "feat(s6-pr6): branded LoadingScreen with pulse + watermark + timeout fallback"
```

### Task 6.3: PR6 push + PR

```bash
git push
gh pr create --title "feat(s6-pr6): icon assets + branded LoadingScreen" --body "Implements spec § 5. Copies PRism icons into frontend/public/, swaps Header Logo + favicon, ships a branded `<LoadingScreen>` (pulse animation + low-opacity watermark + 10s timeout fallback with Reload button). Replaces plain Loading… divs in App.tsx and SetupPage.tsx."
```

---

## PR7 — Accessibility audit

**Goal:** Close every spec § 6 DoD-checkpoint bullet with evidence: axe-core run on every page (zero serious/critical violations) + manual grep + fixes for landmarks/ARIA labels/focus rings/SR-only badges + a VoiceOver pass on the macOS dogfood machine.

**Depends on:** PR3, PR5, PR6 (audit covers the new surfaces).

**Files:**
- Create: `frontend/e2e/a11y-audit.spec.ts`
- Add: `@axe-core/playwright` dependency in `frontend/package.json`
- Modify: any component that fails an axe rule (Header chips, Inbox row chips, iteration tab strip, etc.) to add `aria-label`, `<span className="sr-only">` companions, focus rings
- Modify: `frontend/src/styles/tokens.css` (add `.sr-only` utility if absent)

### Task 7.1: Add `@axe-core/playwright` + a11y audit spec — RED

- [ ] **Step 1: Install dependency**

```bash
cd frontend
npm install --save-dev @axe-core/playwright
```

Commit:

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore(s6-pr7): add @axe-core/playwright dev dependency"
```

- [ ] **Step 2: Write the spec**

Create `frontend/e2e/a11y-audit.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  { path: '/setup', name: 'setup' },
  { path: '/',      name: 'inbox' },
  { path: '/pr/octocat/Hello-World/1',          name: 'pr-overview' },
  { path: '/pr/octocat/Hello-World/1/files',    name: 'pr-files' },
  { path: '/pr/octocat/Hello-World/1/drafts',   name: 'pr-drafts' },
  { path: '/settings', name: 'settings' },
];

for (const page of PAGES) {
  test(`a11y: ${page.name} (${page.path}) — no serious/critical violations`, async ({ page: p }) => {
    await p.goto(page.path);
    await p.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page: p }).analyze();
    const blockers = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
  });
}

test('a11y: cheatsheet open — no serious/critical violations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const blockers = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
  expect(blockers, JSON.stringify(blockers, null, 2)).toEqual([]);
});
```

- [ ] **Step 3: Run + observe failures**

```bash
cd frontend && npx playwright test a11y-audit
```

Expected: SOME failures. The audit will list specific axe violations (rule + selector). Use the output to drive fixes in Task 7.2.

### Task 7.2: Fix audit findings iteratively

For each violation reported by Task 7.1:
- **Icon-only buttons without `aria-label`** — add `aria-label` to the button (e.g., header theme cycle chip, accent picker, AI preview toggle, iteration tab navigation arrows).
- **Missing landmarks** — wrap top-level content in `<main>`; ensure `<header>` and `<nav>` exist.
- **Color-contrast violations** — adjust the offending token in `frontend/src/styles/tokens.css` to meet WCAG AA (4.5:1 for body text, 3:1 for large text + non-text contrast).
- **Form inputs without labels** — add a `<label>` or `aria-label` to every `<input>` / `<textarea>` / `<select>`.

Make each fix as a small commit:

```bash
git add <file>
git commit -m "fix(s6-pr7-a11y): add aria-label to <component>"
```

- [ ] **Step 1: Iterate `npx playwright test a11y-audit` until 0 blockers across every page.**

- [ ] **Step 2: Verify focus rings — manual screenshot**

Run the app, Tab through every page. Use the existing `:focus-visible` styling rules. If any interactive element lacks a visible focus ring, add a `:focus-visible` rule:

```css
button:focus-visible, a:focus-visible, input:focus-visible {
  outline: 2px solid var(--focus-ring, oklch(0.65 0.18 245));
  outline-offset: 2px;
}
```

- [ ] **Step 3: SR-only badges**

Grep for badge / count components:

```bash
grep -r "className=.*[Bb]adge" frontend/src/components
```

For each rendered count, add a companion:

```tsx
<span className="sr-only">{count} new comments</span>
```

Add `.sr-only` to `tokens.css` if absent:

```css
.sr-only {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 4: VoiceOver manual pass (macOS dogfood machine)**

Document findings (or absence of findings) in the PR description. Walk through:
- Unread badges on inbox rows
- Viewed checkbox toggle on Files tab
- Iteration tab strip navigation
- Composer open/dismiss/discard-confirm
- Cheatsheet open/close
- LoadingScreen pulse + label

If issues surface, fix or document as deferrals.

### Task 7.3: PR7 push + PR

- [ ] **Step 1: Verify the CI run** — re-run `npx playwright test a11y-audit`. Must be green.

- [ ] **Step 2: Push + PR**

```bash
git push
gh pr create --title "feat(s6-pr7): accessibility audit (DoD-checkpoint)" --body "$(cat <<'EOF'
## Summary

S6 PR7 of 9. Implements spec § 6 — DoD-checkpoint a11y audit:

- New `e2e/a11y-audit.spec.ts` runs axe-core across all major pages + cheatsheet-open state; zero serious/critical violations.
- Manual fixes for icon-only buttons (aria-label), landmarks (header/main/nav wrappers), focus rings (:focus-visible), SR-only badge companions.
- VoiceOver pass conducted on macOS dogfood machine; findings documented (see below).

## Evidence per DoD § 13 bullet

- [x] Semantic landmarks — axe-core "landmark-one-main" / "region" rules: 0 violations across all pages
- [x] ARIA labels on icon-only buttons — axe-core "button-name" rule: 0 violations
- [x] Keyboard-navigable file tree — existing S3 e2e spec re-verified green
- [x] Focus rings visible — manual screenshot of Tab traversal attached
- [x] WCAG AA color contrast — axe-core "color-contrast" rule: 0 violations
- [x] SR-only badge labels — grep audit + axe-core "aria-text" rule: 0 violations

## VoiceOver findings

(Document here: unread badges, viewed checkbox, iteration tab strip, composer dismiss, cheatsheet, LoadingScreen. Note any deferred items.)
EOF
)"
```

---

## PR8 — `publish.yml` workflow + first-run trust copy

**Goal:** Manual-dispatch CI workflow that produces `PRism-win-x64.exe` and `PRism-osx-arm64` self-contained single-file binaries and attaches them to a draft GitHub Release. Setup screen gains a collapsible "First run on this machine?" disclosure with SmartScreen / Gatekeeper copy.

**Depends on:** none (independent of PR1-PR7).

**Files:**
- Modify: `PRism.Web/PRism.Web.csproj` (publish properties gated on `$(PublishProfile)`)
- Create: `.github/workflows/publish.yml`
- Create: `.github/dependabot.yml`
- Modify: `frontend/src/components/Setup/SetupForm.tsx` (add `<FirstRunDisclosure />`)
- Create: `frontend/src/components/Setup/FirstRunDisclosure.tsx`
- Test: `frontend/__tests__/Setup/FirstRunDisclosure.test.tsx`

### Task 8.1: Publish properties in `.csproj`

- [ ] **Step 1: Modify `PRism.Web.csproj`**

Add (gated on `$(PublishProfile)` so dev builds are untouched):

```xml
<PropertyGroup Condition="'$(PublishProfile)' != ''">
  <PublishSingleFile>true</PublishSingleFile>
  <SelfContained>true</SelfContained>
  <IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>
  <EnableCompressionInSingleFile>true</EnableCompressionInSingleFile>
  <PublishTrimmed>false</PublishTrimmed>
</PropertyGroup>
```

- [ ] **Step 2: Verify dev build still works**

```bash
dotnet build PRism.Web
```

Expected: unchanged behavior; the gate keeps these flags off without `-p:PublishProfile=ci`.

- [ ] **Step 3: Commit**

```bash
git add PRism.Web/PRism.Web.csproj
git commit -m "feat(s6-pr8): csproj publish properties gated on \$(PublishProfile)"
```

### Task 8.2: `publish.yml` workflow

- [ ] **Step 1: Create the workflow file**

`.github/workflows/publish.yml`:

```yaml
name: Publish

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag (e.g., v0.1.0)'
        required: true
        type: string

permissions:
  contents: write

jobs:
  build-and-publish:
    runs-on: windows-latest
    steps:
      # Third-party actions pinned to commit SHAs (security: mutable tags can be
      # force-pushed; pinned SHAs cannot). Bump via Dependabot.
      - uses: actions/checkout@<commit-sha>          # actions/checkout v4.x
      - uses: actions/setup-dotnet@<commit-sha>      # actions/setup-dotnet v4.x
        with:
          dotnet-version: '10.0.x'
      - uses: actions/setup-node@<commit-sha>        # actions/setup-node v4.x
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: 'frontend/package-lock.json'

      - name: Frontend install
        working-directory: frontend
        run: npm ci

      - name: Frontend build
        working-directory: frontend
        # Writes directly to ../PRism.Web/wwwroot per vite.config.ts `build.outDir`;
        # emptyOutDir: true clears stale assets first. No copy step needed.
        run: npm run build

      - name: Publish win-x64
        run: >
          dotnet publish PRism.Web/PRism.Web.csproj
          --runtime win-x64 --self-contained --configuration Release
          -p:PublishProfile=ci -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true
          --output publish/win-x64

      - name: Publish osx-arm64
        run: >
          dotnet publish PRism.Web/PRism.Web.csproj
          --runtime osx-arm64 --self-contained --configuration Release
          -p:PublishProfile=ci -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true
          --output publish/osx-arm64

      - name: Rename and measure binaries
        shell: pwsh
        run: |
          Rename-Item publish/win-x64/PRism.Web.exe PRism-win-x64.exe
          Rename-Item publish/osx-arm64/PRism.Web PRism-osx-arm64
          Write-Host "win-x64 size:   $((Get-Item publish/win-x64/PRism-win-x64.exe).Length / 1MB) MB"
          Write-Host "osx-arm64 size: $((Get-Item publish/osx-arm64/PRism-osx-arm64).Length / 1MB) MB"

      - name: Create draft Release
        uses: softprops/action-gh-release@<commit-sha>   # softprops/action-gh-release v2.x — SHA-pinned per supply-chain discipline
        with:
          tag_name: ${{ github.event.inputs.tag }}
          name: PRism ${{ github.event.inputs.tag }}
          draft: true
          generate_release_notes: true
          files: |
            publish/win-x64/PRism-win-x64.exe
            publish/osx-arm64/PRism-osx-arm64
```

**Pin SHAs**: before opening the PR, look up the current commit SHA for each action's most recent stable release and substitute it in for `<commit-sha>`. Example: `actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11` (verify against the action's release page).

- [ ] **Step 2: Add `.github/dependabot.yml`** for the SHA-pin upkeep

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish.yml .github/dependabot.yml
git commit -m "feat(s6-pr8): publish.yml + dependabot for SHA-pinned Actions"
```

### Task 8.3: `FirstRunDisclosure` component

- [ ] **Step 1: Test**

`frontend/__tests__/Setup/FirstRunDisclosure.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FirstRunDisclosure } from '../../src/components/Setup/FirstRunDisclosure';

describe('FirstRunDisclosure', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');
  afterEach(() => { if (origPlatform) Object.defineProperty(navigator, 'platform', origPlatform); });

  it('renders Windows block on Win32 platform', () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/SmartScreen/i)).toBeInTheDocument();
  });

  it('renders macOS block on MacIntel', () => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/Gatekeeper/i)).toBeInTheDocument();
  });

  it('renders both blocks on unknown platform', () => {
    Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
    render(<FirstRunDisclosure />);
    expect(screen.getByText(/SmartScreen/i)).toBeInTheDocument();
    expect(screen.getByText(/Gatekeeper/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// frontend/src/components/Setup/FirstRunDisclosure.tsx
function detectPlatform(): 'windows' | 'macos' | 'unknown' {
  const p = navigator.platform.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'unknown';
}

export function FirstRunDisclosure() {
  const platform = detectPlatform();
  return (
    <details>
      <summary>First run on this machine?</summary>
      {(platform === 'windows' || platform === 'unknown') && (
        <section>
          <h3>Windows</h3>
          <p>
            The first time you run PRism, Windows shows a SmartScreen warning
            ("Windows protected your PC") because PRism isn't code-signed for
            the PoC. Click <strong>More info</strong>, then <strong>Run anyway</strong>.
          </p>
        </section>
      )}
      {(platform === 'macos' || platform === 'unknown') && (
        <section>
          <h3>macOS</h3>
          <p>
            If macOS Gatekeeper blocks the binary, right-click the app and pick
            <strong> Open</strong> the first time. The first time PRism reads your token,
            macOS asks <strong>Allow / Always Allow / Deny</strong> — click
            <strong> Always Allow</strong> so you aren't asked again.
          </p>
        </section>
      )}
    </details>
  );
}
```

(Browser-default `<details>` styling is acceptable per spec § 7.5.)

- [ ] **Step 3: Wire into `SetupForm.tsx`** — render `<FirstRunDisclosure />` below the PAT generation steps + above the paste field.

- [ ] **Step 4: Run + commit**

```bash
cd frontend && npm test -- FirstRunDisclosure
cd .. && git add frontend/src/components/Setup/FirstRunDisclosure.tsx frontend/src/components/Setup/SetupForm.tsx frontend/__tests__/Setup/FirstRunDisclosure.test.tsx
git commit -m "feat(s6-pr8): FirstRunDisclosure with platform-detected SmartScreen + Gatekeeper copy"
```

### Task 8.4: Manual verification — dispatch the workflow once

- [ ] **Step 1: Push the branch first**

```bash
git push
```

- [ ] **Step 2: Dispatch the workflow with a test tag**

In GitHub Actions UI: Workflows → Publish → Run workflow → tag = `v0.0.1-test`. Workflow runs ~5 minutes.

- [ ] **Step 3: Verify the draft Release**

Download `PRism-win-x64.exe` and `PRism-osx-arm64` from the draft Release. Run each on its native OS:

- **Windows**: double-click → SmartScreen warning → "More info → Run anyway" → app boots → browser auto-launches → Setup screen renders → FirstRunDisclosure visible → can paste PAT → reaches Inbox.
- **macOS Apple Silicon**: double-click → if Gatekeeper blocks, right-click → Open → Keychain "Allow / Always Allow" prompt → click Always Allow → Inbox renders.

If either fails, fix and re-dispatch. Delete the test Release after verification.

### Task 8.5: PR8 push + PR

```bash
gh pr create --title "feat(s6-pr8): publish.yml workflow + first-run trust copy" --body "$(cat <<'EOF'
## Summary

S6 PR8 of 9. Implements spec § 7.

- `PRism.Web.csproj` gains publish properties gated on `\$(PublishProfile)` so dev builds stay clean.
- `.github/workflows/publish.yml` — workflow_dispatch only; builds frontend, publishes win-x64 + osx-arm64 self-contained single-file binaries, renames them, attaches to a draft Release. Third-party actions SHA-pinned per supply-chain discipline.
- `.github/dependabot.yml` configures monthly Actions dependency-update PRs so the SHA pins don't go stale.
- Setup screen gains `<FirstRunDisclosure />` with platform-detected SmartScreen + Gatekeeper copy.

## Test plan

- [x] Vitest tests for FirstRunDisclosure (Win32, MacIntel, unknown)
- [x] Manual: dispatch workflow with v0.0.1-test tag; verify both binaries run on their native OS; FirstRunDisclosure copy renders correctly per platform.
- [x] dotnet build PRism.Web succeeds without -p:PublishProfile=ci (dev builds unchanged)
EOF
)"
```

---

## PR9 — Viewport screenshot test + README graduation + spec doc updates

**Goal:** Final PR. Closes the no-layout-shift DoD line via a Playwright screenshot regression test. Graduates README to "downloadable PoC" status. Updates spec docs (`02-architecture.md`, `03-poc-features.md`, `roadmap.md`, `docs/specs/README.md`) to reflect S6 shipped state.

**Depends on:** PR8 (Release exists for README link).

**Files:**
- Create: `frontend/e2e/no-layout-shift-on-banner.spec.ts`
- Modify: `README.md`
- Modify: `docs/spec/02-architecture.md`
- Modify: `docs/spec/03-poc-features.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/specs/README.md`

### Task 9.1: Viewport screenshot regression test

- [ ] **Step 1: Add `data-testid` markers if absent**

Verify `frontend/src/components/PrDetail/ReloadBanner.tsx` (or equivalent) carries `data-testid="reload-banner"`. Add if missing.

Verify `frontend/src/components/PrDetail/PrHeader.tsx` carries `data-testid="pr-header"`. Add if missing.

- [ ] **Step 2: Write the spec**

`frontend/e2e/no-layout-shift-on-banner.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('PR detail viewport bytes-equal before and after banner trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/pr/octocat/Hello-World/1');
  await page.locator('[data-testid="pr-header"]').waitFor();

  // Disable CSS animations to remove pixel drift sources
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  });

  // Wait for any in-flight network
  await page.waitForLoadState('networkidle');

  // Baseline
  await expect(page).toHaveScreenshot('pr-detail-no-banner.png', {
    mask: [page.locator('[data-testid="reload-banner"]')],
    maxDiffPixelRatio: 0.001,
  });

  // Trigger banner via the S5 test hook
  const resp = await page.request.post('/test/advance-head', {
    data: { prRef: 'octocat/Hello-World/1', newHeadSha: 'feedfacedeadbeef' },
  });
  expect(resp.ok()).toBeTruthy();

  await page.locator('[data-testid="reload-banner"]').waitFor({ state: 'visible' });

  // Compare against the same baseline; banner masked
  await expect(page).toHaveScreenshot('pr-detail-no-banner.png', {
    mask: [page.locator('[data-testid="reload-banner"]')],
    maxDiffPixelRatio: 0.001,
  });
});
```

- [ ] **Step 3: Generate the baseline screenshot**

```bash
cd frontend && npx playwright test no-layout-shift-on-banner --update-snapshots
```

This creates `frontend/e2e/__screenshots__/no-layout-shift-on-banner.spec.ts/pr-detail-no-banner.png`. Commit the baseline alongside the spec.

- [ ] **Step 4: Re-run without `--update-snapshots` to verify pass**

```bash
cd frontend && npx playwright test no-layout-shift-on-banner
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/no-layout-shift-on-banner.spec.ts frontend/e2e/__screenshots__/
git commit -m "test(s6-pr9): viewport screenshot regression on banner arrival"
```

### Task 9.2: README graduation

- [ ] **Step 1: Replace the Status section**

In `README.md`, replace the current "Implementation in progress..." paragraph with:

```markdown
## Status

**Released.** Download PRism v0.1.0 — [Windows x64](RELEASE-LINK) / [macOS Apple Silicon](RELEASE-LINK). See [`docs/roadmap.md`](docs/roadmap.md) for slice history; [`docs/specs/README.md`](docs/specs/README.md) for the spec index.
```

Substitute `RELEASE-LINK` with the actual Release URL after PR8's first real-tag dispatch.

- [ ] **Step 2: Add "Download and first run" section**

Insert immediately after the project description:

````markdown
## Download and first run

Download the binary for your platform from the [Releases page](RELEASE-LINK):
- **Windows x64**: `PRism-win-x64.exe`
- **macOS Apple Silicon**: `PRism-osx-arm64`

### Windows

Double-click the `.exe`. Windows shows a SmartScreen warning because PRism isn't code-signed for the PoC. Click **More info → Run anyway**.

### macOS

Double-click the binary. If Gatekeeper blocks ("can't be opened because Apple cannot check it for malicious software"), right-click → **Open** instead. The first time PRism reads your token from the keychain, macOS asks **Allow / Always Allow / Deny** — click **Always Allow**.

### Generate a GitHub Personal Access Token

PRism authenticates with a PAT you generate at <https://github.com/settings/personal-access-tokens/new>. Required scopes (fine-grained PAT):

- Pull requests: **Read and write**
- Contents: **Read**
- Checks: **Read**
- Commit statuses: **Read**

Paste the PAT into the Setup screen on first launch.
````

- [ ] **Step 3: Add Troubleshooting section** (per spec § 9.4, with the round-2 correction):

````markdown
## Troubleshooting

### Recovering a lost draft

PRism's dedicated forensic event log (`state-events.jsonl`) is not yet implemented — the DI graph registers a no-op writer for the PoC. For now, identity-change events log to `<dataDir>/logs/` (structured logs) with prior + new login + counts:

```
grep 'Identity changed' "<dataDir>/logs/"*.log
```

`DraftSaved` events do NOT currently land in any forensic log. If you need to recover a draft body in the PoC, the safest path is to copy it out of the composer BEFORE any destructive action (Replace token, Discard, foreign-pending-review Discard).

### Replace token

The Settings page has a **Replace token** link in the Auth section. Clicking it walks you through pasting a new PAT and validates it before swapping. If your new token authenticates as a different GitHub login than the previous one, PRism:

- Preserves all draft text across every PR ("the reviewer's text is sacred").
- Clears the GraphQL Node IDs that were owned by the prior login.
- The next time you submit a review on an affected PR, PRism's foreign-pending-review modal handles any orphan pending reviews the prior login left on GitHub.

Drafts for PRs your new token cannot access remain in `state.json` invisibly. They re-surface if access is later restored.
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(s6-pr9): README graduation — Download + first run + Troubleshooting"
```

### Task 9.3: Spec doc updates

- [ ] **Step 1: Update `docs/spec/03-poc-features.md` § 11**

Replace the current "No Settings UI in PoC. All preferences live in `config.json`" framing with a description of the Settings page that just shipped. Reference the S6 spec.

- [ ] **Step 2: Update `docs/spec/02-architecture.md` § Distribution**

Add a note that the canonical publish path is `.github/workflows/publish.yml` (manual-dispatch); binary size measurement lives in README's Download section.

- [ ] **Step 3: Update `docs/roadmap.md` S6 row**

Change status cell from "PR0 shipped..." to "Shipped — PR0 (#53), PR1 (#X), PR2 (#X), PR3 (#X), PR4 (#X), PR5 (#X), PR6 (#X), PR7 (#X), PR8 (#X), PR9 (this PR)." Fill in actual PR numbers.

- [ ] **Step 4: Update `docs/specs/README.md`**

Move the S6 spec entry from "Not started" / "In progress" to "Implemented". Add references to all 9 PRs.

- [ ] **Step 5: Commit**

```bash
git add docs/spec/03-poc-features.md docs/spec/02-architecture.md docs/roadmap.md docs/specs/README.md
git commit -m "docs(s6-pr9): spec doc updates — § 11 Settings, § Distribution, roadmap Shipped, spec index"
```

### Task 9.4: PR9 push + PR + Release promotion

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat(s6-pr9): screenshot regression + README graduation + spec doc updates" --body "$(cat <<'EOF'
## Summary

S6 PR9 of 9. Final PR — closes the slice.

- New `e2e/no-layout-shift-on-banner.spec.ts` closes the DoD § Quality line "no layout shift when a PR with new commits arrives."
- README graduates: Download + first run section, Troubleshooting section.
- Spec docs updated: `03-poc-features.md` § 11 reflects Settings UI shipped; `02-architecture.md` § Distribution notes publish.yml; `roadmap.md` S6 row flipped to Shipped with PR refs; `docs/specs/README.md` moves S6 to Implemented.

After this merges + the first real-tag publish workflow dispatches, the PoC binary is downloadable. The author can begin dogfood; N=3 external validation gate starts when ready.

## Test plan

- [x] no-layout-shift-on-banner.spec.ts passes with bytes-equal masked-banner-region screenshots
- [x] README links resolve; Troubleshooting recipes match the round-2 ILogger sink reality
- [x] Spec doc cross-references intact (no stale PR0-spec-ready text)
EOF
)"
```

- [ ] **Step 3: After this PR merges, dispatch the publish workflow with the real release tag**

In GitHub Actions UI: Workflows → Publish → Run workflow → tag = `v0.1.0` (or whatever the maintainer picks). Workflow runs; binaries land on a draft Release. Maintainer verifies on both OSes, then promotes the draft to published. Updates README Status link to the real Release URL via a small follow-up commit.

---

## Self-review

**Spec coverage check:**

| Spec § | Plan tasks |
|---|---|
| § 1 Goal + scope | (informational — no tasks) |
| § 2.1 Surface (Settings route + Header nav) | Task 3.3 (Settings route + Header nav with three-tab active-state) |
| § 2.2 Field set | Tasks 3.3, 3.4, 3.5 (Settings page, InboxSectionsSection, GithubSection) |
| § 2.3 PatchAsync allowlist | Tasks 1.5, 1.6 |
| § 2.4 Wire shape | Tasks 1.7, 1.8 |
| § 2.5 Validation | Covered by Task 1.6 tests (unknown key 400) |
| § 2.6 Save semantics | Implicit in `usePreferences` optimistic-update behavior; tested in Tasks 3.3, 3.4 |
| § 2.7 Frontend components | Tasks 3.3, 3.4, 3.5 |
| § 3.1 Lazy-swap UI flow | Tasks 4.2, 4.3, 4.4 |
| § 3.1.1 Toast component | Task 3.2 (`'success'` kind) |
| § 3.2 Identity-change rule | Tasks 2.7, 2.8 (endpoint + rule) |
| § 3.2.1 SSE wiring | Tasks 2.1, 2.5 (event type + handler) |
| § 3.3 Cache invalidation | Tasks 2.2, 2.3, 2.4 (`Clear`, `RemoveAll`, `RequestImmediateRefresh`) |
| § 3.4 Multi-tab + 404-on-current-PR | Task 4.5 (`useAuth` subscribes to `identity-changed`) |
| § 3.5 Backend endpoints | Tasks 1.3, 1.4 (`/api/submit/in-flight`); 2.7, 2.8 (`/api/auth/replace`) |
| § 3.6 ILogger identity-change | Tasks 2.6, 2.8 |
| § 3.7 Edge cases | Implicit in test coverage (Task 2.8) |
| § 3.8 Tests | Distributed across PR2 tasks |
| § 4 Cheatsheet | Tasks 5.1, 5.2, 5.3, 5.4 |
| § 5 LoadingScreen + icon assets | Tasks 6.1, 6.2 |
| § 6 A11y audit | PR7 (Tasks 7.1, 7.2, 7.3) |
| § 7 Publish workflow | PR8 (Tasks 8.1, 8.2, 8.3, 8.4) |
| § 7.5 First-run trust copy | Task 8.3 |
| § 8 Screenshot regression | Task 9.1 |
| § 9 README updates | Task 9.2 |
| § 10 v2 register | (spec-doc only; no implementation) |
| § 11 Tests consolidated | Distributed across all PRs |
| § 12 Project standards updates | Task 9.3 |
| § 13 PR cut | Plan IS the PR cut |
| § 14 Open questions | Decisions deferred to writing-plans defaults (per spec); implementer applies defaults inline |

All in-scope spec sections have at least one task.

**Placeholder scan:** No "TBD", "TODO", "implement later" markers. The `<commit-sha>` placeholders in PR8 Task 8.2 are explicit instructions for the implementer to look up — not deferrals.

**Type consistency:** `IdentityChanged(string AccountKey, string PriorLogin, string NewLogin)` consistent across Tasks 2.1, 2.5, 2.8. `ToastSpec.kind: 'info' | 'error' | 'success'` consistent across Tasks 3.2, 3.5, 4.4. `SubmitLockRegistry.AnyHeld() → (bool, string?)` consistent across Tasks 1.1, 1.2, 1.4, 2.8.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-15-s6-polish-and-distribution.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Use the `superpowers:subagent-driven-development` skill.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

The plan is 9 PRs × ~5 tasks/PR ≈ 45 discrete units of work. Subagent-driven keeps blast radius small per task and lets the architectural PRs (PR1, PR2) get deeper review than the docs PRs (PR8, PR9).
