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

        return mad <= double.Epsilon ? median + 1 : median + k * mad;
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
