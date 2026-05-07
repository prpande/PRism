namespace PRism.Core.Iterations;

public interface IIterationClusteringStrategy
{
    /// <summary>
    /// Cluster the input commits into iteration boundaries.
    /// </summary>
    /// <returns>
    /// Non-null on a successful clustering decision (zero or more <see cref="IterationCluster"/>s).
    /// <c>null</c> when the strategy detects insufficient signal to produce a trustworthy clustering
    /// (the per-PR degenerate case described in spec § 6.4). Callers translate <c>null</c> into
    /// <c>ClusteringQuality.Low</c> on the snapshot, which the frontend renders as a
    /// <c>CommitMultiSelectPicker</c> instead of an iteration-tab strip.
    /// </returns>
    IReadOnlyList<IterationCluster>? Cluster(
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
