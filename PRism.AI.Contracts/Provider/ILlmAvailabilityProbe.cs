namespace PRism.AI.Contracts.Provider;

/// <summary>Probes whether the provider's Live mode is currently reachable.</summary>
public interface ILlmAvailabilityProbe
{
    Task<LlmAvailability> ProbeAsync(CancellationToken ct);
}
