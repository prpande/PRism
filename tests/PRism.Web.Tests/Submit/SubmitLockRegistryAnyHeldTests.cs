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
        await Task.CompletedTask;
    }

    [Fact]
    public async Task AnyHeld_LockHeld_ReturnsTrueWithRef()
    {
        var registry = new SubmitLockRegistry();
        await using var handle = await registry.TryAcquireAsync(Pr1, TimeSpan.Zero, CancellationToken.None);
        handle.Should().NotBeNull();

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeTrue();
        prRef.Should().Be(Pr1.ToString());
    }

    [Fact]
    public async Task AnyHeld_LockAcquiredAndReleased_ReturnsFalseNull()
    {
        // Defends against the naive `_locks.Any()` regression: the underlying SemaphoreSlim
        // entry stays in _locks forever after release (no eviction by design), but AnyHeld
        // must report not-held. The held-set is the single source of truth.
        var registry = new SubmitLockRegistry();
        var handle = await registry.TryAcquireAsync(Pr1, TimeSpan.Zero, CancellationToken.None);
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
        await using var h1 = await registry.TryAcquireAsync(Pr1, TimeSpan.Zero, CancellationToken.None);
        await using var h2 = await registry.TryAcquireAsync(Pr2, TimeSpan.Zero, CancellationToken.None);

        var (held, prRef) = registry.AnyHeld();

        held.Should().BeTrue();
        prRef.Should().BeOneOf(Pr1.ToString(), Pr2.ToString());
    }
}
