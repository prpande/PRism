# Inbox Categorization Rethink + Fast Filter/Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `ci-failing` as a section and make CI a cross-cutting filter axis (probed server-side for all inbox PRs, fault-isolated so a CI rate-limit never freezes the inbox); add a search-led client-side filter/sort bar over the existing sections; relabel `awaiting-author`; make section order explicit.

**Architecture:** Three sequenced PRs. **PR1** (backend + thin settings/wire surface, small B1) does the categorization change: widen CI probing across all live sections with fault-isolation + a `ciProbeComplete` flag, drop the `ci-failing` section/config/dedup-pair, relabel, and pin section order. **PR2** (frontend, B1) adds the additive filter/sort bar, the CI-facet failing count + incomplete hint, the per-row dot tooltip, and the empty/zero states. **PR3** adds the persisted `inbox.defaultSort` preference. PR1 must merge before PR2 (PR2's CI facet depends on `ci` being populated inbox-wide).

**Tech Stack:** .NET 10 minimal APIs + records (PRism.Core / PRism.GitHub / PRism.Web), xUnit + FluentAssertions + Moq; React 19 + Vite + TypeScript, Vitest + Testing Library, Playwright e2e.

**Source spec:** `docs/specs/2026-06-07-inbox-taxonomy-design.md` (#262, absorbs #263).

**Plan deviation from the spec's decomposition note (documented per behavioral-guidelines):** the spec sketched "PR1 backend, no UI gate." In reality PR1 populates `ci` for every section, which makes `InboxRow`'s existing CI dot render in `review-requested`/`mentioned`/`awaiting-author`; and dropping `ci-failing` from the `InboxSectionsDto` wire forces the matching frontend type/Settings edits in the same PR. So PR1 carries a small B1 surface (new dots, relabel, removed section) and includes a few frontend settings files. PR2 remains the additive filter bar.

**Conventions for every task below:**
- Backend tests: `dotnet test tests/PRism.<Project>.Tests` (timeout ≥ 300000ms; one at a time). Typecheck/build the frontend with `npm run build` (which runs `tsc -b` — `tsc --noEmit` is a vacuous no-op in this repo).
- Frontend unit tests: `npm test -- <path>` (Vitest). Prettier gate: run `node ./node_modules/prettier/bin/prettier.cjs --check .` directly (rtk masks prettier output).
- Commit after each task with the shown message. Work in worktree `D:\src\PRism-262-inbox-taxonomy` on branch `feature/262-inbox-taxonomy`.

---

# PR1 — Categorization change (backend + settings/wire surface)

Goal: `ci-failing` is gone as a section; CI is probed for all live inbox PRs server-side, fault-isolated, with a `ciProbeComplete` flag; `awaiting-author` is relabeled; section order is explicit. Leaves the app fully working with the new dots visible.

---

### Task 1: CI detector reports probe completeness

The orchestrator must know whether *any* per-PR probe degraded (a fine-grained-PAT 403 / transient 5xx returns `CiStatus.None`, indistinguishable from "passing"). Today `DetectAsync` discards the per-probe `degraded` flag. Surface an aggregate `Complete` flag via a new return type.

**Files:**
- Modify: `PRism.Core/Inbox/ICiFailingDetector.cs`
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Write the failing test** — append to `GitHubCiFailingDetectorTests.cs` (mirror the existing fixture's `IHttpClientFactory` stub style):

```csharp
[Fact]
public async Task DetectAsync_returns_Complete_false_when_a_probe_degrades()
{
    // Checks API 403 (fine-grained PAT) → degraded; status 200 success.
    var handler = new StubHandler(req =>
        req.RequestUri!.AbsolutePath.Contains("/check-runs", StringComparison.Ordinal)
            ? new HttpResponseMessage(System.Net.HttpStatusCode.Forbidden)
            : Json("{\"state\":\"success\"}"));
    var sut = new GitHubCiFailingDetector(FactoryFor(handler), () => Task.FromResult<string?>("t"));

    var result = await sut.DetectAsync(new[] { Raw(1, "sha1") }, CancellationToken.None);

    result.Complete.Should().BeFalse();
    result.Items.Should().ContainSingle().Which.Ci.Should().Be(CiStatus.None);
}

[Fact]
public async Task DetectAsync_returns_Complete_true_when_all_probes_succeed()
{
    var handler = new StubHandler(req =>
        req.RequestUri!.AbsolutePath.Contains("/check-runs", StringComparison.Ordinal)
            ? Json("{\"check_runs\":[]}")
            : Json("{\"state\":\"success\"}"));
    var sut = new GitHubCiFailingDetector(FactoryFor(handler), () => Task.FromResult<string?>("t"));

    var result = await sut.DetectAsync(new[] { Raw(1, "sha1") }, CancellationToken.None);

    result.Complete.Should().BeTrue();
    result.Items.Should().ContainSingle();
}
```

> If the file lacks `StubHandler`/`Json`/`FactoryFor`/`Raw` helpers, reuse whatever request-stub helper the existing tests already define — read the top of the file first and match its names; the assertions on `result.Complete` / `result.Items` are the point.

- [ ] **Step 2: Run to verify it fails to compile** — `dotnet test tests/PRism.GitHub.Tests` → FAIL (`'IReadOnlyList<...>' does not contain a definition for 'Complete'`).

- [ ] **Step 3: Change the interface** — replace the body of `ICiFailingDetector.cs`:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

/// <summary>Result of a CI probe sweep over a set of live PRs.</summary>
/// <param name="Items">Each input PR annotated with its <see cref="CiStatus"/>.</param>
/// <param name="Complete">
/// False when at least one probe degraded this sweep (a non-2xx read such as a
/// fine-grained-PAT 403 on the Checks API or a transient 5xx). A degraded probe
/// yields <see cref="CiStatus.None"/>, indistinguishable from "passing" — callers
/// use this flag to signal that a CI filter may under-match.
/// </param>
public readonly record struct CiDetectResult(
    IReadOnlyList<(RawPrInboxItem Item, CiStatus Ci)> Items,
    bool Complete);

public interface ICiFailingDetector
{
    /// <summary>
    /// Probes Checks API + legacy combined-status for each input PR and annotates it
    /// with its <see cref="CiStatus"/>. Caches by (ref, headSha); degraded reads are
    /// not cached (re-probed next sweep). Throws <see cref="RateLimitExceededException"/>
    /// on 429 so the orchestrator can back off. Scope-agnostic: the caller decides
    /// which PRs to probe.
    /// </summary>
    Task<CiDetectResult> DetectAsync(
        IReadOnlyList<RawPrInboxItem> items,
        CancellationToken ct);
}
```

- [ ] **Step 4: Update the implementation** — in `GitHubCiFailingDetector.cs`, change the `DetectAsync` signature param `authoredItems`→`items`, track degradation per probe, and return `CiDetectResult`:

```csharp
public async Task<CiDetectResult> DetectAsync(
    IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(items);
    if (items.Count == 0) return new CiDetectResult(Array.Empty<(RawPrInboxItem, CiStatus)>(), true);
    var token = await _readToken().ConfigureAwait(false);
    using var sem = new SemaphoreSlim(ConcurrencyCap);

    var done = await Task.WhenAll(items.Select(async c =>
    {
        await sem.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (string.IsNullOrEmpty(c.HeadSha)) return (Item: c, Ci: CiStatus.None, Degraded: false);
            var key = (c.Reference, c.HeadSha);
            if (_cache.TryGetValue(key, out var cached)) return (Item: c, Ci: cached, Degraded: false);

            var (ci, degraded) = await ProbeAsync(c.Reference, c.HeadSha, token, ct).ConfigureAwait(false);
            if (!degraded) _cache[key] = ci;
            return (Item: c, Ci: ci, Degraded: degraded);
        }
        finally { sem.Release(); }
    })).ConfigureAwait(false);

    var anyDegraded = Array.Exists(done, t => t.Degraded);
    var items2 = done.Select(t => (t.Item, t.Ci)).ToList();
    return new CiDetectResult(items2, Complete: !anyDegraded);
}
```

- [ ] **Step 5: Run to verify pass** — `dotnet test tests/PRism.GitHub.Tests` → PASS. (Other call sites won't compile yet; that's Task 2.)

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/ICiFailingDetector.cs PRism.GitHub/Inbox/GitHubCiFailingDetector.cs tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "feat(#262): CI detector reports probe completeness (CiDetectResult)"
```

---

### Task 2: Snapshot carries `CiProbeComplete`

**Files:**
- Modify: `PRism.Core/Inbox/InboxSnapshot.cs`

- [ ] **Step 1: Add the field** — replace `InboxSnapshot.cs`:

```csharp
using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed record InboxSnapshot(
    IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool CiProbeComplete = true)
{
    public static InboxSnapshot Empty { get; } = new(
        new Dictionary<string, IReadOnlyList<PrInboxItem>>(),
        new Dictionary<string, InboxItemEnrichment>(),
        DateTimeOffset.MinValue);
}
```

- [ ] **Step 2: Build** — `dotnet build PRism.Core` → PASS (defaulted param keeps existing constructors valid).

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Inbox/InboxSnapshot.cs
git commit -m "feat(#262): add CiProbeComplete to InboxSnapshot"
```

---

### Task 3: Orchestrator — widen CI probe, fault-isolate, drop `ci-failing`

The keystone backend change. Probe CI over **all distinct live PRs** (not just authored), set `CiProbeComplete`, never let a CI 429 discard the snapshot (re-surface it after publishing so the poller still backs off), and stop materializing `ci-failing`.

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

- [ ] **Step 1: Update the test fake + add tests.** In `InboxRefreshOrchestratorTests.cs`, the `NoneciDetector` fake implements the old signature. Replace it and add a configurable fake + two tests:

```csharp
// CI detector: returns all items with a fixed status + a configurable Complete flag,
// or throws a supplied exception to exercise fault-isolation.
private sealed class FakeCiDetector : ICiFailingDetector
{
    private readonly CiStatus _status;
    private readonly bool _complete;
    private readonly Exception? _throw;
    public IReadOnlyList<RawPrInboxItem>? LastInput { get; private set; }
    public FakeCiDetector(CiStatus status = CiStatus.None, bool complete = true, Exception? toThrow = null)
        { _status = status; _complete = complete; _throw = toThrow; }
    public Task<CiDetectResult> DetectAsync(IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
    {
        LastInput = items;
        if (_throw is not null) throw _throw;
        return Task.FromResult(new CiDetectResult(
            items.Select(i => (i, _status)).ToList(), _complete));
    }
}
```

Replace every `new NoneciDetector()` in this file with `new FakeCiDetector()`. Then add:

```csharp
[Fact]
public async Task Ci_is_probed_for_all_live_sections_not_just_authored()
{
    var detector = new FakeCiDetector(CiStatus.Failing);
    var sut = BuildSut(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1) },
            ["authored-by-me"]   = new[] { RawPr(2) },
        },
        ciDetector: detector);

    await sut.RefreshAsync(CancellationToken.None);

    // detector saw BOTH refs (distinct), and the review-requested PR carries CI now.
    detector.LastInput!.Select(i => i.Reference.Number).Should().BeEquivalentTo(new[] { 1, 2 });
    sut.Current!.Sections["review-requested"][0].Ci.Should().Be(CiStatus.Failing);
    sut.Current.Sections.Should().NotContainKey("ci-failing");
}

[Fact]
public async Task Ci_rate_limit_publishes_snapshot_then_resurfaces_for_backoff()
{
    var detector = new FakeCiDetector(toThrow: new RateLimitExceededException("429", TimeSpan.FromSeconds(30)));
    var sut = BuildSut(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1) },
        },
        ciDetector: detector);

    var act = async () => await sut.RefreshAsync(CancellationToken.None);

    await act.Should().ThrowAsync<RateLimitExceededException>();   // re-surfaced for poller backoff
    sut.Current.Should().NotBeNull();                              // …but the snapshot still published
    sut.Current!.Sections["review-requested"].Should().ContainSingle();
    sut.Current.CiProbeComplete.Should().BeFalse();
}

[Fact]
public async Task Ci_probe_incomplete_sets_flag_without_throwing()
{
    var detector = new FakeCiDetector(CiStatus.None, complete: false);
    var sut = BuildSut(
        sections: _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { RawPr(1) },
        },
        ciDetector: detector);

    await sut.RefreshAsync(CancellationToken.None);

    sut.Current!.CiProbeComplete.Should().BeFalse();
}
```

> The file already has a construction helper (`Build(ISectionQueryRunner? sections, …)`) that takes a **built runner**, not a section-factory `Func`. Add a thin `BuildSut(...)` overload (or extend the existing one) that wraps the `sections` factory into the file's existing `FakeSectionQueryRunner` (`new FakeSectionQueryRunner(_factory)`) and accepts a `ciDetector`. Match the real ctor argument order (`IConfigStore`, `ISectionQueryRunner`, `IPrEnricher`, `IAwaitingAuthorFilter`, `ICiFailingDetector`, `IInboxDeduplicator`, `IAiSeamSelector`, `IReviewEventBus`, `IAppStateStore`, `Func<string>`). Don't invent a new section-fake — reuse `FakeSectionQueryRunner`.

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Core.Tests --filter InboxRefreshOrchestratorTests` → FAIL (compile: `CiDetectResult` not produced; `ci-failing` still present).

- [ ] **Step 3: Rewrite the CI block.** In `RefreshAsync`, replace the "Section 5 fan-out" block (the `var ciByRef = ...` through the `if (visible.Contains("ci-failing"))` close) **and** the immediately-following authored-superset drop block with:

```csharp
            // CI fan-out across ALL live sections (recently-closed flows through a
            // separate path and never enters rawWithEnrichment, so it is excluded).
            // Distinct-by-ref so a PR in two sections is probed once.
            var ciByRef = new Dictionary<PrReference, CiStatus>();
            var ciProbeComplete = true;
            RateLimitExceededException? ciRateLimit = null;
            var liveForCi = rawWithEnrichment.Values
                .SelectMany(v => v)
                .GroupBy(r => r.Reference)
                .Select(g => g.First())
                .ToList();
            if (liveForCi.Count > 0)
            {
                try
                {
                    var probed = await _ciDetector.DetectAsync(liveForCi, ct).ConfigureAwait(false);
                    foreach (var (item, ci) in probed.Items) ciByRef[item.Reference] = ci;
                    ciProbeComplete = probed.Complete;
                    Log.CiDetectionComplete(_log, liveForCi.Count,
                        probed.Items.Count(t => t.Ci == CiStatus.Failing), probed.Complete);
                }
                catch (OperationCanceledException) { throw; }
                catch (RateLimitExceededException rle)
                {
                    // CI is non-critical enrichment. A 429 must NOT discard the snapshot
                    // (that would freeze the no-CI sections too). Publish without CI, mark
                    // incomplete, and re-surface the rate-limit AFTER publishing so the
                    // poller still honors Retry-After. (#262 round-2 fault-isolation.)
                    ciProbeComplete = false;
                    ciRateLimit = rle;
                    Log.CiProbeRateLimited(_log);
                }
            }
```

> Note: the authored-by-me section is now added by `ResolveVisibleSections` iff its own toggle is on (Task 4 edit), so the old "force authored, then drop if disabled" block (the `if (!_config.Current.Inbox.Sections.AuthoredByMe) rawWithEnrichment.Remove("authored-by-me");` block and its comment) is dead — delete it.

- [ ] **Step 4: Thread `CiProbeComplete` into the snapshot and re-surface backoff.** Change the snapshot construction:

```csharp
            var newSnap = new InboxSnapshot(sectionsFinal, enrichmentMap, DateTimeOffset.UtcNow, ciProbeComplete);
```

and immediately after the `if (diff.Changed) { _events.Publish(...); }` block (still inside `try`, before the closing brace of `try`), add:

```csharp
            // Snapshot is committed + event published above. Now re-surface a CI rate-limit
            // so InboxPoller backs off (honoring Retry-After) without losing the snapshot.
            if (ciRateLimit is not null) throw ciRateLimit;
```

- [ ] **Step 5: Update the `Log` messages.** Replace the `CiDetectionComplete` LoggerMessage and add `CiProbeRateLimited`:

```csharp
        [LoggerMessage(Level = LogLevel.Debug, Message = "CI detection: {Probed} PRs probed, {Failing} failing, complete={Complete}")]
        internal static partial void CiDetectionComplete(ILogger logger, int probed, int failing, bool complete);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Inbox CI probe rate-limited (429); snapshot published without CI, backing off")]
        internal static partial void CiProbeRateLimited(ILogger logger);
```

- [ ] **Step 6: Run to verify pass** — `dotnet test tests/PRism.Core.Tests --filter InboxRefreshOrchestratorTests` → PASS.

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#262): widen CI probe across all sections with fault-isolation + ciProbeComplete"
```

---

### Task 4: Remove `ci-failing` from visible-section resolution

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (`ResolveVisibleSections`)

- [ ] **Step 1:** Replace the `ResolveVisibleSections` body so it no longer references `CiFailing`:

```csharp
    private HashSet<string> ResolveVisibleSections()
    {
        var s = _config.Current.Inbox.Sections;
        var v = new HashSet<string>();
        if (s.ReviewRequested) v.Add("review-requested");
        if (s.AwaitingAuthor) v.Add("awaiting-author");
        if (s.AuthoredByMe) v.Add("authored-by-me");
        if (s.Mentioned) v.Add("mentioned");
        // recently-closed is handled separately via QueryClosedHistoryAsync.
        return v;
    }
```

> This won't compile until Task 5 removes `CiFailing` from the record — that's fine; Tasks 4–5 land together. (`s.CiFailing` no longer referenced anywhere after this edit.)

- [ ] **Step 2:** Defer build/commit to Task 5 (same compile unit). Proceed.

---

### Task 5: Drop `CiFailing` from config + wire DTO + allowlist (with migration test)

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs`
- Modify: `PRism.Core/Config/ConfigStore.cs`
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs`
- Modify: `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` (migration + allowlist)

- [ ] **Step 1: Write the migration + allowlist tests** — append to `ConfigStorePatchAsyncDottedPathTests.cs`:

```csharp
[Fact]
public async Task Loads_legacy_config_with_ciFailing_key_cleanly()
{
    var dir = Directory.CreateTempSubdirectory().FullName;
    // Keys MUST be kebab-case: JsonSerializerOptionsFactory.Storage uses
    // KebabCaseJsonNamingPolicy with PropertyNameCaseInsensitive=false, so a
    // camelCase key would silently miss-bind and fall back to record defaults.
    var json = """
    { "inbox": { "deduplicate": true, "sections": {
        "review-requested": true, "awaiting-author": false, "authored-by-me": true,
        "mentioned": true, "ci-failing": true, "recently-closed": false } } }
    """;
    await File.WriteAllTextAsync(Path.Combine(dir, "config.json"), json);

    var store = new ConfigStore(dir);
    await store.InitAsync(CancellationToken.None);

    store.LastLoadError.Should().BeNull();                                  // unknown ciFailing skipped, not rejected
    store.Current.Inbox.Sections.AwaitingAuthor.Should().BeFalse();         // other bools preserved
    store.Current.Inbox.Sections.RecentlyClosed.Should().BeFalse();
}

[Fact]
public async Task Patch_rejects_removed_ci_failing_section_key()
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);

    var act = async () => await store.PatchAsync(
        new Dictionary<string, object?> { ["inbox.sections.ci-failing"] = true }, CancellationToken.None);

    await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*unknown field*");
}
```

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Core.Tests --filter ConfigStorePatchAsyncDottedPathTests` → FAIL (`ci-failing` still allowed; record still has `CiFailing`).

- [ ] **Step 3: Edit `AppConfig.cs`** — drop `CiFailing` from the record and fix `Default`:

```csharp
public sealed record InboxSectionsConfig(
    bool ReviewRequested,
    bool AwaitingAuthor,
    bool AuthoredByMe,
    bool Mentioned,
    bool RecentlyClosed = true);
```

and in `AppConfig.Default` change the `InboxSectionsConfig(...)` arg from six `true`s to five:

```csharp
        new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true), true, 14),
```

- [ ] **Step 4: Edit `ConfigStore.cs`** — remove the two `ci-failing` lines: the `["inbox.sections.ci-failing"] = ConfigFieldType.Bool,` entry in `_allowedFields`, and the `"inbox.sections.ci-failing" => ...` switch arm in `PatchAsync`.

- [ ] **Step 5: Edit `PreferencesDtos.cs`** — remove the `CiFailing` member from `InboxSectionsDto`:

```csharp
internal sealed record InboxSectionsDto(
    [property: JsonPropertyName("review-requested")] bool ReviewRequested,
    [property: JsonPropertyName("awaiting-author")]  bool AwaitingAuthor,
    [property: JsonPropertyName("authored-by-me")]   bool AuthoredByMe,
    bool Mentioned,
    [property: JsonPropertyName("recently-closed")]  bool RecentlyClosed);
```

- [ ] **Step 6: Edit `PreferencesEndpoints.cs`** — in `BuildResponse`, drop the `CiFailing: sections.CiFailing,` line from the `new InboxSectionsDto(...)` call.

- [ ] **Step 7: Sweep the existing `ci-failing` test fallout.** Removing `CiFailing` and the `ci-failing` allowlist/dedup-pair breaks ~58 references across the existing test corpus. Run `git grep -niE "ci-failing|CiFailing|ciFailing" -- tests/` and resolve each — **mechanical compile-fixes** vs **semantic rewrites/deletes**:
  - `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` — `[InlineData("inbox.sections.ci-failing")]` rows asserting *successful* patch/persist now **must assert rejection** (move them to the unknown-field path) or be deleted; `.CiFailing` reads must be removed; the `BooleanKeyTypeMismatch` ci-failing entries deleted.
  - `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` — the `ConfigWithSections`/`InboxSectionsConfig(...)` 6-arg constructions drop to 5 args; any test seeding/asserting a `"ci-failing"` **section** is deleted (the section no longer exists); the `ciFailing` helper param is removed.
  - `tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs` — tests asserting the `ci-failing > authored-by-me` demotion are **deleted** (behavior removed by Task 6).
  - `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs` — any assertion that `ci-failing` is/ isn't queried: keep only if it still holds (ci-failing never had a query); update wording.
  - `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs` + `ConfigStoreTests.cs` — drop `ciFailing`/`CiFailing` from expected wire/round-trip shapes.
  Budget for both kinds before claiming the gate; a mechanical find-replace alone will leave semantically-wrong tests.
- [ ] **Step 8: Run to verify pass** — `dotnet test tests/PRism.Core.Tests` → PASS (migration + orchestrator + dedup once Task 6 lands). If `InboxRefreshOrchestrator` referenced `CiFailing` anywhere else, the compiler points it out — remove those references.

- [ ] **Step 9: Commit** (include every test file touched by the Step 7 sweep)

```bash
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/
git commit -m "feat(#262): drop ci-failing section from config + wire DTO + patch allowlist"
```

---

### Task 6: Drop the `ci-failing > authored-by-me` dedup pair

**Files:**
- Modify: `PRism.Core/Inbox/InboxDeduplicator.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs`

- [ ] **Step 1: Write/adjust the test** — add to `InboxDeduplicatorTests.cs`:

```csharp
[Fact]
public void Does_not_reference_ci_failing_pair()
{
    var pr = new PrInboxItem(new PrReference("acme", "api", 1), "t", "a", "acme/api",
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 1, 0, 0, 0, "sha", CiStatus.Failing, null, null);
    var sections = new Dictionary<string, IReadOnlyList<PrInboxItem>>
    {
        ["authored-by-me"] = new[] { pr },
        ["ci-failing"]     = new[] { pr },   // legacy shape; must NOT be collapsed now
    };

    var result = new InboxDeduplicator().Deduplicate(sections, deduplicate: true);

    result["authored-by-me"].Should().ContainSingle();   // not demoted away by a ci-failing winner
}
```

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Core.Tests --filter InboxDeduplicatorTests` → FAIL (authored-by-me gets emptied by the pair).

- [ ] **Step 3: Remove the pair** — in `InboxDeduplicator.cs`, the `Pairs` array becomes single-entry:

```csharp
    private static readonly (string Winner, string Loser)[] Pairs =
    {
        ("review-requested", "mentioned"), // 1 wins over 4
    };
```

- [ ] **Step 4: Run to verify pass** — `dotnet test tests/PRism.Core.Tests --filter InboxDeduplicatorTests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Inbox/InboxDeduplicator.cs tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs
git commit -m "feat(#262): drop ci-failing>authored-by-me dedup pair"
```

---

### Task 7: Explicit section order + relabel at the `/api/inbox` boundary

**Files:**
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs`

- [ ] **Step 1: Write the pinning + relabel test** — add to `InboxEndpointsTests.cs` (use the file's existing WebApplicationFactory/fake-orchestrator harness; if it seeds a snapshot, seed sections in *reverse* canonical order to prove the serializer re-orders):

```csharp
[Fact]
public async Task Sections_serialize_in_canonical_order_regardless_of_snapshot_order()
{
    // Seed snapshot with sections inserted OUT of canonical order.
    var snap = SnapshotWithSections("mentioned", "review-requested", "recently-closed", "authored-by-me", "awaiting-author");
    using var app = AppWith(snap);
    var client = app.CreateClient();

    var body = await client.GetFromJsonAsync<JsonElement>("/api/inbox");

    var ids = body.GetProperty("sections").EnumerateArray().Select(s => s.GetProperty("id").GetString()).ToList();
    ids.Should().Equal("review-requested", "awaiting-author", "authored-by-me", "mentioned", "recently-closed");
}

[Fact]
public async Task Awaiting_author_label_is_needs_re_review()
{
    using var app = AppWith(SnapshotWithSections("awaiting-author"));
    var body = await app.CreateClient().GetFromJsonAsync<JsonElement>("/api/inbox");
    var label = body.GetProperty("sections").EnumerateArray().First().GetProperty("label").GetString();
    label.Should().Be("Needs re-review");
}
```

> Match the file's existing helper names (`AppWith`, snapshot seeding). If none exist, add a minimal `IInboxRefreshOrchestrator` fake exposing a settable `Current` and register it in the factory — mirror `tests/PRism.Web.Tests/TestHelpers/FakeInboxRefreshOrchestrator.cs`.

- [ ] **Step 2: Run to verify failure** — `dotnet test tests/PRism.Web.Tests --filter InboxEndpointsTests` → FAIL (order follows snapshot; label still "Awaiting author").

- [ ] **Step 3: Edit `InboxEndpoints.cs`.** Relabel + drop the `ci-failing` label, add `SectionOrder`, and order at serialization:

```csharp
    private static readonly Dictionary<string, string> Labels = new()
    {
        ["review-requested"]  = "Review requested",
        ["awaiting-author"]   = "Needs re-review",
        ["authored-by-me"]    = "Authored by me",
        ["mentioned"]         = "Mentioned",
        ["recently-closed"]   = "Recently closed",
    };

    // Canonical UI order. Serialized sections follow this regardless of snapshot
    // dictionary enumeration; unknown ids sort last (stable) and render with a
    // fallback label rather than being dropped.
    private static readonly string[] SectionOrder =
    {
        "review-requested", "awaiting-author", "authored-by-me", "mentioned", "recently-closed",
    };
```

and replace the `var sections = snap.Sections.Select(...)` projection:

```csharp
            var sections = snap.Sections
                .OrderBy(kv =>
                {
                    var i = Array.IndexOf(SectionOrder, kv.Key);
                    return i < 0 ? int.MaxValue : i;
                })
                .Select(kv => new InboxSectionDto(kv.Key, Labels.TryGetValue(kv.Key, out var lbl) ? lbl : kv.Key, kv.Value))
                .ToList();
```

(Delete the now-stale "Section ordering: relies on Dictionary insertion-order…" comment above it.)

- [ ] **Step 4: Run to verify pass** — `dotnet test tests/PRism.Web.Tests --filter InboxEndpointsTests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/InboxEndpoints.cs tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs
git commit -m "feat(#262): explicit canonical section order + relabel awaiting-author"
```

---

### Task 8: Add `CiProbeComplete` to the wire response

**Files:**
- Modify: `PRism.Web/Endpoints/InboxDtos.cs`
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs`

- [ ] **Step 1: Widen the DTO** — add the field to `InboxResponse`:

```csharp
internal sealed record InboxResponse(
    IReadOnlyList<InboxSectionDto> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool TokenScopeFooterEnabled,
    bool CiProbeComplete);
```

- [ ] **Step 2: Populate it** — in `InboxEndpoints.cs`, the `Results.Ok(new InboxResponse(...))` call gains `snap.CiProbeComplete`:

```csharp
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter, snap.CiProbeComplete));
```

- [ ] **Step 3: Build + run web tests** — `dotnet test tests/PRism.Web.Tests` → PASS.

- [ ] **Step 4: Commit**

```bash
git add PRism.Web/Endpoints/InboxDtos.cs PRism.Web/Endpoints/InboxEndpoints.cs
git commit -m "feat(#262): expose ciProbeComplete on /api/inbox response"
```

---

### Task 9: Frontend settings surface — drop `ci-failing`, relabel, add `ciProbeComplete` type

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Modify: `frontend/src/components/Settings/panes/InboxPane.tsx`
- Modify: `frontend/src/components/Inbox/InboxSection.tsx` (drop the dead `ci-failing` EmptyCopy entry)
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx`

- [ ] **Step 1: Update the InboxPane test** — assert five rows and the relabel:

```tsx
it('renders five section rows without ci-failing and with the re-review label', () => {
  renderInboxPane(); // see note below — match this file's existing render pattern
  expect(screen.getAllByRole('switch')).toHaveLength(5);
  expect(screen.queryByText('CI failing on my PRs')).toBeNull();
  expect(screen.getByText('Needs re-review')).toBeInTheDocument();
});
```

> **Render pattern:** `InboxPane.test.tsx` does not have a `renderInboxPane` helper today — it `render(<InboxPane />)` with a module-level `vi.mock('../../../hooks/usePreferences', …)` returning a fixed `preferences` object. Use whatever this file already does. **Two edits the mock needs:** drop `'ci-failing'` from the mocked `inbox.sections`, and (for Task 20) add `defaultSort: 'updated'` to the mocked `inbox`. If you want the parameterized `renderInboxPane({ set, defaultSort })` shape used in Task 20, refactor the fixed mock into a small helper now — but the assertions above are the contract, not the helper name.

- [ ] **Step 2: Run to verify failure** — `npm test -- InboxPane` → FAIL (six rows; old label).

- [ ] **Step 3: `types.ts`** — remove `'ci-failing': boolean;` from `InboxSectionsPreferences`, and add `ciProbeComplete` to `InboxResponse`:

```ts
export interface InboxSectionsPreferences {
  'review-requested': boolean;
  'awaiting-author': boolean;
  'authored-by-me': boolean;
  mentioned: boolean;
  'recently-closed': boolean;
}
```
```ts
export interface InboxResponse {
  sections: InboxSection[];
  enrichments: Record<string, InboxItemEnrichment>;
  lastRefreshedAt: string;
  tokenScopeFooterEnabled: boolean;
  ciProbeComplete: boolean;
}
```

- [ ] **Step 4: `PreferencesContext.tsx`** — remove `'ci-failing'` from the `PreferenceKey` union's `inbox.sections.${...}` template list.

- [ ] **Step 5: `InboxPane.tsx`** — drop the ci-failing row and relabel:

```tsx
const ROWS: readonly { id: InboxSectionId; label: string }[] = [
  { id: 'review-requested', label: 'Review requested' },
  { id: 'awaiting-author', label: 'Needs re-review' },
  { id: 'authored-by-me', label: 'Authored by me' },
  { id: 'mentioned', label: 'Mentioned' },
  { id: 'recently-closed', label: 'Recently closed' },
];
```

- [ ] **Step 6: `InboxSection.tsx`** — remove the `'ci-failing': 'No CI failures on your PRs — nice.',` line from `EmptyCopy`, and change the `'awaiting-author'` empty copy to `'Nothing needs re-review.'` (matches the new label).

- [ ] **Step 7: Run to verify pass + typecheck** — `npm test -- InboxPane PreferencesContext` → PASS; `npm run build` → PASS (the `ci-failing` key removal surfaces any stray references as type errors — fix them).

- [ ] **Step 8: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Inbox/InboxSection.tsx
git add frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/components/Inbox/InboxSection.tsx frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#262): drop ci-failing from settings/types, relabel awaiting-author, add ciProbeComplete type"
```

---

### Task 10: PR1 full-suite gate + B1 visual assert

- [ ] **Step 1:** `dotnet test` (full backend solution) → all green.
- [ ] **Step 2:** `npm test` (full Vitest) → green; `npm run build` → green; `node ./node_modules/prettier/bin/prettier.cjs --check .` → clean.
- [ ] **Step 3: B1 visual assert (real account).** Launch via `./run.ps1 -Reset None --no-browser` (localhost:5180, real PAT). Confirm: (a) no "CI failing on my PRs" section; (b) red CI dots now appear on failing PRs in `review-requested`/`mentioned`/`awaiting-author` rows, not just authored; (c) the second section reads "Needs re-review"; (d) Settings → Inbox shows five toggles. Capture screenshots for the PR per the visual-verification convention (review-assets branch + embedded raw URLs).
- [ ] **Step 4:** Open PR1 via pr-autopilot (base `main`). Title: `feat(#262): remove ci-failing section, widen CI probing, explicit order`. Hold for B1 sign-off before merge.

---

# PR2 — Filter / sort bar (additive, B1)

Goal: a search-led, client-side filter/sort bar over the sections. Pure functions, unit-tested in isolation, then wired into `InboxToolbar`/`InboxPage`. Depends on PR1 (CI populated inbox-wide + `ciProbeComplete`).

**New files:**
- `frontend/src/components/Inbox/filters/applyInboxFilters.ts` (+ test)
- `frontend/src/components/Inbox/filters/useInboxFilters.ts` (+ test)
- `frontend/src/components/Inbox/filters/FilterBar.tsx`
- `frontend/src/components/Inbox/filters/FilterSearchInput.tsx`
- `frontend/src/components/Inbox/filters/FilterFacet.tsx`
- `frontend/src/components/Inbox/filters/FilterSummary.tsx`
- `frontend/src/components/Inbox/filters/filters.module.css`

---

### Task 11: `applyInboxFilters` — the pure filter+sort function

**Files:**
- Create: `frontend/src/components/Inbox/filters/applyInboxFilters.ts`
- Test: `frontend/src/components/Inbox/filters/applyInboxFilters.test.ts`

- [ ] **Step 1: Define the types + write the test.** Create the test first:

```ts
import { describe, it, expect } from 'vitest';
import { applyInboxFilters, type InboxFilters, type SortKey } from './applyInboxFilters';
import type { InboxSection, PrInboxItem } from '../../../api/types';

const pr = (over: Partial<PrInboxItem>): PrInboxItem => ({
  reference: { owner: 'acme', repo: 'api', number: 1 },
  title: 'Fix token refresh',
  author: 'dana',
  repo: 'acme/api',
  updatedAt: '2026-06-01T00:00:00Z',
  pushedAt: '2026-06-01T00:00:00Z',
  iterationNumber: 1,
  commentCount: 0,
  additions: 1,
  deletions: 0,
  headSha: 'sha',
  ci: 'none',
  lastViewedHeadSha: null,
  lastSeenCommentId: null,
  mergedAt: null,
  closedAt: null,
  ...over,
});
const section = (id: string, items: PrInboxItem[]): InboxSection => ({ id, label: id, items });
const empty: InboxFilters = { text: '', ci: [], repos: [], authors: [] };
const updated: SortKey = 'updated';

describe('applyInboxFilters', () => {
  it('returns sections unchanged when no filter is active', () => {
    const secs = [section('review-requested', [pr({})])];
    const r = applyInboxFilters(secs, empty, updated);
    expect(r.filterActive).toBe(false);
    expect(r.sections).toEqual(secs);
  });

  it('free-text matches title OR repo, case-insensitive', () => {
    const secs = [section('s', [pr({ title: 'Retry budget' }), pr({ title: 'Other', repo: 'acme/bff' })])];
    expect(applyInboxFilters(secs, { ...empty, text: 'retry' }, updated).sections[0].items).toHaveLength(1);
    expect(applyInboxFilters(secs, { ...empty, text: 'BFF' }, updated).sections[0].items).toHaveLength(1);
  });

  it('CI facet keeps only matching ci values (OR within facet)', () => {
    const secs = [section('s', [pr({ ci: 'failing' }), pr({ ci: 'pending' }), pr({ ci: 'none' })])];
    expect(applyInboxFilters(secs, { ...empty, ci: ['failing'] }, updated).sections[0].items).toHaveLength(1);
    expect(applyInboxFilters(secs, { ...empty, ci: ['failing', 'pending'] }, updated).sections[0].items).toHaveLength(2);
  });

  it('facets AND across (CI:failing AND repo:bff)', () => {
    const secs = [section('s', [
      pr({ ci: 'failing', repo: 'acme/api' }),
      pr({ ci: 'failing', repo: 'acme/bff' }),
    ])];
    const r = applyInboxFilters(secs, { ...empty, ci: ['failing'], repos: ['acme/bff'] }, updated);
    expect(r.sections[0].items).toHaveLength(1);
    expect(r.sections[0].items[0].repo).toBe('acme/bff');
  });

  it('hides emptied sections when a filter is active', () => {
    const secs = [section('a', [pr({ ci: 'failing' })]), section('b', [pr({ ci: 'none' })])];
    const r = applyInboxFilters(secs, { ...empty, ci: ['failing'] }, updated);
    expect(r.sections.map((s) => s.id)).toEqual(['a']);
    expect(r.matchCount).toBe(1);
    expect(r.totalCount).toBe(2);
  });

  it('sorts within a section, tie-breaking on reference.number descending', () => {
    const secs = [section('s', [
      pr({ reference: { owner: 'acme', repo: 'api', number: 1 }, updatedAt: '2026-06-01T00:00:00Z' }),
      pr({ reference: { owner: 'acme', repo: 'api', number: 2 }, updatedAt: '2026-06-02T00:00:00Z' }),
    ])];
    const r = applyInboxFilters(secs, empty, 'updated');
    // newest updatedAt first
    expect(r.sections[0].items[0].reference.number).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- applyInboxFilters` → FAIL (module missing).

- [ ] **Step 3: Implement** `applyInboxFilters.ts`:

```ts
import type { CiStatus, InboxSection, PrInboxItem } from '../../../api/types';

export type SortKey = 'updated' | 'pushed' | 'diff' | 'comments';

export interface InboxFilters {
  text: string;
  ci: CiStatus[];
  repos: string[];
  authors: string[];
}

export interface FilterResult {
  sections: InboxSection[];
  filterActive: boolean;
  matchCount: number;
  totalCount: number;
}

export function isFilterActive(f: InboxFilters): boolean {
  return f.text.trim() !== '' || f.ci.length > 0 || f.repos.length > 0 || f.authors.length > 0;
}

const comparators: Record<SortKey, (a: PrInboxItem, b: PrInboxItem) => number> = {
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  pushed: (a, b) => b.pushedAt.localeCompare(a.pushedAt),
  diff: (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  comments: (a, b) => b.commentCount - a.commentCount,
};

function matches(pr: PrInboxItem, f: InboxFilters): boolean {
  const text = f.text.trim().toLowerCase();
  if (text && !pr.title.toLowerCase().includes(text) && !pr.repo.toLowerCase().includes(text)) return false;
  if (f.ci.length > 0 && !f.ci.includes(pr.ci)) return false;
  if (f.repos.length > 0 && !f.repos.includes(pr.repo)) return false;
  if (f.authors.length > 0 && !f.authors.includes(pr.author)) return false;
  return true;
}

export function applyInboxFilters(
  sections: InboxSection[],
  filters: InboxFilters,
  sort: SortKey,
): FilterResult {
  const active = isFilterActive(filters);
  const cmp = comparators[sort];
  const tiebreak = (a: PrInboxItem, b: PrInboxItem) => {
    const c = cmp(a, b);
    return c !== 0 ? c : b.reference.number - a.reference.number;
  };

  let matchCount = 0;
  let totalCount = 0;
  const out: InboxSection[] = [];
  for (const s of sections) {
    totalCount += s.items.length;
    const kept = (active ? s.items.filter((p) => matches(p, filters)) : [...s.items]).sort(tiebreak);
    matchCount += kept.length;
    if (active && kept.length === 0) continue; // hide emptied sections while filtering
    out.push({ ...s, items: kept });
  }
  return { sections: out, filterActive: active, matchCount, totalCount };
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- applyInboxFilters` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/filters/
git add frontend/src/components/Inbox/filters/applyInboxFilters.ts frontend/src/components/Inbox/filters/applyInboxFilters.test.ts
git commit -m "feat(#262): applyInboxFilters pure filter+sort over inbox sections"
```

---

### Task 12: `useInboxFilters` — state + facet-value derivation

**Files:**
- Create: `frontend/src/components/Inbox/filters/useInboxFilters.ts`
- Test: `frontend/src/components/Inbox/filters/useInboxFilters.test.ts`

- [ ] **Step 1: Write the test** (facet values from full snapshot; clear resets all):

```ts
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInboxFilters } from './useInboxFilters';
import type { InboxSection } from '../../../api/types';

const secs: InboxSection[] = [
  { id: 'a', label: 'a', items: [
    { repo: 'acme/api', author: 'dana' } as never,
    { repo: 'acme/bff', author: 'pat' } as never,
  ] },
];

describe('useInboxFilters', () => {
  it('derives repo + author values from the full snapshot', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    expect(result.current.repoValues).toEqual(['acme/api', 'acme/bff']);
    expect(result.current.authorValues).toEqual(['dana', 'pat']);
  });

  it('clear() resets every facet incl. free-text', () => {
    const { result } = renderHook(() => useInboxFilters(secs, 'updated'));
    act(() => result.current.setText('retry'));
    act(() => result.current.toggleCi('failing'));
    act(() => result.current.clear());
    expect(result.current.filters).toEqual({ text: '', ci: [], repos: [], authors: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- useInboxFilters` → FAIL.

- [ ] **Step 3: Implement** `useInboxFilters.ts`:

```ts
import { useCallback, useMemo, useState } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import { applyInboxFilters, isFilterActive, type InboxFilters, type SortKey } from './applyInboxFilters';

const EMPTY: InboxFilters = { text: '', ci: [], repos: [], authors: [] };

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function useInboxFilters(sections: InboxSection[], initialSort: SortKey) {
  const [filters, setFilters] = useState<InboxFilters>(EMPTY);
  const [sort, setSort] = useState<SortKey>(initialSort);

  // Facet value lists derive from the FULL snapshot (no cascading) — spec decision.
  const repoValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.repo))),
    [sections],
  );
  const authorValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.author))),
    [sections],
  );

  const result = useMemo(() => applyInboxFilters(sections, filters, sort), [sections, filters, sort]);

  const setText = useCallback((text: string) => setFilters((f) => ({ ...f, text })), []);
  const toggleCi = useCallback(
    (v: CiStatus) => setFilters((f) => ({ ...f, ci: toggle(f.ci, v) })),
    [],
  );
  const toggleRepo = useCallback(
    (v: string) => setFilters((f) => ({ ...f, repos: toggle(f.repos, v) })),
    [],
  );
  const toggleAuthor = useCallback(
    (v: string) => setFilters((f) => ({ ...f, authors: toggle(f.authors, v) })),
    [],
  );
  const clear = useCallback(() => setFilters(EMPTY), []);

  return {
    filters,
    sort,
    setSort,
    setText,
    toggleCi,
    toggleRepo,
    toggleAuthor,
    clear,
    repoValues,
    authorValues,
    result,
    active: isFilterActive(filters),
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- useInboxFilters` → PASS.

- [ ] **Step 5: Commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/filters/
git add frontend/src/components/Inbox/filters/useInboxFilters.ts frontend/src/components/Inbox/filters/useInboxFilters.test.ts
git commit -m "feat(#262): useInboxFilters state + snapshot-derived facet values"
```

---

### Task 13: Filter primitives — search input, facet popover, summary

**Files:**
- Create: `FilterSearchInput.tsx`, `FilterFacet.tsx`, `FilterSummary.tsx`, `filters.module.css`
- Test: `frontend/src/components/Inbox/filters/FilterFacet.test.tsx`

- [ ] **Step 1: Write a focused test for the facet trigger label/count** (`FilterFacet.test.tsx`):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterFacet } from './FilterFacet';

describe('FilterFacet', () => {
  it('shows the bare name when nothing is selected and a count when ≥1', () => {
    const { rerender } = render(
      <FilterFacet name="Repo" values={['acme/api', 'acme/bff']} selected={[]} onToggle={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /Repo/ })).toHaveTextContent('Repo');
    rerender(
      <FilterFacet name="Repo" values={['acme/api', 'acme/bff']} selected={['acme/api']} onToggle={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /Repo/ })).toHaveTextContent('Repo (1)');
  });

  it('toggles a value on checkbox click', () => {
    const onToggle = vi.fn();
    render(<FilterFacet name="Repo" values={['acme/api']} selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Repo/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    expect(onToggle).toHaveBeenCalledWith('acme/api');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- FilterFacet` → FAIL.

- [ ] **Step 3: Implement the primitives.** `FilterFacet.tsx` (checkbox popover; trigger shows name or `name (n)`; inline type-to-filter when the list is long; close on outside-click/Esc):

```tsx
import { useEffect, useRef, useState } from 'react';
import styles from './filters.module.css';

interface Props {
  name: string;
  values: string[];
  selected: string[];
  onToggle(value: string): void;
  /** When set, overrides the trigger text (used by the CI facet's failing count). */
  triggerLabel?: string;
}

export function FilterFacet({ name, values, selected, onToggle, triggerLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = triggerLabel ?? (selected.length > 0 ? `${name} (${selected.length})` : name);
  const showSearch = values.length > 8;
  const shown = showSearch ? values.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : values;

  return (
    <div className={styles.facet} ref={ref}>
      <button
        type="button"
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.popover} role="group" aria-label={`${name} filter`}>
          {showSearch && (
            <input
              className={styles.popoverSearch}
              placeholder={`Filter ${name.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          {shown.map((v) => (
            <label key={v} className={styles.option}>
              <input
                type="checkbox"
                checked={selected.includes(v)}
                onChange={() => onToggle(v)}
              />
              <span>{v}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

`FilterSearchInput.tsx` (free-text, inline clear, Esc clears; debounce handled by the caller passing a debounced setter or local state — keep it controlled):

```tsx
import styles from './filters.module.css';

interface Props {
  value: string;
  onChange(value: string): void;
}

export function FilterSearchInput({ value, onChange }: Props) {
  return (
    <div className={styles.search}>
      <span className={styles.searchIcon} aria-hidden="true">
        🔍
      </span>
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Filter PRs by title or repo…"
        aria-label="Filter PRs by title or repo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
      />
      {value && (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          ✕
        </button>
      )}
    </div>
  );
}
```

`FilterSummary.tsx` (hidden when no filter active; height reserved by the caller's container; "CI status may be incomplete" hint slot):

```tsx
import styles from './filters.module.css';

interface Props {
  active: boolean;
  filterCount: number;
  matchCount: number;
  totalCount: number;
  ciIncomplete: boolean;
  onClear(): void;
}

export function FilterSummary({ active, filterCount, matchCount, totalCount, ciIncomplete, onClear }: Props) {
  if (!active) return <div className={styles.summary} aria-hidden="true" />; // reserve height
  return (
    <div className={styles.summary} role="status">
      {filterCount} {filterCount === 1 ? 'filter' : 'filters'} · showing {matchCount} of {totalCount} PRs
      {ciIncomplete && <span className={styles.ciHint}> · CI status may be incomplete</span>}{' '}
      <button type="button" className={styles.clear} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
```

`filters.module.css` — add layout classes (`facet`, `trigger`, `triggerActive`, `popover`, `popoverSearch`, `option`, `search`, `searchIcon`, `searchInput`, `searchClear`, `summary`, `ciHint`, `clear`, `bar`). Mirror the token surface used by `InboxToolbar.module.css` / Settings controls (deferred-to-plan token decision: use the existing `--surface-*`, `--border`, `--accent` custom properties already in those modules). Keep it minimal; B1 polish lands in the visual assert.

- [ ] **Step 4: Run to verify pass** — `npm test -- FilterFacet` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/filters/
git add frontend/src/components/Inbox/filters/
git commit -m "feat(#262): filter primitives (search, facet popover, summary)"
```

---

### Task 14: `FilterBar` — assemble primitives + CI failing-count trigger

**Files:**
- Create: `frontend/src/components/Inbox/filters/FilterBar.tsx`
- Test: `frontend/src/components/Inbox/filters/FilterBar.test.tsx`

- [ ] **Step 1: Write the test** (CI trigger shows failing count even when unselected; incomplete hint appears):

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilterBar } from './FilterBar';
import type { InboxSection } from '../../../api/types';

const secs: InboxSection[] = [
  { id: 's', label: 's', items: [
    { repo: 'acme/api', author: 'dana', ci: 'failing', title: 't' } as never,
    { repo: 'acme/api', author: 'dana', ci: 'none', title: 't' } as never,
  ] },
];

it('CI trigger shows the failing count when unselected', () => {
  render(<FilterBar sections={secs} initialSort="updated" ciProbeComplete onState={() => {}} />);
  expect(screen.getByRole('button', { name: /CI/ })).toHaveTextContent('CI · 1');
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- FilterBar` → FAIL.

- [ ] **Step 3: Implement** `FilterBar.tsx`. It owns the `useInboxFilters` hook, renders the controls, and reports `{ result, clear }` up via `onState` so `InboxPage` renders the filtered sections and shares the same `clear`:

```tsx
import { useEffect } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import { useInboxFilters } from './useInboxFilters';
import type { FilterResult, SortKey } from './applyInboxFilters';
import { FilterSearchInput } from './FilterSearchInput';
import { FilterFacet } from './FilterFacet';
import { FilterSummary } from './FilterSummary';
import styles from './filters.module.css';

const CI_VALUES: CiStatus[] = ['failing', 'pending'];
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Updated' },
  { key: 'pushed', label: 'Recently pushed' },
  { key: 'diff', label: 'Diff size' },
  { key: 'comments', label: 'Comments' },
];

// FilterBar owns the hook and reports BOTH the filtered result and the `clear`
// handler up, so InboxPage's zero-match state shares the exact same `clear` as
// the in-bar summary — no need to lift the hook into the page.
export interface FilterBarState {
  result: FilterResult;
  clear: () => void;
}

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
}

export function FilterBar({ sections, initialSort, ciProbeComplete, onState }: Props) {
  const f = useInboxFilters(sections, initialSort);
  useEffect(() => onState({ result: f.result, clear: f.clear }), [f.result, f.clear, onState]);

  const failingCount = sections.reduce(
    (n, s) => n + s.items.filter((p) => p.ci === 'failing').length,
    0,
  );
  const ciTrigger = f.filters.ci.length > 0 ? `CI (${f.filters.ci.length})` : `CI · ${failingCount}`;
  const filterCount =
    (f.filters.text.trim() ? 1 : 0) +
    f.filters.ci.length +
    f.filters.repos.length +
    f.filters.authors.length;

  return (
    <div className={styles.bar}>
      <div className={styles.barRow}>
        <FilterSearchInput value={f.filters.text} onChange={f.setText} />
      </div>
      <div className={styles.barRow}>
        <FilterFacet
          name="CI"
          values={CI_VALUES}
          selected={f.filters.ci}
          onToggle={(v) => f.toggleCi(v as CiStatus)}
          triggerLabel={ciTrigger}
        />
        <FilterFacet name="Repo" values={f.repoValues} selected={f.filters.repos} onToggle={f.toggleRepo} />
        <FilterFacet name="Author" values={f.authorValues} selected={f.filters.authors} onToggle={f.toggleAuthor} />
        <span className={styles.spring} />
        <label className={styles.sort}>
          Sort:{' '}
          <select value={f.sort} onChange={(e) => f.setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FilterSummary
        active={f.active}
        filterCount={filterCount}
        matchCount={f.result.matchCount}
        totalCount={f.result.totalCount}
        ciIncomplete={!ciProbeComplete}
        onClear={f.clear}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -- FilterBar` → PASS.

- [ ] **Step 5: Commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/filters/
git add frontend/src/components/Inbox/filters/FilterBar.tsx frontend/src/components/Inbox/filters/FilterBar.test.tsx
git commit -m "feat(#262): FilterBar with CI failing-count trigger + incomplete hint"
```

---

### Task 15: Wire FilterBar into InboxToolbar + InboxPage

**Files:**
- Modify: `frontend/src/components/Inbox/InboxToolbar.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx`
- Modify: `frontend/src/components/Inbox/InboxSection.tsx` (expand-on-reveal)
- Test: `frontend/src/pages/InboxPage.test.tsx` (or the inbox-page test file; add if absent)

- [ ] **Step 1: Write the integration test** — filter narrows live; zero-match shows the distinct state, not `EmptyAllSections`:

```tsx
it('filtering to nothing shows the no-match zero-state, not EmptyAllSections', async () => {
  renderInboxPage({ /* seed two PRs, none failing */ });
  await screen.findByTestId('inbox-page');
  fireEvent.click(screen.getByRole('button', { name: /CI/ }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'failing' }));
  expect(screen.getByText(/No PRs match your filters/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing in your inbox/)).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- InboxPage` → FAIL.

- [ ] **Step 3: `InboxToolbar.tsx`** — accept and render the bar above the paste box (both retained):

```tsx
import { PasteUrlInput } from './PasteUrlInput';
import { FilterBar, type FilterBarState } from './filters/FilterBar';
import type { InboxSection } from '../../api/types';
import type { SortKey } from './filters/applyInboxFilters';
import styles from './InboxToolbar.module.css';

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
}

export function InboxToolbar({ sections, initialSort, ciProbeComplete, onState }: Props) {
  return (
    <div className={styles.toolbar}>
      <PasteUrlInput />
      <FilterBar
        sections={sections}
        initialSort={initialSort}
        ciProbeComplete={ciProbeComplete}
        onState={onState}
      />
    </div>
  );
}
```

- [ ] **Step 4: `InboxPage.tsx`** — hold the `FilterResult`, render filtered sections, gate `EmptyAllSections` on `!filterActive`, render the zero-match state:

```tsx
// add imports
import { useState } from 'react';
import { NoFilterMatches } from '../components/Inbox/filters/NoFilterMatches';
import type { FilterBarState } from '../components/Inbox/filters/FilterBar';
// …inside InboxPage, after `const sections = data?.sections ?? [];`
const [filterState, setFilterState] = useState<FilterBarState | null>(null);
const result = filterState?.result ?? null;
const filterActive = result?.filterActive ?? false;
const visibleSections = result ? result.sections : sections;
const zeroMatch = filterActive && result!.matchCount === 0;
```

Replace the toolbar + sections render region:

```tsx
        {/* initialSort is the literal 'updated' in PR2; Task 20 (PR3) replaces it
            with the persisted preference. Until PR3 ships, the bar always opens on
            'updated' — intended interim state, not a bug. */}
        <InboxToolbar
          sections={sections}
          initialSort="updated"
          ciProbeComplete={data.ciProbeComplete}
          onState={setFilterState}
        />
        <div className={styles.grid}>
          <div className={styles.sections}>
            {!filterActive && allEmpty && <EmptyAllSections />}
            {zeroMatch && <NoFilterMatches onClear={() => filterState?.clear()} />}
            {!zeroMatch &&
              visibleSections.map((s) => (
                <InboxSection
                  key={s.id}
                  section={s}
                  enrichments={data.enrichments}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                  defaultOpen={s.id !== 'recently-closed'}
                  forceOpen={filterActive && s.id !== 'recently-closed'}
                />
              ))}
            {data.tokenScopeFooterEnabled && <InboxFooter />}
          </div>
          {showActivityRail && <ActivityRail />}
        </div>
```

> **Shared `clear` — no hook lift.** The canonical `clear` lives in `FilterBar`'s hook. Rather than lift the hook into the page (which would make `FilterBar` presentational and ripple through `InboxToolbar`), `FilterBar` reports `{ result, clear }` up via `onState` (Task 14). `InboxPage` holds that `FilterBarState` and passes `filterState.clear` to the zero-state, so the in-bar summary's Clear and the zero-state's Clear are the same function. `FilterBar` keeps owning the hook; Task 14's component and test stand as written.

Create `NoFilterMatches.tsx`:

```tsx
import styles from './filters.module.css';

export function NoFilterMatches({ onClear }: { onClear(): void }) {
  return (
    <div className={styles.noMatch} role="status">
      No PRs match your filters ·{' '}
      <button type="button" className={styles.clear} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
```

- [ ] **Step 5: `InboxSection.tsx`** — add a `forceOpen` prop so a filter-revealed section renders expanded; a manual collapse during the session still wins:

```tsx
interface Props {
  // …existing…
  forceOpen?: boolean;
}
// inside component:
const [userToggled, setUserToggled] = useState(false);
const open = userToggled ? userOpen : (forceOpen ?? defaultOpen);
// where userOpen is the existing useState; rename the existing `open`/`setOpen`:
const [userOpen, setUserOpen] = useState(defaultOpen);
const onToggle = () => { setUserToggled(true); setUserOpen((o) => !o); };
```

Update the header button `onClick={onToggle}` and `aria-expanded={open}`, and the body guard `{open && (...)}`. (When a filter clears, `InboxPage` re-mounts sections by key only if needed; the simplest faithful behavior — reset to pre-filter state on clear — is achieved because `forceOpen` goes false and `userToggled` persists only within the session. If the visual assert shows a stale-collapse edge, reset `userToggled` on `forceOpen` going false via an effect.)

- [ ] **Step 6: Run to verify pass + typecheck** — `npm test -- InboxPage FilterBar` → PASS; `npm run build` → PASS.

- [ ] **Step 7: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/ frontend/src/pages/InboxPage.tsx
git add frontend/src/components/Inbox/ frontend/src/pages/InboxPage.tsx
git commit -m "feat(#262): wire filter bar into inbox; gate empty-states; expand-on-reveal"
```

---

### Task 16: Per-row CI dot — pending state + tooltip/aria in newly-dotted sections

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Write the test** — pending dot renders with an accessible label; failing keeps its title:

```tsx
it('renders an accessible pending CI dot', () => {
  renderRow(pr({ ci: 'pending' }));
  expect(screen.getByLabelText('CI: pending')).toBeInTheDocument();
});
it('renders an accessible failing CI dot', () => {
  renderRow(pr({ ci: 'failing' }));
  expect(screen.getByLabelText('CI: failing')).toBeInTheDocument();
});
```

> `InboxRow.test.tsx` has no `renderRow`/`pr` helpers — it uses a fixed `PR` const and an inline `render(<MemoryRouter><OpenTabsProvider>…</…></MemoryRouter>)` (InboxRow calls `useNavigate`/`useOpenTabs`). Reuse that existing wrapper; just vary `ci`. The `getByLabelText` assertions are the contract.

- [ ] **Step 2: Run to verify failure** — `npm test -- InboxRow` → FAIL.

- [ ] **Step 3: Implement** — replace the `<span className={styles.status}>…</span>` block:

```tsx
      <span className={styles.status}>
        {!isDone && pr.ci === 'failing' ? (
          <span className={`${styles.dot} ${styles.dotDanger}`} role="img" aria-label="CI: failing" title="CI failing" />
        ) : !isDone && pr.ci === 'pending' ? (
          <span className={`${styles.dot} ${styles.dotPending}`} role="img" aria-label="CI: pending" title="CI pending" />
        ) : (
          <span className={styles.dot} style={{ opacity: 0 }} aria-hidden="true" />
        )}
      </span>
```

Add a `.dotPending` rule to `InboxRow.module.css` using the existing pending/amber token (mirror `.dotDanger`).

- [ ] **Step 4: Run to verify pass** — `npm test -- InboxRow` → PASS.

- [ ] **Step 5: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#262): accessible pending+failing CI dots in inbox rows"
```

---

### Task 17: e2e + PR2 gate

**Files:**
- Create/extend: `frontend/e2e/inbox-filter.spec.ts`

- [ ] **Step 1:** Find how the existing inbox e2e specs seed data first — `git grep -l "inbox" frontend/e2e/` and read the closest spec + its fixture/route-mock setup (the suite already exercises the inbox; reuse that exact seeding approach, whether it's a fixture file under `frontend/e2e/fixtures/` or a mocked `/api/inbox` response). Then write a Playwright spec covering: filter bar narrows live; CI facet filters failing across sections; emptied sections hide and re-reveal expanded; all-match-nothing shows the zero-state; sort reorders within a section; `PasteUrlInput` still present; runs in light + dark. Follow the existing `frontend/e2e/*.spec.ts` patterns (globalSetup, seeded data). Seed at least one `ci: 'failing'` and one `ci: 'pending'` PR in a non-authored section so the CI facet has cross-section data.
- [ ] **Step 2:** Run the suite locally (`npm run e2e` or the project's Playwright command) → green; regenerate any drifted parity baseline from the CI artifact if the header/toolbar height shifted (per the regen-baseline convention).
- [ ] **Step 3:** Full gate: `npm test` green, `npm run build` green, prettier clean, `dotnet test` green (no backend change in PR2, but run once).
- [ ] **Step 4: B1 visual assert** (real account, `./run.ps1 -Reset None --no-browser`): confirm the bar, facet popovers, CI failing-count trigger, incomplete hint (force by using a fine-grained PAT or a repo with restricted Checks), zero-state, expand-on-reveal, sort. Capture screenshots for the PR.
- [ ] **Step 5:** Open PR2 via pr-autopilot (base `main`, after PR1 merges). Hold for B1 sign-off.

---

# PR3 — `inbox.defaultSort` preference

Goal: persist the sort default. First scalar inbox preference — full plumbing through config, allowlist (with value validation), DTO, `PreferencesContext`, and a Settings select. PR2's bar defaults to `'updated'`; this makes it configurable.

---

### Task 18: Backend — `DefaultSort` config + validated patch + DTO

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs`, `PRism.Core/Config/ConfigStore.cs`
- Modify: `PRism.Web/Endpoints/PreferencesDtos.cs`, `PRism.Web/Endpoints/PreferencesEndpoints.cs`
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the validation tests:**

```csharp
[Fact]
public async Task Patch_sets_valid_default_sort()
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);
    await store.PatchAsync(new Dictionary<string, object?> { ["inbox.defaultSort"] = "pushed" }, CancellationToken.None);
    store.Current.Inbox.DefaultSort.Should().Be("pushed");
}

[Fact]
public async Task Patch_rejects_unknown_default_sort_value()
{
    var store = new ConfigStore(Directory.CreateTempSubdirectory().FullName);
    await store.InitAsync(CancellationToken.None);
    var act = async () => await store.PatchAsync(
        new Dictionary<string, object?> { ["inbox.defaultSort"] = "bogus" }, CancellationToken.None);
    await act.Should().ThrowAsync<ConfigPatchException>().WithMessage("*inbox.defaultSort*");
}
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: `AppConfig.cs`** — add `DefaultSort` to `InboxConfig` (defaulted so positional `AppConfig.Default` stays valid; place it after the existing trailing defaulted param):

```csharp
public sealed record InboxConfig(
    bool Deduplicate,
    InboxSectionsConfig Sections,
    bool ShowHiddenScopeFooter,
    int RecentlyClosedWindowDays = 14,
    string DefaultSort = "updated");
```

(`AppConfig.Default` needs no change — `DefaultSort` defaults to `"updated"`.)

- [ ] **Step 4: `ConfigStore.cs`** — add to `_allowedFields`:

```csharp
            ["inbox.defaultSort"] = ConfigFieldType.String,
```

add a value-set check **before** `_gate.WaitAsync` (mirroring the existing per-key type-validation block — reject bad input without taking the gate), and a plain assignment arm in the switch. After the `switch (expectedType)` type-validation block, add:

```csharp
        if (key == "inbox.defaultSort" && !_allowedSorts.Contains((string)value!))
            throw new ConfigPatchException(
                $"field 'inbox.defaultSort' expects one of updated|pushed|diff|comments (got '{(string)value!}')");
```

the switch arm (after `_gate.WaitAsync`) just assigns:

```csharp
                "inbox.defaultSort" =>
                    _current with { Inbox = _current.Inbox with { DefaultSort = (string)value! } },
```

and the allowed-set near `_allowedFields`:

```csharp
    private static readonly HashSet<string> _allowedSorts =
        new(StringComparer.Ordinal) { "updated", "pushed", "diff", "comments" };
```

(The pre-gate `switch (expectedType)` already guarantees `value is string` for `inbox.defaultSort`, so the cast is safe.)

- [ ] **Step 5: `PreferencesDtos.cs`** — add `DefaultSort` to `InboxPreferencesDto`:

```csharp
internal sealed record InboxPreferencesDto(InboxSectionsDto Sections, string DefaultSort);
```

- [ ] **Step 6: `PreferencesEndpoints.cs`** — `BuildResponse` passes it:

```csharp
            Inbox: new InboxPreferencesDto(new InboxSectionsDto(/* …existing… */), config.Current.Inbox.DefaultSort),
```

- [ ] **Step 7: Run to verify pass** — `dotnet test tests/PRism.Core.Tests tests/PRism.Web.Tests` → PASS.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs PRism.Core/Config/ConfigStore.cs PRism.Web/Endpoints/PreferencesDtos.cs PRism.Web/Endpoints/PreferencesEndpoints.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#262): inbox.defaultSort backend config + validated patch + DTO"
```

---

### Task 19: Frontend — `inbox.defaultSort` read/write branch + types

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/contexts/PreferencesContext.tsx`
- Test: `frontend/__tests__/PreferencesContext.test.tsx`

- [ ] **Step 1: Write the routing test** — `inbox.defaultSort` round-trips through the scalar branch, NOT `sections['defaultSort']`:

```tsx
it('routes inbox.defaultSort to the scalar branch, not sections', () => {
  const prefs = makePrefs({ inbox: { sections: makeSections(), defaultSort: 'updated' } });
  expect(readKey(prefs, 'inbox.defaultSort')).toBe('updated');
  const next = writeKey(prefs, 'inbox.defaultSort', 'pushed');
  expect(next.inbox.defaultSort).toBe('pushed');
  expect((next.inbox.sections as Record<string, unknown>).defaultSort).toBeUndefined();
});
```

> `readKey`/`writeKey` are module-private today. Export them for test (or test via `set`/the provider). Simplest: add `export` to both in `PreferencesContext.tsx` — they're already a documented seam-ish surface.

- [ ] **Step 2: Run to verify failure** — `npm test -- PreferencesContext` → FAIL.

- [ ] **Step 3: `types.ts`** — add to `InboxPreferences` and the `Density`-style sort type:

```ts
export type InboxSortKey = 'updated' | 'pushed' | 'diff' | 'comments';

export interface InboxPreferences {
  sections: InboxSectionsPreferences;
  defaultSort: InboxSortKey;
}
```

- [ ] **Step 4: `PreferencesContext.tsx`** — extend the `PreferenceKey` union and add an explicit branch BEFORE the `inbox.sections.*` slice in both `readKey` and `writeKey`:

```ts
export type PreferenceKey =
  | 'theme'
  | 'accent'
  | 'aiPreview'
  | 'density'
  | 'inbox.defaultSort'
  | `inbox.sections.${
      | 'review-requested'
      | 'awaiting-author'
      | 'authored-by-me'
      | 'mentioned'
      | 'recently-closed'}`;
```
```ts
// readKey — add before the inbox.sections slice:
  if (key === 'inbox.defaultSort') return prefs.inbox.defaultSort;
```
```ts
// writeKey — add before the inbox.sections slice:
  if (key === 'inbox.defaultSort')
    return {
      ...prefs,
      inbox: { ...prefs.inbox, defaultSort: value as PreferencesResponse['inbox']['defaultSort'] },
    };
```

Also update `InboxSectionKey = Exclude<PreferenceKey, 'theme' | 'accent' | 'aiPreview' | 'density' | 'inbox.defaultSort'>` so the slice helper's type stays correct.

- [ ] **Step 5: Run to verify pass + build** — `npm test -- PreferencesContext` → PASS; `npm run build` → PASS.

- [ ] **Step 6: Commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx
git add frontend/src/api/types.ts frontend/src/contexts/PreferencesContext.tsx frontend/__tests__/PreferencesContext.test.tsx
git commit -m "feat(#262): inbox.defaultSort frontend type + preference routing branch"
```

---

### Task 20: Settings select + apply default to the bar

**Files:**
- Modify: `frontend/src/components/Settings/panes/InboxPane.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx` (use the persisted default as the bar's initial sort)
- Test: `frontend/src/components/Settings/panes/InboxPane.test.tsx`

- [ ] **Step 1: Write the test** — a sort select renders after the five rows and persists:

```tsx
it('renders a default-sort select and persists a change', async () => {
  const set = vi.fn().mockResolvedValue(undefined);
  renderInboxPane({ set, defaultSort: 'updated' });
  const select = screen.getByLabelText('Default sort');
  fireEvent.change(select, { target: { value: 'pushed' } });
  expect(set).toHaveBeenCalledWith('inbox.defaultSort', 'pushed');
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- InboxPane` → FAIL.

- [ ] **Step 3: `InboxPane.tsx`** — after the `ROWS.map(...)` block, add the select:

```tsx
      <div className={pane.row}>
        <label className={pane.label} htmlFor="inbox-default-sort">
          Default sort
        </label>
        <div className={pane.spring}>
          <select
            id="inbox-default-sort"
            value={preferences.inbox.defaultSort}
            onChange={(e) =>
              set('inbox.defaultSort' as PreferenceKey, e.target.value).catch(() => {})
            }
          >
            <option value="updated">Updated</option>
            <option value="pushed">Recently pushed</option>
            <option value="diff">Diff size</option>
            <option value="comments">Comments</option>
          </select>
        </div>
      </div>
```

- [ ] **Step 4: `InboxPage.tsx`** — read the persisted default for the bar. Pull `usePreferences()` (already available app-wide) and pass `initialSort`:

```tsx
import { usePreferences } from '../hooks/usePreferences';
// …inside InboxPage:
const { preferences } = usePreferences();
const initialSort = preferences?.inbox.defaultSort ?? 'updated';
// pass initialSort to <InboxToolbar initialSort={initialSort} … />
```

- [ ] **Step 5: Run to verify pass + build** — `npm test -- InboxPane` → PASS; `npm run build` → PASS.

- [ ] **Step 6: Prettier + commit**

```bash
node ./node_modules/prettier/bin/prettier.cjs --write frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/pages/InboxPage.tsx
git add frontend/src/components/Settings/panes/InboxPane.tsx frontend/src/pages/InboxPage.tsx frontend/src/components/Settings/panes/InboxPane.test.tsx
git commit -m "feat(#262): default-sort Settings select applied to the inbox bar"
```

---

### Task 21: PR3 gate

- [ ] **Step 1:** `dotnet test` green; `npm test` green; `npm run build` green; prettier clean.
- [ ] **Step 2:** Manual: Settings → Inbox → change Default sort → reload → the inbox bar opens with that sort; persisted across restart (config.json).
- [ ] **Step 3:** Open PR3 via pr-autopilot (base `main`, after PR2). B1 is light here (a Settings select), but include a screenshot.

---

## Self-review checklist (run before opening PR1)

- **Spec coverage:** ci-failing→filter (T3–T9), CI fault-isolation + ciProbeComplete (T1–T3, T8, T14–T15), relabel (T7, T9), explicit order (T7), filter bar + facets + search + sort (T11–T15), empty/zero states + expand-on-reveal (T15), per-row dot + tooltip (T16), defaultSort (T18–T20), config migration (T5), dedup pair drop (T6). ✔
- **Type consistency:** `CiDetectResult` (T1) consumed in T3; `SortKey`/`InboxFilters` (T11) used by T12/T14; `ciProbeComplete` flows snapshot(T2)→response(T8)→type(T9)→FilterBar(T14). ✔
- **No placeholders:** every code step shows real code; where a test helper name is uncertain, the step says "match the file's existing helper" and names the asserted behavior. ✔
- **FilterBar architecture (resolved):** `FilterBar` owns the hook and reports `{ result, clear }` up via `onState` (T14); `InboxPage` shares that `clear` with the zero-state (T15). No hook lift, no `InboxToolbar` prop churn — Task 14's component/test are final.
- **Test-corpus fallout (resolved):** T5 Step 7 enumerates the ~58 `ci-failing` references across 8 test files with delete-vs-rewrite guidance; the green-gates assume that sweep is done.
