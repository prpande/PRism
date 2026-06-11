# Awaiting-author Review-Selection Semantics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GitHubAwaitingAuthorFilter`'s "last reviewed head" selection pick the viewer review with the **maximum `submitted_at`** among reviews that carry a real timestamp and a non-empty `commit_id`, instead of trusting array position — resolving the null-`commit_id` semantics (decision A: fall back) and making ordering contractual.

**Architecture:** Single private-method change inside `GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync`. Eligibility gates a review on a non-empty `commit_id` **and** a `JsonValueKind.String` `submitted_at` (so JSON-null PENDING drafts are a clean `continue`, not a thrown-and-caught malformed item). Selection tracks a running `(DateTimeOffset? bestSubmittedAt, string? best)` and replaces on strictly-greater timestamp via an explicit null-guard (`bestSubmittedAt is null || submittedAt > bestSubmittedAt.Value`). No interface, caller, pagination, cache, or error-path change.

**Tech Stack:** C# / .NET 10, `System.Text.Json` (`JsonElement`), xUnit + FluentAssertions + Moq, existing test helpers (`FakeHttpMessageHandler`, `FakeHttpClientFactory`, `PaginatedFakeHandler`).

**Spec:** `docs/specs/2026-06-11-awaiting-author-review-selection-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs` | The filter; `FetchLastReviewShaAsync` selection logic + its doc comment | Modify (Tasks 2, 4) |
| `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs` | All unit tests + fixtures + `BuildSut` | Modify (Tasks 1–5) |

No new files. No production dependencies added.

---

## Reference: current `FetchLastReviewShaAsync` inner loop (before)

`GitHubAwaitingAuthorFilter.cs` — line 74 declares `string? best = null;`; the per-review loop (lines 98–111) is:

```csharp
foreach (var review in doc.RootElement.EnumerateArray())
{
    try
    {
        var login = review.GetProperty("user").GetProperty("login").GetString();
        if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
        var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
        if (sha != null) best = sha; // ascending order → last seen overall = most recent
    }
    catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
    {
        Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
    }
}
```

`InboxJsonGuard.IsMalformedItem` recognizes `KeyNotFoundException`, `InvalidOperationException`, `FormatException`, `OverflowException`, `JsonException`. `Log.ReviewItemSkipped` is a source-gen `LoggerMessage` at `LogLevel.Debug` (`GitHubAwaitingAuthorFilter.cs:132-134`). The SUT ctor already accepts an optional `ILogger<GitHubAwaitingAuthorFilter>? log = null` (lines 21–29).

---

## Task 1: Fixture-realism pre-position (no implementation change)

Add `submitted_at` to every fixture so reviews are eligible under the new rule, **while the old implementation still passes** (the old rule ignores `submitted_at`). This isolates the fixture churn from the behavior change.

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`

- [ ] **Step 1: Add a default `submittedAt` to the `ReviewsResponse` helper**

Replace the helper (currently lines 30–34):

```csharp
private static string ReviewsResponse(
    string viewerLogin, string lastReviewSha, string submittedAt = "2020-01-01T00:00:00Z") => $$"""
    [
        { "user": { "login": "{{viewerLogin}}" }, "commit_id": "{{lastReviewSha}}", "submitted_at": "{{submittedAt}}" }
    ]
    """;
```

All existing callers pass two arguments and inherit the default timestamp, so the single review becomes eligible.

- [ ] **Step 2: Add `submitted_at` to the inline paginated fixtures**

In `Most_recent_review_on_page_2_is_used_not_page_1`, make page 2 newer than page 1:

```csharp
var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""";
var page2 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" } ]""";
```

In `Single_page_with_no_next_link_returns_page_1_best`:

```csharp
var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""";
```

In `Malformed_review_item_is_skipped_scan_continues` (the first item stays login-less; the second gains a timestamp):

```csharp
var page1 = $$"""
    [ { "user": {} },
      { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]
    """;
```

In `Page_cap_is_honored_and_does_not_loop_forever`:

```csharp
var pages = Enumerable.Range(1, 11)
    .Select(_ => $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""")
    .ToArray();
```

- [ ] **Step 3: Run the full filter test class — expect all green under the OLD implementation**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~GitHubAwaitingAuthorFilterTests"`
Expected: PASS (the old array-last rule ignores `submitted_at`; adding it changes nothing yet).

- [ ] **Step 4: Commit**

```bash
git add tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "test(#367): enrich awaiting-author fixtures with submitted_at (no behavior change)"
```

---

## Task 2: submitted_at-max selection (drives the ordering fix)

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`
- Modify: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs` (line 74 + loop lines 98–111 + doc comment lines 64–70)

- [ ] **Step 1: Write the failing test (out-of-order array)**

Add to `GitHubAwaitingAuthorFilterTests`:

```csharp
[Fact]
public async Task Most_recent_by_submitted_at_wins_over_array_position()
{
    // array-FIRST review is the NEWER one (at the current head); array-LAST is OLDER.
    // The old array-last rule would pick "old" != head ⇒ wrongly include. The new rule
    // picks the max-submitted_at review ("head") == head ⇒ correctly exclude.
    var body = $$"""
        [
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" },
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" }
        ]
        """;
    var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
    var sut = BuildSut(handler);

    var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

    result.Should().BeEmpty("the newest review by submitted_at is at the current head");
}
```

- [ ] **Step 2: Run it — expect FAIL under the old rule**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~Most_recent_by_submitted_at_wins_over_array_position"`
Expected: FAIL — old rule sets `best = "old"` (array-last) ≠ "head" ⇒ result has one item, assertion wants empty.

- [ ] **Step 3: Implement submitted_at-max selection**

In `GitHubAwaitingAuthorFilter.cs`, change the `best` declaration (line 74) to track the timestamp too:

```csharp
        string? best = null;
        DateTimeOffset? bestSubmittedAt = null;
```

Replace the per-review loop body (lines 98–111) with:

```csharp
        foreach (var review in doc.RootElement.EnumerateArray())
        {
            try
            {
                var login = review.GetProperty("user").GetProperty("login").GetString();
                if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;

                var commitId = review.TryGetProperty("commit_id", out var c) ? c.GetString() : null;
                if (string.IsNullOrEmpty(commitId)) continue; // null/empty commit_id → no comparable head

                if (!review.TryGetProperty("submitted_at", out var sa)) continue; // unsubmitted/absent → skip
                var submittedAt = sa.GetDateTimeOffset();

                // Strictly-greater; the explicit null-guard takes the first eligible review
                // (a bare lifted `>` against a null DateTimeOffset? returns false).
                if (bestSubmittedAt is null || submittedAt > bestSubmittedAt.Value)
                {
                    bestSubmittedAt = submittedAt;
                    best = commitId;
                }
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
            }
        }
```

Update the method's doc comment (currently lines 64–70) to describe the new rule:

```csharp
    // GitHub returns reviews paginated at per_page=100 with no documented sort order. Rather
    // than trust array position, select the viewer review with the maximum submitted_at among
    // reviews that carry a real (string-kind) submitted_at AND a non-empty commit_id; its
    // commit_id is the "last reviewed head". The running best persists across all walked pages
    // (capped at MaxReviewPages, mirroring the CI detector), so the max is global, not per-page.
    // PENDING drafts (submitted_at: null) and null/empty commit_id reviews are skipped (#367).
    // Per-review JSON access is isolated so one malformed review item is skipped, not the tick.
```

- [ ] **Step 4: Run the new test + the full filter class**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~GitHubAwaitingAuthorFilterTests"`
Expected: PASS (new test green; all Task-1-enriched fixtures still green — for ascending fixtures, max-by-timestamp picks the same review array-last did).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "feat(#367): select last reviewed head by max submitted_at, not array position"
```

---

## Task 3: Null-`commit_id`-latest falls back (decision A coverage)

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`

- [ ] **Step 1: Write the test**

```csharp
[Fact]
public async Task Latest_by_submitted_at_with_null_commit_id_falls_back_to_prior()
{
    // The newest review (by submitted_at) has commit_id: null → skipped; selection falls
    // back to the older review at "old". PR head "new" != "old" ⇒ PR included (decision A).
    var body = $$"""
        [
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" },
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": null,  "submitted_at": "2020-02-01T00:00:00Z" }
        ]
        """;
    var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
    var sut = BuildSut(handler);

    var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

    result.Should().ContainSingle("the null-commit_id newest review is skipped; best falls back to 'old' != head");
}
```

- [ ] **Step 2: Run it**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~Latest_by_submitted_at_with_null_commit_id_falls_back_to_prior"`
Expected: PASS (`"commit_id": null` → `c.GetString()` returns null → `string.IsNullOrEmpty` → `continue`; best = "old").

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "test(#367): pin null-commit_id-latest fall-back (decision A)"
```

---

## Task 4: JSON-null `submitted_at` is a clean skip (drives the kind-guard)

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`
- Modify: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs` (the `submitted_at` eligibility line)

- [ ] **Step 1: Add the test usings + a logger-injecting `BuildSut` overload**

At the top of `GitHubAwaitingAuthorFilterTests.cs`, add:

```csharp
using Microsoft.Extensions.Logging;
using Moq;
```

Add a second `BuildSut` next to the existing one:

```csharp
private static GitHubAwaitingAuthorFilter BuildSut(
    HttpMessageHandler handler, ILogger<GitHubAwaitingAuthorFilter> log) =>
    new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
        () => Task.FromResult<string?>("t"), log);
```

- [ ] **Step 2: Write the failing test (pending JSON-null + no malformed-log)**

```csharp
[Fact]
public async Task Pending_review_with_null_submitted_at_is_skipped_cleanly_no_malformed_log()
{
    // The pending review carries a non-null commit_id "head" (load-bearing: a fully-pending
    // review with commit_id null would be skipped at the commit_id gate before the kind
    // check). Its submitted_at is a literal JSON null. It must be excluded by the ValueKind
    // gate as a normal `continue` — NOT thrown-and-caught as a malformed item. best falls
    // back to "old" != head ⇒ PR included; and no ReviewItemSkipped log is emitted.
    var log = new Mock<ILogger<GitHubAwaitingAuthorFilter>>();
    var body = $$"""
        [
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" },
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": null }
        ]
        """;
    var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
    var sut = BuildSut(handler, log.Object);

    var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

    result.Should().ContainSingle("pending review skipped; best falls back to 'old' != head");
    log.Verify(
        l => l.Log(
            It.IsAny<LogLevel>(),
            It.IsAny<EventId>(),
            It.IsAny<It.IsAnyType>(),
            It.IsAny<Exception>(),
            (Func<It.IsAnyType, Exception?, string>)It.IsAny<object>()),
        Times.Never,
        "a JSON-null submitted_at must be a clean skip, not a malformed-item log");
}
```

- [ ] **Step 3: Run it — expect FAIL on the no-log assertion**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~Pending_review_with_null_submitted_at_is_skipped_cleanly_no_malformed_log"`
Expected: FAIL — without the kind-guard, `submitted_at` is present (null-kind), `GetDateTimeOffset()` throws `InvalidOperationException`, the guard catches it and `Log.ReviewItemSkipped` fires, so `Times.Never` fails. (The `ContainSingle` part already passes.)

- [ ] **Step 4: Add the `JsonValueKind.String` guard**

In `GitHubAwaitingAuthorFilter.cs`, change the `submitted_at` eligibility line (added in Task 2) from:

```csharp
                if (!review.TryGetProperty("submitted_at", out var sa)) continue; // unsubmitted/absent → skip
```

to:

```csharp
                // submitted_at is JSON null for PENDING drafts; gate on the value KIND so a
                // null-kind is a clean skip, not a GetDateTimeOffset() throw caught as malformed
                // (mirrors GitHubReviewService.cs:917). A non-date STRING still reaches the parse
                // below and throws FormatException → handled by the malformed-item guard.
                if (!review.TryGetProperty("submitted_at", out var sa) ||
                    sa.ValueKind != JsonValueKind.String) continue;
```

- [ ] **Step 5: Run the new test + the full filter class**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~GitHubAwaitingAuthorFilterTests"`
Expected: PASS — the kind-guard makes the pending review a clean `continue`; no log; all prior tests still green.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "fix(#367): gate submitted_at on JsonValueKind.String so pending drafts skip cleanly"
```

---

## Task 5: Cross-page + malformed-string coverage, then full verification

**Files:**
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`

- [ ] **Step 1: Write the cross-page test**

```csharp
[Fact]
public async Task Newer_review_on_page1_wins_over_older_on_page2_by_submitted_at()
{
    // Page 1 holds the NEWER review (at head); page 2 the OLDER (at old sha). The running
    // best must be the max-by-submitted_at across BOTH pages ⇒ best == head ⇒ PR excluded.
    var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" } ]""";
    var page2 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" } ]""";
    var handler = new PaginatedFakeHandler()
        .RouteJson("/repos/acme/api/pulls/1/reviews", page1, page2);
    var sut = BuildSut(handler);

    var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

    result.Should().BeEmpty("the page-1 review is newest by submitted_at and is at head");
    handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(2);
}
```

- [ ] **Step 2: Write the malformed-string test**

```csharp
[Fact]
public async Task Malformed_submitted_at_string_skips_one_review_scan_continues()
{
    // First review: non-null commit_id "x" (so it passes the commit_id gate) + a non-date
    // STRING submitted_at (passes the ValueKind gate, throws FormatException at parse) →
    // skipped via the malformed-item guard. Second review valid ⇒ best = "old" != head.
    var body = $$"""
        [
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "x",   "submitted_at": "not-a-date" },
          { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" }
        ]
        """;
    var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
    var sut = BuildSut(handler);

    var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

    var result = await act.Should().NotThrowAsync();
    result.Subject.Should().ContainSingle("malformed review skipped; best = 'old' != head");
}
```

- [ ] **Step 3: Run both new tests**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release --filter "FullyQualifiedName~Newer_review_on_page1_wins_over_older_on_page2_by_submitted_at|FullyQualifiedName~Malformed_submitted_at_string_skips_one_review_scan_continues"`
Expected: PASS (both exercise paths already implemented; coverage locks for AC1-cross-page and AC4).

- [ ] **Step 4: Full Release build + test of the GitHub project**

Run: `dotnet build PRism.GitHub/PRism.GitHub.csproj -c Release`
Expected: 0 errors, 0 warnings.

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj -c Release`
Expected: PASS (full `PRism.GitHub.Tests` suite green).

- [ ] **Step 5: Commit**

```bash
git add tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "test(#367): cover cross-page submitted_at-max and malformed-timestamp skip"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|-----------|------|
| R1 submitted_at-max selection | Task 2 |
| R1a strictly-greater + null-guard comparison | Task 2 (Step 3) |
| R1b decision A (null-commit_id fall back) | Task 3 |
| R2 PENDING excluded (intended change) | Task 4 |
| Key insight — `JsonValueKind.String` kind-guard | Task 4 (Step 4) |
| AC1 ordering-robust (within page) | Task 2 (test 1) |
| AC1 ordering-robust (cross page) | Task 5 (test 4) |
| AC2 null-commit_id excluded + fall back | Task 3 (test 2) |
| AC3 JSON-null submitted_at excluded, no-log | Task 4 (test 3) |
| AC4 malformed timestamp skipped, no abort | Task 5 (test 5) |
| AC5 no collateral change / existing tests green | Tasks 1 (pre-position) + 4/5 (Step verifications) |
| Test-harness prerequisite (BuildSut logger overload + Moq) | Task 4 (Step 1) |
| Fixture realism (ascending submitted_at) | Task 1 |
| Page-cap × submitted_at-max equivalence | preserved by Task 2 (best persists across pages; cap unchanged) |
| Out-of-scope: interface/callers/pagination/cache/404/429/cancellation untouched | no task touches them (verified by full-suite runs) |

No gaps.

**Placeholder scan:** none — every code step shows complete code and exact `dotnet` commands.

**Type/name consistency:** `best` (`string?`) and `bestSubmittedAt` (`DateTimeOffset?`) are introduced together in Task 2 and used identically in Task 4. `BuildSut(handler)` and the new `BuildSut(handler, log)` overload are both referenced after their definitions. Test method names are unique. `ReviewsResponse`'s new optional `submittedAt` parameter is backward-compatible with all existing two-arg callers.

**Note on the Moq source-gen verify (Task 4):** `Log.ReviewItemSkipped` lowers to the generic `ILogger.Log(LogLevel, EventId, TState, Exception?, Func<TState, Exception?, string>)` overload, so the `Times.Never` verify must target that signature with `It.IsAnyType` / the `(Func<It.IsAnyType, Exception?, string>)It.IsAny<object>()` cast — this is the established Moq pattern for asserting a source-generated logger message did not fire.
