using System;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.AI.Contracts.Provider;
using PRism.Web.Ai;
using Xunit;

namespace PRism.Web.Tests.Ai;

public sealed class CachedLlmAvailabilityProbeTests
{
    private sealed class CountingProbe : ILlmAvailabilityProbe
    {
        public int Calls;
        public Task<LlmAvailability> ProbeAsync(CancellationToken ct) { Calls++; return Task.FromResult(LlmAvailability.Ok); }
    }

    /// <summary>
    /// Minimal hand-rolled TimeProvider stub: holds a mutable "now" that tests advance explicitly.
    /// Microsoft.Extensions.Time.Testing (FakeTimeProvider) is not referenced in this project;
    /// this stub is the testability seam instead.
    /// </summary>
    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan delta) => _now = _now.Add(delta);
    }

    [Fact]
    public async Task SecondCall_WithinTtl_UsesCache()
    {
        var inner = new CountingProbe();
        var clock = new ManualTimeProvider();
        var probe = new CachedLlmAvailabilityProbe(inner, clock, TimeSpan.FromSeconds(30));

        await probe.ProbeAsync(CancellationToken.None);
        await probe.ProbeAsync(CancellationToken.None);
        inner.Calls.Should().Be(1);

        clock.Advance(TimeSpan.FromSeconds(31));
        await probe.ProbeAsync(CancellationToken.None);
        inner.Calls.Should().Be(2);
    }

    [Fact]
    public async Task FirstCall_AlwaysProbes()
    {
        var inner = new CountingProbe();
        var clock = new ManualTimeProvider();
        var probe = new CachedLlmAvailabilityProbe(inner, clock, TimeSpan.FromSeconds(30));

        await probe.ProbeAsync(CancellationToken.None);
        inner.Calls.Should().Be(1);
    }

    [Fact]
    public async Task ReturnsCachedResult_NotNewResult()
    {
        int callCount = 0;
        var probe = new CachedLlmAvailabilityProbe(
            new DelegatingProbe(() =>
            {
                callCount++;
                return callCount == 1
                    ? LlmAvailability.Ok
                    : LlmAvailability.Unavailable("second-call");
            }),
            new ManualTimeProvider(),
            TimeSpan.FromSeconds(30));

        var first = await probe.ProbeAsync(CancellationToken.None);
        var second = await probe.ProbeAsync(CancellationToken.None);

        second.Should().Be(first);    // cached — same Ok instance
        callCount.Should().Be(1);
    }

    private sealed class DelegatingProbe(Func<LlmAvailability> fn) : ILlmAvailabilityProbe
    {
        public Task<LlmAvailability> ProbeAsync(CancellationToken ct) => Task.FromResult(fn());
    }
}
