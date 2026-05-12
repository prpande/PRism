using PRism.Core.Contracts;
using PRism.Web.Submit;

namespace PRism.Web.Tests.Submit;

public class SubmitLockRegistryTests
{
    private static PrReference Ref(int n) => new("o", "r", n);

    [Fact]
    public async Task TryAcquire_ReturnsHandle_OnFirstCall()
    {
        var registry = new SubmitLockRegistry();
        await using var handle = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(handle);
    }

    [Fact]
    public async Task TryAcquire_ReturnsNull_WhenLockHeldByAnotherCaller()
    {
        var registry = new SubmitLockRegistry();
        await using var first = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        await using var second = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(first);
        Assert.Null(second);
    }

    [Fact]
    public async Task TryAcquire_DifferentPrRefs_DoNotInterfere()
    {
        var registry = new SubmitLockRegistry();
        await using var firstPr1 = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        await using var firstPr2 = await registry.TryAcquireAsync(Ref(2), TimeSpan.Zero, default);
        Assert.NotNull(firstPr1);
        Assert.NotNull(firstPr2);
    }

    [Fact]
    public async Task Handle_Release_AllowsReacquisition()
    {
        var registry = new SubmitLockRegistry();
        await using (var h = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default))
        {
            Assert.NotNull(h);
        }
        // After dispose, a new acquire succeeds.
        await using var second = await registry.TryAcquireAsync(Ref(1), TimeSpan.Zero, default);
        Assert.NotNull(second);
    }
}
