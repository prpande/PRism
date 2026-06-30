using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Activity;
using PRism.Core.Storage;
using PRism.Core.Tests.Inbox;
using Xunit;

namespace PRism.Core.Tests.Activity;

/// <summary>
/// Spec tests 16, 17, 17b, 18 — activity provider cold-start cache:
/// rehydrate-with-expired-TTL, generation-gated write-through, cross-identity guard, evict-on-Reset.
/// </summary>
public sealed class ActivityCacheTests
{
    // -----------------------------------------------------------------------
    // Test 16 — cold miss with matching cache entry rehydrates stale; next call fetches live
    // -----------------------------------------------------------------------

    [Fact]
    public async Task First_miss_rehydrates_with_expired_At_then_next_call_fetches_live()
    {
        var cached = ActivityTestData.Response(prNumber: 1) with { Stale = false };
        var fileCache = new RecordingIdentityCache<ActivityResponse>();
        await fileCache.SaveAsync(cached, new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var readers = new SpyReaders();
        var sut = ActivityTestData.Provider(fileCache, readers, login: "octocat", host: "github.com");

        // --- first call: served from disk ---
        var first = await sut.GetActivityAsync(CancellationToken.None);

        first.Stale.Should().BeTrue("the rehydrated entry must be flagged stale");
        first.Items.Should().HaveCount(1, "disk payload must be returned intact");
        readers.TotalReads.Should().Be(0, "no GitHub fan-out should have happened on the cold rehydrate");

        // --- second call: expired At forces a live fetch ---
        var second = await sut.GetActivityAsync(CancellationToken.None);

        readers.TotalReads.Should().BeGreaterThan(0, "the expired At must force a live fetch on the next call");
        second.Stale.Should().BeFalse("a freshly fetched response is never stale");
    }

    // -----------------------------------------------------------------------
    // Test 17 — write-through is generation-gated: Reset() mid-fetch discards the result
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Write_through_is_generation_gated()
    {
        var fileCache = new RecordingIdentityCache<ActivityResponse>();
        var readers = new SpyReaders();
        var sut = ActivityTestData.Provider(fileCache, readers, login: "octocat", host: "github.com");

        // Rotate the generation the instant the fan-out starts, so the in-flight build
        // is stamped under a now-stale generation and the gen-gate discards the write.
        readers.OnFanOutStarted = () => sut.Reset();

        await sut.GetActivityAsync(CancellationToken.None);

        fileCache.Saves.Should().BeEmpty("the write was discarded because Reset() rotated the generation mid-fetch");
    }

    // -----------------------------------------------------------------------
    // Test 17b (round-2 SEC-1) — write-through stamps the login captured BEFORE the fan-out
    // -----------------------------------------------------------------------

    [Fact]
    public async Task Write_through_stamps_login_captured_before_fanout()
    {
        var fileCache = new RecordingIdentityCache<ActivityResponse>();
        var login = new MutableLogin("alice");
        var readers = new SpyReaders();
        var sut = ActivityTestData.Provider(fileCache, readers, loginProvider: login.Get, host: "github.com");

        // Flip the login to "bob" the instant the fan-out starts — simulates /connect's
        // Set("bob") landing during SetDefaultAccountLoginAsync (a real disk-I/O await)
        // BEFORE Reset() runs. The generation is NOT rotated here, so the write-through's
        // gen gate passes — only the captured-login stamp prevents the cross-identity leak.
        readers.OnFanOutStarted = () => login.Value = "bob";

        await sut.GetActivityAsync(CancellationToken.None);

        fileCache.Saves.Should().ContainSingle("a live feed must be persisted");
        fileCache.Saves.Single().Identity.Login.Should().Be("alice",
            "the stamp must use the login captured BEFORE the fan-out, not the flipped 'bob'");
        fileCache.TryLoad(new CacheIdentity("bob", "github.com")).Should().BeNull(
            "alice's feed must not be retrievable under bob's identity");
    }

    // -----------------------------------------------------------------------
    // Test 18 — Reset evicts the persisted feed
    // -----------------------------------------------------------------------

    [Fact]
    public void Reset_evicts_persisted_feed()
    {
        var fileCache = new RecordingIdentityCache<ActivityResponse>();
        var sut = ActivityTestData.Provider(fileCache, new SpyReaders(),
            login: "octocat", host: "github.com");

        sut.Reset();

        fileCache.EvictCount.Should().BeGreaterThan(0, "Reset must fire-and-forget EvictAsync");
    }
}
