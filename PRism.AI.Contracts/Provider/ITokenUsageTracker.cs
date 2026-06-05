namespace PRism.AI.Contracts.Provider;

/// <summary>Appends a usage record to durable storage (budget visibility).</summary>
public interface ITokenUsageTracker
{
    Task RecordAsync(TokenUsageRecord record, CancellationToken ct);
}
