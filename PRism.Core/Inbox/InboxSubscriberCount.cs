namespace PRism.Core.Inbox;

public sealed class InboxSubscriberCount
{
    private int _count;
    private TaskCompletionSource _hasSubscribers = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public int Current => Volatile.Read(ref _count);

    public void Increment()
    {
        if (Interlocked.Increment(ref _count) == 1)
            _hasSubscribers.TrySetResult();
    }

    public void Decrement()
    {
        if (Interlocked.Decrement(ref _count) == 0)
            Interlocked.Exchange(ref _hasSubscribers,
                new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
    }

    public Task WaitForSubscriberAsync(CancellationToken ct)
    {
        var t = Volatile.Read(ref _hasSubscribers).Task;
        return t.IsCompleted ? Task.CompletedTask : t.WaitAsync(ct);
    }
}
