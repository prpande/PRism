namespace PRism.Core.Iterations;

public sealed class FileJaccardMultiplier : IDistanceMultiplier
{
    public double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        ArgumentNullException.ThrowIfNull(prev);
        ArgumentNullException.ThrowIfNull(next);
        ArgumentNullException.ThrowIfNull(coefficients);

        if (prev.ChangedFiles is null || next.ChangedFiles is null) return 1.0;
        if (prev.ChangedFiles.Count == 0 || next.ChangedFiles.Count == 0) return 1.0;

        var prevSet = new HashSet<string>(prev.ChangedFiles, StringComparer.Ordinal);
        var nextSet = new HashSet<string>(next.ChangedFiles, StringComparer.Ordinal);

        var intersection = prevSet.Intersect(nextSet).Count();
        var union = prevSet.Union(nextSet).Count();
        if (union == 0) return 1.0;

        var jaccard = (double)intersection / union;
        return 1.0 - coefficients.FileJaccardWeight * jaccard;
    }
}
