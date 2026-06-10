using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using PRism.Core.Activity;
using PRism.Core.Config;
using Xunit;

namespace PRism.Core.Tests.Activity;

public sealed class ActivityProviderTests
{
    // FakeTimeProvider seeded ~2026 so the 24h activity window includes the
    // `now`-stamped fixtures every test builds (an unseeded fake starts at an
    // arbitrary epoch and would window-filter them out unpredictably).
    private static FakeTimeProvider Clock() =>
        new(DateTimeOffset.UnixEpoch.AddYears(56));

    // --- IConfigStore stub: the provider only reads .Current, so the rest throws. ---
    private sealed class StubConfigStore(AppConfig current) : IConfigStore
    {
        public AppConfig Current { get; } = current;
        public string ConfigPath => throw new NotSupportedException();
        public Exception? LastLoadError => null;
        public Task InitAsync(CancellationToken ct) => throw new NotSupportedException();
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => throw new NotSupportedException();
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => throw new NotSupportedException();
        public event EventHandler<ConfigChangedEventArgs>? Changed { add { } remove { } }
    }

    // AppConfig.Default with Inbox.KnownBots overridden by the arg (default empty).
    private static IConfigStore Config(string knownBots = "")
    {
        var d = AppConfig.Default;
        return new StubConfigStore(d with { Inbox = d.Inbox with { KnownBots = knownBots } });
    }

    // --- Fake readers ---
    private sealed class CountingReceivedEventsReader : IReceivedEventsReader
    {
        public int Calls { get; private set; }
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(new ReceivedEventsResult([], Degraded: false));
        }
    }

    private sealed class SingleEventReceivedEventsReader(RawReceivedEvent ev) : IReceivedEventsReader
    {
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct) =>
            Task.FromResult(new ReceivedEventsResult([ev], Degraded: false));
    }

    private sealed class EmptyNotifReader : INotificationsReader
    {
        public Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct) =>
            Task.FromResult(new NotificationsResult([], Degraded: false));
    }

    private sealed class EmptyWatchReader : IWatchedReposReader
    {
        public Task<WatchedReposResult> ReadAsync(CancellationToken ct) =>
            Task.FromResult(new WatchedReposResult([], Degraded: false));
    }

    private sealed class DegradedReceivedEventsReader : IReceivedEventsReader
    {
        public Task<ReceivedEventsResult> ReadAsync(CancellationToken ct) =>
            Task.FromResult(new ReceivedEventsResult([], Degraded: true));
    }

    private sealed class DegradedNotifReader : INotificationsReader
    {
        public Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct) =>
            Task.FromResult(new NotificationsResult([], Degraded: true));
    }

    private sealed class DegradedWatchReader : IWatchedReposReader
    {
        public Task<WatchedReposResult> ReadAsync(CancellationToken ct) =>
            Task.FromResult(new WatchedReposResult([], Degraded: true));
    }

    private sealed class SingleNotifReader(RawNotification n) : INotificationsReader
    {
        public Task<NotificationsResult> ReadAsync(DateTimeOffset since, CancellationToken ct) =>
            Task.FromResult(new NotificationsResult([n], Degraded: false));
    }

    // No-op enrichment (default): every PR resolves to "no actor" → rows stay actorless.
    private sealed class EmptyTimelineReader : IPrTimelineReader
    {
        public Task<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>> ReadLatestAsync(
            IReadOnlyCollection<(string Repo, int PrNumber)> pullRequests, CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>>(
                new Dictionary<(string Repo, int PrNumber), TimelineActor>());
    }

    // Records the PRs it was asked to enrich and returns a fixed map.
    private sealed class StubTimelineReader(IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor> map)
        : IPrTimelineReader
    {
        public List<(string Repo, int PrNumber)> Requested { get; } = [];
        public Task<IReadOnlyDictionary<(string Repo, int PrNumber), TimelineActor>> ReadLatestAsync(
            IReadOnlyCollection<(string Repo, int PrNumber)> pullRequests, CancellationToken ct)
        {
            Requested.AddRange(pullRequests);
            return Task.FromResult(map);
        }
    }

    private static IPrTimelineReader Timeline() => new EmptyTimelineReader();

    // Gates the fetch mid-flight: signals Entered when ReadAsync is first entered,
    // then awaits the injected release task. Entered is set BEFORE awaiting release
    // so the test can observe entry without deadlocking on the gate.
    private sealed class GatedReceivedEventsReader(Task release) : IReceivedEventsReader
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Calls { get; private set; }
        public async Task<ReceivedEventsResult> ReadAsync(CancellationToken ct)
        {
            Calls++;
            Entered.TrySetResult();
            await release.ConfigureAwait(false);
            return new ReceivedEventsResult([], Degraded: false);
        }
    }

    private static RawReceivedEvent Review(string id, string actor = "alice") => new(
        id, "PullRequestReviewEvent", actor, null, "acme/api", "created", 7, "T",
        "https://github.com/acme/api/pull/7", false, false, DateTimeOffset.UtcNow);

    // --- P1 ctor coverage (updated to the 6-arg form) ---
    [Fact]
    public async Task Maps_reader_output_into_response()
    {
        var reader = new SingleEventReceivedEventsReader(Review("1"));
        var sut = new ActivityProvider(reader, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            Clock(), Config(), NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().ContainSingle().Which.Verb.Should().Be(ActivityVerb.Reviewed);
        resp.Degraded.ReceivedEvents.Should().BeFalse();
    }

    [Fact]
    public async Task Propagates_degradation_with_empty_items()
    {
        var sut = new ActivityProvider(new DegradedReceivedEventsReader(), new EmptyNotifReader(),
            new EmptyWatchReader(), Timeline(), Clock(), Config(), NullLogger<ActivityProvider>.Instance);

        var resp = await sut.GetActivityAsync(default);

        resp.Items.Should().BeEmpty();
        resp.Degraded.ReceivedEvents.Should().BeTrue();
    }

    // --- Cache / generation / Reset ---
    [Fact]
    public async Task Caches_within_ttl_then_refetches_after()
    {
        var clock = Clock();
        var ev = new CountingReceivedEventsReader();
        var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            clock, Config(), NullLogger<ActivityProvider>.Instance);

        await p.GetActivityAsync(default);
        await p.GetActivityAsync(default);
        ev.Calls.Should().Be(1);                                   // 2nd served from cache

        clock.Advance(TimeSpan.FromSeconds(61));
        await p.GetActivityAsync(default);
        ev.Calls.Should().Be(2);                                   // TTL expired → refetch
    }

    [Fact]
    public async Task Reset_forces_refetch()
    {
        var clock = Clock();
        var ev = new CountingReceivedEventsReader();
        var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            clock, Config(), NullLogger<ActivityProvider>.Instance);

        await p.GetActivityAsync(default);
        p.Reset();
        await p.GetActivityAsync(default);
        ev.Calls.Should().Be(2);
    }

    [Fact]
    public async Task Reset_during_inflight_fetch_discards_that_result()
    {
        var clock = Clock();
        var release = new TaskCompletionSource();                  // gates the reader mid-fetch
        var ev = new GatedReceivedEventsReader(release.Task);
        var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            clock, Config(), NullLogger<ActivityProvider>.Instance);

        var inflight = p.GetActivityAsync(default);                // starts fetch #1, blocks on release
        await ev.Entered.Task;                                     // ensure fetch #1 is inside ReadAsync
        p.Reset();                                                 // rotate token mid-fetch (bumps generation)
        release.SetResult();                                       // let fetch #1 complete
        await inflight;                                            // fetch #1 returns but must NOT cache

        await p.GetActivityAsync(default);                        // fetch #2: cache discarded → refetch
        ev.Calls.Should().Be(2);                                   // reset-mid-fetch result was never cached
    }

    [Fact]
    public async Task Waiter_past_ttl_refetches_using_post_wait_time()
    {
        // A request that queues behind a slow (>TTL) in-flight fetch must judge cache
        // freshness by the clock AFTER the wait, not the value captured before it.
        var clock = Clock();
        var release = new TaskCompletionSource();
        var ev = new GatedReceivedEventsReader(release.Task);
        var p = new ActivityProvider(ev, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            clock, Config(), NullLogger<ActivityProvider>.Instance);

        var a = p.GetActivityAsync(default);                       // A: enters reader, holds the gate
        await ev.Entered.Task;                                     // A is inside ReadAsync

        var b = p.GetActivityAsync(default);                      // B: misses fast path, parks on the gate
                                                                   //    (captures pre-wait `now` synchronously here)
        clock.Advance(TimeSpan.FromSeconds(61));                   // >TTL elapses while B waits
        release.SetResult();                                       // A completes, caches with its own (pre-advance) timestamp
        await a;
        await b;                                                   // B acquires the gate

        // With pre-wait `now`, B would see A's entry as 0s old and serve it (Calls == 1).
        // With post-wait `now`, B sees it as 61s old → stale → refetch.
        ev.Calls.Should().Be(2);
    }

    [Fact]
    public async Task Aggregates_degradation_from_three_sources()
    {
        var p = new ActivityProvider(new DegradedReceivedEventsReader(), new DegradedNotifReader(),
            new DegradedWatchReader(), Timeline(), Clock(), Config(), NullLogger<ActivityProvider>.Instance);

        (await p.GetActivityAsync(default)).Degraded
            .Should().Be(new ActivityDegradation(true, true, true));
    }

    // Provider→builder bot wiring: a configured extra bot login flows through and the
    // matching event is flagged as a bot (distinct from the Task 6 pure-builder test).
    [Fact]
    public async Task Configured_extra_bot_flags_event_actor_as_bot()
    {
        var reader = new SingleEventReceivedEventsReader(Review("1", actor: "acme-ci"));
        var p = new ActivityProvider(reader, new EmptyNotifReader(), new EmptyWatchReader(), Timeline(),
            Clock(), Config(knownBots: "acme-ci"), NullLogger<ActivityProvider>.Instance);

        var resp = await p.GetActivityAsync(default);

        resp.Items.Should().ContainSingle().Which.ActorIsBot.Should().BeTrue();
    }

    // A vague (reason=subscribed → Other) notification is enriched with the latest timeline
    // actor + action: the row gains an actor and the verb resolves to the timeline event.
    [Fact]
    public async Task Enriches_vague_notification_with_timeline_actor()
    {
        var clock = Clock();
        var now = clock.GetUtcNow();
        var notif = new RawNotification("acme/api", "subscribed", 7, "Title",
            "https://github.com/acme/api/pull/7", now);
        var timeline = new StubTimelineReader(new Dictionary<(string Repo, int PrNumber), TimelineActor>
        {
            [("acme/api", 7)] = new TimelineActor("dave", "https://avatar/dave", IsBot: false, ActivityVerb.Approved),
        });
        var p = new ActivityProvider(new CountingReceivedEventsReader(), new SingleNotifReader(notif),
            new EmptyWatchReader(), timeline, clock, Config(), NullLogger<ActivityProvider>.Instance);

        var resp = await p.GetActivityAsync(default);

        var item = resp.Items.Should().ContainSingle().Subject;
        item.ActorLogin.Should().Be("dave");
        item.ActorAvatarUrl.Should().Be("https://avatar/dave");
        item.Verb.Should().Be(ActivityVerb.Approved);
        // the provider asked the timeline reader for exactly the vague PR
        timeline.Requested.Should().ContainSingle().Which.Should().Be(("acme/api", 7));
    }
}
