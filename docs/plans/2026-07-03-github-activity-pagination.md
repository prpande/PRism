# GitHub activity-reader pagination + cap signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paginate the three GitHub activity readers by following `Link rel="next"` in the shared `GitHubArrayReader` choke point, bounded by a max-page budget and a visited-URL guard, with a source-generated cap-hit log — fixing the P1 silent-truncation of `user/subscriptions` (#604 Part E) with no wire/struct/`ActivityProvider` change.

**Architecture:** All three readers already delegate to `GitHubArrayReader.ReadAsync<T>`. We add the pagination loop there (single choke point), returning `degraded:true` only when zero items are collected so a coherent prefix never blanks the activity rail. The readers gain an optional `ILogger<T>?` (via `GetService`, null-safe) forwarded to the helper for the cap-hit warning.

**Tech Stack:** C# / .NET 10, xUnit + FluentAssertions, `Microsoft.Extensions.Logging` `[LoggerMessage]` source generator.

**Spec:** `docs/specs/2026-07-03-github-activity-pagination-design.md`

## Global Constraints

- Backend-only. No change to result records (`ReceivedEventsResult`/`NotificationsResult`/`WatchedReposResult`), `ActivityProvider`, `ActivityContracts`, `ActivityEndpoints`, `FakeActivityProvider`, or the `/api/activity` wire.
- `degraded:true` ⇔ the read produced **zero** usable items. A non-empty prefix (complete, budget-capped, or later-page-fault) is always `degraded:false`.
- The absolute `rel="next"` URL is passed to `SendAsync` **as-is** — never stripped/re-derived to relative (would double-prefix the GHES `/api/v3` base and bypass the absolute-URI branch of the egress guard).
- Degrade-don't-throw contract is preserved: the only exceptions that escape `ReadAsync` are `OperationCanceledException` on genuine cancellation.
- `DefaultMaxPages = 10`. Build/test with real `dotnet.exe`; one build/test at a time, foreground, timeout ≥ 300000ms.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01HUnfWat3YPn4JzJCYHVzbv`

## Test-double note (deviation from spec)

The spec named `PaginatedFakeHandler` for multi-page tests, but that helper cannot script (a) mixed-status pages (page 1 = 200, page 2 = 500), (b) a repeated `next` URL, or (c) an off-host `next`. Rather than widen the shared helper, Task 1 adds one small purpose-built `ScriptedPagesHandler` in the test project that replays a FIFO list of `(status, body, nextUrl?)` and emits `Link: <nextUrl>; rel="next"` when `nextUrl` is non-null. It gives full control for every new helper-level test. `PaginatedFakeHandler` is still used for the reader-level Part-E happy-path test (Task 5).

## File Structure

- **Modify** `PRism.GitHub/GitHubArrayReader.cs` — `internal static class` → `internal static partial class`; add the pagination loop, `DefaultMaxPages`, visited-URL guard, and a nested `private static partial class Log` with the cap-hit method (Tasks 1–4).
- **Create** `tests/PRism.GitHub.Tests/TestHelpers/ScriptedPagesHandler.cs` — Link-emitting FIFO handler (Task 1).
- **Modify** `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs` — new pagination tests; existing tests unchanged (Tasks 1–4).
- **Modify** the 3 readers `PRism.GitHub/Activity/{GitHubReceivedEventsReader,GitHubNotificationsReader,GitHubWatchedReposReader}.cs` — trailing `ILogger<T>? logger` ctor param, forwarded with a resource label (Task 5).
- **Modify** `PRism.GitHub/ServiceCollectionExtensions.cs:178-209` — DI lambdas pass `sp.GetService<ILogger<…>>()` (Task 5).
- **Modify** reader tests `tests/PRism.GitHub.Tests/Activity/{GitHubReceivedEventsReaderTests,GitHubNotificationsReaderTests,GitHubWatchedReposReaderTests,GitHubActivityReadersAuthHeaderTests}.cs` — pass a logger to the ctor; add the Part-E full-pagination test + every-page Bearer assertion (Task 5).

---

### Task 1: Pagination loop — follow `next`, concatenate, degraded-only-when-empty

**Files:**
- Modify: `PRism.GitHub/GitHubArrayReader.cs`
- Create: `tests/PRism.GitHub.Tests/TestHelpers/ScriptedPagesHandler.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs`

**Interfaces:**
- Consumes: existing `GitHubArrayReader.ReadAsync<T>(IHttpClientFactory, Func<Task<string?>>, string url, Func<JsonElement,T?>, CancellationToken)`.
- Produces: same signature, now paginating. `ScriptedPagesHandler` test double (used by Tasks 2–4).

- [ ] **Step 1: Create the `ScriptedPagesHandler` test double**

Create `tests/PRism.GitHub.Tests/TestHelpers/ScriptedPagesHandler.cs`:

```csharp
using System.Net;

namespace PRism.GitHub.Tests.TestHelpers;

// Replays a FIFO list of (status, body, nextUrl?) responses. Emits a
// Link: <nextUrl>; rel="next" header when nextUrl is non-null, so a caller's
// pagination loop follows it. Records how many requests were made and the
// absolute URIs requested, for assertions. Throws on over-call so an
// unterminated loop is loud at test time.
internal sealed class ScriptedPagesHandler : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, string Body, string? NextUrl)> _pages;
    public List<string> RequestedUris { get; } = new();
    public int CallCount => RequestedUris.Count;

    public ScriptedPagesHandler(params (HttpStatusCode Status, string Body, string? NextUrl)[] pages)
        => _pages = new Queue<(HttpStatusCode, string, string?)>(pages);

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(req);
        RequestedUris.Add(req.RequestUri!.ToString());
        if (_pages.Count == 0)
            throw new InvalidOperationException(
                $"ScriptedPagesHandler ran out of scripted pages on request #{CallCount}.");

        var (status, body, next) = _pages.Dequeue();
        var resp = new HttpResponseMessage(status)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        if (next is not null)
            resp.Headers.TryAddWithoutValidation("Link", $"<{next}>; rel=\"next\"");
        return Task.FromResult(resp);
    }
}
```

- [ ] **Step 2: Write the failing test — follow `next` across pages and concatenate**

Add to `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs` (the class already has `Token` and `ParseV` helpers; add a factory that takes a handler):

```csharp
    private static FakeHttpClientFactory FactoryFor(HttpMessageHandler handler)
        => new(handler, new Uri("https://api.github.com/"));

    [Fact]
    public async Task Follows_link_next_across_pages_and_concatenates()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=3"),
            (HttpStatusCode.OK, """[{"v":"c"}]""", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b", "c");
        handler.CallCount.Should().Be(3);
    }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Follows_link_next_across_pages" --nologo`
Expected: FAIL — only 1 item ("a"), `CallCount == 1` (current code makes a single request).

- [ ] **Step 4: Implement the pagination loop**

Rewrite the body of `ReadAsync` in `PRism.GitHub/GitHubArrayReader.cs`. Change the class declaration to `internal static partial class GitHubArrayReader` and add `using PRism.GitHub;` is not needed (same namespace). Add `using Microsoft.Extensions.Logging;` for later tasks now. Replace the method body:

```csharp
    public static async Task<(IReadOnlyList<T> Items, bool Degraded)> ReadAsync<T>(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string url,
        Func<JsonElement, T?> parse,
        CancellationToken ct) where T : class
    {
        var list = new List<T>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var token = await readToken().ConfigureAwait(false);
            using var http = httpFactory.CreateClient("github");
            var currentUrl = url;
            while (true)
            {
                using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, currentUrl, token, ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode) return (list, list.Count == 0);

                using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return (list, list.Count == 0);

                foreach (var el in doc.RootElement.EnumerateArray())
                    if (parse(el) is { } item) list.Add(item);

                if (!GitHubLinkHeader.TryGetRel(resp, "next", out var next)) break;
                if (!visited.Add(next)) break; // repeated next URL: treat as exhausted
                currentUrl = next; // absolute URL, passed as-is (never stripped to relative)
            }
            return (list, false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return (list, list.Count == 0); }
    }
```

Add `using System.Collections.Generic;` at the top if missing. (The `Microsoft.Extensions.Logging` using is added in Task 3 when the `Log` class is introduced — don't add it here.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Follows_link_next_across_pages" --nologo`
Expected: PASS.

- [ ] **Step 6: Run the full GitHubArrayReader test class to confirm existing contract holds**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubArrayReaderTests" --nologo`
Expected: PASS — the existing single-request tests still pass (`Non_success_degrades` returns `([], true)` because `list.Count == 0` on a page-1 failure; `Parses_array_via_delegate` / `Empty_array_is_not_degraded` have no `next` header so the loop breaks after one page).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubArrayReader.cs tests/PRism.GitHub.Tests/TestHelpers/ScriptedPagesHandler.cs tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs
git commit -m "feat(#628): paginate GitHubArrayReader via Link rel=next"
```

---

### Task 2: Later-page-failure returns a coherent prefix (degraded only when empty)

**Files:**
- Test: `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs`
- (No production change — Task 1's `list.Count == 0` rule already implements this; this task pins it with tests.)

**Interfaces:**
- Consumes: `ReadAsync` + `ScriptedPagesHandler` from Task 1.

- [ ] **Step 1: Write the failing test — later-page failure ⇒ partial prefix + degraded:false**

Add to `GitHubArrayReaderTests.cs`:

```csharp
    [Fact]
    public async Task Later_page_failure_returns_partial_prefix_not_degraded()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"},{"v":"b"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.InternalServerError, "", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();          // coherent prefix must not blank the rail
        items.Should().Equal("a", "b");       // page-1 items retained
        handler.CallCount.Should().Be(2);     // it tried page 2, got 500, stopped
    }

    [Fact]
    public async Task Later_page_transport_fault_returns_partial_prefix_not_degraded()
    {
        // Page 1 OK with a next; page 2 throws (no scripted page → over-call throw is a
        // transport-style fault the catch filter would NOT cover, so instead script an
        // explicit page-2 fault via a malformed body caught as JsonException on the SECOND page).
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, "NOT JSON {{{", null));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        degraded.Should().BeFalse();
        items.Should().Equal("a");
        handler.CallCount.Should().Be(2);
    }
```

- [ ] **Step 2: Run the tests to verify they pass (behavior already implemented in Task 1)**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Later_page" --nologo`
Expected: PASS. (If either fails, the Task 1 loop's `list.Count == 0` rule or the catch's `return (list, list.Count == 0)` is wrong — fix in `GitHubArrayReader.cs`, do not weaken the test.)

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs
git commit -m "test(#628): pin later-page-failure returns coherent prefix, not degraded"
```

---

### Task 3: Max-page budget + cap-hit log + visited-URL cycle guard

**Files:**
- Modify: `PRism.GitHub/GitHubArrayReader.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs`

**Interfaces:**
- Produces: `ReadAsync<T>(..., CancellationToken ct, ILogger? logger = null, string? resource = null, int maxPages = DefaultMaxPages)`; `const int DefaultMaxPages = 10`; nested `Log.ActivityPaginationCapHit(ILogger, string resource, int maxPages)`.

- [ ] **Step 1: Write the failing test — stop at budget, log a warning, not degraded**

Add to `GitHubArrayReaderTests.cs` (`CapturingLogger<T>` is generic — instantiate a concrete one and pass it as `ILogger`):

```csharp
    [Fact]
    public async Task Stops_at_max_page_budget_and_logs_cap_hit()
    {
        // 4 pages, each advertising a next; maxPages: 2 → only 2 requests, then break+log.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=3"),
            (HttpStatusCode.OK, """[{"v":"c"}]""", "https://api.github.com/x?page=4"),
            (HttpStatusCode.OK, """[{"v":"d"}]""", null));
        var logger = new CapturingLogger<GitHubArrayReaderTests>();

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None,
            logger, resource: "user/subscriptions", maxPages: 2);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
        handler.CallCount.Should().Be(2);
        logger.Entries.Should().ContainSingle(e =>
            e.Level == LogLevel.Warning && e.Message.Contains("user/subscriptions"));
    }
```

- [ ] **Step 2: Write the failing test — repeated `next` URL breaks the loop without exhausting the budget**

```csharp
    [Fact]
    public async Task Repeated_next_url_breaks_without_exhausting_budget()
    {
        // Both pages advertise the SAME next URL. The visited guard must stop after the
        // second fetch (the repeat), NOT loop up to maxPages, and NOT log a cap-hit.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://api.github.com/x?page=2"),
            (HttpStatusCode.OK, """[{"v":"b"}]""", "https://api.github.com/x?page=2"));
        var logger = new CapturingLogger<GitHubArrayReaderTests>();

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None,
            logger, resource: "user/subscriptions", maxPages: 10);

        degraded.Should().BeFalse();
        items.Should().Equal("a", "b");
        handler.CallCount.Should().Be(2);            // stopped on the repeat, not at page 10
        logger.Entries.Should().BeEmpty();           // a cycle is not a budget cap
    }
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Stops_at_max_page_budget|FullyQualifiedName~Repeated_next_url" --nologo`
Expected: FAIL — `ReadAsync` has no `logger`/`resource`/`maxPages` params yet (compile error), and no budget check.

- [ ] **Step 4: Add the budget, the log delegate, and the params**

In `PRism.GitHub/GitHubArrayReader.cs`: ensure `using Microsoft.Extensions.Logging;`. Add the constant and the nested `Log` class inside the class, and extend the signature + loop. Full method + Log:

```csharp
    internal const int DefaultMaxPages = 10;

    public static async Task<(IReadOnlyList<T> Items, bool Degraded)> ReadAsync<T>(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string url,
        Func<JsonElement, T?> parse,
        CancellationToken ct,
        ILogger? logger = null,
        string? resource = null,
        int maxPages = DefaultMaxPages) where T : class
    {
        var list = new List<T>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            var token = await readToken().ConfigureAwait(false);
            using var http = httpFactory.CreateClient("github");
            var currentUrl = url;
            var page = 0;
            while (true)
            {
                page++;
                using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, currentUrl, token, ct).ConfigureAwait(false);
                if (!resp.IsSuccessStatusCode) return (list, list.Count == 0);

                using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
                if (doc.RootElement.ValueKind != JsonValueKind.Array) return (list, list.Count == 0);

                foreach (var el in doc.RootElement.EnumerateArray())
                    if (parse(el) is { } item) list.Add(item);

                // The next URL is GitHub's ABSOLUTE Link header value, passed to SendAsync as-is.
                // NEVER strip/re-derive it to a relative path: a relative URL always resolves
                // against the trusted BaseAddress, so the ApplyHeaders absolute-URI egress guard
                // would never run — a re-derivation bug could silently reopen an off-host PAT leak.
                if (!GitHubLinkHeader.TryGetRel(resp, "next", out var next)) break;
                if (page >= maxPages)
                {
                    if (logger is not null) Log.ActivityPaginationCapHit(logger, resource ?? "", maxPages);
                    break;
                }
                if (!visited.Add(next)) break; // repeated next URL: treat as exhausted (not a cap)
                currentUrl = next;
            }
            return (list, false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return (list, list.Count == 0); }
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 628, EventName = "ActivityPaginationCapHit",
            Message = "GitHub list read for {Resource} hit the {MaxPages}-page pagination budget; results may be truncated (some items were not loaded).")]
        internal static partial void ActivityPaginationCapHit(ILogger logger, string resource, int maxPages);
    }
```

Confirm the class header is `internal static partial class GitHubArrayReader` (the `Log` nested class and `[LoggerMessage]` require `partial`).

- [ ] **Step 5: Run both tests to verify they pass**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Stops_at_max_page_budget|FullyQualifiedName~Repeated_next_url" --nologo`
Expected: PASS.

- [ ] **Step 6: Run the whole GitHubArrayReader test class**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubArrayReaderTests" --nologo`
Expected: PASS (all old + new).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubArrayReader.cs tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs
git commit -m "feat(#628): add max-page budget, cap-hit log, and visited-URL cycle guard"
```

---

### Task 4: Off-host `next` is thrown, not credentialed (egress-guard lock)

**Files:**
- Test: `tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs`
- (No production change — the maintainer comment was added in Task 3; this task locks the security behavior with a test.)

**Interfaces:**
- Consumes: `ReadAsync` + `ScriptedPagesHandler`.

- [ ] **Step 1: Write the failing test — a well-formed off-host `next` throws in ApplyHeaders and is caught**

Add to `GitHubArrayReaderTests.cs`:

```csharp
    [Fact]
    public async Task Off_host_next_url_is_not_credentialed_and_degrades_to_prefix()
    {
        // Page 1 OK (same-host) advertises a WELL-FORMED but OFF-HOST next. Following it must
        // trip GitHubHttp.ApplyHeaders' scheme+host+port guard (throw HttpRequestException)
        // BEFORE the request is sent, so the off-host host never receives a credentialed call.
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"v":"a"}]""", "https://attacker.example/x?page=2"));

        var (items, degraded) = await GitHubArrayReader.ReadAsync(
            FactoryFor(handler), Token, "x", ParseV, CancellationToken.None);

        items.Should().Equal("a");            // page-1 prefix retained
        degraded.Should().BeFalse();          // non-empty prefix ⇒ not degraded
        handler.CallCount.Should().Be(1);     // the off-host page-2 request never reached the handler
    }
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Off_host_next" --nologo`
Expected: PASS. The `FakeHttpClientFactory` sets `BaseAddress = https://api.github.com/`; `ApplyHeaders` throws `HttpRequestException` for the `attacker.example` host, the catch filter returns `(list, list.Count == 0)` → `(["a"], false)`. If it FAILS with `CallCount == 2`, the loop is stripping the URL to relative or bypassing the guard — fix the loop, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.GitHub.Tests/GitHubArrayReaderTests.cs
git commit -m "test(#628): lock off-host next URL is not credentialed"
```

---

### Task 5: Wire `ILogger` into the 3 readers, DI, and prove the Part-E fix

**Files:**
- Modify: `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs`, `GitHubNotificationsReader.cs`, `GitHubWatchedReposReader.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs:178-209`
- Modify: `tests/PRism.GitHub.Tests/Activity/GitHubWatchedReposReaderTests.cs`, `GitHubNotificationsReaderTests.cs`, `GitHubReceivedEventsReaderTests.cs`, `GitHubActivityReadersAuthHeaderTests.cs`

**Interfaces:**
- Consumes: `ReadAsync<T>(..., ILogger? logger, string? resource, int maxPages)` from Task 3.
- Produces: reader ctors with a trailing `ILogger<T>? logger` param; result records unchanged.

- [ ] **Step 1: Write the failing reader-level test — WatchedReposReader reads all pages (Part E fix)**

In `tests/PRism.GitHub.Tests/Activity/GitHubWatchedReposReaderTests.cs`, add (using `ScriptedPagesHandler` and `NullLogger`):

```csharp
    [Fact]
    public async Task Reads_all_watched_repos_across_pages()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"full_name":"o/r1"}]""", "https://api.github.com/user/subscriptions?page=2"),
            (HttpStatusCode.OK, """[{"full_name":"o/r2"}]""", null));
        var reader = new GitHubWatchedReposReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<GitHubWatchedReposReader>.Instance);

        var result = await reader.ReadAsync(CancellationToken.None);

        result.Degraded.Should().BeFalse();
        result.Repos.Should().Equal("o/r1", "o/r2");   // page-2 repo no longer silently truncated
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Reads_all_watched_repos_across_pages" --nologo`
Expected: FAIL to compile — `GitHubWatchedReposReader` has no 3-arg ctor yet.

- [ ] **Step 3: Add the logger param to `GitHubWatchedReposReader`**

In `PRism.GitHub/Activity/GitHubWatchedReposReader.cs`: add `using Microsoft.Extensions.Logging;`, a trailing ctor param, a field, and forward `(logger, resource)`:

```csharp
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly ILogger<GitHubWatchedReposReader>? _logger;

    public GitHubWatchedReposReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken,
        ILogger<GitHubWatchedReposReader>? logger = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _logger = logger;
    }

    public async Task<WatchedReposResult> ReadAsync(CancellationToken ct)
    {
        var url = $"user/subscriptions?per_page={PerPage}";
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct, _logger, "user/subscriptions").ConfigureAwait(false);
        return new WatchedReposResult(items, degraded);
    }
```

(`= null` default keeps any other direct constructions compiling; the DI lambda passes a real logger.)

- [ ] **Step 4: Run the Part-E test to verify it passes**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Reads_all_watched_repos_across_pages" --nologo`
Expected: PASS.

- [ ] **Step 5: Add the logger param to the other two readers**

`PRism.GitHub/Activity/GitHubNotificationsReader.cs` — add `using Microsoft.Extensions.Logging;`, field `ILogger<GitHubNotificationsReader>? _logger`, trailing ctor param `ILogger<GitHubNotificationsReader>? logger = null`, and forward:

```csharp
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct, _logger, "notifications").ConfigureAwait(false);
```

`PRism.GitHub/Activity/GitHubReceivedEventsReader.cs` — the ctor is 3-arg today (`httpFactory, readToken, readLogin`); add the logger **after** `readLogin`:

```csharp
    private readonly ILogger<GitHubReceivedEventsReader>? _logger;

    public GitHubReceivedEventsReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<Task<string?>> readLogin,
        ILogger<GitHubReceivedEventsReader>? logger = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readLogin = readLogin;
        _logger = logger;
    }
```

and forward in `ReadAsync`:

```csharp
        var (items, degraded) = await GitHubArrayReader
            .ReadAsync(_httpFactory, _readToken, url, Parse, ct, _logger, "received_events").ConfigureAwait(false);
```

Add `using Microsoft.Extensions.Logging;` to that file.

- [ ] **Step 6: Wire the DI lambdas to pass the logger (null-safe)**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, add `sp.GetService<ILogger<…>>()` as the trailing argument to each of the three `new …Reader(…)` calls (lines ~183, ~197, ~206). `GetService` (not `GetRequiredService`) returns null in a bare container without `AddLogging()`, which the reader tolerates:

```csharp
            return new PRism.GitHub.Activity.GitHubReceivedEventsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                () => Task.FromResult(viewerLogin.Get() is { Length: > 0 } l ? l : null),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubReceivedEventsReader>>());
```
```csharp
            return new PRism.GitHub.Activity.GitHubNotificationsReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubNotificationsReader>>());
```
```csharp
            return new PRism.GitHub.Activity.GitHubWatchedReposReader(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetService<ILogger<PRism.GitHub.Activity.GitHubWatchedReposReader>>());
```

Ensure `using Microsoft.Extensions.Logging;` is present in that file (it likely already is for the other reader registrations; add if not).

- [ ] **Step 7: Fix the every-page Bearer assertion in the auth-header test**

First, extend `ScriptedPagesHandler` (from Task 1) to record the auth header on every request — add one field and one line in `SendAsync`:

```csharp
    public List<string?> AuthHeaders { get; } = new();
    // ...in SendAsync, right after RequestedUris.Add(...):
    AuthHeaders.Add(req.Headers.Authorization?.ToString());
```

In `tests/PRism.GitHub.Tests/Activity/GitHubActivityReadersAuthHeaderTests.cs`, the existing reader constructions (~lines 56-60) now need a trailing logger arg — pass `NullLogger<T>.Instance` (import `Microsoft.Extensions.Logging.Abstractions`). Then add a `[Fact]` that drives 2 pages and asserts the Bearer header rode **every** page request:

```csharp
    [Fact]
    public async Task Bearer_is_attached_on_every_paginated_request()
    {
        var handler = new ScriptedPagesHandler(
            (HttpStatusCode.OK, """[{"full_name":"o/r1"}]""", "https://api.github.com/user/subscriptions?page=2"),
            (HttpStatusCode.OK, """[{"full_name":"o/r2"}]""", null));
        var reader = new GitHubWatchedReposReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            NullLogger<GitHubWatchedReposReader>.Instance);

        await reader.ReadAsync(CancellationToken.None);

        handler.AuthHeaders.Should().HaveCount(2);
        handler.AuthHeaders.Should().OnlyContain(h => h == "Bearer token");
    }
```

- [ ] **Step 8: Fix remaining compile-breaks in reader tests**

Run a build to find every direct reader construction that now needs a logger arg:

Run: `& "C:/Program Files/dotnet/dotnet.exe" build tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Expected initially: compile errors at `GitHubNotificationsReaderTests.cs:15-18` and `:120-121`, `GitHubReceivedEventsReaderTests.cs`, and any other direct `new …Reader(...)`. For each, add a trailing `NullLogger<T>.Instance` (import `Microsoft.Extensions.Logging.Abstractions`). Because the ctor params default to `null`, only call sites that use positional-only construction with an analyzer requiring all args, or that need a real logger, must change — most compile as-is, but add the arg where the compiler flags it.

- [ ] **Step 9: Build clean, then run the full GitHub test project**

Run: `& "C:/Program Files/dotnet/dotnet.exe" build PRism.GitHub/PRism.GitHub.csproj --nologo`
Expected: Build succeeded, 0 warnings.

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Expected: PASS — all existing + new tests green.

- [ ] **Step 10: Commit**

```bash
git add PRism.GitHub/Activity/GitHubReceivedEventsReader.cs PRism.GitHub/Activity/GitHubNotificationsReader.cs PRism.GitHub/Activity/GitHubWatchedReposReader.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/
git commit -m "feat(#628): wire optional ILogger into the 3 activity readers; prove #604 Part E fix"
```

---

### Task 6: Full-solution verification

**Files:** none (verification only).

- [ ] **Step 1: Build the whole solution**

Run: `& "C:/Program Files/dotnet/dotnet.exe" build PRism.sln --nologo` (or the repo's standard build target)
Expected: Build succeeded, 0 warnings.

- [ ] **Step 2: Run the GitHub + Web test projects (the impacted suites)**

Run: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --nologo`
Then: `& "C:/Program Files/dotnet/dotnet.exe" test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --nologo`
Expected: PASS on both. (`ActivityProvider`/endpoint tests must be unaffected — the wire shape did not change.)

- [ ] **Step 3: Confirm no wire/struct drift**

Run: `git diff main --stat`
Expected: changes limited to `PRism.GitHub/GitHubArrayReader.cs`, the 3 readers, `ServiceCollectionExtensions.cs`, the test project, and the two docs. No edits to `PRism.Core/Activity/ActivityContracts.cs`, `ActivityProvider.cs`, `ActivityEndpoints.cs`, or `FakeActivityProvider.cs`.

- [ ] **Step 4: Commit (if any verification touch-ups were needed; otherwise skip)**

---

## Follow-ups to file (from the spec's accepted residuals)

- **User-facing cap surfacing:** when the >budget cap is hit, surface a per-source "list may be incomplete" signal to the user (needs the `ActivityRail` degraded-gate rework: events/notifications are all-or-nothing today). Deferred because it is a frontend change outside this backend slice. File after this PR merges.
- #628 Slice 2 (ETag/`304`) and Slice 3 (secondary rate-limit) remain open on #628.
