# Stale-OID Investigation — Instrumentation PR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the diagnostic instrumentation that the stale-OID SSE/Reload-banner investigation methodology depends on. Three `LoggerMessage.Define`-backed delegates (one in `ActivePrPoller`, two in `SseChannel`) plus a one-line `FileLoggerExtensions` gate-lift behind `PRISM_FILE_LOGGER_FORCE=1`, plus the Playwright real-flow config flip that activates the gate. No production behavior changes; pure diagnostic additions.

**Architecture:** All changes are additive. The delegates follow PRism's established `LoggerMessage.Define<T...>(LogLevel, EventId, template)` pattern (see existing `s_pollFailedLog` and `s_tickFailedLog` in `ActivePrPoller.cs`). The gate-lift extends the existing `if` predicate with `&& PRISM_FILE_LOGGER_FORCE != "1"` so the Test-env early-return fires only when BOTH the Test environment AND the missing-override conditions hold (semantically equivalent to disabled-unless-overridden). Tests use per-file `sealed class CapturingLogger : ILogger<T>` inner classes that filter on the specific `EventId.Id` under test — not the existing `ListLoggerProvider` — because each delegate emits a unique `EventId` (3/4/5) and per-event filtering keeps assertions decoupled from unrelated infrastructure log noise.

**Tech Stack:** C# / .NET 10 minimal hosting, xUnit + FluentAssertions, `Microsoft.Extensions.Logging.Abstractions` (`NullLogger<T>` + `ILoggerProvider`), Playwright TypeScript config.

**Source spec:** [docs/specs/2026-05-19-stale-oid-banner-investigation-design.md](../specs/2026-05-19-stale-oid-banner-investigation-design.md) — Sections 3.1, 3.2, 3.3, 3.4, 7.1.

**Scope:** This plan covers ONLY the investigation-instrumentation PR (the first PR). Per-hypothesis fix-branch plans (H1, H2, H3, H4) are produced by a separate `writing-plans` run AFTER the investigation produces its finding artifact. Sections 6.1, 6.2, 6.3, 6.4 of the spec are out-of-scope for this plan.

---

## File Structure

**Production files to modify:**
- `PRism.Core/PrDetail/ActivePrPoller.cs` — add `s_pollSnapshotLog` delegate + emit call site in `TickAsync`.
- `PRism.Web/Sse/SseChannel.cs` — add `s_sseActivePrFanoutLog` delegate + emit call site in `OnActivePrUpdated`; add `s_sseActivePrDeliveryLog` delegate + emit call sites in `WriteAndEvictOnFailureAsync`.
- `PRism.Web/Logging/FileLoggerExtensions.cs` — extend the Test-env gate with `&& Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE") != "1"`.
- `frontend/playwright.real.config.ts` — add `PRISM_FILE_LOGGER_FORCE: '1'` to the webServer `env` block.

**Test files to create:**
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSnapshotLogTests.cs` — T-INV-1, T-INV-2, T-INV-3.
- `tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs` — T-INV-4, T-INV-5.
- `tests/PRism.Web.Tests/Sse/SseChannelActivePrDeliveryLogTests.cs` — T-INV-6.
- `tests/PRism.Web.Tests/Logging/FileLoggerGateOverrideTests.cs` — T-INV-7.

Each test file has one focused responsibility (one delegate per file). T-INV-4 and T-INV-5 share a file because they both assert on `s_sseActivePrFanoutLog`; T-INV-6 gets its own file because it assert on a different delegate (`s_sseActivePrDeliveryLog`) and the fan-out vs delivery split is the load-bearing distinction in Section 4.3's boundary table (5a vs 5b).

---

## Pre-flight: confirm we are on `feat/stale-oid-banner` in the worktree

- [ ] **Step 0.1: Verify worktree branch**

Run: `git -C D:/src/prism-stale-oid branch --show-current`
Expected output: `feat/stale-oid-banner`

If you are not on this branch, stop. The worktree at `D:\src\prism-stale-oid` was created via `git worktree add ../prism-stale-oid -b feat/stale-oid-banner main` during brainstorming.

- [ ] **Step 0.2: Verify spec is committed or ready to ship in this PR**

Run: `git -C D:/src/prism-stale-oid status --short`
Expected: `docs/specs/2026-05-19-stale-oid-banner-investigation-design.md` and `docs/plans/2026-05-19-stale-oid-investigation-instrumentation.md` are unstaged. They ship in this PR alongside the implementation.

---

## Task 1: `ActivePrPoller` snapshot log delegate

**Files:**
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs` — add delegate near line 177 (alongside existing `s_pollFailedLog` / `s_tickFailedLog`); call site after line 127 (after `firstPoll`/`headChanged`/`commentChanged` computed, BEFORE `_bus.Publish`).
- Create: `tests/PRism.Core.Tests/PrDetail/ActivePrPollerSnapshotLogTests.cs`.

### Task 1.1: T-INV-1 — Write the failing test (delegate fires once per successful poll)

- [ ] **Step 1.1.1: Create the test file**

Create `D:\src\prism-stale-oid\tests\PRism.Core.Tests\PrDetail\ActivePrPollerSnapshotLogTests.cs`:

```csharp
using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Core.Tests.PrDetail;

// Asserts the s_pollSnapshotLog delegate emits the expected fields per poll.
// Substring matches against the rendered FormattedMessage; PRism doesn't have
// a structured-field assertion helper today and the rendered template is the
// shape the on-disk logger ultimately writes.
public class ActivePrPollerSnapshotLogTests
{
    private static readonly DateTimeOffset T0 = new(2026, 5, 19, 0, 0, 0, TimeSpan.Zero);

    private sealed class CapturingLogger : ILogger<ActivePrPoller>
    {
        public ConcurrentBag<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            if (eventId.Id == 3) Messages.Add(formatter(state, exception));
        }
        private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    private static (ActivePrPoller poller, FakePollerReviewService review, CapturingLogger logger, ActivePrSubscriberRegistry registry) Build()
    {
        var registry = new ActivePrSubscriberRegistry();
        var review = new FakePollerReviewService();
        var bus = new FakeReviewEventBus();
        var cache = new ActivePrCache(registry);
        var logger = new CapturingLogger();
        var poller = new ActivePrPoller(
            registry, review, bus, cache,
            logger,
            new FakeHostEnvironment("Production"));
        return (poller, review, logger, registry);
    }

    private static ActivePrPollSnapshot Snapshot(string headSha = "h1", int commentCount = 0) =>
        new(headSha, "MERGEABLE", "OPEN", commentCount, 0);

    [Fact]
    public async Task T_INV_1_emits_one_snapshot_line_per_successful_poll()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1"));

        await poller.TickAsync(T0, default);

        logger.Messages.Should().ContainSingle();
        logger.Messages.Single().Should().Contain("Active-PR poll snapshot");
    }
}
```

- [ ] **Step 1.1.2: Run the test to verify it fails (delegate doesn't exist yet)**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivePrPollerSnapshotLogTests"`
Expected: FAIL with assertion `Expected logger.Messages to contain a single item, but found none.` (because `s_pollSnapshotLog` doesn't exist yet — `EventId.Id == 3` matches nothing).

### Task 1.2: Add the delegate + call site

- [ ] **Step 1.2.1: Add the delegate declaration**

In `D:\src\prism-stale-oid\PRism.Core\PrDetail\ActivePrPoller.cs`, find the existing `s_pollFailedLog` declaration (around line 177). Add this delegate IMMEDIATELY BEFORE it:

```csharp
    private static readonly Action<ILogger, PrReference, string, string?, bool, bool, bool, Exception?> s_pollSnapshotLog =
        LoggerMessage.Define<PrReference, string, string?, bool, bool, bool>(
            LogLevel.Information,
            new EventId(3, "ActivePrPollSnapshot"),
            "Active-PR poll snapshot {PrRef}: head={HeadSha} prevHead={PrevHeadSha} firstPoll={FirstPoll} headChanged={HeadChanged} commentChanged={CommentChanged}");
```

- [ ] **Step 1.2.2: Add the call site in `TickAsync`**

In the same file, find `TickAsync` around line 127 (the block that computes `firstPoll`, `headChanged`, `commentChanged` and then publishes). The current sequence is:

```csharp
                var firstPoll = state.LastHeadSha is null && state.LastCommentCount is null;
                var headChanged = state.LastHeadSha is { } prev && prev != snapshot.HeadSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != snapshot.CommentCount;

                if (firstPoll || headChanged || commentChanged)
                {
                    _bus.Publish(new ActivePrUpdated(
```

Insert the diagnostic emit BETWEEN the boolean computations and the `if (firstPoll || ...)`:

```csharp
                var firstPoll = state.LastHeadSha is null && state.LastCommentCount is null;
                var headChanged = state.LastHeadSha is { } prev && prev != snapshot.HeadSha;
                var commentChanged = state.LastCommentCount is { } prevCount && prevCount != snapshot.CommentCount;

                s_pollSnapshotLog(_logger, prRef, snapshot.HeadSha, state.LastHeadSha, firstPoll, headChanged, commentChanged, null);

                if (firstPoll || headChanged || commentChanged)
                {
                    _bus.Publish(new ActivePrUpdated(
```

`state.LastHeadSha` is the PRE-update value at this point (the assignment on lines 137–138 happens later in the method, after the publish). That is the intended "PrevHeadSha" — the head the poller had recorded BEFORE this poll's result.

- [ ] **Step 1.2.3: Run T-INV-1 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivePrPollerSnapshotLogTests"`
Expected: PASS (one test, T-INV-1).

### Task 1.3: T-INV-2 — First-poll signature (firstPoll=True, prevHead=null)

- [ ] **Step 1.3.1: Add the test method**

Append to `ActivePrPollerSnapshotLogTests` class:

```csharp
    [Fact]
    public async Task T_INV_2_first_poll_after_subscribe_has_firstPoll_true_and_prevHead_null()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);
        review.SetSnapshot(pr, Snapshot(headSha: "h1"));

        await poller.TickAsync(T0, default);

        var line = logger.Messages.Single();
        line.Should().Contain("firstPoll=True");
        line.Should().Contain("headChanged=False");
        line.Should().Contain("commentChanged=False");
        line.Should().Contain("head=h1");
        // PrevHeadSha is null on first poll. LoggerMessage renders null as the empty string,
        // so the substring lands as "prevHead=" followed by a space.
        line.Should().Contain("prevHead= ");
    }
```

- [ ] **Step 1.3.2: Run T-INV-2 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivePrPollerSnapshotLogTests"`
Expected: PASS (two tests).

### Task 1.4: T-INV-3 — Second-poll-with-delta signature (firstPoll=False, prevHead=SHA-A, headChanged=True)

- [ ] **Step 1.4.1: Add the test method**

Append:

```csharp
    [Fact]
    public async Task T_INV_3_second_poll_with_head_delta_has_firstPoll_false_prevHead_set_and_headChanged_true()
    {
        var (poller, review, logger, registry) = Build();
        var pr = new PrReference("o", "r", 1);
        registry.Add("sub1", pr);

        review.SetSnapshot(pr, Snapshot(headSha: "h1"));
        await poller.TickAsync(T0, default);  // first poll captures h1

        review.SetSnapshot(pr, Snapshot(headSha: "h2"));
        await poller.TickAsync(T0.AddSeconds(30), default);  // second poll observes delta

        logger.Messages.Should().HaveCount(2);
        var secondLine = logger.Messages.OrderBy(m => m).Last(); // h2 sorts after h1 — deterministic ordering for this assertion
        // Defensive: re-pick the line containing "head=h2" so the ordering isn't load-bearing.
        var deltaLine = logger.Messages.Single(m => m.Contains("head=h2"));
        deltaLine.Should().Contain("firstPoll=False");
        deltaLine.Should().Contain("prevHead=h1");
        deltaLine.Should().Contain("head=h2");
        deltaLine.Should().Contain("headChanged=True");
        deltaLine.Should().Contain("commentChanged=False");
    }
```

- [ ] **Step 1.4.2: Run T-INV-3 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ActivePrPollerSnapshotLogTests"`
Expected: PASS (three tests).

### Task 1.5: Commit Task 1

- [ ] **Step 1.5.1: Run the full Core test suite to confirm no regression**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Core.Tests/PRism.Core.Tests.csproj`
Expected: ALL PASS.

- [ ] **Step 1.5.2: Stage and commit**

```bash
cd D:/src/prism-stale-oid
git add PRism.Core/PrDetail/ActivePrPoller.cs tests/PRism.Core.Tests/PrDetail/ActivePrPollerSnapshotLogTests.cs
git commit -m "feat(diagnostics): ActivePrPoller per-poll snapshot log delegate

s_pollSnapshotLog (EventId 3, Information) emits per successful PollActivePrAsync
with prRef + snapshot.HeadSha + state.LastHeadSha (pre-update) + firstPoll /
headChanged / commentChanged booleans. Diagnostic instrument for the stale-OID
SSE/Reload-banner investigation (see docs/specs/2026-05-19-stale-oid-...md
Section 3.1). T-INV-1/2/3 cover emission count + first-poll / delta signatures."
```

---

## Task 2: `SseChannel` fan-out log delegate

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs` — add `s_sseActivePrFanoutLog` delegate; emit at the top of `OnActivePrUpdated` (line 238).
- Create: `tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs`.

### Task 2.1: T-INV-4 — Write the failing test (delegate fires per OnActivePrUpdated with correct SubscriberCount)

- [ ] **Step 2.1.1: Create the test file**

Create `D:\src\prism-stale-oid\tests\PRism.Web.Tests\Sse\SseChannelActivePrFanoutLogTests.cs`:

```csharp
using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

// Asserts s_sseActivePrFanoutLog (EventId 4) emits per OnActivePrUpdated with
// SubscriberCount matching registry.SubscribersFor(prRef).Count at publish time.
public class SseChannelActivePrFanoutLogTests
{
    private sealed class CapturingLogger : ILogger<SseChannel>
    {
        public ConcurrentBag<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            if (eventId.Id == 4) Messages.Add(formatter(state, exception));
        }
        private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    [Fact]
    public void T_INV_4_fanout_log_fires_per_ActivePrUpdated_publish_with_correct_subscriber_count()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var prRef = new PrReference("o", "r", 1);
        registry.Add("sub-A", prRef);
        registry.Add("sub-B", prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", NewCommentCount: null));

        logger.Messages.Should().ContainSingle();
        var line = logger.Messages.Single();
        line.Should().Contain("SSE fan-out");
        line.Should().Contain("ActivePrUpdated");
        line.Should().Contain("subscribers=2");
        line.Should().Contain("headShaChanged=True");
        line.Should().Contain("commentCountChanged=False");
    }
}
```

- [ ] **Step 2.1.2: Run the test to verify it fails**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SseChannelActivePrFanoutLogTests"`
Expected: FAIL — `Expected logger.Messages to contain a single item, but found none.` (delegate doesn't exist yet).

### Task 2.2: Add the delegate + call site

- [ ] **Step 2.2.1: Add the delegate declaration**

In `D:\src\prism-stale-oid\PRism.Web\Sse\SseChannel.cs`, find an appropriate static-readonly section for delegates (typically near other `LoggerMessage.Define` declarations; if none exist, add at the bottom of the class). Add:

```csharp
    private static readonly Action<ILogger, string, PrReference, int, bool, bool, Exception?> s_sseActivePrFanoutLog =
        LoggerMessage.Define<string, PrReference, int, bool, bool>(
            LogLevel.Information,
            new EventId(4, "SseActivePrFanout"),
            "SSE fan-out {EventType} {PrRef}: subscribers={SubscriberCount} headShaChanged={HeadShaChanged} commentCountChanged={CommentCountChanged}");
```

- [ ] **Step 2.2.2: Add the call site in `OnActivePrUpdated`**

In the same file, find `OnActivePrUpdated(ActivePrUpdated evt)` (line 238). At the TOP of the method body, BEFORE any other logic:

```csharp
    private void OnActivePrUpdated(ActivePrUpdated evt)
    {
        var subscriberList = _activeRegistry.SubscribersFor(evt.PrRef);
        s_sseActivePrFanoutLog(_logger, nameof(ActivePrUpdated), evt.PrRef, subscriberList.Count, evt.HeadShaChanged, evt.CommentCountChanged, null);

        // ... existing body continues ...
```

If `OnActivePrUpdated` already calls `_activeRegistry.SubscribersFor(evt.PrRef)` further down, replace that downstream call with the `subscriberList` variable you just created — DRY, single registry lookup per fan-out.

- [ ] **Step 2.2.3: Run T-INV-4 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SseChannelActivePrFanoutLogTests"`
Expected: PASS (one test).

### Task 2.3: T-INV-5 — Zero-subscriber control case logs SubscriberCount=0 without throwing

- [ ] **Step 2.3.1: Add the test method**

Append:

```csharp
    [Fact]
    public void T_INV_5_fanout_log_with_zero_subscribers_emits_SubscriberCount_zero_without_throw()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var prRef = new PrReference("o", "r", 42);
        // Intentionally no registry.Add — verify the log still fires with subscribers=0.

        var act = () => bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h-orphan", NewCommentCount: null));

        act.Should().NotThrow();
        logger.Messages.Should().ContainSingle();
        logger.Messages.Single().Should().Contain("subscribers=0");
    }
```

- [ ] **Step 2.3.2: Run T-INV-5 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SseChannelActivePrFanoutLogTests"`
Expected: PASS (two tests).

### Task 2.4: Commit Task 2

- [ ] **Step 2.4.1: Run the full Web test suite**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj`
Expected: ALL PASS.

- [ ] **Step 2.4.2: Stage and commit**

```bash
cd D:/src/prism-stale-oid
git add PRism.Web/Sse/SseChannel.cs tests/PRism.Web.Tests/Sse/SseChannelActivePrFanoutLogTests.cs
git commit -m "feat(diagnostics): SseChannel fan-out intent log delegate

s_sseActivePrFanoutLog (EventId 4, Information) emits per OnActivePrUpdated
with EventType + PrRef + SubscriberCount + headShaChanged + commentCountChanged.
Captures intent-to-deliver (the subscriber count the fan-out is about to write
to) — distinct from per-write outcome which Task 3's delivery delegate captures.
See docs/specs/2026-05-19-stale-oid-...md Section 3.2 + boundary 5a."
```

---

## Task 3: `SseChannel` per-subscriber delivery log delegate

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs` — add `s_sseActivePrDeliveryLog` delegate; emit on success-path (after `WriteAsync` completes) and on eviction-path (catch handlers in `WriteAndEvictOnFailureAsync`).
- Create: `tests/PRism.Web.Tests/Sse/SseChannelActivePrDeliveryLogTests.cs`.

### Task 3.1: T-INV-6 — Write the failing test (per-subscriber WriteAsync outcome)

- [ ] **Step 3.1.1: Create the test file**

Create `D:\src\prism-stale-oid\tests\PRism.Web.Tests\Sse\SseChannelActivePrDeliveryLogTests.cs`:

```csharp
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Inbox;
using PRism.Core.PrDetail;
using PRism.Web.Sse;

namespace PRism.Web.Tests.Sse;

// Asserts s_sseActivePrDeliveryLog (EventId 5) emits per per-subscriber
// WriteAsync attempt — Success=true on completion, Success=false on the
// eviction path. The eviction path is exercised by a Stream that throws on
// WriteAsync to force the catch.
public class SseChannelActivePrDeliveryLogTests
{
    private sealed class CapturingLogger : ILogger<SseChannel>
    {
        public ConcurrentBag<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            if (eventId.Id == 5) Messages.Add(formatter(state, exception));
        }
        private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    private sealed class FaultingStream : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get => 0; set { } }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => 0;
        public override long Seek(long offset, SeekOrigin origin) => 0;
        public override void SetLength(long value) { }
        public override void Write(byte[] buffer, int offset, int count) => throw new IOException("simulated socket failure");
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => throw new IOException("simulated socket failure");
    }

    [Fact]
    public async Task T_INV_6_delivery_log_emits_Success_true_on_successful_write()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        // Wait for the subscriber to register so SubscribersFor returns it.
        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));

        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", NewCommentCount: null));

        // Delivery is async (fire-and-forget Task launched from OnActivePrUpdated). Poll for the log line.
        await WaitFor(() => logger.Messages.Count >= 1, TimeSpan.FromSeconds(5));

        logger.Messages.Should().ContainSingle();
        var line = logger.Messages.Single();
        line.Should().Contain("SSE delivery");
        line.Should().Contain("ActivePrUpdated");
        line.Should().Contain($"subscriber={subscriberId}");
        line.Should().Contain("success=True");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task T_INV_6b_delivery_log_emits_Success_false_on_eviction_path()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger();
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new FaultingStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new ActivePrUpdated(prRef, HeadShaChanged: true, CommentCountChanged: false, NewHeadSha: "h2", NewCommentCount: null));

        // FaultingStream throws on WriteAsync — eviction path fires, Success=false emits.
        await WaitFor(() => logger.Messages.Any(m => m.Contains("success=False")), TimeSpan.FromSeconds(5));

        var failureLine = logger.Messages.Single(m => m.Contains("success=False"));
        failureLine.Should().Contain("SSE delivery");
        failureLine.Should().Contain($"subscriber={subscriberId}");
        failureLine.Should().Contain("success=False");

        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    private static async Task WaitFor(Func<bool> predicate, TimeSpan timeout)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (sw.Elapsed < timeout)
        {
            if (predicate()) return;
            await Task.Delay(20);
        }
    }
}
```

- [ ] **Step 3.1.2: Run the tests to verify they fail**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SseChannelActivePrDeliveryLogTests"`
Expected: FAIL — both tests fail because `s_sseActivePrDeliveryLog` doesn't exist yet (EventId 5 matches nothing).

### Task 3.2: Add the delegate + call sites

- [ ] **Step 3.2.1: Add the delegate declaration**

In `PRism.Web/Sse/SseChannel.cs`, near the `s_sseActivePrFanoutLog` declaration from Task 2:

```csharp
    private static readonly Action<ILogger, string, PrReference, string, bool, Exception?> s_sseActivePrDeliveryLog =
        LoggerMessage.Define<string, PrReference, string, bool>(
            LogLevel.Information,
            new EventId(5, "SseActivePrDelivery"),
            "SSE delivery {EventType} {PrRef} subscriber={SubscriberId} success={Success}");
```

- [ ] **Step 3.2.2: Add the call sites in `WriteAndEvictOnFailureAsync`**

`WriteAndEvictOnFailureAsync` is the per-subscriber write method invoked by `OnActivePrUpdated` (fire-and-forget Task). Locate it in `SseChannel.cs`. The body has a structure roughly:

```csharp
private async Task WriteAndEvictOnFailureAsync(Subscriber sub, ReadOnlyMemory<byte> frame, /* per-call args */)
{
    try
    {
        // ... WriteAsync(frame, ...) ...
    }
    catch (OperationCanceledException) { /* eviction */ }
    catch (Exception)                   { /* eviction */ }
}
```

Required emit points:
- **Success path:** AFTER the successful `await s.WriteAsync(...)` completes, BEFORE the try-block closes. Emit `success: true`.
- **Eviction path:** in EACH catch handler that triggers an eviction. Emit `success: false`.

You will need access to the `PrReference` and the event type name. The current `WriteAndEvictOnFailureAsync` signature may not carry `PrReference`. Two options:
1. Extend the method signature with `PrReference prRef, string eventType` parameters — pass them from `OnActivePrUpdated`'s call site (and adjust the `FanoutProjected` call site if applicable).
2. Use a wrapper method that closes over `prRef` + `eventType` and delegates to `WriteAndEvictOnFailureAsync`.

Pick option 1 (cleaner; one method, explicit signature). After adjusting the method signature, the success-path call site:

```csharp
            await s.WriteAsync(frame, cts.Token);
            s_sseActivePrDeliveryLog(_logger, eventType, prRef, sub.SubscriberId, true, null);
```

Each eviction-path catch:

```csharp
        catch (OperationCanceledException)
        {
            s_sseActivePrDeliveryLog(_logger, eventType, prRef, sub.SubscriberId, false, null);
            // ... existing eviction logic ...
        }
```

Adjust the field name `sub.SubscriberId` to whatever the existing subscriber-id field/property is called in `SseChannel.cs`. If `Subscriber` is a private nested record/class, look for the existing `subscriberId` retrieval pattern in the file.

- [ ] **Step 3.2.3: Run T-INV-6 to verify it passes**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SseChannelActivePrDeliveryLogTests"`
Expected: PASS (two tests, T_INV_6 and T_INV_6b).

### Task 3.3: Commit Task 3

- [ ] **Step 3.3.1: Run the full Web test suite**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj`
Expected: ALL PASS.

- [ ] **Step 3.3.2: Stage and commit**

```bash
cd D:/src/prism-stale-oid
git add PRism.Web/Sse/SseChannel.cs tests/PRism.Web.Tests/Sse/SseChannelActivePrDeliveryLogTests.cs
git commit -m "feat(diagnostics): SseChannel per-subscriber delivery log delegate

s_sseActivePrDeliveryLog (EventId 5, Information) emits per per-subscriber
WriteAsync attempt with EventType + PrRef + SubscriberId + Success boolean.
Distinct from the fan-out intent log: this captures delivery outcome
(boundary 5b in the investigation decision tree) vs intent-to-deliver
(boundary 5a). See docs/specs/2026-05-19-stale-oid-...md Section 3.3."
```

---

## Task 4: `FileLoggerExtensions` gate-lift + Playwright env var

**Files:**
- Modify: `PRism.Web/Logging/FileLoggerExtensions.cs:22-24` — extend the Test-env gate.
- Modify: `frontend/playwright.real.config.ts:26-33` — add `PRISM_FILE_LOGGER_FORCE: '1'`.
- Create: `tests/PRism.Web.Tests/Logging/FileLoggerGateOverrideTests.cs`.

### Task 4.1: T-INV-7 — Write the failing tests (gate-override behavior)

- [ ] **Step 4.1.1: Create the test file**

Create `D:\src\prism-stale-oid\tests\PRism.Web.Tests\Logging\FileLoggerGateOverrideTests.cs`:

```csharp
using System;
using System.IO;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PRism.Web.Logging;
using PRism.Web.Tests.TestHelpers;

namespace PRism.Web.Tests.Logging;

// Asserts the FileLoggerExtensions Test-env gate can be overridden by the
// PRISM_FILE_LOGGER_FORCE=1 env var. Without the override, the existing xUnit
// safety (preventing per-test writer-task storms) is preserved.
public sealed class FileLoggerGateOverrideTests : IDisposable
{
    private readonly string _dataDir;
    private readonly string? _originalForceValue;

    public FileLoggerGateOverrideTests()
    {
        _dataDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        Directory.CreateDirectory(_dataDir);
        _originalForceValue = Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE");
    }

    public void Dispose()
    {
        // Restore the env var to its original state so this test doesn't leak into siblings.
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", _originalForceValue);
#pragma warning disable CA1031
        try { if (Directory.Exists(_dataDir)) Directory.Delete(_dataDir, recursive: true); }
        catch (Exception) { /* best-effort cleanup */ }
#pragma warning restore CA1031
        GC.SuppressFinalize(this);
    }

    [Fact]
    public void T_INV_7a_gate_blocks_FileLoggerProvider_in_Test_env_when_override_unset()
    {
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", null);

        using var factory = new PRismWebApplicationFactory();
        using var client = factory.CreateClient();

        var provider = factory.Services.GetService<FileLoggerProvider>();
        provider.Should().BeNull(
            "in Test env without the override env var, the FileLoggerProvider must NOT register");
    }

    [Fact]
    public void T_INV_7b_gate_admits_FileLoggerProvider_in_Test_env_when_override_set()
    {
        Environment.SetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE", "1");

        using var factory = new PRismWebApplicationFactory();
        using var client = factory.CreateClient();

        var provider = factory.Services.GetService<FileLoggerProvider>();
        provider.Should().NotBeNull(
            "in Test env with PRISM_FILE_LOGGER_FORCE=1, the FileLoggerProvider must register");
    }
}
```

If `PRismWebApplicationFactory` doesn't exist with that exact name, locate the existing `WebApplicationFactory<Program>` derivative in `tests/PRism.Web.Tests/TestHelpers/` — files like `SubmitEndpointsTestContext.cs` use it. Adjust the type name in this test to match the actual factory class.

- [ ] **Step 4.1.2: Run the tests to verify they fail**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~FileLoggerGateOverrideTests"`
Expected: T_INV_7a PASSES (the current code blocks unconditionally in Test env). T_INV_7b FAILS because the override env var is not honored — `FileLoggerProvider` returns null even when the env var is set.

### Task 4.2: Apply the gate-lift

- [ ] **Step 4.2.1: Edit `FileLoggerExtensions.cs`**

In `D:\src\prism-stale-oid\PRism.Web\Logging\FileLoggerExtensions.cs`, change line 24:

Before:
```csharp
        if (env.IsEnvironment("Test")) return builder;
```

After:
```csharp
        if (env.IsEnvironment("Test")
            && Environment.GetEnvironmentVariable("PRISM_FILE_LOGGER_FORCE") != "1")
            return builder;
```

Also update the comment block above (lines 11–21) to mention the override env var. New comment:

```csharp
    // Registers the FileLoggerProvider as an additional ILoggerProvider alongside the
    // framework defaults (Console + Debug). Gated on !env.IsEnvironment("Test") so xUnit
    // WebApplicationFactory<Program>-based tests don't all spin up writer tasks against
    // 111 temp DataDirs (see spec § 9.1). Integration tests in
    // tests/PRism.Web.Tests/Logging/FileLoggerIntegrationTests.cs opt in explicitly via
    // factory.WithWebHostBuilder(...) with a per-test Guid-named temp DataDir.
    //
    // The Test-env gate is bypassed when PRISM_FILE_LOGGER_FORCE=1 is set in the
    // environment. This lets the real-flow Playwright suite (which sets
    // ASPNETCORE_ENVIRONMENT=Test for cadence and seam reasons) opt into on-disk
    // logging for the stale-OID investigation methodology — see
    // docs/specs/2026-05-19-stale-oid-banner-investigation-design.md Section 3.4.
    //
    // The pre-Build registration shape (call from Program.cs BEFORE builder.Build()) is
    // load-bearing: LoggerFactory.AddProvider called AFTER Build() does not propagate to
    // already-resolved Logger<T> instances, and LoggerFactory.Dispose invokes sync
    // Dispose() not DisposeAsync(), breaking the drain contract. See spec § 9.
```

- [ ] **Step 4.2.2: Run T-INV-7 to verify both tests pass**

Run: `dotnet test D:/src/prism-stale-oid/tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~FileLoggerGateOverrideTests"`
Expected: PASS (two tests).

### Task 4.3: Add the Playwright env var

- [ ] **Step 4.3.1: Edit `playwright.real.config.ts`**

In `D:\src\prism-stale-oid\frontend\playwright.real.config.ts`, the existing webServer env block (lines 26–33):

Before:
```typescript
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    // PRISM_E2E_FAKE_REVIEW deliberately NOT set — Program.cs rejects the combo.
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '1',
  },
```

After:
```typescript
  env: {
    ASPNETCORE_ENVIRONMENT: 'Test',
    PRISM_E2E_REAL_INJECT: '1',
    // PRISM_E2E_FAKE_REVIEW deliberately NOT set — Program.cs rejects the combo.
    DataDir: e2eDataDir,
    PRISM_POLLER_CADENCE_SECONDS: '1',
    // Override FileLoggerExtensions Test-env gate so the stale-OID investigation
    // methodology can capture structured logs to <DataDir>/logs/prism-yyyy-MM-dd.log.
    // See docs/specs/2026-05-19-stale-oid-banner-investigation-design.md Section 3.4.
    PRISM_FILE_LOGGER_FORCE: '1',
  },
```

- [ ] **Step 4.3.2: Run frontend prettier + lint to confirm the config edit is clean**

Run: `cd D:/src/prism-stale-oid/frontend && npm run prettier -- --check playwright.real.config.ts`
Expected: prints `All matched files use Prettier code style!` (or auto-fix with `npm run prettier -- --write playwright.real.config.ts` if not).

Run: `cd D:/src/prism-stale-oid/frontend && npm run lint`
Expected: lint passes (the config file is a TypeScript module; lint rules apply).

### Task 4.4: Commit Task 4

- [ ] **Step 4.4.1: Stage and commit**

```bash
cd D:/src/prism-stale-oid
git add PRism.Web/Logging/FileLoggerExtensions.cs frontend/playwright.real.config.ts tests/PRism.Web.Tests/Logging/FileLoggerGateOverrideTests.cs
git commit -m "feat(diagnostics): allow FileLoggerProvider in Test env via PRISM_FILE_LOGGER_FORCE

One-line gate-lift: existing IsEnvironment(\"Test\") block-out gains an &&
PRISM_FILE_LOGGER_FORCE != \"1\" suffix. Real-flow Playwright config sets
the env var so the investigation methodology can capture structured logs
to <DataDir>/logs/prism-yyyy-MM-dd.log. xUnit WebApplicationFactory tests
that don't set the env var remain protected by the original gate.

T-INV-7a/b cover both gate behaviors. See spec § 3.4."
```

---

## Task 5: Spec + plan + pre-push checklist + final commit

**Files:**
- Stage: `docs/specs/2026-05-19-stale-oid-banner-investigation-design.md`, `docs/plans/2026-05-19-stale-oid-investigation-instrumentation.md`.

### Task 5.1: Stage the spec + plan (they ship with this PR)

- [ ] **Step 5.1.1: Stage the docs**

```bash
cd D:/src/prism-stale-oid
git add docs/specs/2026-05-19-stale-oid-banner-investigation-design.md docs/plans/2026-05-19-stale-oid-investigation-instrumentation.md
git commit -m "docs(stale-oid): investigation-design spec + instrumentation plan

Brainstormed spec + writing-plans output for the stale-OID SSE/Reload-banner
investigation. Spec went through two ce-doc-review rounds (round-2 reversed
the round-1 stdout-redirect approach in favor of the FileLoggerExtensions
gate-lift). Plan covers the investigation-instrumentation PR only;
per-hypothesis fix-branch plans wait for the investigation finding."
```

### Task 5.2: Pre-push checklist (per memory `feedback_run_full_pre_push_checklist.md` — every step, no exceptions)

- [ ] **Step 5.2.1: `dotnet build` (Release)**

Run: `dotnet build D:/src/prism-stale-oid/PRism.sln --configuration Release`
Expected: build succeeds with 0 errors and 0 warnings.

If CA-rule warnings fire on the new delegates (CA1848 / CA1727 / CA1873), they should NOT fire — the new code uses `LoggerMessage.Define` (the recommended pattern). If warnings DO fire, check the call-site argument types match the generic parameter types exactly.

- [ ] **Step 5.2.2: `dotnet test` (entire suite, foreground, ≥5 min timeout per memory `feedback_run_full_pre_push_checklist.md`)**

Run: `dotnet test D:/src/prism-stale-oid/PRism.sln --configuration Release`
Expected: ALL PASS. Per memory, this is the long-running build/test command — only ONE such command at a time, in foreground (NOT `run_in_background`).

- [ ] **Step 5.2.3: `npm run lint` (frontend)**

Run: `cd D:/src/prism-stale-oid/frontend && npm run lint`
Expected: passes. Prettier `--check` is part of `npm run lint` per memory `feedback_prettier_check_in_ci.md`. If new frontend files were added (none are in this PR — only `playwright.real.config.ts` was modified), prettier `--write` them BEFORE staging.

- [ ] **Step 5.2.4: `npm run build` (frontend)**

Run: `cd D:/src/prism-stale-oid/frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 5.2.5: Manual smoke — verify the on-disk log file appears under real-flow run**

Run: `cd D:/src/prism-stale-oid/frontend && npx playwright test --config=playwright.real.config.ts --grep "happy path"`
Expected: the happy-path real-flow spec passes. After the run, check `os.tmpdir()/PRism-e2e-real-<timestamp>/logs/prism-yyyy-MM-dd.log`. The file should exist and contain `ActivePrPollSnapshot` lines (EventId 3), `SseActivePrFanout` lines (EventId 4), and `SseActivePrDelivery` lines (EventId 5).

If the file is empty or missing, the gate-lift didn't activate. Re-verify the env var spelling in `playwright.real.config.ts` and the `FileLoggerExtensions` gate logic.

### Task 5.3: Push + open the PR

- [ ] **Step 5.3.1: Push the branch**

Run: `git push -u origin feat/stale-oid-banner`
Expected: push succeeds.

- [ ] **Step 5.3.2: Open the PR via `gh pr create`**

Run:
```bash
cd D:/src/prism-stale-oid
gh pr create --title "feat(diagnostics): stale-OID investigation instrumentation" --body "$(cat <<'EOF'
## Summary

- Three `Information`-level `LoggerMessage.Define` delegates instrument the stale-OID SSE/Reload-banner investigation methodology: `s_pollSnapshotLog` in `ActivePrPoller` (EventId 3), `s_sseActivePrFanoutLog` (EventId 4) + `s_sseActivePrDeliveryLog` (EventId 5) in `SseChannel`.
- One-line `FileLoggerExtensions` gate-lift: `PRISM_FILE_LOGGER_FORCE=1` overrides the Test-env block-out so the real-flow Playwright suite can capture structured logs to `<DataDir>/logs/prism-yyyy-MM-dd.log`. xUnit `WebApplicationFactory` tests that don't set the env var remain protected.
- `playwright.real.config.ts` sets `PRISM_FILE_LOGGER_FORCE=1` in the webServer env block.
- 7 xUnit tests cover the delegates' emission, structured-field correctness, and the gate-override behavior.

This PR enables — but does NOT execute — the investigation. The investigation runs after merge; its finding artifact + per-hypothesis writing-plans output produces the actual fix PR.

Spec: docs/specs/2026-05-19-stale-oid-banner-investigation-design.md
Plan: docs/plans/2026-05-19-stale-oid-investigation-instrumentation.md

## Test plan
- [ ] `dotnet build --configuration Release` green
- [ ] `dotnet test` green (7 new T-INV-* tests + zero regressions)
- [ ] `npm run lint` green
- [ ] `npm run build` green
- [ ] Manual smoke: happy-path real-flow spec runs; `prism-yyyy-MM-dd.log` appears under `os.tmpdir()/PRism-e2e-real-<ts>/logs/` with EventId 3/4/5 lines.
EOF
)"
```

---

## Self-Review

Plan written. Now checking it against the spec.

**1. Spec coverage:**
- Section 3.1 `s_pollSnapshotLog` — Task 1.2.1 / 1.2.2. ✓
- Section 3.2 `s_sseActivePrFanoutLog` — Task 2.2.1 / 2.2.2. ✓
- Section 3.3 `s_sseActivePrDeliveryLog` — Task 3.2.1 / 3.2.2. ✓
- Section 3.4 `FileLoggerExtensions` gate-lift + `PRISM_FILE_LOGGER_FORCE` — Tasks 4.2.1 + 4.3.1. ✓
- Section 7.1 T-INV-1 through T-INV-7 — Tasks 1.1–1.4 (1/2/3), 2.1–2.3 (4/5), 3.1–3.2 (6/6b), 4.1–4.2 (7a/7b). T-INV-7 split into two test methods (gate-blocks + gate-admits) for clarity — the spec's T-INV-7 description allows this. ✓
- Section 8 un-skip mechanics + Section 9 finding artifact format — OUT OF SCOPE for this plan (they belong to the per-hypothesis fix PR + the investigation-finding PR respectively). ✓

**2. Placeholder scan:** no TBD/TODO/"implement later" entries. Every code block contains the actual code; every command shows the full command and expected output.

**3. Type consistency:**
- `s_pollSnapshotLog` signature uses `Action<ILogger, PrReference, string, string?, bool, bool, bool, Exception?>` — matches the generic `LoggerMessage.Define<PrReference, string, string?, bool, bool, bool>` parameters. ✓
- `s_sseActivePrFanoutLog` signature `Action<ILogger, string, PrReference, int, bool, bool, Exception?>` — matches `LoggerMessage.Define<string, PrReference, int, bool, bool>`. ✓
- `s_sseActivePrDeliveryLog` signature `Action<ILogger, string, PrReference, string, bool, Exception?>` — matches `LoggerMessage.Define<string, PrReference, string, bool>`. ✓
- `EventId` numbering: 3 / 4 / 5 — distinct from existing `s_pollFailedLog` (EventId 1) and `s_tickFailedLog` (EventId 2) in `ActivePrPoller.cs`, and the existing SseChannel delegates (if any). Verify EventId 4 and 5 aren't already used in `SseChannel.cs` during implementation — if they are, renumber.

**4. Risk acknowledgment:** Task 3.2.2 calls out that `WriteAndEvictOnFailureAsync`'s signature may need to grow `prRef` + `eventType` parameters. The plan picks option 1 (extend signature) explicitly. If the implementer discovers the method is more complex than the spec assumed, that's a writing-plans deviation worth documenting per memory `feedback_document_plan_deviations.md` — but the plan instructs the implementer to make the smallest signature change consistent with PRism's idioms.

Plan complete and saved to `docs/plans/2026-05-19-stale-oid-investigation-instrumentation.md`. Status: ready for execution.
