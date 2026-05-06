namespace PRism.Core.Inbox;

public sealed class InboxSubscriberCount
{
    private int _count;
    private TaskCompletionSource _hasSubscribers = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public int Current => Volatile.Read(ref _count);

    public void Increment()
    {
        // Volatile.Read on _hasSubscribers so the 0->1 transition completes the TCS that
        // Decrement most recently swapped in (otherwise a stale plain-field read could
        // call TrySetResult on the already-completed prior TCS, leaving the active gate
        // blocked indefinitely).
        if (Interlocked.Increment(ref _count) == 1)
            Volatile.Read(ref _hasSubscribers).TrySetResult();
    }

    public void Decrement()
    {
        // CAS loop: clamp at zero so an extra Decrement (double-dispose, error path)
        // cannot drive _count negative and cannot spuriously reset the gate.
        // Only the 1 -> 0 transition swaps in a fresh (uncompleted) TCS.
        while (true)
        {
            var current = Volatile.Read(ref _count);
            if (current <= 0)
                return; // Already drained — nothing to do, and definitely don't go negative.

            if (Interlocked.CompareExchange(ref _count, current - 1, current) != current)
                continue; // Lost the race — re-read and retry.

            if (current == 1)
                Interlocked.Exchange(ref _hasSubscribers,
                    new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));
            return;
        }
    }

    public Task WaitForSubscriberAsync(CancellationToken ct)
    {
        // Race-safe by design: when Decrement triggers the TCS exchange, a concurrent
        // reader may capture the old (completed) TCS via Volatile.Read and pass through
        // immediately. This causes one extra refresh tick — harmless. The next call to
        // WaitForSubscriberAsync sees the new (uncompleted) TCS and gates correctly.
        var t = Volatile.Read(ref _hasSubscribers).Task;
        return t.IsCompleted ? Task.CompletedTask : t.WaitAsync(ct);
    }
}
