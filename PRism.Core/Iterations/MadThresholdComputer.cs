namespace PRism.Core.Iterations;

public static class MadThresholdComputer
{
    public static double Compute(IReadOnlyList<double> distances, int k)
    {
        ArgumentNullException.ThrowIfNull(distances);
        if (distances.Count == 0) return double.MaxValue;

        var sorted = distances.OrderBy(x => x).ToArray();
        var median = Median(sorted);

        var deviations = distances.Select(x => Math.Abs(x - median)).OrderBy(x => x).ToArray();
        var mad = Median(deviations);

        if (mad > double.Epsilon) return median + k * mad;

        // MAD=0 means >half the distances cluster at the median (typically the floor under
        // rebase-collapsed timelines). The legacy `median + 1` fallback then makes every
        // non-clamped gap a boundary, over-segmenting rebase-collapsed PRs. Use the
        // SECOND-largest distance as the threshold — only outliers strictly greater than the
        // second-largest cross, so a single max-outlier reliably becomes a boundary while a
        // run of equal large values does not. Preserves `median + 1` as the floor for the
        // all-distances-equal case (where sorted[^2] == median).
        var secondLargest = sorted.Length >= 2 ? sorted[^2] : sorted[^1];
        return Math.Max(median + 1, secondLargest);
    }

    private static double Median(double[] sorted)
    {
        if (sorted.Length == 0) return 0;
        var mid = sorted.Length / 2;
        return sorted.Length % 2 == 0
            ? (sorted[mid - 1] + sorted[mid]) / 2.0
            : sorted[mid];
    }
}
