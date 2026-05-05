using FluentAssertions;
using PRism.Core.Inbox;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxSubscriberCountTests
{
    [Fact]
    public void Current_starts_at_zero()
    {
        var sut = new InboxSubscriberCount();
        sut.Current.Should().Be(0);
    }

    [Fact]
    public void Increment_then_decrement_returns_to_zero()
    {
        var sut = new InboxSubscriberCount();

        sut.Increment();
        sut.Current.Should().Be(1);

        sut.Decrement();
        sut.Current.Should().Be(0);
    }

    [Fact]
    public async Task WaitForSubscriberAsync_completes_immediately_when_subscribers_present()
    {
        var sut = new InboxSubscriberCount();
        sut.Increment();

        using var cts = new CancellationTokenSource();
        var task = sut.WaitForSubscriberAsync(cts.Token);

        // Should already be completed
        task.IsCompleted.Should().BeTrue();
        await task; // No exception
    }

    [Fact]
    public async Task WaitForSubscriberAsync_blocks_until_first_increment()
    {
        var sut = new InboxSubscriberCount();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var waitTask = sut.WaitForSubscriberAsync(cts.Token);

        // Give it a moment — task should NOT be completed yet
        await Task.Delay(30);
        waitTask.IsCompleted.Should().BeFalse();

        // Now increment
        sut.Increment();

        // Task should complete shortly
        await waitTask.WaitAsync(TimeSpan.FromMilliseconds(500));
        waitTask.IsCompleted.Should().BeTrue();
    }

    [Fact]
    public async Task WaitForSubscriberAsync_blocks_again_after_drop_to_zero()
    {
        var sut = new InboxSubscriberCount();

        // Increment then decrement — should reset the gate
        sut.Increment();
        sut.Decrement();

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var waitTask = sut.WaitForSubscriberAsync(cts.Token);

        await Task.Delay(30);
        waitTask.IsCompleted.Should().BeFalse();

        // Increment again — should unblock
        sut.Increment();

        await waitTask.WaitAsync(TimeSpan.FromMilliseconds(500));
        waitTask.IsCompleted.Should().BeTrue();
    }

    [Fact]
    public async Task Concurrent_increment_decrement_keeps_count_consistent()
    {
        var sut = new InboxSubscriberCount();

        await Parallel.ForAsync(0, 1000, async (_, _) =>
        {
            sut.Increment();
            await Task.Yield();
            sut.Decrement();
        });

        sut.Current.Should().Be(0);
    }

    [Fact]
    public async Task Cancellation_during_wait_propagates()
    {
        var sut = new InboxSubscriberCount();

        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        var act = async () => await sut.WaitForSubscriberAsync(cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
