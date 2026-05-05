namespace PRism.Core.Logging;

public sealed record StateEvent(string Kind, DateTime At, IReadOnlyDictionary<string, object?> Fields);

public interface IStateEventLog
{
    Task AppendAsync(StateEvent evt, CancellationToken ct);
}
