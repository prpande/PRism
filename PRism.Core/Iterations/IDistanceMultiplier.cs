using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Iterations;

[SuppressMessage("Naming", "CA1716:Identifiers should not match keywords",
    Justification = "'For' and 'next' are the natural names for a per-edge distance multiplier; the interface is internal-facing and not exposed to VB consumers.")]
public interface IDistanceMultiplier
{
    /// <summary>Returns the multiplier in (0, ∞) for the gap between the two consecutive commits.</summary>
    double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
