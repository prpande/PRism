namespace PRism.Core.Logging;

public sealed class NoopStateEventLog : IStateEventLog
{
    public Task AppendAsync(StateEvent evt, CancellationToken ct) => Task.CompletedTask;
}
