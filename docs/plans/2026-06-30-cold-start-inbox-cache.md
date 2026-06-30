# Cold-start inbox + activity-rail cache — Implementation Plan (#619)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the last-known-good inbox snapshot and activity feed to disk, rehydrate them on launch before the first live GitHub fetch (stale-while-revalidate), so neither surface ever paints empty when a cache for the current identity exists.

**Architecture:** One generic on-disk cache helper (`IdentityKeyedFileCache<T>`, envelope = version + owner login/host + payload, atomic write, validate-or-miss read) backs two thin integrations: the inbox orchestrator (write on change/enrichment, rehydrate via a new `IHostedService`) and the activity provider (write-through, rehydrate-with-expired-TTL). Identity safety = imperative awaited eviction at the three auth token-change sites + a fail-closed config-identity backstop at rehydrate. The frontend gains a backend `stale` flag driving a refreshing bar, an "Updated <age>" pill (>30 min), and a non-blocking GitHub-unreachable snackbar modeled on `StreamHealthSnackbar`.

**Tech Stack:** .NET 10 (PRism.Core / PRism.Web, minimal-API, System.Text.Json with `JsonSerializerOptionsFactory.Storage`), React 18 + Vite + TypeScript (frontend), xUnit + FluentAssertions (backend tests), vitest + @testing-library + Playwright (frontend tests).

**Spec:** [`docs/specs/2026-06-30-cold-start-inbox-cache-design.md`](../specs/2026-06-30-cold-start-inbox-cache-design.md) (2× `ce-doc-review` applied; approved at the B1 spec gate).

## Global Constraints

- **Storage serialization:** all on-disk JSON uses `JsonSerializerOptionsFactory.Storage` (kebab-case property names, **no** dictionary-key policy, kebab `JsonStringEnumConverter`) — copied verbatim from the existing stores. Never `JsonSerializerOptionsFactory.Api` for cache files.
- **Atomic write idiom (verbatim from `AppStateStore`/`ConfigStore`):** `var temp = $"{_path}.tmp-{Guid.NewGuid():N}";` → `File.WriteAllTextAsync(temp, json, ct)` → `AtomicFileMove.MoveAsync(temp, _path, ct)`. Reads use `new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read)`.
- **Caches are disposable, never migrated.** Any read failure (missing / parse error / version mismatch / identity mismatch / structurally-invalid) → return miss → today's cold start. No quarantine-and-resave.
- **Exactly one new wire field per response:** `stale: bool` on `InboxResponse` and `ActivityResponse`. `lastRefreshedAt` (inbox) and `generatedAt` (activity) are **already** on the wire — do not re-add them.
- **Eviction at token change is awaited**, placed alongside the existing `activityProvider.Reset()` at `/api/auth/connect`, `/api/auth/connect/commit`, `/api/auth/replace` — NOT via an `IdentityChanged` subscription.
- **`STALE_LABEL_THRESHOLD = 30 min`** (owner-chosen, tunable) gates the "Updated <age>" pill.
- **Never add disk I/O under `InboxRefreshOrchestrator._writerLock`** (it already spans network I/O — the #663/#678 contention lever). Cache writes are scheduled outside the lock.
- **Build/test discipline:** run `dotnet.exe`/`git` real binaries (not rtk); one long-running build/test at a time, foreground, timeout ≥ 300000 ms. Frontend: run vitest via the local binary, never `npx vitest`. `prettier --write` new FE files (CI gates `npm run lint`).
- **Commit messages** end with the `Co-Authored-By:` + `Claude-Session:` trailer lines.

## Plan-vs-spec refinements (documented deviations)

Two small refinements the spec's prose did not spell out; both are mechanical, surfaced at the gate:

1. **`IIdentityKeyedFileCache<T>` interface seam.** The spec §3.1 shows a sealed concrete helper. To inject a recording double in the orchestrator / activity / rehydrator tests (spec tests 12, 13, 15, 16, 17) the consumers depend on an **interface** `IIdentityKeyedFileCache<T>`; the concrete sealed `IdentityKeyedFileCache<T>` implements it and is tested directly (tests 1–8). This preserves the "one shared helper" intent and is standard testability, not a scope change.
2. **One additive interface getter on `IInboxRefreshOrchestrator`, with a default implementation.** The spec §2 non-goal "no interface changes" was about not *restructuring* the interface. The `/api/inbox` GET endpoint consumes `IInboxRefreshOrchestrator` and must read the `stale` flag; the cleanest implementation adds one read-only `bool IsServingRehydratedSnapshot` getter (sibling to the existing `Current`) rather than coupling the endpoint to the concrete type. It ships as a **default interface member** (`=> false`) so existing test fakes that don't override it keep compiling — zero CS0535 blast radius (round-1 SCOPE-1). The concrete orchestrator overrides it with the real flag. `TryRehydrate` stays concrete-only (called only by the rehydrator, which already resolves the concrete type via dual-registration).

3. **Hosted-service ordering: rehydrator runs FIRST, before `ViewerLoginHydrator` (refines spec §4).** The spec §4 placed the rehydrator after `ViewerLoginHydrator`. Round-1 review (ADV-1, cross-confirmed by feasibility) showed that `ViewerLoginHydrator.StartAsync` performs a **blocking network** `ValidateCredentialsAsync`, and with .NET's default sequential hosted-service startup that would gate the offline instant-paint — the feature's headline guarantee — behind that network timeout. The rehydrator depends only on on-disk config (loaded by `ConfigStore` at construction), so it can and must run first. **This is a deliberate deviation from the approved spec's stated ordering**, surfaced at the gate; the spec's §4 ordering note should be updated to match (or the deviation accepted in the PR's Proof section).

---

## File structure

**Backend (new):**
- `PRism.Core/Storage/IdentityKeyedFileCache.cs` — `IIdentityKeyedFileCache<T>`, `IdentityKeyedFileCache<T>`, `CacheIdentity`.
- `PRism.Core/Inbox/InboxCacheRehydrator.cs` — `IHostedService` that loads + rehydrates on startup.

**Backend (modified):**
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — `TryRehydrate`, rehydrate flag + getter, force-notify consume, capture-identity coalesced writer, ctor cache dep.
- `PRism.Core/Inbox/IInboxRefreshOrchestrator.cs` — add `IsServingRehydratedSnapshot`.
- `PRism.Core/Activity/ActivityProvider.cs` — ctor deps (`IIdentityKeyedFileCache<ActivityResponse>`, `IViewerLoginProvider`), write-through, rehydrate, evict-on-Reset.
- `PRism.Core/Activity/ActivityContracts.cs` — `ActivityResponse.Stale`.
- `PRism.Core/ServiceCollectionExtensions.cs` — two cache singletons; dual-register orchestrator; insert rehydrator hosted service.
- `PRism.Web/Endpoints/InboxDtos.cs` + `PRism.Web/Endpoints/InboxEndpoints.cs` — `stale` on `InboxResponse` + mapping.
- `PRism.Web/Endpoints/AuthEndpoints.cs` — awaited evictions + persist-config-login-on-connect.

**Frontend (modified):**
- `frontend/src/api/types.ts` — `stale` on `InboxResponse` + `ActivityResponse`.
- `frontend/src/pages/InboxPage.tsx`, `hooks/useInbox.ts`, `hooks/useInboxUpdates.ts` — refreshing affordance, snackbar wiring.
- `frontend/src/components/Inbox/StalePill/*` (new) — the "Updated <age>" pill.
- `frontend/src/components/GitHubUnreachableSnackbar/*` (new) — the fetch-failure snackbar.
- `frontend/src/hooks/useActivity.ts`, `components/ActivityRail/ActivityRail.tsx` — stale refetch + header swap.

**On disk (data dir):** `inbox-snapshot.json`, `activity-feed.json`.

---

## Test harness contract (canonical — round-2 COH-2/3)

`tests/PRism.Core.Tests/Inbox/InboxOrchestratorTestHarness.cs` is the **single** source of truth for inbox-orchestrator test construction. It is created in **Task 2 Step 1** (provisionally, against the pre-cache ctor) and reaches its **final** form in **Task 3 Step 3** (the `cache`/`loginProvider` params land when the ctor gains its cache dependency). Every task below calls these exact signatures — do not invent per-task variants. The bodies wrap the existing fakes from `InboxRefreshOrchestratorTests.cs` (`FakeSectionQueryRunner`, `FakePrBatchReader`, `FakeCiFailingDetector`, the in-memory `FakeReviewEventBus`, a temp `IAppStateStore`/`IConfigStore`); match those real type names when implementing.

**One canonical `Build` signature** (all optional params; covers every call site — `Build()`, `Build(cache:…)`, `Build(cache:…, login:…, host:…)`, `Build(cache:…, loginProvider:…, host:…)`):

```csharp
// Returns the orchestrator + the two fakes tests assert against. `cache` defaults to a fresh
// RecordingIdentityCache<InboxSnapshot>. `loginProvider`, when non-null, OVERRIDES `login` (used by
// the capture-identity test 13 to flip the login mid-refresh). The `cache` param is absent in the
// Task 2 provisional harness (the ctor has no cache yet) and added in Task 3 — see each task.
public static (InboxRefreshOrchestrator Orch, FakeSectionQueryRunner Sections, FakeReviewEventBus Events) Build(
    IIdentityKeyedFileCache<InboxSnapshot>? cache = null,
    string login = "octocat",
    string host = "github.com",
    Func<string>? loginProvider = null);
```

**Helper signatures** (defined once, in the harness; referenced by Tasks 2–4):

```csharp
// A snapshot containing one PR (prNumber) in `section`; used to seed rehydrate/no-op tests.
public static InboxSnapshot SnapshotWith(string section, int prNumber);

// The snapshot a live RefreshAsync WOULD produce from the given seeded sections — built by running a
// throwaway orchestrator's RefreshAsync over the same seed and returning its Current. Used so a
// rehydrate-then-refresh test yields diff.Changed == false (the force-notify path, tests 11/14).
public static Task<InboxSnapshot> BuildEquivalentSnapshotAsync(FakeSectionQueryRunner sections);

// An IConfigStore whose Github.Accounts[0].Login == login (or an empty Accounts list when login is null)
// and Github.Host == host. Drives the rehydrator's fail-closed config-identity backstop (Task 4).
public static IConfigStore ConfigWith(string? login, string host);

// Deterministic write-drain await: `await orch.CacheWriteIdleAsync()` then re-enter the gate to confirm
// `_queuedWrite is null`; if a new write enqueued during the await, loop. POLLS the condition, never a
// fixed delay (poll-condition-not-fixed-delay CI discipline). Added in Task 3 with the writer.
public static Task WaitForCacheWriteIdleAsync(InboxRefreshOrchestrator orch);

// Raises the enrichment-ready event the orchestrator subscribes to (drives OnInboxEnrichmentsReady),
// stamping `prId` with `chip`. Mirrors how InboxRefreshOrchestratorTests fires enrichment events today.
public static void RaiseEnrichmentReady(FakeReviewEventBus events, string prId, string chip);
```

`MutableLogin` (Task 3 test 13) is a small sibling helper: a `Func<string> Get` whose first call returns its seed login then runs `OnNextRead` to flip the backing value for subsequent reads. Defined beside the harness.

---

## Task 1: `IdentityKeyedFileCache<T>` — the shared on-disk cache

**Files:**
- Create: `PRism.Core/Storage/IdentityKeyedFileCache.cs`
- Test: `tests/PRism.Core.Tests/Storage/IdentityKeyedFileCacheTests.cs`

**Interfaces:**
- Produces:
  - `public readonly record struct CacheIdentity(string Login, string Host);`
  - `public interface IIdentityKeyedFileCache<T> where T : class { Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct); T? TryLoad(CacheIdentity identity); Task EvictAsync(CancellationToken ct); }`
  - `public sealed class IdentityKeyedFileCache<T> : IIdentityKeyedFileCache<T> where T : class` with ctor `(string path, int schemaVersion, Func<T, bool>? isStructurallyValid = null, ILogger? log = null)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Storage/IdentityKeyedFileCacheTests.cs`. These exercise spec §11 storage tests 1–8 using `InboxSnapshot` (the AI-bearing payload) and a tiny `record`. Note test 1 uses a **non-empty `AiEnrichmentSettled`** set (exercises the `init` normalizer end-to-end, spec §13 scope residual).

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Activity;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Core.Tests.Storage;

// NOTE (round-1 feasibility residual): the SampleSnapshot helper below constructs PrInboxItem and
// PrReference positionally. Match the REAL record signatures when implementing — PrInboxItem has 15
// required positional params (Reference … LastSeenCommentId) then optional ones; PrReference is
// (Owner, Repo, Number) with a computed PrId. The compiler will flag any mismatch at TDD Step 4.

public sealed class IdentityKeyedFileCacheTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-cache-" + Guid.NewGuid().ToString("N"));
    private string Path0 => Path.Combine(_dir, "cache.json");

    public IdentityKeyedFileCacheTests() => Directory.CreateDirectory(_dir);
    public void Dispose() { try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ } }

    private static CacheIdentity Id(string login = "octocat", string host = "github.com") => new(login, host);

    private static InboxSnapshot SampleSnapshot()
    {
        var item = new PrInboxItem(
            new PrReference("octocat", "hello", 7), "Title", "octocat", "octocat/hello",
            DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, 1, 1, 0, 1, 0, "deadbeef",
            CiStatus.Passing, null, null);
        var sections = new Dictionary<string, IReadOnlyList<PrInboxItem>> { ["mine"] = new[] { item } };
        var enrich = new Dictionary<string, InboxItemEnrichment>
        {
            [item.Reference.PrId] = new InboxItemEnrichment(item.Reference.PrId, "needs-review", null),
        };
        return new InboxSnapshot(sections, enrich, DateTimeOffset.UnixEpoch, CiProbeComplete: true,
            AiEnrichmentSettled: new HashSet<string>(StringComparer.Ordinal) { item.Reference.PrId });
    }

    private IdentityKeyedFileCache<InboxSnapshot> NewInboxCache(Func<InboxSnapshot, bool>? valid = null) =>
        new(Path0, schemaVersion: 1, isStructurallyValid: valid ?? (s => s.Sections is not null && s.Enrichments is not null));

    [Fact] // test 1 — round-trip incl. non-empty AiEnrichmentSettled + kebab enum
    public async Task SaveAsync_then_TryLoad_round_trips_payload()
    {
        var cache = NewInboxCache();
        var snap = SampleSnapshot();
        await cache.SaveAsync(snap, Id(), CancellationToken.None);
        var loaded = cache.TryLoad(Id());
        loaded.Should().NotBeNull();
        loaded!.Sections["mine"].Should().HaveCount(1);
        loaded.Enrichments.Values.Single().CategoryChip.Should().Be("needs-review");
        loaded.AiEnrichmentSettled.Should().ContainSingle();
        loaded.Sections["mine"][0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact] // test 1 (activity half, round-1 SCOPE-2) — ActivityResponse round-trip incl. kebab ActivitySource/ActivityVerb
    public async Task SaveAsync_then_TryLoad_round_trips_ActivityResponse_with_kebab_enums()
    {
        var cache = new IdentityKeyedFileCache<ActivityResponse>(
            Path.Combine(_dir, "activity.json"), schemaVersion: 1, isStructurallyValid: r => r.Items is not null);
        var resp = new ActivityResponse(
            new[]
            {
                new ActivityItem("alice", null, ActorIsBot: false, ActivityVerb.ReviewRequested,
                    "octocat/hello", 7, "Title", "https://github.com/octocat/hello/pull/7",
                    DateTimeOffset.UnixEpoch, ActivitySource.Notification),
            },
            DateTimeOffset.UnixEpoch,
            new ActivityDegradation(false, false, false),
            Array.Empty<WatchedRepoActivity>());
        await cache.SaveAsync(resp, Id(), CancellationToken.None);

        var loaded = cache.TryLoad(Id());
        loaded.Should().NotBeNull();
        loaded!.Items.Should().ContainSingle();
        loaded.Items[0].Verb.Should().Be(ActivityVerb.ReviewRequested);   // kebab "review-requested" round-trips
        loaded.Items[0].Source.Should().Be(ActivitySource.Notification);  // kebab "notification" round-trips
    }

    [Fact] // test 2 — login mismatch, host mismatch, both-match (login OrdinalIgnoreCase)
    public async Task TryLoad_gates_on_login_and_host()
    {
        var cache = NewInboxCache();
        await cache.SaveAsync(SampleSnapshot(), Id("octocat", "github.com"), CancellationToken.None);
        cache.TryLoad(Id("someone-else", "github.com")).Should().BeNull();
        cache.TryLoad(Id("octocat", "ghe.example.com")).Should().BeNull();
        cache.TryLoad(Id("OCTOCAT", "github.com")).Should().NotBeNull(); // login is OrdinalIgnoreCase
    }

    [Fact] // test 3 — missing file
    public void TryLoad_returns_null_when_file_absent() =>
        NewInboxCache().TryLoad(Id()).Should().BeNull();

    [Fact] // test 4 — corrupt file → null, no throw, file left as-is
    public async Task TryLoad_returns_null_on_corrupt_file_without_throwing()
    {
        await File.WriteAllTextAsync(Path0, "{ this is not valid json");
        var cache = NewInboxCache();
        cache.TryLoad(Id()).Should().BeNull();
        File.Exists(Path0).Should().BeTrue();
    }

    [Fact] // test 5 — wrong schema version (older AND future)
    public async Task TryLoad_returns_null_on_version_mismatch()
    {
        var v2 = new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 2);
        await v2.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 1).TryLoad(Id()).Should().BeNull(); // older reader
        new IdentityKeyedFileCache<InboxSnapshot>(Path0, schemaVersion: 3).TryLoad(Id()).Should().BeNull(); // future reader
    }

    [Fact] // test 6 — structurally-invalid payload (parses + identity match, but invalid)
    public async Task TryLoad_returns_null_when_structurally_invalid()
    {
        var writer = NewInboxCache();
        await writer.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        var strict = NewInboxCache(valid: s => s.Sections.Count > 5); // never satisfied here
        strict.TryLoad(Id()).Should().BeNull();
    }

    [Fact] // test 7 — SaveAsync never throws even if the move target dir vanishes
    public async Task SaveAsync_never_throws_on_io_failure()
    {
        var badPath = Path.Combine(_dir, "no-such-subdir", "cache.json"); // parent dir does not exist
        var cache = new IdentityKeyedFileCache<InboxSnapshot>(badPath, schemaVersion: 1);
        var act = async () => await cache.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        await act.Should().NotThrowAsync();
    }

    [Fact] // test 8 — EvictAsync removes the file
    public async Task EvictAsync_removes_the_file()
    {
        var cache = NewInboxCache();
        await cache.SaveAsync(SampleSnapshot(), Id(), CancellationToken.None);
        File.Exists(Path0).Should().BeTrue();
        await cache.EvictAsync(CancellationToken.None);
        File.Exists(Path0).Should().BeFalse();
        cache.TryLoad(Id()).Should().BeNull();
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~IdentityKeyedFileCacheTests"`
Expected: FAIL — `IdentityKeyedFileCache` / `CacheIdentity` do not exist (compile error).

- [ ] **Step 3: Implement the cache**

Create `PRism.Core/Storage/IdentityKeyedFileCache.cs`:

```csharp
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Json;

namespace PRism.Core.Storage;

/// <summary>Owner-identity key for a persisted cache file: the token-owner login + GitHub host.</summary>
public readonly record struct CacheIdentity(string Login, string Host);

/// <summary>
/// Injection seam for <see cref="IdentityKeyedFileCache{T}"/> so consumers can be unit-tested with a
/// recording/stub double (the concrete class does real file I/O and is tested directly).
/// </summary>
public interface IIdentityKeyedFileCache<T> where T : class
{
    Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct);
    T? TryLoad(CacheIdentity identity);
    Task EvictAsync(CancellationToken ct);
}

/// <summary>
/// A single-file, identity-stamped, schema-versioned cache. Disposable by design: any read failure
/// (missing / parse error / version mismatch / identity mismatch / structurally-invalid) returns a
/// miss — the caller treats it exactly like a first run. Never migrates; the next write overwrites.
/// Writes are atomic (temp-file + AtomicFileMove) and best-effort (never throw to the caller).
/// </summary>
public sealed class IdentityKeyedFileCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    private readonly string _path;
    private readonly int _schemaVersion;
    private readonly Func<T, bool> _isStructurallyValid;
    private readonly ILogger _log;

    public IdentityKeyedFileCache(string path, int schemaVersion,
        Func<T, bool>? isStructurallyValid = null, ILogger? log = null)
    {
        _path = path;
        _schemaVersion = schemaVersion;
        _isStructurallyValid = isStructurallyValid ?? (static _ => true);
        _log = log ?? NullLogger.Instance;
    }

    // Kebab-cased on disk via JsonSerializerOptionsFactory.Storage → {version, owner-login, owner-host, payload}.
    private sealed record Envelope(int Version, string OwnerLogin, string OwnerHost, T Payload);

    public async Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct)
    {
        try
        {
            var envelope = new Envelope(_schemaVersion, identity.Login, identity.Host, payload);
            var json = JsonSerializer.Serialize(envelope, JsonSerializerOptionsFactory.Storage);
            var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
            await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
            await AtomicFileMove.MoveAsync(temp, _path, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { throw; }
#pragma warning disable CA1031 // a cache write must never break a refresh; log + swallow
        catch (Exception ex)
        {
            _log.LogDebug(ex, "IdentityKeyedFileCache save failed for {Path}", _path);
        }
#pragma warning restore CA1031
    }

    public T? TryLoad(CacheIdentity identity)
    {
        try
        {
            if (!File.Exists(_path)) return null;

            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = reader.ReadToEnd();

            var envelope = JsonSerializer.Deserialize<Envelope>(raw, JsonSerializerOptionsFactory.Storage);
            if (envelope is null) return null;
            if (envelope.Version != _schemaVersion) return null;
            if (!string.Equals(envelope.OwnerLogin, identity.Login, StringComparison.OrdinalIgnoreCase)) return null;
            if (!string.Equals(envelope.OwnerHost, identity.Host, StringComparison.OrdinalIgnoreCase)) return null;
            if (envelope.Payload is null) return null;
            if (!_isStructurallyValid(envelope.Payload)) return null;
            return envelope.Payload;
        }
#pragma warning disable CA1031 // disposable cache: any read failure is a miss, never a crash
        catch (Exception ex)
        {
            _log.LogDebug(ex, "IdentityKeyedFileCache load failed for {Path}", _path);
            return null;
        }
#pragma warning restore CA1031
    }

    public Task EvictAsync(CancellationToken ct)
    {
        try
        {
            if (File.Exists(_path)) File.Delete(_path);
        }
#pragma warning disable CA1031 // best-effort delete; a lingering file is rejected by the identity gate
        catch (Exception ex)
        {
            _log.LogDebug(ex, "IdentityKeyedFileCache evict failed for {Path}", _path);
        }
#pragma warning restore CA1031
        return Task.CompletedTask;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~IdentityKeyedFileCacheTests"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Storage/IdentityKeyedFileCache.cs tests/PRism.Core.Tests/Storage/IdentityKeyedFileCacheTests.cs
git commit -m "feat(#619): add IdentityKeyedFileCache<T> — versioned, identity-keyed, disposable on-disk cache"
```

---

## Task 2: Inbox orchestrator — rehydrate side (`TryRehydrate`, stale flag, force-notify)

**Files:**
- Modify: `PRism.Core/Inbox/IInboxRefreshOrchestrator.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxRehydrateTests.cs` (new)

**Interfaces:**
- Consumes: `InboxSnapshot` (existing), `_writerLock`, `_current`, `_firstSnapshotTcs` (existing private fields).
- Produces (concrete): `public void TryRehydrate(InboxSnapshot snapshot)`. Produces (interface + concrete): `bool IsServingRehydratedSnapshot { get; }`.

> **Note:** This task assumes the orchestrator ctor is unchanged. Task 3 adds the cache ctor dependency; do Task 2 first against the current ctor, then Task 3 threads the cache through. The `forceNotify` parameter and publish branch **already exist** (`RefreshAsync(ct, hardRefresh, forceNotify)`, publish at the `else if (forceNotify)` branch) — this task only adds the rehydrate-driven consume.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Inbox/InboxRehydrateTests.cs`. (Covers spec tests 9, 10, 11, 14.) Use the existing orchestrator test construction helper if the test project has one; otherwise construct with the existing fakes. The snippet below assumes a local `BuildOrchestrator(...)` helper that mirrors the existing `InboxRefreshOrchestratorTests` setup and returns `(InboxRefreshOrchestrator orch, FakeEventBus events, FakeSectionQueryRunner sections, ...)`. If no such helper exists yet, factor one out of the existing test file in this step.

```csharp
using FluentAssertions;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxRehydrateTests
{
    [Fact] // test 9 — TryRehydrate sets Current + completes the first-snapshot gate + arms force-notify
    public async Task TryRehydrate_sets_current_and_completes_first_snapshot_gate()
    {
        var (orch, _, _) = InboxOrchestratorTestHarness.Build();
        var snap = InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 7);

        orch.TryRehydrate(snap);

        orch.Current.Should().BeSameAs(snap);
        orch.IsServingRehydratedSnapshot.Should().BeTrue();
        (await orch.WaitForFirstSnapshotAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None))
            .Should().BeTrue(); // returns without a refresh
    }

    [Fact] // test 10 — TryRehydrate no-ops if a refresh already committed
    public async Task TryRehydrate_no_ops_when_current_already_set()
    {
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build();
        sections.Seed("mine", prNumber: 1);
        await orch.RefreshAsync(CancellationToken.None);
        var live = orch.Current;

        orch.TryRehydrate(InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 99));

        orch.Current.Should().BeSameAs(live);              // live retained
        orch.IsServingRehydratedSnapshot.Should().BeFalse(); // never armed
    }

    [Fact] // test 11 — first successful refresh after rehydrate force-notifies even on no-change, then clears
    public async Task First_refresh_after_rehydrate_force_notifies_then_clears()
    {
        var (orch, sections, events) = InboxOrchestratorTestHarness.Build();
        // Rehydrate with a snapshot equal to what the live refresh will produce → diff.Changed == false.
        sections.Seed("mine", prNumber: 5);
        var rehydrated = await InboxOrchestratorTestHarness.BuildEquivalentSnapshotAsync(sections);
        var (orch2, sections2, events2) = InboxOrchestratorTestHarness.Build();
        sections2.Seed("mine", prNumber: 5);
        orch2.TryRehydrate(rehydrated);
        events2.Clear();

        await orch2.RefreshAsync(CancellationToken.None);

        // Round-1 ADV-5: assert the publish came from the FORCE-NOTIFY branch, not a diff.Changed branch
        // (both publish exactly one InboxUpdated, so ContainSingle alone can't distinguish them). The
        // force-notify payload is NewOrUpdatedPrCount==0 over the full Sections.Keys set.
        var published = events2.Published.OfType<InboxUpdated>().Should().ContainSingle().Subject;
        published.NewOrUpdatedPrCount.Should().Be(0);                      // no real delta → proves force-notify
        published.ChangedSectionIds.Should().BeEquivalentTo(rehydrated.Sections.Keys);
        orch2.IsServingRehydratedSnapshot.Should().BeFalse();              // flag cleared

        events2.Clear();
        await orch2.RefreshAsync(CancellationToken.None);
        events2.Published.OfType<InboxUpdated>().Should().BeEmpty();       // subsequent no-change refresh is silent
    }

    [Fact] // test 14 — first refresh after rehydrate diffs against the rehydrated snapshot (real delta, not "everything new")
    public async Task First_refresh_after_rehydrate_diffs_against_rehydrated_not_null()
    {
        var (orch, sections, events) = InboxOrchestratorTestHarness.Build();
        sections.Seed("mine", prNumber: 5);
        var rehydrated = await InboxOrchestratorTestHarness.BuildEquivalentSnapshotAsync(sections);
        var (orch2, sections2, events2) = InboxOrchestratorTestHarness.Build();
        sections2.Seed("mine", prNumber: 5);
        sections2.Seed("mine", prNumber: 6); // one genuinely new PR
        orch2.TryRehydrate(rehydrated);
        events2.Clear();

        await orch2.RefreshAsync(CancellationToken.None);

        var updated = events2.Published.OfType<InboxUpdated>().Single();
        updated.NewOrUpdatedPrCount.Should().Be(1); // only the real delta, NOT CountAll(everything)
    }
}
```

> Create `tests/PRism.Core.Tests/Inbox/InboxOrchestratorTestHarness.cs` in this step per the **canonical Test harness contract** above (the single source of truth for every signature). In THIS task it is provisional: the orchestrator ctor has no cache param yet, so `Build`'s `cache` parameter is **not** present — `Build(login, host, loginProvider)` only. Task 3 adds the `cache` param (a new optional, backward-compatible) + the `WaitForCacheWriteIdleAsync`/`RaiseEnrichmentReady` helpers when the writer lands. Implement `SnapshotWith`, `BuildEquivalentSnapshotAsync`, and `ConfigWith` here, wrapping the existing fakes; model construction on the block already in `InboxRefreshOrchestratorTests.cs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxRehydrateTests"`
Expected: FAIL — `TryRehydrate` / `IsServingRehydratedSnapshot` not defined.

- [ ] **Step 3: Add the interface getter**

In `PRism.Core/Inbox/IInboxRefreshOrchestrator.cs`, add the getter next to `Current`:

```csharp
public interface IInboxRefreshOrchestrator
{
    InboxSnapshot? Current { get; }

    /// <summary>
    /// True while the served snapshot is a rehydrated, not-yet-successfully-revalidated cache
    /// (drives the <c>stale</c> wire flag, #619). Flips false once the first refresh since launch
    /// commits. A failed (network) revalidation does NOT clear it — the data is still stale.
    /// </summary>
    // Round-1 SCOPE-1: a DEFAULT interface implementation (=> false) so existing IInboxRefreshOrchestrator
    // test fakes (which don't override it) keep compiling — no CS0535 blast radius. The concrete
    // InboxRefreshOrchestrator overrides it with the real flag (Step 4).
    bool IsServingRehydratedSnapshot => false;

    Task<bool> WaitForFirstSnapshotAsync(TimeSpan timeout, CancellationToken ct);
    // ... unchanged ...
```

- [ ] **Step 4: Add the field, getter, TryRehydrate, and the force-notify consume**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, add a field next to `_current` (line ~29):

```csharp
    private InboxSnapshot? _current;
    // #619 — armed by TryRehydrate; consumed (cleared) by the first SUCCESSFUL revalidation's commit.
    // Drives both the force-notify-once behavior and the `stale` wire flag.
    private volatile bool _rehydratedAwaitingRevalidate;
```

Add the getter next to the existing `Current` accessor (line ~93):

```csharp
    public InboxSnapshot? Current => Volatile.Read(ref _current);

    public bool IsServingRehydratedSnapshot => _rehydratedAwaitingRevalidate;
```

Add the `TryRehydrate` method (place it just after `WaitForFirstSnapshotAsync`):

```csharp
    /// <summary>
    /// #619 — Called once, by InboxCacheRehydrator, before the poller's first RefreshAsync. Sets the
    /// rehydrated snapshot as _current, completes the first-snapshot gate so GET /api/inbox returns
    /// immediately, and arms force-notify-once so the stale flag always clears on the first
    /// successful revalidation. No-op if a refresh already committed (loses harmlessly).
    /// </summary>
    public void TryRehydrate(InboxSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        _writerLock.Wait();
        try
        {
            if (_current is not null) return; // a refresh beat us — keep live data
            Volatile.Write(ref _current, snapshot);
            _rehydratedAwaitingRevalidate = true;
            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();
        }
        finally { _writerLock.Release(); }
    }
```

In `RefreshAsync`, at the publish step (currently `var diff = ComputeDiff(_current, newSnap); Volatile.Write(ref _current, newSnap); ... if (diff.Changed) {...} else if (forceNotify) {...}`), insert the consume **after** the commit and **before** the publish so a throw-before-commit leaves the flag armed:

```csharp
            var diff = ComputeDiff(_current, newSnap);
            Volatile.Write(ref _current, newSnap);
            // Stash under the lock so ReprobeOnceAsync can re-read the full set (#655).
            _lastRawSet = allRawDistinct;

            if (!_firstSnapshotTcs.Task.IsCompleted) _firstSnapshotTcs.TrySetResult();

            // #619 — the first SUCCESSFUL revalidation after a rehydrate force-notifies so the FE
            // always refetches and clears `stale`, even when the rehydrated snapshot already equals
            // live (diff.Changed == false). Consumed here, after the commit: a network-failed refresh
            // throws before reaching this line and leaves the flag armed (the data is still stale).
            var effectiveForceNotify = forceNotify;
            if (_rehydratedAwaitingRevalidate)
            {
                effectiveForceNotify = true;
                _rehydratedAwaitingRevalidate = false;
            }

            sw.Stop();
            Log.SnapshotBuilt(_log, postDedupeTotal, sectionsFinal.Count, diff.Changed, diff.NewOrUpdatedPrCount, sw.ElapsedMilliseconds);

            if (diff.Changed)
            {
                _events.Publish(new InboxUpdated(
                    diff.ChangedSectionIds.ToArray(),
                    diff.NewOrUpdatedPrCount));
            }
            else if (effectiveForceNotify)
            {
                _events.Publish(new InboxUpdated(newSnap.Sections.Keys.ToArray(), 0));
            }
```

(The only changes vs. the current body: the new `_rehydratedAwaitingRevalidate` consume block, and `forceNotify` → `effectiveForceNotify` in the `else if`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxRehydrateTests"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/IInboxRefreshOrchestrator.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRehydrateTests.cs tests/PRism.Core.Tests/Inbox/InboxOrchestratorTestHarness.cs
git commit -m "feat(#619): inbox orchestrator TryRehydrate + stale flag + force-notify-once on first revalidation"
```

---

## Task 3: Inbox orchestrator — write side (capture-identity, two triggers, coalesced writer)

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxCacheWriteTests.cs` (new)
- Test helper: `tests/PRism.Core.Tests/Inbox/RecordingIdentityCache.cs` (new)

**Interfaces:**
- Consumes: `IIdentityKeyedFileCache<InboxSnapshot>` (Task 1), `CacheIdentity`.
- Produces: orchestrator ctor gains a positional `IIdentityKeyedFileCache<InboxSnapshot> cache` parameter (inserted **before** `Func<string> viewerLoginProvider`); a private coalescing writer.

> **Blast radius (round-1 COH-2):** inserting a ctor param breaks every direct `new InboxRefreshOrchestrator(...)` call site (the DI registration — fixed in Task 4 — and any test harness). This task brings `InboxOrchestratorTestHarness` to its **final** form per the canonical Test harness contract above: add the optional `cache:` parameter (defaulting to a fresh `RecordingIdentityCache<InboxSnapshot>` so Task 2's `Build()` / `Build(login:…, host:…)` call sites keep compiling), the `loginProvider:` override param, and the `WaitForCacheWriteIdleAsync`/`RaiseEnrichmentReady` helpers (the latter two land with the writer in Step 3). **Re-run Task 2's `InboxRehydrateTests` after this task** — they exercise the same harness and must stay green through the signature change. If `ConfigWith`/`SnapshotWith`/`BuildEquivalentSnapshotAsync` were not already added in Task 2, add them now (round-1 COH-4).

- [ ] **Step 1: Write the recording cache + failing tests**

Create `tests/PRism.Core.Tests/Inbox/RecordingIdentityCache.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Storage;

namespace PRism.Core.Tests.Inbox;

/// <summary>In-memory IIdentityKeyedFileCache that records every SaveAsync (payload + identity) and
/// serves the last saved payload from TryLoad, for orchestrator/activity write-path assertions.</summary>
public sealed class RecordingIdentityCache<T> : IIdentityKeyedFileCache<T> where T : class
{
    public ConcurrentQueue<(T Payload, CacheIdentity Identity)> Saves { get; } = new();
    public int EvictCount;
    private (T Payload, CacheIdentity Identity)? _last;
    private readonly Func<T, CacheIdentity>? _seed;

    public RecordingIdentityCache(Func<T, CacheIdentity>? seed = null) => _seed = seed;

    public Task SaveAsync(T payload, CacheIdentity identity, CancellationToken ct)
    {
        Saves.Enqueue((payload, identity));
        _last = (payload, identity);
        return Task.CompletedTask;
    }

    public T? TryLoad(CacheIdentity identity) =>
        _last is { } v && v.Identity.Login.Equals(identity.Login, StringComparison.OrdinalIgnoreCase)
            && v.Identity.Host.Equals(identity.Host, StringComparison.OrdinalIgnoreCase)
            ? v.Payload : null;

    public Task EvictAsync(CancellationToken ct) { EvictCount++; _last = null; return Task.CompletedTask; }
}
```

Create `tests/PRism.Core.Tests/Inbox/InboxCacheWriteTests.cs` (spec tests 12, 13). The harness exposes the recording cache; a `WaitForCacheWriteIdleAsync()` helper polls until the writer drains (poll the condition, never a fixed delay — per CI-flake discipline).

```csharp
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxCacheWriteTests
{
    [Fact] // test 12 — write on Changed; no write on no-change/no-enrichment; write on enrichment-ready
    public async Task Writes_on_change_and_on_enrichment_ready_but_not_on_idle_tick()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var (orch, sections, events) = InboxOrchestratorTestHarness.Build(cache: cache, login: "octocat", host: "github.com");

        sections.Seed("mine", prNumber: 1);
        await orch.RefreshAsync(CancellationToken.None);          // Changed == true → one write
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().ContainSingle();
        cache.Saves.Single().Identity.Should().Be(new CacheIdentity("octocat", "github.com"));

        await orch.RefreshAsync(CancellationToken.None);          // identical tick, no new enrichment → no write
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().ContainSingle();                     // still exactly one

        InboxOrchestratorTestHarness.RaiseEnrichmentReady(events, "octocat/hello#1", chip: "needs-review");
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().HaveCount(2);                        // enrichment-ready flush
        cache.Saves.Last().Payload.AiEnrichmentSettled.Should().Contain("octocat/hello#1");
    }

    [Fact] // test 13 — captured-identity stamp: snapshot captured under A persists as A even if login flips to B before flush
    public async Task Coalesced_write_stamps_identity_captured_with_the_snapshot()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var login = new MutableLogin("alice");
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build(cache: cache, loginProvider: login.Get, host: "github.com");

        sections.Seed("mine", prNumber: 1);
        // Flip the login to B the instant the snapshot commits but before the coalesced write drains.
        login.OnNextRead = () => login.Value = "bob";
        await orch.RefreshAsync(CancellationToken.None);
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);

        cache.Saves.Single().Identity.Login.Should().Be("alice"); // stamped with the capture-time login, NOT bob
        cache.TryLoad(new CacheIdentity("bob", "github.com")).Should().BeNull();
    }
}
```

> `MutableLogin` is a tiny test helper (a `Func<string> Get` whose **first** invocation returns `"alice"` then runs `OnNextRead` to flip the backing value to `"bob"` for all subsequent reads); add it beside the test if not present. The first `Get()` in `RefreshAsync` is the line-175 `viewerLogin` read, so the snapshot's data is fetched under `"alice"` and `_lastCaptureIdentity` is stamped `"alice"` — proving the write closed over the **fetch** identity, not a later commit-time read. (This test is precisely what catches the ADV-2 regression: a fresh `_viewerLoginProvider()` read at commit time would return `"bob"` and fail the `Identity.Login.Should().Be("alice")` assertion.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxCacheWriteTests"`
Expected: FAIL — orchestrator ctor has no `cache` parameter / no write behavior.

- [ ] **Step 3: Add the ctor dep + the coalescing writer + the two write hooks**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, add the field:

```csharp
    private readonly IIdentityKeyedFileCache<InboxSnapshot> _cache;
```

Add the ctor parameter (insert before `Func<string> viewerLoginProvider`) and assign it:

```csharp
    public InboxRefreshOrchestrator(
        IConfigStore config,
        ISectionQueryRunner sections,
        IPrBatchReader batchReader,
        ICiFailingDetector ciDetector,
        IInboxDeduplicator dedupe,
        IAiSeamSelector aiSelector,
        IReviewEventBus events,
        IAppStateStore stateStore,
        IIdentityKeyedFileCache<InboxSnapshot> cache,   // #619
        Func<string> viewerLoginProvider,
        ILogger<InboxRefreshOrchestrator>? log = null,
        Func<TimeSpan, CancellationToken, Task>? burstDelay = null)
    {
        _config = config;
        _sections = sections;
        _batchReader = batchReader;
        _ciDetector = ciDetector;
        _dedupe = dedupe;
        _aiSelector = aiSelector;
        _events = events;
        _stateStore = stateStore;
        _cache = cache;
        _viewerLoginProvider = viewerLoginProvider;
        // ... rest unchanged ...
```

Add the coalescing-writer state + methods (place near the bottom of the class, beside the other private helpers):

```csharp
    // ── #619 cache writer: serialized, latest-wins coalescing (§5.1.3) ──────────────
    // At most one in-flight SaveAsync. A newer (snapshot, identity) replaces any queued-but-unstarted
    // write and starts AFTER the in-flight one completes — so an older slow write can never land after
    // a newer one. Identity is captured by the caller (under _writerLock) and closed over here.
    private readonly object _cacheWriteGate = new();
    private (InboxSnapshot Snapshot, CacheIdentity Identity, int Epoch)? _queuedWrite;
    private Task _cacheWriteLoop = Task.CompletedTask;
    // Round-1 ADV-4 fix: gate the drainer relaunch on an explicit _draining flag, NOT on
    // _cacheWriteLoop.IsCompleted. The loop releases _cacheWriteGate (Monitor.Exit) a moment before
    // its Task transitions to IsCompleted; a ScheduleCacheWrite landing in that window would see
    // IsCompleted==false and skip the relaunch, stranding the queued write. _draining is set/cleared
    // strictly under the lock, closing the window.
    private bool _draining;

    // ── Round-2 ADV-1: epoch gate (supersedes the round-1 quiesce-only invalidation) ───────────────
    // QuiesceCacheWrites alone could NOT stop a write scheduled AFTER an auth-site evict: an in-flight
    // RefreshAsync (holding _writerLock across network I/O) or a slow OnInboxEnrichmentsReady (AI settles
    // ~53s later) can call ScheduleCacheWrite after the drain+evict returned, re-creating the file. On a
    // SAME-LOGIN token rotation _lastCaptureIdentity.Login is unchanged, so the identity gate accepts the
    // resurrected file — defeating evict-on-swap. The fix mirrors ActivityProvider._generation: every
    // write carries the epoch captured WHEN ITS SNAPSHOT'S DATA WAS FETCHED (the line-175 read); the
    // auth-site invalidate bumps the epoch; the drainer DROPS any write whose epoch != the current epoch.
    // A pre-rotation write (old epoch) is discarded even if it schedules after evict; a genuinely new
    // post-rotation refresh captures the new epoch and persists normally.
    private int _cacheWriteEpoch;        // bumped by InvalidateCacheWritesAsync at each auth token change
    private int _lastCaptureEpoch;       // the epoch READ at line-175 for the last committed snapshot

    private void ScheduleCacheWrite(InboxSnapshot snapshot, CacheIdentity identity, int epoch)
    {
        lock (_cacheWriteGate)
        {
            _queuedWrite = (snapshot, identity, epoch); // latest-wins: overwrites any not-yet-started write
            if (!_draining)
            {
                _draining = true;
                _cacheWriteLoop = Task.Run(DrainCacheWritesAsync);
            }
        }
    }

    private async Task DrainCacheWritesAsync()
    {
        while (true)
        {
            (InboxSnapshot Snapshot, CacheIdentity Identity, int Epoch) next;
            lock (_cacheWriteGate)
            {
                if (_queuedWrite is null) { _draining = false; return; } // cleared under the lock
                next = _queuedWrite.Value;
                _queuedWrite = null;
            }
            // Round-2 ADV-1: drop a write captured under a since-invalidated epoch (a token rotation ran
            // between this write's line-175 capture and now). Checked at write time, not schedule time, so
            // a write that schedules AFTER the auth-site bump+evict is discarded rather than resurrecting
            // the evicted file. Re-read the live epoch each iteration.
            if (next.Epoch != Volatile.Read(ref _cacheWriteEpoch)) continue;
            await _cache.SaveAsync(next.Snapshot, next.Identity, CancellationToken.None).ConfigureAwait(false);
        }
    }

    // Round-2 ADV-1 (supersedes round-1 QuiesceCacheWritesAsync): called by the auth handlers BEFORE an
    // awaited EvictAsync. (1) Interlocked-bump the epoch so every already-captured pre-rotation write is
    // dropped by the drainer's gate — even one that ScheduleCacheWrites after this returns. (2) Clear the
    // queue and await the in-flight loop so any SaveAsync that already passed the gate finishes before the
    // caller's EvictAsync deletes the file. Post-rotation refreshes capture the new epoch and write normally.
    internal async Task InvalidateCacheWritesAsync()
    {
        Task inFlight;
        lock (_cacheWriteGate)
        {
            Interlocked.Increment(ref _cacheWriteEpoch); // fence: pre-rotation writes now fail the drainer gate
            _queuedWrite = null;
            inFlight = _cacheWriteLoop;
        }
        await inFlight.ConfigureAwait(false);
    }

    // Test seam: awaits the in-flight cache-write loop so write-path assertions are deterministic.
    internal Task CacheWriteIdleAsync() { lock (_cacheWriteGate) { return _cacheWriteLoop; } }

**Capture identity AND epoch from the data-fetch point, NOT a fresh read (round-1 ADV-2 + round-2 ADV-1 — load-bearing).** `RefreshAsync`
already reads the login once at the top (`var viewerLogin = _viewerLoginProvider();`, ~line 175) and passes it
to `_batchReader.ReadAsync(...)` — that is the login the snapshot's **data** was fetched under. A fresh
`_viewerLoginProvider()` read at commit time would return a *different* login if a token swap interleaved
between line 175 and the commit, stamping login A's data as B (the exact cross-identity leak the capture
mechanism exists to prevent). At the **same line-175 point**, also snapshot the write epoch
(`var writeEpoch = Volatile.Read(ref _cacheWriteEpoch);`) — read it BEFORE the network fetch so a token
rotation that bumps the epoch mid-refresh marks this snapshot's eventual write as stale (round-2 ADV-1; an
epoch read at commit time would see the post-bump value and wrongly persist pre-rotation data). Stash both the
line-175 login and the line-175 epoch under the lock at commit, and reuse them for both triggers; the
enrichment-ready trigger (which has no fetch of its own) reuses the same stashed identity+epoch, since the
settled-AI snapshot it persists belongs to the snapshot that was fetched under that login at that epoch.

At line ~175, alongside `var viewerLogin = _viewerLoginProvider();`, add the epoch capture:

```csharp
            var viewerLogin = _viewerLoginProvider();
            var writeEpoch = Volatile.Read(ref _cacheWriteEpoch); // #619 round-2 ADV-1 — capture WITH the fetch login
```

Add fields:

```csharp
    // #619 — the identity the last committed snapshot was FETCHED under (the line-175 viewerLogin, not a
    // fresh read). Set under _writerLock at commit; reused by both cache-write triggers so a token swap
    // racing a pending write can never re-attribute a snapshot to the new login. (Round-1 ADV-2.)
    private CacheIdentity _lastCaptureIdentity;
    // (_lastCaptureEpoch is declared with the writer block above — the epoch read at line-175 for this snapshot.)
```

Wire **trigger (a)** in `RefreshAsync` — at the commit, stash the identity+epoch from the line-175 locals
and schedule on a core change. Add it right after the `_rehydratedAwaitingRevalidate` consume block
(still inside the `try`, under `_writerLock`; `viewerLogin` and `writeEpoch` are the locals already in scope from ~line 175):

```csharp
            // #619 — stamp with the login the snapshot's DATA was fetched under (the line-175 `viewerLogin`
            // local) and the epoch read at that same point, captured under the lock. NOT fresh reads (ADV-2/ADV-1).
            _lastCaptureIdentity = new CacheIdentity(viewerLogin, _config.Current.Github.Host);
            _lastCaptureEpoch = writeEpoch;
            // #619 trigger (a) — persist on a core change, carrying the captured epoch.
            if (diff.Changed)
                ScheduleCacheWrite(newSnap, _lastCaptureIdentity, _lastCaptureEpoch);
```

Wire **trigger (b)** in `OnInboxEnrichmentsReady`, right after its commit (`Volatile.Write(ref _current, current with { ... });` then `_events.Publish(...)`). It reuses `_lastCaptureIdentity`/`_lastCaptureEpoch` (the snapshot it patches was built by the last `RefreshAsync` under that login at that epoch):

```csharp
            var settledSnapshot = current with { Enrichments = merged, AiEnrichmentSettled = settled };
            Volatile.Write(ref _current, settledSnapshot);
            _events.Publish(new InboxUpdated(changedSections.ToArray(), applied));
            // #619 trigger (b) — flush the settled-AI snapshot so the persisted copy carries real chips
            // (ComputeDiff is enrichment-blind, so trigger (a) alone would persist blank-chip snapshots).
            // Reuse the captured fetch-identity + epoch, NOT fresh reads (round-1 ADV-2 / round-2 ADV-1).
            // Round-2 FEAS-residual: skip if no refresh has committed yet (_lastCaptureIdentity defaults to
            // (null,null)) — enrichment-ready can't realistically precede the first refresh, but the guard is
            // cheap and avoids ever scheduling a write stamped with an empty login.
            if (!string.IsNullOrEmpty(_lastCaptureIdentity.Login))
                ScheduleCacheWrite(settledSnapshot, _lastCaptureIdentity, _lastCaptureEpoch);
```

(Refactor the existing inline `current with { ... }` into the named `settledSnapshot` local so both the `Volatile.Write` and the schedule use the same reference.)

The `CacheWriteIdleAsync` / `InvalidateCacheWritesAsync` seams are already defined in the writer block above. `InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch)` must **poll the condition, not fixed-delay** (per the `poll-condition-not-fixed-delay` CI discipline): `await orch.CacheWriteIdleAsync()`, then re-enter the lock to confirm `_queuedWrite is null`; if a new write was enqueued during the await, loop. No `Thread.Sleep`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxCacheWriteTests|FullyQualifiedName~InboxRehydrateTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/
git commit -m "feat(#619): inbox cache write path — capture-identity, change+enrichment triggers, coalesced writer"
```

---

## Task 4: `InboxCacheRehydrator` hosted service + DI wiring

**Files:**
- Create: `PRism.Core/Inbox/InboxCacheRehydrator.cs`
- Modify: `PRism.Core/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.Core.Tests/Inbox/InboxCacheRehydratorTests.cs` (new)

**Interfaces:**
- Consumes: `InboxRefreshOrchestrator` (concrete, for `TryRehydrate`), `IIdentityKeyedFileCache<InboxSnapshot>`, `IConfigStore`.
- Produces: `public sealed class InboxCacheRehydrator : IHostedService`. New DI: consts `InboxSnapshotCacheVersion = 1` + `ActivityFeedCacheVersion = 1`, **both** cache singletons (inbox + activity — the activity one is moved up from Task 6 per round-1 FEAS-2), dual-registered orchestrator, and the rehydrator hosted-service inserted **before** `ViewerLoginHydrator` (round-1 ADV-1).

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/Inbox/InboxCacheRehydratorTests.cs` (spec test 15). The rehydrator must rehydrate ONLY against a non-empty config identity matching the envelope, and must NOT touch the network (it depends only on config + cache, never the validator — so "offline-capable" is structural here; assert it rehydrates with no live readers wired).

```csharp
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxCacheRehydratorTests
{
    [Fact] // test 15a — present cache + non-empty matching config identity → rehydrates
    public async Task Rehydrates_when_cache_matches_nonempty_config_identity()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var snap = InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 7);
        await cache.SaveAsync(snap, new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: "octocat", host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeSameAs(snap);
        orch.IsServingRehydratedSnapshot.Should().BeTrue();
    }

    [Fact] // test 15a — empty config identity (first connect not persisted) → fails closed
    public async Task Fails_closed_when_config_identity_empty()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        await cache.SaveAsync(InboxOrchestratorTestHarness.SnapshotWith("mine", 7),
            new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: null, host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeNull(); // skeleton → live
    }

    [Fact] // test 15a — owner mismatch → fails closed
    public async Task Fails_closed_when_owner_mismatches_config()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        await cache.SaveAsync(InboxOrchestratorTestHarness.SnapshotWith("mine", 7),
            new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: "someone-else", host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeNull();
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxCacheRehydratorTests"`
Expected: FAIL — `InboxCacheRehydrator` not defined.

- [ ] **Step 3: Implement the rehydrator**

Create `PRism.Core/Inbox/InboxCacheRehydrator.cs`:

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Config;
using PRism.Core.Storage;

namespace PRism.Core.Inbox;

/// <summary>
/// #619 — On startup, rehydrates the last-known-good inbox snapshot from disk into the orchestrator
/// BEFORE the first poll, so /api/inbox paints real prior data instantly (offline-capable: reads only
/// config + the cache file, never the network). Registered FIRST among hosted services — BEFORE
/// ViewerLoginHydrator (whose StartAsync does a BLOCKING network credential validation, round-1 ADV-1) and
/// before InboxPoller, so the offline paint is never gated behind a network timeout. The last-validated
/// identity is read from on-disk config (loaded by ConfigStore at construction), so no upstream hosted
/// service need run first. (StartAsync runs in registration order.)
/// Fails closed: rehydrates only against a NON-EMPTY config identity matching the cache envelope (§4).
/// </summary>
public sealed class InboxCacheRehydrator : IHostedService
{
    private readonly InboxRefreshOrchestrator _orchestrator;
    private readonly IIdentityKeyedFileCache<InboxSnapshot> _cache;
    private readonly IConfigStore _config;
    private readonly ILogger<InboxCacheRehydrator> _log;

    public InboxCacheRehydrator(
        InboxRefreshOrchestrator orchestrator,
        IIdentityKeyedFileCache<InboxSnapshot> cache,
        IConfigStore config,
        ILogger<InboxCacheRehydrator>? log = null)
    {
        _orchestrator = orchestrator;
        _cache = cache;
        _config = config;
        _log = log ?? NullLogger<InboxCacheRehydrator>.Instance;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        var accounts = _config.Current.Github.Accounts;
        var login = accounts.Count > 0 ? accounts[0].Login : null;
        if (string.IsNullOrEmpty(login))
            return Task.CompletedTask; // first-ever connect not yet persisted → skeleton → live

        var identity = new CacheIdentity(login, _config.Current.Github.Host);
        var snapshot = _cache.TryLoad(identity);
        if (snapshot is not null)
            _orchestrator.TryRehydrate(snapshot);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
```

- [ ] **Step 4: Wire DI**

In `PRism.Core/ServiceCollectionExtensions.cs`:

(a) Add **both** cache singletons near the other store registrations (e.g. after the `IAppStateStore` line), plus version consts at the top of the class. **Both are registered here, in Task 4 — not Task 6 (round-1 FEAS-2):** Task 5's auth handlers take `IIdentityKeyedFileCache<ActivityResponse>` as a delegate parameter, so it must be resolvable from DI *before* Task 5, or production + every existing auth-endpoint test would throw "Unable to resolve service" between the Task 5 and Task 6 commits.

```csharp
    // #619 — schema versions for the cold-start caches. Bump on any InboxSnapshot/ActivityResponse shape change.
    private const int InboxSnapshotCacheVersion = 1;
    private const int ActivityFeedCacheVersion = 1;
```

```csharp
        services.AddSingleton<IIdentityKeyedFileCache<InboxSnapshot>>(_ =>
            new IdentityKeyedFileCache<InboxSnapshot>(
                Path.Combine(dataDir, "inbox-snapshot.json"),
                InboxSnapshotCacheVersion,
                isStructurallyValid: s => s.Sections is not null && s.Enrichments is not null));
        services.AddSingleton<IIdentityKeyedFileCache<ActivityResponse>>(_ =>
            new IdentityKeyedFileCache<ActivityResponse>(
                Path.Combine(dataDir, "activity-feed.json"),
                ActivityFeedCacheVersion,
                isStructurallyValid: r => r.Items is not null));
```

(`ActivityResponse` is in `PRism.Core.Activity` — add the `using`. The `ActivityProvider` registration at `Program.cs:119` resolves this singleton from DI once Task 6 adds the ctor dependency; no `Program.cs` change is needed.)

(b) Replace the interface-only orchestrator registration (the `services.AddSingleton<IInboxRefreshOrchestrator>(sp => { ... })` block) with a dual-registration that also passes the cache:

```csharp
        services.AddSingleton<InboxRefreshOrchestrator>(sp =>
        {
            var loginCache = sp.GetRequiredService<IViewerLoginProvider>();
            return new InboxRefreshOrchestrator(
                sp.GetRequiredService<IConfigStore>(),
                sp.GetRequiredService<ISectionQueryRunner>(),
                sp.GetRequiredService<IPrBatchReader>(),
                sp.GetRequiredService<ICiFailingDetector>(),
                sp.GetRequiredService<IInboxDeduplicator>(),
                sp.GetRequiredService<IAiSeamSelector>(),
                sp.GetRequiredService<IReviewEventBus>(),
                sp.GetRequiredService<IAppStateStore>(),
                sp.GetRequiredService<IIdentityKeyedFileCache<InboxSnapshot>>(),
                loginCache.Get,
                sp.GetRequiredService<ILogger<InboxRefreshOrchestrator>>());
        });
        services.AddSingleton<IInboxRefreshOrchestrator>(sp => sp.GetRequiredService<InboxRefreshOrchestrator>());
```

(c) Insert the rehydrator hosted service **before** the `ViewerLoginHydrator` registration (round-1 ADV-1 — registration order = `StartAsync` order, and `ViewerLoginHydrator.StartAsync` performs a **blocking network** `ValidateCredentialsAsync`; ordering the rehydrator after it would gate the offline instant-paint behind that network timeout). The rehydrator depends only on **on-disk config**, which `ConfigStore` loads synchronously at construction (`CreateConfigStore` → `InitAsync(...).GetAwaiter().GetResult()`), so the last-validated identity is already available before any hosted service runs — the rehydrator does **not** need `ViewerLoginHydrator` to run first:

```csharp
        // #619 — rehydrate the persisted inbox snapshot FIRST (before ViewerLoginHydrator's blocking
        // network ValidateCredentialsAsync, round-1 ADV-1), so _current is set instantly and the offline
        // paint is not gated behind a credential-validation timeout. Reads only on-disk config (loaded by
        // ConfigStore at construction) + the cache file — no network. Still before InboxPoller's first poll.
        services.AddHostedService(sp => new InboxCacheRehydrator(
            sp.GetRequiredService<InboxRefreshOrchestrator>(),
            sp.GetRequiredService<IIdentityKeyedFileCache<InboxSnapshot>>(),
            sp.GetRequiredService<IConfigStore>(),
            sp.GetRequiredService<ILogger<InboxCacheRehydrator>>()));
```

Resulting hosted-service start order: **`InboxCacheRehydrator` → `ViewerLoginHydrator` → `InboxPoller`**. (This refines the spec §4 ordering, which placed the rehydrator after `ViewerLoginHydrator`; see Plan-vs-spec refinement #3.)

- [ ] **Step 5: Run the tests + a build to verify the DI graph resolves**

Run: `dotnet.exe build PRism.Web/PRism.Web.csproj`
Expected: build succeeds (DI graph compiles; the `InboxRefreshOrchestrator` ctor now has the cache arg supplied everywhere).
Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~InboxCacheRehydratorTests"`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/InboxCacheRehydrator.cs PRism.Core/ServiceCollectionExtensions.cs tests/PRism.Core.Tests/Inbox/InboxCacheRehydratorTests.cs
git commit -m "feat(#619): InboxCacheRehydrator hosted service + DI (cache singleton, dual-register orchestrator, hosted order)"
```

---

## Task 5: Evict caches + persist config login at the auth token-change sites

**Files:**
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/AuthCacheEvictionTests.cs` (new)

**Interfaces:**
- Consumes: `IIdentityKeyedFileCache<InboxSnapshot>`, `IIdentityKeyedFileCache<ActivityResponse>` (resolved as delegate params), `IConfigStore.SetDefaultAccountLoginAsync`.
- Produces: awaited `EvictAsync` on both caches at `/connect`, `/connect/commit`, `/replace`, alongside the existing `activityProvider.Reset()`; `SetDefaultAccountLoginAsync` added to `/connect` + `/connect/commit`.

> **Why the activity cache is evicted here even though `ActivityProvider.Reset()` already evicts it (Task 6):** the inbox cache has no `Reset()`, so its eviction MUST live here; evicting the activity cache at the same site too is belt-and-suspenders and keeps the two caches symmetric. The orchestrator has no in-process reset, so the file evict is the only inbox guarantee.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Web.Tests/Endpoints/AuthCacheEvictionTests.cs` (spec tests 15b, 15c). Use the existing `AuthEndpointsTests` factory pattern (inject spies via `WithWebHostBuilder` + `RemoveAll`/`AddSingleton`). Inject a `RecordingIdentityCache<InboxSnapshot>` and `RecordingIdentityCache<ActivityResponse>` as the registered `IIdentityKeyedFileCache<…>` singletons and assert `EvictCount` increments.

```csharp
[Fact] // test 15b — /replace SAME-LOGIN rotation evicts both caches (IdentityChanged does NOT fire here)
public async Task Replace_same_login_rotation_evicts_both_caches()
{
    var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
    var activityCache = new RecordingIdentityCache<ActivityResponse>();
    using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat", priorLogin: "octocat");
    var client = f.CreateAuthenticatedClient();

    var resp = await client.PostAsJsonAsync("/api/auth/replace", new { pat = "ghp_new" });
    resp.EnsureSuccessStatusCode();

    inboxCache.EvictCount.Should().BeGreaterThan(0);
    activityCache.EvictCount.Should().BeGreaterThan(0);
}

[Fact] // test 15b — /connect (no-warning) evicts both caches
public async Task Connect_evicts_both_caches()
{
    var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
    var activityCache = new RecordingIdentityCache<ActivityResponse>();
    using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat");
    var client = f.CreateAuthenticatedClient();

    var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
    resp.EnsureSuccessStatusCode();

    inboxCache.EvictCount.Should().BeGreaterThan(0);
    activityCache.EvictCount.Should().BeGreaterThan(0);
}

[Fact] // test 15b — /connect/commit (post-warning commit) evicts both caches (round-1 SEC-2)
public async Task Connect_commit_after_warning_evicts_both_caches()
{
    var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
    var activityCache = new RecordingIdentityCache<ActivityResponse>();
    // Validator returns a soft warning (NoReposSelected) so /connect does NOT commit; the commit
    // (and thus the eviction) happens at /connect/commit. Mirrors the existing
    // Connect_commit_after_warning_persists_token_and_sets_host test's two-step flow.
    using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat",
        validationWarning: AuthValidationWarning.NoReposSelected);
    var client = f.CreateAuthenticatedClient();

    (await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_warn" })).EnsureSuccessStatusCode();
    inboxCache.EvictCount.Should().Be(0); // not yet — connect returned a warning, no commit

    (await client.PostAsJsonAsync("/api/auth/connect/commit", new { })).EnsureSuccessStatusCode();
    inboxCache.EvictCount.Should().BeGreaterThan(0);   // evicted at commit
    activityCache.EvictCount.Should().BeGreaterThan(0);
}

[Fact] // test 15c — fail-closed: a config-write failure on token change still evicts
public async Task Token_change_still_evicts_when_config_write_throws()
{
    var inboxCache = new RecordingIdentityCache<InboxSnapshot>();
    var activityCache = new RecordingIdentityCache<ActivityResponse>();
    using var f = FactoryWithCaches(inboxCache, activityCache, validatedLogin: "octocat",
        configWriteThrows: true);
    var client = f.CreateAuthenticatedClient();

    var resp = await client.PostAsJsonAsync("/api/auth/connect", new { pat = "ghp_x" });
    resp.EnsureSuccessStatusCode();

    inboxCache.EvictCount.Should().BeGreaterThan(0); // evict precedes/decoupled from the config write
}
```

> **Request-body field is `pat`, not `token` (round-1 SEC-1):** all three endpoints read `doc.RootElement.TryGetProperty("pat", …)` and 400 before any commit/eviction if it's missing — mirror the existing `AuthEndpointsTests`/`AuthReplaceEndpointTests`, which post `new { pat }`.
>
> `FactoryWithCaches(...)` mirrors the existing `AuthEndpointsTests` harness: `RemoveAll<IIdentityKeyedFileCache<InboxSnapshot>>()`/`<ActivityResponse>` + `AddSingleton(...)` the recording caches; a `StubReviewAuth` whose `ValidateCredentialsAsync` returns `validatedLogin` with **`AuthValidationError.None`** and the given `validationWarning` (default none — a no-warning result so `/connect` reaches the commit branch; `NoReposSelected` to drive the two-step `/connect/commit` flow); and (for `configWriteThrows`) an `IConfigStore` decorator whose `SetDefaultAccountLoginAsync` throws. Reuse the existing `StubReviewAuth`/spy plumbing and `CreateAuthenticatedClient()` (which sets the session + Origin headers the endpoints require). Confirm the auth handlers in this harness see the Origin header — the existing tests set it via `CreateAuthenticatedClient`/`AddPrismSessionHeaders`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet.exe test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~AuthCacheEvictionTests"`
Expected: FAIL — no eviction wired.

- [ ] **Step 3: Wire the evictions + config-login persist**

In `PRism.Web/Endpoints/AuthEndpoints.cs`, add the two cache interfaces as delegate parameters to each of the three handlers (`/api/auth/connect`, `/api/auth/connect/commit`, `/api/auth/replace`), e.g. for `/connect`:

```csharp
        app.MapPost("/api/auth/connect", async (HttpContext ctx, ITokenStore tokens, IReviewAuth review,
            IAppStateStore stateStore, IConfigStore config, IViewerLoginProvider viewerLogin,
            IGitHubCredentialHealth credentialHealth, IActivityProvider activityProvider,
            IIdentityKeyedFileCache<PRism.Core.Inbox.InboxSnapshot> inboxCache,
            IIdentityKeyedFileCache<PRism.Core.Activity.ActivityResponse> activityCache,
            InboxRefreshOrchestrator orchestrator,   // #619 concrete (dual-registered) — for InvalidateCacheWritesAsync
            ILogger<Category> log, CancellationToken ct) =>
```

Each handler also takes the concrete `InboxRefreshOrchestrator orchestrator` as a delegate parameter (it's dual-registered per Task 4, and `/replace` already injects the concrete `InboxPoller inboxPoller`, so this is consistent) so it can **quiesce the inbox cache writer before evicting** (round-1 ADV-3).

In `/connect`'s commit branch, **after** `viewerLogin.Set(result.Login ?? "")`, persist the config login (mirroring `/replace:298`), quiesce the writer, and evict both caches (awaited) alongside the existing `Reset()`:

```csharp
            viewerLogin.Set(result.Login ?? "");
            // #619 — persist the config login from the FIRST connect so the rehydrate backstop has a
            // non-empty config identity (today connect only sets the in-memory viewerLogin). Best-effort.
            try
            {
                await config.SetDefaultAccountLoginAsync(result.Login ?? "", ct).ConfigureAwait(false);
            }
#pragma warning disable CA1031 // best-effort; eviction below is fail-closed regardless
            catch (Exception ex) { Log.SetDefaultAccountLoginFailed(log, ex); }
#pragma warning restore CA1031
            activityProvider.Reset();
            // #619 — a token change behaves exactly like a first load: drop both caches (awaited) so the
            // prior identity's data is gone before the response returns. Fail-closed: runs even if the
            // config write above threw. Quiesce the inbox writer FIRST (round-1 ADV-3) so no in-flight/
            // queued coalesced write can re-create inbox-snapshot.json after the delete — which on a
            // same-login rotation the captured-identity stamp + config backstop would both wrongly accept.
            await orchestrator.QuiesceCacheWritesAsync().ConfigureAwait(false);
            await inboxCache.EvictAsync(ct).ConfigureAwait(false);
            await activityCache.EvictAsync(ct).ConfigureAwait(false);
```

In `/connect/commit`, apply the same pattern after `viewerLogin.Set(login ?? "")`: add the `SetDefaultAccountLoginAsync` best-effort call, then the quiesce + two awaited `EvictAsync` calls next to `activityProvider.Reset()`.

In `/replace`, the `SetDefaultAccountLoginAsync` call already exists (line ~298). Add the quiesce + two awaited `EvictAsync` calls next to the unconditional `activityProvider.Reset()` (the one OUTSIDE `if (identityChanged)`, line ~393):

```csharp
            activityProvider.Reset();
            // #619 — evict both cold-start caches on EVERY successful replace (incl. same-login rotation,
            // where IdentityChanged does not fire), alongside Reset(). Quiesce the inbox writer first
            // (round-1 ADV-3); awaited evict — gone before the response.
            await orchestrator.QuiesceCacheWritesAsync().ConfigureAwait(false);
            await inboxCache.EvictAsync(ct).ConfigureAwait(false);
            await activityCache.EvictAsync(ct).ConfigureAwait(false);
```

> **Activity-side residual (round-1 ADV-3, corrected round-2; cross-identity case closed by round-2 SEC-1).** `ActivityProvider.Reset()` must stay **non-blocking** (its contract — it runs on the auth request thread and must not wait on an in-flight fetch), so its write-through `SaveAsync` is fire-and-forget and a save dispatched just before `Reset()` can still land after the awaited `activityCache.EvictAsync`. **The cross-identity half of this is now closed:** with the round-2 SEC-1 fix, that late write is stamped with the login captured **before** the fan-out (the data's true owner), so on an account switch the resurrected file carries the PRIOR owner's identity and the next cold start (under the new owner's config identity) rejects it at the gate — the new account never sees it. What remains is only a **same-login token rotation**, where the resurrected `activity-feed.json` carries the unchanged identity and the backstop accepts it until the next activity fetch overwrites it. **Self-heal path corrected:** this does NOT ride on `inboxPoller.RequestImmediateRefresh()` — that nudges the *inbox* poller, and in `/replace` it's called only inside the `if (identityChanged)` block (which does **not** fire on a same-login rotation), so it neither runs here nor touches the activity feed. The activity file instead self-heals on the **next `/api/activity` fetch** — the rail's ~90s `useActivity` poll, or sooner when the rail is next viewed — which runs under the current identity and rewrites the file (and `Reset()` already incremented the generation, so the in-flight gen-gated write that caused the residual won't itself re-persist). Narrow restart-timing window, accepted as a residual consistent with spec §4 "residual reduced, not zero" — surfaced at the gate. (Fully closing it would require the activity write-through to be generation-checked at the moment of the file write, which the generic cache cannot see; deferred.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet.exe test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~AuthCacheEvictionTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/AuthEndpoints.cs tests/PRism.Web.Tests/Endpoints/AuthCacheEvictionTests.cs
git commit -m "feat(#619): evict cold-start caches (awaited) + persist config login at auth token-change sites"
```

---

## Task 6: Activity provider integration (write-through, rehydrate, evict, `Stale`)

**Files:**
- Modify: `PRism.Core/Activity/ActivityContracts.cs`
- Modify: `PRism.Core/Activity/ActivityProvider.cs`
- Modify: `PRism.Core/ServiceCollectionExtensions.cs` (activity cache singleton)
- Test: `tests/PRism.Core.Tests/Activity/ActivityCacheTests.cs` (new)

**Interfaces:**
- Consumes: `IIdentityKeyedFileCache<ActivityResponse>`, `IViewerLoginProvider`.
- Produces: `ActivityResponse` gains a trailing `bool Stale = false`; `ActivityProvider` ctor gains the two deps; write-through (gen-gated), rehydrate-once (expired `At`), evict-on-`Reset`.

> **Blast radius:** the `ActivityProvider` ctor gains two params and `ActivityResponse` gains a positional. Update every direct `new ActivityResponse(...)` and `new ActivityProvider(...)` call site (test factories in `ActivityProviderTests.cs`, the `RESP`/`resp`/`OneReviewed` builders, and the `Program.cs:119` registration resolves the two new deps from DI automatically — no change there since both are registered).
>
> **Login-provider type asymmetry is intentional (round-1 COH-1).** `ActivityProvider` injects the `IViewerLoginProvider` **interface** (`_viewerLogin.Get()`), while `InboxRefreshOrchestrator` injects a `Func<string>` (`loginCache.Get`, bound at its DI registration). This mirrors each class's existing constructor convention — the orchestrator already took a `Func<string>` before #619; the activity provider takes the interface directly. Not a mistake; no need to unify.

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Activity/ActivityCacheTests.cs` (spec tests 16, 17, 17b, 18). Reuse the existing `ActivityProviderTests` fakes (the three readers + timeline + `TimeProvider` + `IConfigStore`); add a `RecordingIdentityCache<ActivityResponse>` and a stub `IViewerLoginProvider`. Test 17b (round-2 SEC-1) additionally needs: a `loginProvider:` overload of the `ActivityTestData.Provider(...)` factory (a `Func<string>` backing the stub `IViewerLoginProvider`, alongside the existing `login:` string form), the `MutableLogin` helper shared from Task 3, and `SpyReaders.OnFanOutStarted` (the same hook test 17 uses) to flip the login at fan-out start.

```csharp
[Fact] // test 16 — first cold miss with a matching cache rehydrates with an EXPIRED At; next call fetches live
public async Task First_miss_rehydrates_with_expired_At_then_next_call_fetches_live()
{
    var cached = ActivityTestData.Response(prNumber: 1) with { Stale = false };
    var fileCache = new RecordingIdentityCache<ActivityResponse>();
    await fileCache.SaveAsync(cached, new CacheIdentity("octocat", "github.com"), CancellationToken.None);
    var readers = new SpyReaders(); // counts ReadAsync calls
    var sut = ActivityTestData.Provider(fileCache, readers, login: "octocat", host: "github.com");

    var first = await sut.GetActivityAsync(CancellationToken.None);

    first.Stale.Should().BeTrue();
    first.Items.Should().HaveCount(1);
    readers.TotalReads.Should().Be(0); // served from disk, NO GitHub fan-out

    var second = await sut.GetActivityAsync(CancellationToken.None);
    readers.TotalReads.Should().BeGreaterThan(0); // expired At → next call is a live fetch
    second.Stale.Should().BeFalse();
}

[Fact] // test 17 — write-through is generation-gated: a save under a since-rotated generation does not persist
public async Task Write_through_is_generation_gated()
{
    var fileCache = new RecordingIdentityCache<ActivityResponse>();
    var readers = new SpyReaders();
    var sut = ActivityTestData.Provider(fileCache, readers, login: "octocat", host: "github.com");
    readers.OnFanOutStarted = () => sut.Reset(); // rotate generation mid-fetch

    await sut.GetActivityAsync(CancellationToken.None);

    fileCache.Saves.Should().BeEmpty(); // discarded — not persisted under the stale generation
}

[Fact] // test 17b (round-2 SEC-1) — write-through stamps the login captured BEFORE the fan-out, not a flipped one
public async Task Write_through_stamps_login_captured_before_fanout()
{
    var fileCache = new RecordingIdentityCache<ActivityResponse>();
    var login = new MutableLogin("alice");
    var readers = new SpyReaders();
    var sut = ActivityTestData.Provider(fileCache, readers, loginProvider: login.Get, host: "github.com");
    // Flip the login to "bob" the instant the fan-out starts (simulates /connect's Set("bob") landing
    // during the auth handler's SetDefaultAccountLoginAsync await, before activityProvider.Reset() runs).
    // The generation is NOT rotated here, so the write-through's gen gate passes — only the captured-login
    // stamp prevents the cross-identity leak.
    readers.OnFanOutStarted = () => login.Value = "bob";

    await sut.GetActivityAsync(CancellationToken.None);

    fileCache.Saves.Should().ContainSingle();
    fileCache.Saves.Single().Identity.Login.Should().Be("alice"); // stamped pre-fan-out, NOT bob
    fileCache.TryLoad(new CacheIdentity("bob", "github.com")).Should().BeNull();
}

[Fact] // test 18 — Reset evicts the persisted feed
public async Task Reset_evicts_persisted_feed()
{
    var fileCache = new RecordingIdentityCache<ActivityResponse>();
    var sut = ActivityTestData.Provider(fileCache, new SpyReaders(), login: "octocat", host: "github.com");

    sut.Reset();

    fileCache.EvictCount.Should().BeGreaterThan(0);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivityCacheTests"`
Expected: FAIL — `Stale` / new ctor deps / write-through not present.

- [ ] **Step 3: Add `Stale` to `ActivityResponse`**

In `PRism.Core/Activity/ActivityContracts.cs`:

```csharp
public sealed record ActivityResponse(
    IReadOnlyList<ActivityItem> Items,
    System.DateTimeOffset GeneratedAt,
    ActivityDegradation Degraded,
    IReadOnlyList<WatchedRepoActivity> Watching,
    bool Stale = false);   // #619 — true only when serving a rehydrated, not-yet-revalidated feed
```

- [ ] **Step 4: Add the ctor deps + write-through + rehydrate + evict**

In `PRism.Core/Activity/ActivityProvider.cs`, add fields + rehydrate-once guard:

```csharp
    private readonly IIdentityKeyedFileCache<ActivityResponse> _fileCache; // #619
    private readonly IViewerLoginProvider _viewerLogin;                    // #619
    private bool _rehydrateAttempted;                                      // #619 — disk read once, on the cold miss
    // ^ Touched ONLY inside the `_gate`-held section of GetActivityAsync (the rehydrate block runs after
    //   `await _gate.WaitAsync()`), so concurrent first-misses serialize on the gate — no double-read race,
    //   no `volatile` needed. (Round-1 scope-guardian residual: gate-protected, not a data race.)
```

Extend the ctor (add the two params at the end and assign):

```csharp
    public ActivityProvider(
        IReceivedEventsReader events,
        INotificationsReader notifs,
        IWatchedReposReader watched,
        IPrTimelineReader timeline,
        TimeProvider clock,
        IConfigStore config,
        ILogger<ActivityProvider> log,
        IIdentityKeyedFileCache<ActivityResponse> fileCache,   // #619
        IViewerLoginProvider viewerLogin)                      // #619
    {
        // ... existing assignments ...
        _fileCache = fileCache;
        _viewerLogin = viewerLogin;
    }
```

**Capture the login BEFORE the fan-out (round-2 SEC-1 — load-bearing, mirrors the inbox ADV-2 fix).** Right where `host` is computed (`var host = cfg.Github.Host.TrimEnd('/');`, ~line 108) — **before** the GitHub fan-out — also snapshot the login into a local:

```csharp
            var host = cfg.Github.Host.TrimEnd('/');
            var loginSnapshot = _viewerLogin.Get(); // #619 round-2 SEC-1 — capture BEFORE fan-out, like inbox line-175
```

Why: a `_viewerLogin.Get()` re-read at the write-through (post-fan-out) commit can observe a login that `/api/auth/connect` already `Set("bob")` while it was awaiting `SetDefaultAccountLoginAsync` (a real disk-I/O yield) but **before** its `activityProvider.Reset()` ran — so an in-flight poll still passes the generation gate (gen not yet bumped) and stamps alice's feed under bob's identity, which bob then sees on the next cold start. The generation gate alone does not close this (it only catches `Reset()` firing *during* the fan-out, not in the gen-check→commit window). Capturing the login before the fan-out makes the stamp track the data's true owner regardless of a mid-call `Set`. Use `loginSnapshot` (not a fresh `Get()`) in **both** identity constructions below.

In `GetActivityAsync`, inside the gated section, **after** the under-gate TTL re-check and **before** the GitHub fan-out (`var evT = _events.ReadAsync(ct);`), add the one-shot rehydrate:

```csharp
            // #619 — one-shot cold rehydrate: on the genuine first miss, seed _cache from disk with an
            // already-EXPIRED At so THIS call serves the stale rows immediately while the NEXT call is a
            // miss that fetches live (seeding At=now would defer the live fetch up to ~90s).
            if (!_rehydrateAttempted)
            {
                _rehydrateAttempted = true;
                var rid = new CacheIdentity(loginSnapshot, host); // captured-before-fan-out login + trimmed host
                var loaded = _fileCache.TryLoad(rid);
                if (loaded is not null)
                {
                    var stale = loaded with { Stale = true };
                    _cache = new CacheEntry(stale, now - Ttl, gen); // expired At → next GetActivityAsync misses
                    return stale;
                }
            }
```

At the cache-set site (the gen-gated `if (Volatile.Read(ref _generation) == gen) _cache = new CacheEntry(resp, now, gen);`), add the fire-and-forget write-through inside the same generation gate (so a feed built under an about-to-rotate identity is not persisted), using the captured `loginSnapshot` + `host`:

```csharp
            if (Volatile.Read(ref _generation) == gen)
            {
                _cache = new CacheEntry(resp, now, gen);
                // #619 — persist last-known-good (gen-gated by this if). resp.Stale is false here (live);
                // CancellationToken.None so a request-abort doesn't surface an unobserved task exception.
                // Stamp with `loginSnapshot` (captured BEFORE the fan-out, round-2 SEC-1) + the `host` local,
                // NOT a fresh _viewerLogin.Get() — a mid-call token swap must not re-attribute alice's feed to bob.
                _ = _fileCache.SaveAsync(resp, new CacheIdentity(loginSnapshot, host), CancellationToken.None);
            }
```

In `Reset()`, add the evict (fire-and-forget, non-blocking — `Reset()` must stay non-blocking per its contract):

```csharp
    public void Reset()
    {
        Interlocked.Increment(ref _generation);
        _cache = null;
        _ = _fileCache.EvictAsync(CancellationToken.None); // #619 — drop the persisted feed on rotation
    }
```

- [ ] **Step 5: (Activity cache singleton already registered in Task 4)**

The `IIdentityKeyedFileCache<ActivityResponse>` singleton is registered in **Task 4 Step 4(a)** (moved up per round-1 FEAS-2 so Task 5's auth handlers can resolve it). Nothing to register here. The `Program.cs:119` `AddSingleton<IActivityProvider, ActivityProvider>()` now resolves both new ctor deps (`IIdentityKeyedFileCache<ActivityResponse>` + `IViewerLoginProvider`) from DI — no `Program.cs` change required. Verify the build resolves the graph: `dotnet.exe build PRism.Web/PRism.Web.csproj`.

- [ ] **Step 6: Update existing `ActivityResponse` / `ActivityProvider` construction call sites**

The new positional `Stale = false` default keeps existing `new ActivityResponse(items, gen, degraded, watching)` calls compiling (it's optional). The new `ActivityProvider` ctor params are required — update direct constructions in `tests/PRism.Core.Tests/Activity/ActivityProviderTests.cs` to pass a `RecordingIdentityCache<ActivityResponse>` (or a no-op stub) and a stub `IViewerLoginProvider`. Run a build to surface every site:

Run: `dotnet.exe build tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
Fix each `new ActivityProvider(...)` call the compiler flags.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `dotnet.exe test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivityCacheTests|FullyQualifiedName~ActivityProviderTests"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
# Round-2 COH-1: ServiceCollectionExtensions.cs is NOT staged here — the activity cache singleton was
# registered in Task 4 (round-1 FEAS-2). This task changes only contracts + provider + tests.
git add PRism.Core/Activity/ActivityContracts.cs PRism.Core/Activity/ActivityProvider.cs tests/PRism.Core.Tests/Activity/
git commit -m "feat(#619): activity provider cold-start cache — write-through, rehydrate-with-expired-TTL, evict-on-Reset, stale flag"
```

---

## Task 7: Surface `stale` on `InboxResponse`

**Files:**
- Modify: `PRism.Web/Endpoints/InboxDtos.cs`
- Modify: `PRism.Web/Endpoints/InboxEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/InboxStaleFlagTests.cs` (new)

**Interfaces:**
- Consumes: `IInboxRefreshOrchestrator.IsServingRehydratedSnapshot` (Task 2).
- Produces: `InboxResponse.Stale` (camelCase `stale` on the wire).

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Endpoints/InboxStaleFlagTests.cs`. Drive the orchestrator into a rehydrated state and assert the GET body carries `stale: true`; after a successful refresh, `stale: false`. Use the existing inbox endpoint test harness (real orchestrator via `PRismWebApplicationFactory` with fake readers, or a stub `IInboxRefreshOrchestrator` exposing `IsServingRehydratedSnapshot`).

```csharp
[Fact]
public async Task Inbox_GET_reports_stale_true_while_serving_rehydrated_snapshot()
{
    using var f = InboxTestFactory.WithRehydratedOrchestrator(serving: true);
    var client = f.CreateAuthenticatedClient();
    var body = await client.GetFromJsonAsync<JsonElement>("/api/inbox");
    body.GetProperty("stale").GetBoolean().Should().BeTrue();
}

[Fact]
public async Task Inbox_GET_reports_stale_false_when_not_rehydrated()
{
    using var f = InboxTestFactory.WithRehydratedOrchestrator(serving: false);
    var client = f.CreateAuthenticatedClient();
    var body = await client.GetFromJsonAsync<JsonElement>("/api/inbox");
    body.GetProperty("stale").GetBoolean().Should().BeFalse();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet.exe test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~InboxStaleFlagTests"`
Expected: FAIL — `stale` not in the response.

- [ ] **Step 3: Add the field + mapping**

In `PRism.Web/Endpoints/InboxDtos.cs`, append `Stale`:

```csharp
internal sealed record InboxResponse(
    IReadOnlyList<InboxSectionDto> Sections,
    IReadOnlyDictionary<string, InboxItemEnrichment> Enrichments,
    DateTimeOffset LastRefreshedAt,
    bool TokenScopeFooterEnabled,
    bool CiProbeComplete,
    IReadOnlyCollection<string> AiEnrichmentSettled,
    bool Stale);   // #619
```

In `PRism.Web/Endpoints/InboxEndpoints.cs`, pass the flag at the `new InboxResponse(...)` site (line ~69):

```csharp
            return Results.Ok(new InboxResponse(
                sections, snap.Enrichments, snap.LastRefreshedAt,
                config.Current.Inbox.ShowHiddenScopeFooter, snap.CiProbeComplete,
                snap.AiEnrichmentSettled.ToArray(),
                orch.IsServingRehydratedSnapshot));   // #619
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet.exe test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~InboxStaleFlagTests"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Endpoints/InboxDtos.cs PRism.Web/Endpoints/InboxEndpoints.cs tests/PRism.Web.Tests/Endpoints/InboxStaleFlagTests.cs
git commit -m "feat(#619): surface stale flag on InboxResponse"
```

---

## Task 8: Frontend wire types + test/fixture updates for `stale`

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/hooks/useActivity.test.tsx`, `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx`
- Modify: any `frontend/e2e` inbox route-mock body constructing an `InboxResponse`

**Interfaces:**
- Produces: `InboxResponse.stale: boolean`, `ActivityResponse.stale: boolean`.

> Per the `nonoptional-wire-field-escapes-e2e-route-mocks` discipline: a non-optional `stale` escapes `tsc` in Playwright `route.fulfill` JSON and `as any` bodies. The activity rail has **no** e2e route mock (it's served by the real `FakeActivityProvider`), but the inbox **does** have e2e route mocks. Grep `frontend/e2e` for inbox response bodies and add `stale: false`.

- [ ] **Step 1: Add the wire fields**

In `frontend/src/api/types.ts`:

```ts
export interface InboxResponse {
  sections: InboxSection[];
  enrichments: Record<string, InboxItemEnrichment>;
  lastRefreshedAt: string;
  tokenScopeFooterEnabled: boolean;
  ciProbeComplete: boolean;
  aiEnrichmentSettled: string[];
  stale: boolean; // #619 — true while serving a rehydrated, not-yet-revalidated snapshot
}
```

```ts
export interface ActivityResponse {
  items: ActivityItem[];
  generatedAt: string;
  degraded: ActivityDegradation;
  watching: WatchedRepoActivity[];
  stale: boolean; // #619
}
```

- [ ] **Step 2: Update unit-test factories**

In `frontend/src/hooks/useActivity.test.tsx` `RESP(n)` factory, add `stale: false,`. In `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx` `resp(partial)` factory, add `stale: false,` to the base object.

- [ ] **Step 3: Update inbox e2e route mocks + any inbox unit-test fixtures**

Run a search to find every inbox response body:

Run: `git grep -n "lastRefreshedAt\|aiEnrichmentSettled" frontend/e2e frontend/src`
For each Playwright `route.fulfill` / `as any` body and each inbox unit-test `InboxResponse` fixture, add `stale: false,` so `tsc -b` and the strict route bodies stay valid.

- [ ] **Step 4: Typecheck**

Run (from `frontend/`): `npx tsc -b`
Expected: no type errors (vacuous-noEmit avoided — `tsc -b` per the `tsc-noemit-vacuous` discipline).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/hooks/useActivity.test.tsx frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx frontend/e2e
git commit -m "feat(#619): add stale to InboxResponse/ActivityResponse FE types + fixtures"
```

---

## Task 9: Inbox refreshing affordance (content-not-skeleton, in-flight bar, stale aria)

**Files:**
- Modify: `frontend/src/pages/InboxPage.tsx`
- Modify: `frontend/src/hooks/useInbox.ts` (expose an in-flight flag distinct from the cold `isLoading`)
- Test: `frontend/src/pages/InboxPage.test.tsx` (extend)

**Interfaces:**
- Consumes: `data.stale` (Task 8).
- Produces: a stale-onset announcement region; the cold-start branch renders content (not skeleton) whenever `data` exists.

> The cold-start branch already shows content when `data` exists for the *normal* loaded path (line ~146). The behavioral change for #619: the rehydrated GET returns `data` with `stale: true`, so the existing `isLoading && !data` gate already falls through to content — **good**. What's missing per spec §9 / test 19, 19b, 20: (a) a one-shot stale-onset aria announcement, and (b) the `LoadingBar` must reflect an *in-flight fetch attempt*, NOT a permanent `stale`-keyed spin (so an offline launch with failing revalidation doesn't spin forever).

- [ ] **Step 1: Write the failing tests**

Extend `frontend/src/pages/InboxPage.test.tsx` (spec tests 19, 19b, 20-stale-onset). Using the house `vi.mock('../hooks/useInbox')` pattern:

```tsx
it('renders content (not skeleton) when stale data is present', () => {
  setHooks({ inbox: { data: staleInbox(), error: null, isLoading: false, reload: vi.fn() } });
  renderPage();
  expect(screen.getByTestId('inbox-page')).toBeInTheDocument();
  expect(screen.queryByTestId('inbox-skeleton')).not.toBeInTheDocument();
});

it('announces "Showing saved inbox" once when stale first becomes true', () => {
  const { rerender } = renderPageWith({ data: staleInbox(), isLoading: false });
  expect(screen.getByTestId('inbox-stale-status')).toHaveTextContent('Showing saved inbox');
  // a re-render with stale still true does not re-announce (text stable, fired once)
});

it('does not pin the LoadingBar on while stale (offline failing revalidation)', () => {
  setHooks({ inbox: { data: staleInbox(), error: null, isLoading: false, isFetching: false, reload: vi.fn() } });
  renderPage();
  expect(screen.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'false');
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from `frontend/`): `npm run test -- InboxPage`
Expected: FAIL — no stale-status region; bar still keyed off `isLoading || isRefreshing` only.

- [ ] **Step 3: Expose an in-flight flag from `useInbox`**

In `frontend/src/hooks/useInbox.ts`, add an `isFetching` boolean (true for the duration of a `reload()` attempt regardless of whether `data` already exists), distinct from the cold `isLoading` (which the skeleton uses). Set it true at the top of `reload`, false in the same places `setIsLoading(false)` is set. Return it from the hook and its type.

```ts
  const [isFetching, setIsFetching] = useState(false);
  // ...in reload(): setIsFetching(true) at the top; setIsFetching(false) wherever the loop exits.
  return { data, error, isLoading, isFetching, reload };
```

- [ ] **Step 4: Wire the bar + stale announcement in `InboxPage`**

Drive the loaded-branch `LoadingBar` off the in-flight fetch (plus manual refresh), not stale:

```tsx
      <LoadingBar active={isFetching || isRefreshing} data-testid="inbox-loading-bar" />
```

Add a one-shot stale-onset announcement (a third sr-only live region; fire its text once on the false→true `stale` edge via a ref-guarded effect):

```tsx
  const [staleAnnounce, setStaleAnnounce] = useState('');
  const wasStale = useRef(false);
  useEffect(() => {
    const stale = !!data?.stale;
    if (stale && !wasStale.current) setStaleAnnounce('Showing saved inbox');
    if (!stale && wasStale.current) setStaleAnnounce('Inbox updated');
    wasStale.current = stale;
  }, [data?.stale]);
```

```tsx
        <div className="sr-only" role="status" aria-live="polite" data-testid="inbox-stale-status">
          {staleAnnounce}
        </div>
```

- [ ] **Step 5: Run to verify they pass + full FE suite for the aria/skeleton change**

Run (from `frontend/`): `npm run test -- InboxPage`
Expected: PASS.
Run the FULL suite (aria/skeleton-branch regressions have bitten before — `reference_test_readonly_during_async...`): `npm run test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/InboxPage.tsx frontend/src/hooks/useInbox.ts frontend/src/pages/InboxPage.test.tsx
git commit -m "feat(#619): inbox refreshing affordance — content-not-skeleton, in-flight bar, stale-onset aria"
```

---

## Task 10: "Updated <age>" pill (>30 min, ticker, reserve-space, aria-once)

**Files:**
- Create: `frontend/src/components/Inbox/StalePill/StalePill.tsx` + `StalePill.module.css`
- Create: `frontend/src/components/Inbox/StalePill/__tests__/StalePill.test.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx` (mount the pill; placement default per §9, finalized at the visual mockup)

**Interfaces:**
- Consumes: `data.lastRefreshedAt`, `formatAge` (`src/utils/relativeTime.ts`).
- Produces: `export const STALE_LABEL_THRESHOLD_MS = 30 * 60_000;` and `<StalePill lastRefreshedAt={...} />`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/Inbox/StalePill/__tests__/StalePill.test.tsx` (spec tests 20-pill, 21b). Use vitest fake timers for the ~60s ticker.

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StalePill } from '../StalePill';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('StalePill', () => {
  it('is absent for a fresh (<30 min) cache', () => {
    render(<StalePill lastRefreshedAt={minsAgo(5)} />);
    expect(screen.queryByTestId('inbox-stale-pill')).not.toBeInTheDocument();
  });

  it('renders "Updated <age>" when older than 30 min', () => {
    render(<StalePill lastRefreshedAt={minsAgo(125)} />);
    const pill = screen.getByTestId('inbox-stale-pill');
    expect(pill).toHaveTextContent(/Updated 2h ago/);
    expect(pill).toHaveAttribute('role', 'status');
  });

  it('appears once the ~60s ticker crosses the 30-min threshold', () => {
    render(<StalePill lastRefreshedAt={minsAgo(29)} />);
    expect(screen.queryByTestId('inbox-stale-pill')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(120_000); }); // cross 30 min
    expect(screen.getByTestId('inbox-stale-pill')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from `frontend/`): `npm run test -- StalePill`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the pill**

Create `frontend/src/components/Inbox/StalePill/StalePill.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { formatAge } from '../../../utils/relativeTime';
import styles from './StalePill.module.css';

export const STALE_LABEL_THRESHOLD_MS = 30 * 60_000; // #619 owner-chosen, tunable
const TICK_MS = 60_000;

interface StalePillProps {
  lastRefreshedAt: string;
}

/**
 * #619 — "Updated <age>" pill, shown only when the data is older than STALE_LABEL_THRESHOLD_MS.
 * Reserve-space: the container is always in the DOM at constant height (empty when hidden) so its
 * appearance/disappearance never reflows the toolbar. Announces its text once on threshold entry.
 */
export function StalePill({ lastRefreshedAt }: StalePillProps) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), TICK_MS); // re-evaluate age + threshold while idle
    return () => clearInterval(id);
  }, []);

  const ageMs = Date.now() - new Date(lastRefreshedAt).getTime();
  const show = Number.isFinite(ageMs) && ageMs > STALE_LABEL_THRESHOLD_MS;

  // Round-1 DES-2: announce via a PERSISTENTLY-MOUNTED live region whose text is set in an EFFECT on
  // the hidden→shown edge — NOT by toggling aria-live on a conditionally-mounted span or mutating a ref
  // during render (both fail under React strict-mode double-invoke and across AT engines). Mirrors the
  // InboxPage stale-onset pattern (Task 9).
  const [announceText, setAnnounceText] = useState('');
  const wasShown = useRef(false);
  useEffect(() => {
    if (show && !wasShown.current) setAnnounceText(`Inbox last updated ${formatAge(lastRefreshedAt)}`);
    wasShown.current = show;
  }, [show, lastRefreshedAt]);

  return (
    <div className={styles.slot} data-reserved="true">
      {/* Always-mounted sr-only live region — the announcement channel, separate from the visible pill.
          Uses the GLOBAL `sr-only` utility (which pins top:0;left:0), NOT a module class, and the .slot
          below sets position:relative — together they keep the abspos region clipped INSIDE the slot
          instead of escaping to the page and extending scroll height (round-2 DES-2; #197 /
          reference_sr_only_abspos_page_scroll). Mirrors Task 9's `className="sr-only"`. */}
      <span className="sr-only" role="status" aria-live="polite">{announceText}</span>
      {show && (
        <span className={styles.pill} data-testid="inbox-stale-pill">
          Updated {formatAge(lastRefreshedAt)}
        </span>
      )}
    </div>
  );
}
```

> The sr-only live region uses the **global** `sr-only` utility class (`className="sr-only"`, as in Task 9) — do NOT add a module `.sr` class. The global utility already pins `top:0; left:0`; combined with `position: relative` on `.slot` below, the absolutely-positioned region stays clipped inside the slot. A module `.sr` that omitted those pins reproduced the page-scroll bug (round-2 DES-2; #197 / `reference_sr_only_abspos_page_scroll`: an abspos `.sr-only` with no positioned ancestor escapes its pane and extends page scroll height).

Create `frontend/src/components/Inbox/StalePill/StalePill.module.css` (chip-token styling; reserve-space constant height):

```css
.slot {
  position: relative; /* round-2 DES-2 — contain the global sr-only abspos region so it can't escape and scroll the page */
  min-height: 24px;   /* reserve space so show/hide never reflows the toolbar */
  display: flex;
  align-items: center;
}
.pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: 11px;
  font-size: 0.75rem;
  color: var(--text-3);
  background: var(--surface-3);
  border: 1px solid var(--border-1);
  white-space: nowrap;
}
```

> **Tokens corrected (round-1 DES-1):** `--text-muted` and `--border-subtle` do **not** exist in `tokens.css` (CSS custom props fail silently → wrong inherited color + no border); `--surface-2` exists but is the panel surface, not the chip surface. Use `--text-3` (the global `.muted` mapping), `--surface-3` (the `.chip` base surface), and `--border-1` (lightest border in the scale) — the tokens the existing category chip actually uses. Verify both themes at the visual mockup (oklch surface scales are theme-asymmetric — `reference_oklch_surface_scale_asymmetry...`).

- [ ] **Step 4: Mount the pill in the toolbar (default placement; finalized at mockup)**

In `frontend/src/pages/InboxPage.tsx`, render `<StalePill lastRefreshedAt={data.lastRefreshedAt} />` at the default placement — inline in the search toolbar next to the facet/sort dropdowns (candidate (a), §9). The exact placement (toolbar-inline vs. above-toolbar band) is finalized at the visual sign-off (Task 14); the reserve-space slot keeps either placement reflow-free.

- [ ] **Step 5: Run to verify they pass**

Run (from `frontend/`): `npm run test -- StalePill`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Inbox/StalePill/ frontend/src/pages/InboxPage.tsx
git commit -m "feat(#619): Updated-age pill (>30 min, ~60s ticker, reserve-space, aria-once)"
```

---

## Task 11: GitHub-unreachable snackbar (StreamHealthSnackbar pattern)

**Files (Option B):**
- Create: `PRism.Core/Inbox/InboxRefreshStatus.cs` (`record InboxRefreshStatus(bool Ok) : IReviewEvent`)
- Modify: `PRism.Core/Inbox/InboxPoller.cs` (inject `IReviewEventBus`; publish status per tick, NOT on rate-limit)
- Modify: `PRism.Core/ServiceCollectionExtensions.cs` (the `InboxPoller` factory at ~125–135 — pass the new `IReviewEventBus` arg)
- Modify: `PRism.Web/Sse/SseChannel.cs` (forward `InboxRefreshStatus` → `inbox-refresh-status`: Subscribe + handler + Dispose unsubscribe)
- Modify: `frontend/src/api/events.ts` (register `inbox-refresh-status` in BOTH `EventPayloadByType` and `EVENT_TYPES`)
- Create: `frontend/src/hooks/useInboxRefreshHealth.ts` (subscribe to the SSE event → debounced `failing`)
- Create: `frontend/src/components/GitHubUnreachableSnackbar/GitHubUnreachableSnackbar.tsx`
- Create: `frontend/src/components/GitHubUnreachableSnackbar/__tests__/GitHubUnreachableSnackbar.test.tsx`
- Modify: `frontend/src/pages/InboxPage.tsx` (mount it; suppress under `StreamHealthSnackbar`; mutual-exclusion with cold-load `ErrorModal`)

> ### ⚠️ ROUND-1 BLOCKER — gate decision required before executing this task
>
> **Three reviewers (product, feasibility, design) independently found that the originally-planned failure
> source cannot observe GitHub-unreachability**, the snackbar's headline scenario. Verified against code:
> `useInboxUpdates` is purely **SSE-event-driven** (`stream.on('inbox-updated', …)`), not a poller — and a
> GitHub-unreachable `RefreshAsync` **throws before** publishing `inbox-updated`, so no event fires and the
> hook's `catch` never runs. Separately, `GET /api/inbox` returns **HTTP 200 + the cached snapshot** when
> GitHub is down (it serves `orch.Current`), so `useInbox.reload()` doesn't throw either. The only thing that
> throws is a **backend**-down state — which is `StreamHealthSnackbar`'s domain, under which this snackbar is
> explicitly *suppressed*. Net: as originally written, the snackbar **can never fire** for the offline-cold-launch
> case (test 19b) or the degraded-live-session case (§9 13r-PROD1) it exists to cover.
>
> The spec §12 decision 9 explicitly makes the snackbar **independently descope-able**. So this is a genuine
> owner decision — resolved at the B1 gate (see the gate question). The three options:
> - **(A) Descope the snackbar to a follow-up issue (de-risk).** Ship the core cache + refreshing bar + pill now;
>   the snackbar + its detection mechanism land as a tracked follow-up. Offline users still see cached data
>   (+ pill if aged); manual-refresh failures still toast. Spec-sanctioned, smallest PR.
> - **(B) Add a backend refresh-status SSE signal (full coverage — specified below).** `InboxPoller` publishes a
>   refresh-outcome event the FE consumes to drive `failing` (debounced). Covers **both** offline-cold-launch
>   and mid-session degrade. **Round-2 raised B's real cost** beyond the round-1 scoping: a whole-contract backend
>   surface (new `IReviewEvent`; `SseChannel` 3-site forwarding; `InboxPoller` DI-factory change; `events.ts`
>   double-map registration — FEAS-1/2/3) **plus** signal-semantics leaks (a 429 must be excluded or it false-fires;
>   the binary `Ok` can't see partial degradation and a flap must cancel the armed timer — ADV-2/3). Scope-guardian
>   judged this surface **disproportionate** to a non-blocking pill on a local single-owner tool (SCOPE-1).
> - **(C) FE-only staleness watchdog (partial).** A FE timer sets `failing` when `data.stale` persists past a
>   window. Covers offline-cold-launch only (mid-session degrade has `stale:false`, so it's NOT covered). Cheapest;
>   **none of B's FEAS-1/2/3 surface and none of B's ADV-2/3 signal leaks apply** (no backend contract, no binary
>   Ok). Doesn't meet the spec's mid-session intent — but round-2 product (PROD-1) notes mid-session isn't truly
>   "blind" without it: the StalePill is a slower fallback cue, and a sustained mid-session GitHub outage on a
>   local tool is rare.
>
> **Round-2 recommendation: C (or A), not B.** The accumulated integration cost (FEAS-1/2/3), signal leakiness
> (ADV-2/3), and disproportion (SCOPE-1) make B the most expensive option for the least-blocking surface in the
> feature. C delivers the owner's headline ask — a non-blocking "data isn't refreshing" cue on an offline cold
> launch, in the same visual family as the backend-connection snackbar — at a fraction of B's surface; A ships
> the rest now and tracks the cue as a follow-up. **The steps below remain written for Option (B)** (corrected per
> round-2 so B is executable if the owner still wants mid-session coverage). If the gate picks (A), delete this
> task and file the follow-up; if (C), replace Step 1/1b's backend signal with the FE watchdog timer
> (`failing := data.stale persisted > window`), keeping Steps 2–6 (the snackbar component + mount) unchanged.

**Interfaces:**
- Consumes: the generic `<Snackbar tone="warning" .../>`, `useStreamHealth().healthy`, and a new `inbox-refresh-status` SSE event (Option B).
- Produces: `<GitHubUnreachableSnackbar failing={boolean} onRetry={() => void} suppressed={boolean} />`; a new backend `InboxRefreshStatus(bool Ok)` domain event + SSE forwarding.

> Mirrors `StreamHealthSnackbar` precisely (spec §9): steady-state (renders on the steady failing state, not only on the edge), ~30s debounce before showing (sustained failure), pinned through the episode until a fetch succeeds, dismiss-on-edge (once per episode), suppressed when `StreamHealthSnackbar` is visible (shared `position:fixed` slot), and mutually exclusive with the cold-load `ErrorModal` (`error && data` vs `error && !data`). Background-poll failure → this snackbar; manual-refresh failure keeps the existing `useInboxRefresh` toast (one path per failure).

- [ ] **Step 1: Backend — publish a refresh-status SSE event the FE can observe (Option B)**

The FE has no way to observe a backend→GitHub refresh failure today (see the blocker callout). Add a backend signal. **Four exact seams (round-2 FEAS-2/3, ADV-2) — get these right or the event silently never reaches the FE:**

1. **New domain event — MUST implement `IReviewEvent`.** `public sealed record InboxRefreshStatus(bool Ok) : IReviewEvent;` in `PRism.Core/Inbox/` (beside `InboxUpdated`, which also implements `IReviewEvent`). `IReviewEventBus.Publish<TEvent>` is constrained `where TEvent : IReviewEvent`; without the interface it will not compile (round-2 FEAS-2).
2. **Publish from `InboxPoller` — and fix its DI registration.** Inject `IReviewEventBus` into `InboxPoller` (a new ctor param). **This breaks the dual `AddSingleton`/`AddHostedService` factory at `ServiceCollectionExtensions.cs:~125–135`, which `new InboxPoller(...)`s with the current 4 args** — update that factory to resolve and pass `IReviewEventBus` too, or the host fails to build (round-2 FEAS-3). In `ExecuteAsync`, publish each tick's outcome: after a successful `RefreshAsync`, `_events.Publish(new InboxRefreshStatus(true))`. In the generic `catch (Exception ex)` branch (line 69–72), after the existing log, `_events.Publish(new InboxRefreshStatus(false))`. **Do NOT publish `false` from the `catch (RateLimitExceededException)` branch (line 63–67)** — a 429 is a deliberate, expected backoff, not GitHub-unreachability; publishing `false` there would raise a spurious "Couldn't reach GitHub" snackbar during normal rate-limit pacing (round-2 ADV-2). Leave the rate-limit branch as-is (it already honors `Retry-After`); optionally publish `InboxRefreshStatus(true)` there is **wrong** too (it isn't a success) — publish nothing, so the FE state is simply held. Decoupling from the diff-gated `InboxUpdated` means a recovered-but-unchanged refresh still reports `Ok=true`.
3. **Forward over SSE in `SseChannel.cs` (NOT an "endpoint").** `SseChannel` is where `InboxUpdated` → `inbox-updated` forwarding lives, across **three** sites that must all be touched (round-2 FEAS-2): (a) the ctor `Subscribe<InboxRefreshStatus>(OnInboxRefreshStatus)` next to the existing `Subscribe<InboxUpdated>` (~line 80); (b) a new `OnInboxRefreshStatus` handler that enqueues an `inbox-refresh-status` frame carrying `{ ok }` (mirror `OnInboxUpdated`, ~line 296–306); (c) the matching unsubscribe in `Dispose` (~line 425). Miss the Dispose site and you leak a subscription per SSE connection.
4. **Register the FE event in `events.ts` — BOTH maps (round-2 FEAS-1/DES-1).** `inbox-refresh-status` must be added to **both** the `EventPayloadByType` map (typing the `{ ok: boolean }` payload, ~line 62–78) **and** the `EVENT_TYPES` array that the `addEventListener` loop iterates (~line 83–99). The array drives which SSE event names are actually subscribed; an entry in the payload map alone is silently never listened for. This is a frontend change but it's the other half of the backend signal — do it in this step so the contract is whole.

Write backend tests first: `InboxPoller` publishes `InboxRefreshStatus(false)` on a throwing `RefreshAsync`, `InboxRefreshStatus(true)` on a successful one, and **publishes neither `true` nor `false` on a `RateLimitExceededException`** (fake orchestrator + recording bus, round-2 ADV-2); `SseChannel` emits an `inbox-refresh-status` frame on the event.

- [ ] **Step 1b: Frontend — derive a debounced `failing` flag from the SSE signal**

Add a hook (e.g. `useInboxRefreshHealth`) that subscribes to the `inbox-refresh-status` SSE event via `useEventSource` (registered in `events.ts` per Step 1.4) and exposes `failing: boolean`: arm a ~30s timer (mirroring `UNHEALTHY_AFTER_MS`) on the first `ok:false`; set `failing=true` if it stays failing past the window (debounces a single blip). On **any** `ok:true`, clear `failing` **and cancel the armed arm-timer** — a flap (`false → true` before the window elapses) must disarm the pending timer, else it fires later and spuriously sets `failing` even though the latest signal was a success (round-2 ADV-3). Keep current data (no clear). Write focused tests: one `ok:false` does NOT set `failing` (debounce); sustained `ok:false` DOES; a subsequent `ok:true` clears it; and a `false → true` flap **within** the window leaves `failing` false (the armed timer was cancelled).

> **Documented Option-B limitation (round-2 ADV-3) — surfaced at the gate.** `Ok` is binary. A *partial* GitHub degradation where `RefreshAsync` returns a degraded-but-non-throwing result reports `Ok=true`, so this signal does NOT cover partial outages — only a refresh that actually throws drives `Ok=false`. Whether a total outage reliably throws (vs. returning an empty/degraded snapshot) depends on `QueryAllAsync`'s failure mode, which the implementer must confirm at execution; if it swallows total-outage errors into a degraded result, Option B under-fires and Option C's staleness watchdog would be the more reliable detector. This leakiness is part of the A/B/C gate tradeoff.

- [ ] **Step 2: Write the failing snackbar tests**

Create `frontend/src/components/GitHubUnreachableSnackbar/__tests__/GitHubUnreachableSnackbar.test.tsx` (spec tests 20b, 21):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitHubUnreachableSnackbar } from '../GitHubUnreachableSnackbar';

describe('GitHubUnreachableSnackbar', () => {
  it('shows the warning pill on a sustained failure', () => {
    render(<GitHubUnreachableSnackbar failing onRetry={vi.fn()} suppressed={false} />);
    expect(screen.getByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(screen.getByText('Retry now')).toBeInTheDocument();
  });

  it('is suppressed when the backend-connection snackbar is up', () => {
    render(<GitHubUnreachableSnackbar failing onRetry={vi.fn()} suppressed />);
    expect(screen.queryByText(/Couldn't reach GitHub/)).not.toBeInTheDocument();
  });

  it('renders nothing when not failing', () => {
    render(<GitHubUnreachableSnackbar failing={false} onRetry={vi.fn()} suppressed={false} />);
    expect(screen.queryByText(/Couldn't reach GitHub/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Implement the snackbar**

Create `frontend/src/components/GitHubUnreachableSnackbar/GitHubUnreachableSnackbar.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Snackbar } from '../Snackbar';

interface Props {
  failing: boolean;   // sustained background-fetch failure (debounced upstream in useInboxUpdates)
  onRetry: () => void;
  suppressed: boolean; // true when StreamHealthSnackbar (FE↔backend down) is visible
}

/**
 * #619 — non-blocking "Couldn't reach GitHub" pill on a sustained background-fetch failure. Modeled on
 * StreamHealthSnackbar: steady-state render, pinned through the episode, dismiss-once-per-episode,
 * suppressed under the more-fundamental backend-connection snackbar (shared fixed slot). Mutually
 * exclusive with the cold-load ErrorModal — mount this only when cached data is present (caller gates).
 */
export function GitHubUnreachableSnackbar({ failing, onRetry, suppressed }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const wasFailing = useRef(failing);
  useEffect(() => {
    if (!wasFailing.current && failing) setDismissed(false); // fresh failing edge re-shows
    wasFailing.current = failing;
  }, [failing]);

  if (!failing || dismissed || suppressed) return null;

  return (
    <Snackbar
      tone="warning"
      message="Couldn't reach GitHub — retrying"
      action={{ label: 'Retry now', onClick: onRetry }}
      onDismiss={() => setDismissed(true)}
      role="status"
      ariaLive="polite"
    />
  );
}
```

- [ ] **Step 4: Mount it in `InboxPage` with suppression + mutual-exclusion**

In `frontend/src/pages/InboxPage.tsx`: read `const { healthy } = useStreamHealth();` and `const { failing } = useInboxRefreshHealth();` (the new Option-B hook). Mount the snackbar in the loaded branch (where `data` is present — so it never co-fires with the cold-load `ErrorModal` at `error && !data`):

```tsx
      <GitHubUnreachableSnackbar
        failing={failing}
        onRetry={() => void reload()}
        suppressed={!healthy}
      />
```

- [ ] **Step 5: Run the tests + full suite**

Run the backend tests (Option B): `dotnet.exe test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~InboxRefreshStatus"` and the poller test in `PRism.Core.Tests`.
Run (from `frontend/`): `npm run test -- GitHubUnreachableSnackbar useInboxRefreshHealth InboxPage`
Expected: PASS.
Run the full suite: `npm run test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
# SSE forwarding lives in PRism.Web/Sse/SseChannel.cs (3 sites); FE event registration in frontend/src/api/events.ts
# (both maps); InboxPoller DI fix in PRism.Core/ServiceCollectionExtensions.cs (round-2 FEAS-1/2/3).
git add PRism.Core/Inbox/InboxRefreshStatus.cs PRism.Core/Inbox/InboxPoller.cs PRism.Core/ServiceCollectionExtensions.cs PRism.Web/Sse/SseChannel.cs frontend/src/api/events.ts frontend/src/hooks/useInboxRefreshHealth.ts frontend/src/components/GitHubUnreachableSnackbar/ frontend/src/pages/InboxPage.tsx tests/
git commit -m "feat(#619): GitHub-unreachable snackbar via inbox-refresh-status SSE signal (debounced, pinned, suppressed under StreamHealthSnackbar)"
```

---

## Task 12: Activity rail FE (stale immediate refetch + "saved" header)

**Files:**
- Modify: `frontend/src/hooks/useActivity.ts`
- Modify: `frontend/src/components/ActivityRail/ActivityRail.tsx`
- Test: `frontend/src/hooks/useActivity.test.tsx`, `frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx` (extend)

**Interfaces:**
- Consumes: `ActivityResponse.stale` (Task 8).
- Produces: an immediate refetch when a fetched response is `stale`; the rail "last 24h" header swaps to "saved" (both header spots) while stale.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/hooks/useActivity.test.tsx` (spec test 22), assert that a `stale: true` response triggers a second fetch WITHOUT advancing the 90s timer:

```tsx
it('immediately refetches when the response is stale', async () => {
  getActivityMock
    .mockResolvedValueOnce({ ...RESP(1), stale: true })
    .mockResolvedValueOnce({ ...RESP(2), stale: false });
  const { result } = renderHook(() => useActivity());
  await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(2)); // refetched without the 90s tick
  expect(getActivityMock).toHaveBeenCalledTimes(2);
});
```

In `ActivityRail.test.tsx`, assert the header swap:

```tsx
it('shows "saved" instead of "last 24h" when the feed is stale', () => {
  railProps = { data: resp({ items: [], stale: true }), isLoading: false, error: null };
  renderRail();
  expect(screen.queryByText('last 24h')).not.toBeInTheDocument();
  expect(screen.getAllByText('saved').length).toBeGreaterThan(0);
});

it('restores "last 24h" when not stale', () => {
  railProps = { data: resp({ items: [], stale: false }), isLoading: false, error: null };
  renderRail();
  expect(screen.getAllByText('last 24h').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from `frontend/`): `npm run test -- useActivity ActivityRail`
Expected: FAIL.

- [ ] **Step 3: Add the immediate refetch in `useActivity`**

In `frontend/src/hooks/useActivity.ts`, declare `let immediateRefetchFired = false;` at the top of the polling `useEffect` body (next to the existing `let cancelled = false;`, so it resets on each mount). Then, after `setData(next)` in `poll()`, if `next.stale` schedule an immediate re-poll (microtask), guarded by that flag so it fires at most once per mount (not a loop if the backend keeps returning stale):

```ts
        const next = await getActivity();
        if (cancelled) return;
        cachedActivity = next;
        setData(next);
        setError(null);
        if (next.stale && !immediateRefetchFired) {
          // #619 — the rehydrated feed is stale; nudge an immediate live fetch rather than waiting ~90s.
          // The backend seeds an expired TTL so this refetch is a real GitHub read. Round-1 DES-4: gate
          // on an explicit one-shot flag (scoped to this effect closure) so a backend that returns
          // stale:true twice cannot trigger an unbounded fetch loop — don't rely on backend behavior
          // as the loop terminator.
          immediateRefetchFired = true;
          queueMicrotask(() => { if (!cancelled) void poll(); });
        }
```

- [ ] **Step 4: Swap the rail header when stale**

In `frontend/src/components/ActivityRail/ActivityRail.tsx`, replace BOTH hardcoded `<span className={styles.muted}>last 24h</span>` spots (the Activity header ~line 199 and the Watching header ~line 242) with a stale-aware label:

```tsx
          <span className={styles.muted}>{data?.stale ? 'saved' : 'last 24h'}</span>
```

(Optionally show a small rail refreshing indicator while `data?.stale` — keep it minimal; the header swap is the primary cue.)

- [ ] **Step 5: Run to verify they pass + full suite**

Run (from `frontend/`): `npm run test -- useActivity ActivityRail`
Expected: PASS.
Run: `npm run test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useActivity.ts frontend/src/components/ActivityRail/ActivityRail.tsx frontend/src/hooks/useActivity.test.tsx frontend/src/components/ActivityRail/__tests__/ActivityRail.test.tsx
git commit -m "feat(#619): activity rail stale refetch + 'saved' header swap"
```

---

## Task 13: E2E — seed both caches, assert instant paint + reconcile

**Files:**
- Create/Modify: `frontend/e2e/cold-start-cache.spec.ts` (new, prod project)

**Interfaces:**
- Consumes: the real backend rehydrate path (seed `inbox-snapshot.json` + `activity-feed.json` in the test data dir).

> Per `feedback_dev_playwright_project_cant_run_scenario_specs`: scenario specs run on the **prod** project. Seed via the data-dir fixture (not a route mock) so the rehydrate path is exercised end to end (spec test 23). The seeded envelope must match the test identity's `(owner-login, owner-host)` and the current `schemaVersion` (1).

- [ ] **Step 1: Write the failing e2e test**

Create `frontend/e2e/cold-start-cache.spec.ts`. Before the app boots, write a valid `inbox-snapshot.json` and `activity-feed.json` into the run's data dir (use the existing per-test `(port, dataDir)` harness from `parallel-agent-testing.md`). Assert: the inbox paints PR rows and the rail paints activity rows with **no** skeleton; the refreshing signal shows; then live data reconciles and the signal clears.

```ts
import { test, expect } from '@playwright/test';
import { seedCacheFile, startAppWithSeededCaches } from './helpers/coldStart';

test('cold start paints rehydrated inbox + rail with no skeleton, then reconciles', async ({ page }) => {
  const { dataDir, baseURL } = await startAppWithSeededCaches();
  await seedCacheFile(dataDir, 'inbox-snapshot.json', /* version 1, matching identity, 1 section/PR */);
  await seedCacheFile(dataDir, 'activity-feed.json', /* version 1, matching identity, 1 item */);

  await page.goto(baseURL);
  // Instant paint: rows present, no skeleton.
  await expect(page.getByTestId('inbox-page')).toBeVisible();
  await expect(page.getByTestId('inbox-skeleton')).toHaveCount(0);
  await expect(page.locator('[data-testid="inbox-row"]').first()).toBeVisible();
  // Refreshing signal, then it clears once live reconciles.
  await expect(page.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('inbox-loading-bar')).toHaveAttribute('data-active', 'false');
});
```

> The exact seed-file helper and the app-boot hook depend on the existing e2e harness; model `startAppWithSeededCaches` on how other specs launch the backend with a private data dir, writing the cache files **before** the webServer starts (per `reference_playwright_globalsetup_webserver_race` — build/seed in the webServer command, not globalSetup, if ordering bites).

- [ ] **Step 2: Run to verify it fails**

Run (from `frontend/`): `npx playwright test cold-start-cache --project=prod` (via the local `.bin/playwright`, not `npx` if the cached-runner gotcha bites — `npx-playwright-separate-runner-instance`).
Expected: FAIL — seeding/rehydrate not yet exercised end to end (or helper missing).

- [ ] **Step 3: Implement the seed helper + ensure `data-testid="inbox-row"` exists**

Add `frontend/e2e/helpers/coldStart.ts` building the envelope JSON (kebab-case, version 1, matching identity) and writing it into the data dir. Confirm inbox rows carry a stable `data-testid` (add `data-testid="inbox-row"` to the row component if absent).

- [ ] **Step 4: Run to verify it passes**

Run (from `frontend/`): `npx playwright test cold-start-cache --project=prod`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/cold-start-cache.spec.ts frontend/e2e/helpers/coldStart.ts
git commit -m "test(#619): e2e cold-start cache — seed both caches, assert instant paint + reconcile"
```

---

## Task 14: Cross-tier consumer checks, full-suite gate, visual verification

**Files:** (verification + visual sign-off; no new production code unless a check surfaces a regression)

**Interfaces:** none produced; this task clears spec §10 and the visual sign-off before PR.

- [ ] **Step 1: First-`InboxUpdated` consumer check (§10)**

Grep FE consumers of the inbox SSE / `InboxUpdated` for behavior keyed off the *first* post-launch event or an "N new / everything-new" banner; confirm the shift from "everything new" (`ComputeDiff(null,…)`) to a real delta against the rehydrated snapshot doesn't regress it.

Run: `git grep -n "InboxUpdated\|everything.new\|N new\|newOrUpdated" frontend/src`
Document the finding in the PR `## Proof` section.

- [ ] **Step 2: `stale` consumer + non-optional-wire-field check (§10)**

Run: `git grep -n "InboxResponse\|ActivityResponse" frontend/src frontend/e2e` and confirm every route-mock / `as any` body sets `stale`. Run `npx tsc -b` from `frontend/`.

- [ ] **Step 3: Serialization round-trip + background-failure double-surface check (§10)**

Confirm the `IdentityKeyedFileCache` STJ round-trip covers `IReadOnlyDictionary`/`IReadOnlyList` → concrete, `AiEnrichmentSettled` init-normalizer, and kebab enums (Task 1 test 1 asserts this). Confirm a background-poll failure surfaces the snackbar but a manual-refresh failure still uses the existing toast — never both (Task 11 covers; re-verify in `InboxPage`).

- [ ] **Step 4: Full backend + frontend suites (the repo pre-push checklist, verbatim)**

Run the exact pre-push checklist from `.ai/docs/development-process.md` (do not curate a subset — `run-repo-pre-push-checklist-verbatim`). At minimum:

Run: `dotnet.exe build` (solution) → `dotnet.exe test` (full) → from `frontend/`: `npm run lint` → `npm run test` → `npx playwright test --project=prod`.
Expected: all green. (Known flakes: `InboxPoller Within500ms`, `EventsEndpoints SSE first-event`, `AiUsageRollupTailer.StopAsync`, `inbox-unread-reset` — re-run if hit; only yours if the diff touches that surface.)

- [ ] **Step 5: Visual verification (owner requires it — B1 visual gate)**

Per the owner's explicit request and `feedback_validate_layout_bugs_in_running_app` / `feedback_visual_verification_screenshots_on_pr`:
1. Launch the app via `run.ps1 -Reset None --no-browser` (Development + real PAT), serve-detached on the standard port.
2. Seed an aged inbox cache (`lastRefreshedAt` > 30 min) so the pill renders.
3. Capture **live Playwright screenshots** of the cold-start inbox in **both themes**, for **both** candidate pill placements (toolbar-inline vs. above-toolbar band), plus the refreshing bar and the snackbar.
4. Post the PNGs to a throwaway `review-assets/pr-N` branch (raw URLs) in a PR comment for the owner to choose placement.
5. The owner picks the final placement; apply it (it's a CSS/JSX placement change in `InboxPage` + `StalePill` slot — no logic change).

- [ ] **Step 6: Commit any check-driven fixes + the chosen placement**

```bash
git add -A
git commit -m "chore(#619): cross-tier consumer checks, full-suite gate, final pill placement from visual sign-off"
```

---

## Self-review

**Spec coverage:**
- §3.1 `IdentityKeyedFileCache<T>` → Task 1. §3.2 inbox integration → Tasks 2–4. §3.3 activity integration → Task 6.
- §4 identity/eviction/backstop/persist-config-on-connect → Tasks 4 (backstop), 5 (evict + persist). §5.1 write path → Task 3. §5.2 rehydrate + force-notify + failed-revalidation → Tasks 2 (mechanism) + 9 (FE failed-revalidation presentation). §5.3 persist-everything → Tasks 1/3 (settled-AI flush).
- §6 single-writer/disposable → Task 1 (disposable) + DI single-writer (Task 4). §7 inventory → all tasks. §9 affordance (stale flag, bar, pill, snackbar, rail) → Tasks 7–12. §10 consumer checks → Task 14. §11 test plan → tests embedded per task (1–8 → T1; 9–11,14 → T2; 12–13 → T3; 15 → T4; 15b/15c → T5; 16–18 + 17b (round-2 SEC-1) → T6; 19–22 → T9–T12; 23 → T13). §12 decisions → realized across tasks. Visual sign-off → Task 14.

**Placeholder scan:** No "TBD/TODO" in production code. The only deferred decision is the **pill placement**, which is an owner visual choice (Task 14) with a concrete default (toolbar-inline, reserve-space) shipped in Task 10 — not a placeholder.

**Type consistency:** `IIdentityKeyedFileCache<T>` / `CacheIdentity` (T1) used identically in T3/T4/T5/T6. `TryRehydrate` / `IsServingRehydratedSnapshot` (T2) consumed in T4/T7. `stale` wire field (T7/T8) consumed in T9–T12. `STALE_LABEL_THRESHOLD_MS` defined once (T10). `isFetching` (T9) drives the bar consistently. Orchestrator ctor cache-param order (T3) matches the DI registration (T4). `ActivityResponse.Stale` trailing-optional (T6) keeps existing positional constructions compiling.

---

## Round-1 `ce-doc-review` dispositions (7 personas)

Adjudicated with `receiving-code-review` rigor — each verified against the codebase before applying; advisory/FYI items judged on merit. **Disposition** = Applied (plan revised) / Gate (owner decision surfaced at B1) / Accepted-residual / Deferred.

| # | Reviewer | Finding | Sev/Conf | Disposition |
|---|----------|---------|----------|-------------|
| FEAS-1 / PROD-1 / DES-3 | feasibility + product + design (3×) | The snackbar's `failing` source (`useInboxUpdates`) is SSE-driven, not a poller, and GET `/api/inbox` returns 200+cache — so it **cannot observe GitHub-unreachability** (the headline case). | P1/75 | **Gate** — Task 11 rewritten around a backend `inbox-refresh-status` SSE signal (Option B); A/B/C scope decision surfaced at the B1 gate (spec §12 decision 9 sanctions descope). |
| ADV-1 / FEAS-res | adversarial + feasibility | Rehydrator ordered **after** `ViewerLoginHydrator`, whose `StartAsync` blocks on a network credential validation — sequential startup gates the offline instant-paint behind that timeout. | P1/75 | **Applied** — reorder rehydrator **first** (reads on-disk config only); documented as a deliberate spec §4 deviation (refinement #3); surfaced at gate. |
| ADV-2 | adversarial | `CaptureIdentity()` re-reads the login fresh at commit time instead of the line-175 fetch login — reintroduces the A-data-stamped-as-B leak and breaks test 13. | P1/75 | **Applied** — stash `_lastCaptureIdentity` from the line-175 `viewerLogin`; reuse in both triggers; test 13 note corrected. |
| DES-1 | design | `StalePill.module.css` uses non-existent tokens (`--text-muted`, `--border-subtle`) → silent wrong color + no border. | P1/100 | **Applied** (safe_auto) — `--text-3` / `--surface-3` / `--border-1`. |
| DES-2 | design | StalePill announce-once is unreliable — conditionally-mounted live region + ref-mutation-during-render breaks under React strict mode. | P1/75 | **Applied** — always-mounted sr-only live region + `useEffect` (mirrors the Task 9 pattern). |
| COH-2 | coherence | Task 2's `Build()` test calls break after Task 3 evolves the harness signature; no re-verify note. | P1/100 | **Applied** — `cache:` param defaults to a recording cache; explicit "re-run Task 2 tests after Task 3" note. |
| FEAS-2 | feasibility | Activity cache singleton consumed in Task 5 but not registered until Task 6 → DI resolve failure between commits. | P2/75 | **Applied** — both cache singletons registered together in Task 4. |
| ADV-3 / SEC-res | adversarial + security | Awaited `EvictAsync` races the background coalescing writer; a post-evict flush re-creates the file, accepted on same-login rotation. | P2/75 | **Applied (inbox)** — `QuiesceCacheWritesAsync()` before evict. **⚠ Superseded in round 2** — quiesce-only proved insufficient; replaced by the epoch gate / `InvalidateCacheWritesAsync` (see R2-ADV-1). **Accepted-residual (activity)** — see R2-SEC-1 (cross-identity half later closed). |
| SEC-1 | security | Eviction-test bodies use `token` not the endpoint's required `pat` → 400 before eviction. | P2/100 | **Applied** (safe_auto) — `pat` + validator-stub note. |
| SEC-2 | security | No `/connect/commit` eviction test despite spec test 15b requiring all three endpoints. | P2/75 | **Applied** — added the two-step warning→commit eviction test. |
| SCOPE-1 | scope | `IsServingRehydratedSnapshot` interface addition would break existing fakes (CS0535); spec said "no interface changes". | P2/75 | **Applied** — ships as a **default interface member** (`=> false`); zero fake blast radius; deviation documented (refinement #2). |
| SCOPE-2 | scope | Task 1 omits the `ActivityResponse` round-trip from spec §11 test 1 → kebab `ActivitySource`/`ActivityVerb` file serialization untested. | P2/75 | **Applied** (safe_auto) — added the activity round-trip `[Fact]`. |
| ADV-4 | adversarial | Coalescing-writer drain-exit handshake can strand the latest queued write (`IsCompleted` gate races the lock release). | P3/50 | **Applied** — explicit `_draining` flag set/cleared under the lock. |
| ADV-5 | adversarial | Force-notify test 11 can pass via the `diff.Changed` branch without exercising force-notify. | P3/50 | **Applied** — assert `NewOrUpdatedPrCount==0` + full `Sections.Keys` payload shape. |
| DES-4 | design | Activity stale-refetch has no loop guard despite the plan claiming one. | P2/50 | **Applied** — explicit `immediateRefetchFired` one-shot flag. |
| PROD-2 | product | For a fresh (<30 min) cache, the cold-start revalidation window is cue-less for sighted users (bar is off while the FE idles waiting on SSE; pill suppressed; stale-onset aria is sr-only). | P2/50 | **Accepted-residual** — data is seconds-old and about to refresh; a sustained sighted cue is a visual-polish call deferred to the Task 14 mockup. |
| COH-1 | coherence | `Func<string>` (inbox) vs `IViewerLoginProvider` (activity) login-provider asymmetry unexplained. | P2/75 | **Applied** — note: intentional, mirrors each class's existing ctor convention. |
| COH-3 | coherence | Activity write-through `host` local scope not shown. | P2/50 | **Applied** — clarified it reuses the existing `GetActivityAsync` `host` local (~line 108). |
| COH-4 | coherence | `InboxOrchestratorTestHarness.ConfigWith` referenced but never defined. | P2/50 | **Applied** — harness-helper definition folded into the Task 3 blast-radius note. |
| COH-5 | coherence | Self-review test-mapping "9–14 → T2/T3" imprecise (tests 12–13 are T3-only). | P1/100 | **Applied** (safe_auto) — "9–11,14 → T2; 12–13 → T3". |
| SCOPE-res | scope | `_rehydrateAttempted` not volatile → claimed double-read race. | (residual) | **Clarified (not a bug)** — the rehydrate block runs under `_gate`; serialized, no race. Note added. |
| SCOPE-res | scope | `WaitForCacheWriteIdleAsync` must poll the condition, not fixed-delay. | (residual) | **Applied** — explicit poll-the-condition note (CI-flake discipline). |
| SEC-res / DES-res | security + design | Rehydrator-before-Poller relies on sequential hosted-service startup with no runtime guard. | (residual) | **Deferred** — documented assumption (spec §13r-SECres); a startup assertion is reasonable but gold-plating for v1. Reordering to rehydrator-first (ADV-1) makes the dependency even looser. |
| FEAS-res | feasibility | `SampleSnapshot` `PrInboxItem`/`PrReference` positional arg lists must match the real records. | (residual) | **Applied** — caution note added to Task 1. |
| DES-res | design | `--text-muted` is a pre-existing undefined token in `PrActionsPanel`. | (residual) | **Noted, out of scope** — pre-existing; StalePill no longer uses it. |

---

## Round-2 `ce-doc-review` dispositions (7 personas)

Round 2 pressure-tested the round-1 revisions. Adjudicated with `receiving-code-review` rigor. **Disposition** = Applied / Gate / Accepted-residual / Deferred. (Security round-2 was re-dispatched after the first run died on a process exit; it returned one new finding, SEC-1.)

| # | Reviewer | Finding | Sev/Conf | Disposition |
|---|----------|---------|----------|-------------|
| R2-ADV-1 | adversarial | `QuiesceCacheWritesAsync` (drain-then-evict) is insufficient: an in-flight `RefreshAsync` (lock held across I/O) or a slow `OnInboxEnrichmentsReady` (~53s) can `ScheduleCacheWrite` **after** evict; on a same-login rotation `_lastCaptureIdentity.Login` is unchanged so the gate accepts the resurrected file — defeating evict-on-swap. | P1/75 | **Applied** — **epoch gate** (supersedes quiesce-only): `_cacheWriteEpoch` captured at line-175 with the login, dropped by the drainer on mismatch, bumped by `InvalidateCacheWritesAsync` at each auth site. |
| R2-SEC-1 | security (re-run) | Activity write-through re-reads `_viewerLogin.Get()` at commit (post-fan-out), lacking the inbox ADV-2 capture; the `await SetDefaultAccountLoginAsync` in `/connect` opens a real window where `Set("bob")` has fired but `Reset()` hasn't → alice's feed stamped under bob, served to bob next cold start. | P2/75 | **Applied** — capture `loginSnapshot` **before** the fan-out (mirrors inbox line-175); use in both rehydrate + write-through identities; added test 17b. Narrows the activity residual to the benign same-login case. |
| R2-FEAS-1 / R2-DES-1 | feasibility + design (2×) | Option B's `inbox-refresh-status` event must be registered in **both** `events.ts` maps (`EventPayloadByType` **and** `EVENT_TYPES`) or it's silently never subscribed. | P1/75 | **Applied** — Step 1.4 makes both-map registration explicit (Option B). |
| R2-FEAS-2 | feasibility | Option B's `InboxRefreshStatus` must implement `: IReviewEvent` (the bus is constrained); SSE forwarding lives in `SseChannel.cs` at **three** sites (Subscribe + handler + Dispose), not a vague "endpoint". | P2/75 | **Applied** — Step 1.1/1.3 corrected with the interface + the 3 `SseChannel` sites (Option B). |
| R2-FEAS-3 | feasibility | Injecting `IReviewEventBus` into `InboxPoller` breaks its DI factory at `ServiceCollectionExtensions.cs:~125–135` (4-arg `new InboxPoller`). | P2/75 | **Applied** — Step 1.2 names the factory fix (Option B). |
| R2-ADV-2 | adversarial | Publishing `Ok=false` from the `RateLimitExceededException` branch raises a spurious "Couldn't reach GitHub" snackbar during normal 429 backoff. | P3/50 | **Applied** — Step 1.2 publishes nothing on rate-limit; backend test asserts neither true nor false (Option B). |
| R2-ADV-3 | adversarial | Binary `Ok` can't see partial degradation; an `ok:false→true` flap within the debounce window doesn't cancel the armed timer (spurious `failing`). | P2/50 | **Applied** (flap) — Step 1b cancels the armed timer on `ok:true` + adds a flap test. **Documented limitation** (partial degradation) — surfaced as part of the A/B/C tradeoff (Option B). |
| R2-DES-2 | design | StalePill's module `.sr` class (no `top:0;left:0`, `.slot` no `position:relative`) reproduces the #197 abspos-page-scroll bug — a regression introduced by the round-1 DES-2 fix. | P1/75 | **Applied** (safe_auto) — use the global `sr-only` utility + `position:relative` on `.slot` (matches Task 9). |
| R2-COH-1 | coherence | Task 6 Step 8 stages `ServiceCollectionExtensions.cs` though Step 5 says it's registered in Task 4. | P1/100 | **Applied** (safe_auto) — removed from the Task 6 `git add`. |
| R2-COH-2/3 | coherence | Harness helpers (`Build`/`ConfigWith`/`SnapshotWith`/`BuildEquivalentSnapshotAsync`/`WaitForCacheWriteIdleAsync`/`RaiseEnrichmentReady`) undefined + `Build()` signature inconsistent across tasks. | P2/75 | **Applied** — added a canonical "Test harness contract" section (one `Build` signature, all helper signatures); Tasks 2/3 reference it. |
| R2-SCOPE-1 | scope | Option B's backend-contract surface is disproportionate to a non-blocking pill on a local single-owner tool. | (gate) | **Gate** — folded into the sharpened A/B/C recommendation (C or A over B). |
| R2-PROD-1/2 | product | Mid-session degrade isn't truly "blind" without B (StalePill is a slower fallback); B's `failing` could cheaply close the PROD-2 fresh-window cue via a `stale && !failing` bar predicate; PROD-2 stays coupled to the A/B/C choice. | (gate) | **Gate** — reflected in the Task 11 recommendation + PROD-2 stays an accepted-residual deferred to the Task 14 mockup. |
| R2-residual | feasibility | `_lastCaptureIdentity` defaults to `(null,null)`; trigger (b) could (unreachably) schedule a write with an empty login. | (residual) | **Applied** — cheap guard: trigger (b) skips when `_lastCaptureIdentity.Login` is empty. |
| R2-residual | adversarial/scope | Earlier note over-claimed the activity self-heal rode on `/replace`'s `RequestImmediateRefresh()` (it's inbox-only + `identityChanged`-gated). | (residual) | **Applied** — corrected to "next `/api/activity` fetch (rail poll ≤90s)". |
| R2-residual | adversarial | Rehydrator-first slightly weakens the fail-closed backstop for out-of-band token replacement (not a supported flow). | (residual) | **Documented** — not a supported path; the envelope identity gate remains the defense. |

**Security round-2 cleared (no finding):** host/login normalization (OrdinalIgnoreCase both, trailing-slash asymmetry internally consistent), envelope tamper/partial-write/corruption (atomic write + fail-closed `TryLoad`), eviction completeness (all 3 sites, both caches, awaited), on-disk plaintext exposure (no net gain over the already-persisted PAT on a local tool), startup rehydrate ordering (config identity can't be network-spoofed; empty/mismatch fail closed). `EvictAsync` DEBUG-level failure log confirmed intentional (identity gate is the backstop).

**Gate decisions surfaced for the B1 human review (round-2-informed):**
1. **Snackbar scope (FEAS-1/PROD-1/DES-3 + R2-FEAS-1/2/3, R2-ADV-2/3, R2-SCOPE-1):** Option A (descope to follow-up) / B (backend `inbox-refresh-status` SSE — corrected, executable, but now-known higher cost) / C (FE-only staleness watchdog). **Round-2 recommendation: C or A, not B** — B's backend-contract surface + signal-semantics leaks are disproportionate to a non-blocking pill on a local single-owner tool. See the Task 11 callout.
2. **Rehydrator ordering (ADV-1):** accept the deviation from spec §4 (rehydrator runs first) — recommended; update the spec §4 ordering note to match.
3. **Inbox writer-race (R2-ADV-1):** the epoch gate fully closes the inbox resurrection; no residual to accept there.
4. **Activity writer-race residual (ADV-3 + R2-SEC-1):** the cross-identity half is now **closed** (capture-before-fan-out); accept only the narrow **same-login** restart-window residual (self-heals on the next activity fetch), consistent with spec §4 "residual reduced, not zero".
