# Inbox CI Status Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbox CI dot advance without a head-SHA change — stop pinning transient `Pending` (background auto-advance), and make manual Refresh force a CI re-read.

**Architecture:** Two levers in `GitHubCiFailingDetector`. Lever 1: never cache a `Pending` (re-probe each sweep until terminal). Lever 2: a `forceReprobe` flag threaded `/api/inbox/refresh` → `IInboxRefreshOrchestrator.RefreshAsync(hardRefresh)` → `ICiFailingDetector.DetectAsync(forceReprobe)` that skips the cache read and refreshes the stored value. CI only ever sees live PRs, so "live-only" is automatic.

**Tech Stack:** C# / .NET, xUnit + FluentAssertions + Moq. Spec: `docs/specs/2026-06-11-inbox-ci-status-refresh-design.md`.

**Pre-push:** `.ai/docs/development-process.md` checklist. Backend only — no frontend/Playwright. Run `dotnet test` (one long-running command at a time, ≥5min timeout).

---

## File Structure

| File | Change |
|------|--------|
| `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` | Lever 1 (cache-write guard) + Lever 2 (`forceReprobe` param, cache-read bypass) |
| `PRism.Core/Inbox/ICiFailingDetector.cs` | add `bool forceReprobe = false` to `DetectAsync` + xmldoc |
| `PRism.Core/Inbox/IInboxRefreshOrchestrator.cs` | add `bool hardRefresh = false` to `RefreshAsync` |
| `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` | forward `hardRefresh` → `DetectAsync(forceReprobe:)` |
| `PRism.Web/Endpoints/InboxEndpoints.cs` | `/api/inbox/refresh` → `RefreshAsync(ct, hardRefresh: true)` |
| `PRism.Web/TestHooks/FakeCiFailingDetector.cs` | add param (compile) |
| `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` | `FakeCiDetector` gains param (Task 2, compile-only); gains flag-capture field + forwarding test (Task 3) |
| `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs` | add param + capture flag |
| `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs` | Lever 1 + Lever 2 detector tests |
| `tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs` | endpoint-forwards-hardRefresh test |

---

## Task 1: Lever 1 — stop caching `Pending` (detector)

No signature change. This is the bug fix; its first test reds on `origin/main`.

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs:46`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Write the failing tests**

Add to `GitHubCiFailingDetectorTests.cs` (the `InProgressCheckRun`, `AllPassingCheckRuns`, `SuccessNoLegacyStatus`, `RegisteredPendingStatus` constants and `Respond`/`BuildSut`/`Raw` helpers already exist):

```csharp
    [Fact]
    public async Task Pending_is_not_cached_and_advances_to_terminal_next_sweep()
    {
        // #355 Lever 1: a clean (non-degraded) Pending must NOT be pinned. Same (ref, headSha):
        // sweep 1 reads in-progress (Pending), sweep 2 reads passing → sweep 2 must reflect Passing.
        // On main the cached Pending pins and sweep 2 still returns Pending (RED).
        var finished = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, finished ? AllPassingCheckRuns : InProgressCheckRun);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        var first = await sut.DetectAsync([Raw(1)], default);
        first.Items[0].Ci.Should().Be(CiStatus.Pending);

        finished = true;
        var second = await sut.DetectAsync([Raw(1)], default);
        second.Items[0].Ci.Should().Be(CiStatus.Passing,
            "a clean Pending must not be cached — the next sweep re-probes and sees the terminal status");
    }

    [Fact]
    public async Task Pending_reprobes_http_each_sweep()
    {
        // A Pending sweep must issue HTTP again next sweep (not served from cache).
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, InProgressCheckRun);
            return Respond(HttpStatusCode.OK, RegisteredPendingStatus);
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "sha-A");
        await sut.DetectAsync([candidate], default);
        var afterFirst = requestCount;
        await sut.DetectAsync([candidate], default);

        afterFirst.Should().Be(2);
        requestCount.Should().Be(4, "a Pending result must re-probe next sweep, not hit the cache");
    }
```

- [ ] **Step 2: Run the new tests against a clean `origin/main` checkout — confirm RED**

Run (from the worktree): copy the two test methods onto a scratch `origin/main` build, or run the suite on the branch BEFORE the Step 3 edit. Expected: `Pending_is_not_cached_and_advances_to_terminal_next_sweep` FAILS asserting `Expected CiStatus.Passing, but found CiStatus.Pending`; `Pending_reprobes_http_each_sweep` FAILS asserting `Expected 4, but found 2`. Capture this output for the PR's red-on-main proof.

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`

- [ ] **Step 3: Apply the Lever 1 fix**

In `GitHubCiFailingDetector.cs`, change the cache-write guard (currently line 46):

```csharp
                // Cache only a complete, successful, NON-TRANSIENT read. A degraded result
                // (non-2xx) is never cached so the next tick re-probes (#213). Pending joins
                // it: a clean Pending is transient — caching it pinned the CI dot until the
                // head SHA moved, so checks finishing on an unchanged head never advanced the
                // dot (#355). Re-probe Pending every sweep until it goes terminal, then cache.
                if (!degraded && ci != CiStatus.Pending) _cache[key] = ci;
```

- [ ] **Step 4: Run the detector tests — confirm GREEN (including existing cache tests)**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: PASS — the two new tests pass, and existing `Cache_hit_skips_http`, `Cache_invalidates_on_head_sha_change`, `Definitive_failing_is_cached_even_when_other_source_degraded` stay green (terminal statuses are still cached).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubCiFailingDetector.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "fix(#355): stop caching transient Pending CI so the inbox dot advances on the poll"
```

---

## Task 2: Lever 2 — `forceReprobe` cache-read bypass (detector)

Adds the interface param. Touches the two existing detector fakes (compile).

**Files:**
- Modify: `PRism.Core/Inbox/ICiFailingDetector.cs`
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` (`DetectAsync` signature + cache-read line)
- Modify: `PRism.Web/TestHooks/FakeCiFailingDetector.cs` (compile)
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (`FakeCiDetector` compile — flag capture lands in Task 3)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Write the failing tests**

Add to `GitHubCiFailingDetectorTests.cs`:

```csharp
    [Fact]
    public async Task forceReprobe_bypasses_cache_read_and_refreshes_value()
    {
        // #355 Lever 2: a normal call caches Passing; a forceReprobe call ignores the cache and
        // re-reads (now Failing) for the SAME sha, then WRITES the fresh value so a subsequent
        // normal call returns Failing with no new HTTP.
        var failing = false;
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, failing ? FailingCheckRun : AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing);
        var afterFirst = requestCount; // 2

        failing = true;
        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.Failing, "forceReprobe must bypass the cached Passing");
        requestCount.Should().Be(afterFirst + 2, "forceReprobe re-probes both sources");

        var afterForced = requestCount;
        var third = await sut.DetectAsync([candidate], default); // normal, no force
        third.Items[0].Ci.Should().Be(CiStatus.Failing, "the forced reprobe refreshed the cached value");
        requestCount.Should().Be(afterForced, "the refreshed terminal is now served from cache");
    }

    [Fact]
    public async Task forceReprobe_does_not_cache_pending()
    {
        // forceReprobe still honors Lever 1: a forced reprobe returning Pending is not pinned.
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, InProgressCheckRun);
            return Respond(HttpStatusCode.OK, RegisteredPendingStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.Pending);
        var afterForced = requestCount;

        var normal = await sut.DetectAsync([candidate], default);
        normal.Items[0].Ci.Should().Be(CiStatus.Pending);
        requestCount.Should().Be(afterForced + 2, "a forced Pending was not cached — the next sweep re-probes");
    }

    [Fact]
    public async Task forceReprobe_degraded_leaves_existing_cached_terminal()
    {
        // A forced reprobe that degrades (5xx) writes nothing and does NOT evict the prior
        // cached terminal — a transient blip is not evidence the terminal is wrong.
        var degrade = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return degrade
                    ? Respond(HttpStatusCode.ServiceUnavailable, "{}")
                    : Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing);

        degrade = true;
        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.None, "the forced reprobe degraded this sweep");

        degrade = false;
        var normal = await sut.DetectAsync([candidate], default);
        normal.Items[0].Ci.Should().Be(CiStatus.Passing,
            "the degraded forced reprobe did not evict the prior cached terminal");
    }
```

- [ ] **Step 2: Run to verify they fail to compile / fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: COMPILE ERROR — `DetectAsync` has no `forceReprobe` parameter. (That is the red.)

- [ ] **Step 3: Add the interface parameter**

In `PRism.Core/Inbox/ICiFailingDetector.cs`, update the method + xmldoc:

```csharp
    /// <summary>
    /// Probes Checks API + legacy combined-status for each input PR and annotates it
    /// with its <see cref="CiStatus"/>. Caches by (ref, headSha); degraded reads and
    /// transient <see cref="CiStatus.Pending"/> are never cached (re-probed next sweep).
    /// Throws <see cref="RateLimitExceededException"/> on 429 so the orchestrator can back off.
    /// Scope-agnostic: the caller decides which PRs to probe.
    /// </summary>
    /// <param name="forceReprobe">
    /// When true, skips the cache READ for every item (always probes) and refreshes the stored
    /// value, honoring the same never-cache rules for Pending/degraded. Used by the manual
    /// "Refresh now" path so an unchanged head SHA re-reads CI. The caller is responsible for
    /// passing only live PRs (recently-closed never reaches this detector).
    /// </param>
    Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items,
        CancellationToken ct,
        bool forceReprobe = false);
```

- [ ] **Step 4: Implement the cache-read bypass**

In `GitHubCiFailingDetector.cs`, update the `DetectAsync` signature and the cache-read line (currently line 37):

```csharp
    public async Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
    {
```

```csharp
                var key = (c.Reference, c.HeadSha);
                if (!forceReprobe && _cache.TryGetValue(key, out var cached))
                    return (Item: c, Ci: cached, Degraded: false);
```

- [ ] **Step 5: Fix the two existing detector fakes (compile)**

`PRism.Web/TestHooks/FakeCiFailingDetector.cs:9`:

```csharp
    public Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
```

`tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` — `FakeCiDetector.DetectAsync` (currently line 125):

```csharp
        public Task<CiDetectResult> DetectAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
        {
            LastInput = items;
```

This task touches `FakeCiDetector`'s **signature only** (to keep the solution compiling). Task 3 then adds a `LastForceReprobe` capture field + assignment to this same fake for the forwarding assertion — do not add the field here.

- [ ] **Step 6: Run the detector tests — confirm GREEN**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: PASS (all new + existing).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Inbox/ICiFailingDetector.cs PRism.GitHub/Inbox/GitHubCiFailingDetector.cs PRism.Web/TestHooks/FakeCiFailingDetector.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "feat(#355): add forceReprobe to ICiFailingDetector.DetectAsync (cache-read bypass)"
```

---

## Task 3: Orchestrator forwards `hardRefresh` → `forceReprobe`

**Files:**
- Modify: `PRism.Core/Inbox/IInboxRefreshOrchestrator.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:83,160`
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (`FakeCiDetector` captures flag + new test)

- [ ] **Step 1: Write the failing test**

First extend `FakeCiDetector` in `InboxRefreshOrchestratorTests.cs` to capture the flag (add the field + assignment):

```csharp
        public IReadOnlyList<RawPrInboxItem>? LastInput { get; private set; }
        public bool LastForceReprobe { get; private set; }
```

```csharp
        public Task<CiDetectResult> DetectAsync(
            IReadOnlyList<RawPrInboxItem> items, CancellationToken ct, bool forceReprobe = false)
        {
            LastInput = items;
            LastForceReprobe = forceReprobe;
            if (_throw is not null) throw _throw;
```

Then add the test, modeled exactly on the existing `Ci_is_probed_for_all_live_sections_not_just_authored` (same file, ~line 413). It uses the `BuildSut(sections, ciDetector)` convenience overload (line 210) with an inline section dict and `RawPr(int n)` (line 23). The CI detector only runs when a live section has ≥1 PR (`liveForCi.Count > 0`), and `BuildSut`'s default config is `AppConfig.Default` (all sections enabled), so a single `authored-by-me` PR suffices:

```csharp
    [Fact]
    public async Task RefreshAsync_hardRefresh_forwards_forceReprobe_to_detector()
    {
        var ci = new FakeCiDetector(CiStatus.Passing);
        var sut = BuildSut(
            sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
            {
                ["authored-by-me"] = new[] { RawPr(1) },
            },
            ciDetector: ci);

        await sut.RefreshAsync(CancellationToken.None);                       // default false
        ci.LastForceReprobe.Should().BeFalse("a normal poll/cold-start must use the cached path");

        await sut.RefreshAsync(CancellationToken.None, hardRefresh: true);    // manual refresh
        ci.LastForceReprobe.Should().BeTrue("a hard refresh must force the CI re-read");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxRefreshOrchestratorTests.RefreshAsync_hardRefresh_forwards_forceReprobe_to_detector"`
Expected: COMPILE ERROR — `RefreshAsync` has no `hardRefresh` parameter.

- [ ] **Step 3: Add the interface parameter**

`PRism.Core/Inbox/IInboxRefreshOrchestrator.cs`:

```csharp
    /// <summary>
    /// Pulls a fresh inbox snapshot. <paramref name="hardRefresh"/> = true forces a live-CI
    /// re-read bypassing the (ref, headSha) cache (the manual "Refresh now" path); the
    /// background poll passes false to keep its cheap cached path.
    /// </summary>
    Task RefreshAsync(CancellationToken ct, bool hardRefresh = false);
```

- [ ] **Step 4: Forward it in the orchestrator**

`InboxRefreshOrchestrator.cs` — update the signature (line 83) and the `DetectAsync` call (line 160):

```csharp
    public async Task RefreshAsync(CancellationToken ct, bool hardRefresh = false)
```

```csharp
                    var probed = await _ciDetector.DetectAsync(liveForCi, ct, forceReprobe: hardRefresh).ConfigureAwait(false);
```

(`TryColdStartRefresh`'s `RefreshAsync(CancellationToken.None)` and the poller's `RefreshAsync(stoppingToken)` bind to the `false` default — no edit.)

- [ ] **Step 5: Run the test — confirm GREEN**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~InboxRefreshOrchestratorTests"`
Expected: PASS (new test + all existing orchestrator tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/IInboxRefreshOrchestrator.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#355): thread hardRefresh through RefreshAsync to the CI detector"
```

---

## Task 4: Endpoint wires `/api/inbox/refresh` to a hard refresh

**Files:**
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs:78`
- Modify: `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs` (param + capture)
- Test: `tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs`

- [ ] **Step 1: Update the fake to the new signature + capture the flag**

`tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs`:

```csharp
    public int RefreshCalls { get; private set; }
    public bool? LastHardRefresh { get; private set; }
```

```csharp
    public Task RefreshAsync(CancellationToken ct, bool hardRefresh = false)
    {
        RefreshCalls++;
        LastHardRefresh = hardRefresh;
        return RefreshOverride?.Invoke(ct) ?? Task.CompletedTask;
    }
```

- [ ] **Step 2: Write the failing test**

Add to `InboxRefreshEndpointTests.cs` (reuses `MakeSnapshot`/`PostRefresh`/`PRismWebApplicationFactory`):

```csharp
    [Fact]
    public async Task Post_refresh_forwards_hardRefresh_true()
    {
        var fakeOrch = new FakeInboxRefreshOrchestrator { Current = MakeSnapshot() };
        using var factory = new PRismWebApplicationFactory { FakeOrchestrator = fakeOrch };
        var client = factory.CreateClient();

        var resp = await PostRefresh(client);

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        fakeOrch.LastHardRefresh.Should().BeTrue("/api/inbox/refresh is a hard refresh (#355)");
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~InboxRefreshEndpointTests.Post_refresh_forwards_hardRefresh_true"`
Expected: FAIL — `LastHardRefresh` is `false` (endpoint still calls `RefreshAsync(ct)`).

- [ ] **Step 4: Wire the endpoint**

`PRism.Web/Endpoints/InboxEndpoints.cs` — in the `/api/inbox/refresh` handler (line 78):

```csharp
                await orch.RefreshAsync(ct, hardRefresh: true).ConfigureAwait(false);
```

- [ ] **Step 5: Run the endpoint tests — confirm GREEN**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~InboxRefreshEndpointTests"`
Expected: PASS (new test + the 4 existing refresh-endpoint tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/Endpoints/InboxEndpoints.cs tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs tests/PRism.Web.Tests/Endpoints/InboxRefreshEndpointTests.cs
git commit -m "feat(#355): manual Refresh forces a live-CI re-read"
```

---

## Final verification (before PR)

- [ ] **Full backend suite green.** Run: `dotnet test` (≥5min timeout). Expected: all pass.
- [ ] **Secrets scan** over the diff (`.ai/docs/behavioral-guidelines.md` §6) — no tokens/keys/connection strings. This diff touches no config.
- [ ] **Re-read the diff against the Axis-B risk table** (`.ai/docs/issue-resolution-workflow.md`): confirm no auth/token-storage/migration/cross-tab/sidecar/security surface was touched. Expected: hands-off holds (CI-enrichment cache logic only).
- [ ] **Assemble `## Proof`**: red-on-main output from Task 1 Step 2; acceptance-criteria checklist (Lever 1 = Task 1 tests; Lever 2 = Tasks 2–4 tests); secrets-scan result; doc-review dispositions (2× ce-doc-review, all applied; #361 filed for the same-SHA-rerun gap).
- [ ] `pr-autopilot`.
