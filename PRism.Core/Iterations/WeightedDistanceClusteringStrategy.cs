namespace PRism.Core.Iterations;

public sealed class WeightedDistanceClusteringStrategy : IIterationClusteringStrategy
{
    private readonly IReadOnlyList<IDistanceMultiplier> _multipliers;

    public WeightedDistanceClusteringStrategy(IEnumerable<IDistanceMultiplier> multipliers)
    {
        ArgumentNullException.ThrowIfNull(multipliers);
        _multipliers = multipliers.ToList();
    }

    public IReadOnlyList<IterationCluster>? Cluster(
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(coefficients);
        coefficients.Validate();

        if (input.Commits.Count == 0) return Array.Empty<IterationCluster>();

        var sorted = input.Commits.OrderBy(c => c.CommittedDate).ToArray();
        if (sorted.Length == 1)
            return new[] { new IterationCluster(1, sorted[0].Sha, sorted[0].Sha, new[] { sorted[0].Sha }) };

        var weighted = new double[sorted.Length - 1];
        var floor = coefficients.HardFloorSeconds;
        var ceiling = coefficients.HardCeilingSeconds;

        for (var i = 0; i < sorted.Length - 1; i++)
        {
            var dt = Math.Max(0, (sorted[i + 1].CommittedDate - sorted[i].CommittedDate).TotalSeconds);
            var multiplier = _multipliers
                .Select(m => m.For(sorted[i], sorted[i + 1], input, coefficients))
                .Aggregate(1.0, (acc, m) => acc * m);
            weighted[i] = Math.Clamp(dt * multiplier, floor, ceiling);
        }

        // Degenerate-case: > DegenerateFloorFraction at hard floor → return null so the
        // caller (PrDetailLoader) emits ClusteringQuality:Low on the snapshot. The frontend
        // renders CommitMultiSelectPicker — a GitHub-style commit picker — instead of fake
        // iteration tabs.
        //
        // Gated by `weighted.Length >= MadK * 2` so small-N tight-amend cases naturally
        // fall through to the MAD path (which produces a single cluster when all weighted
        // distances are equal, since no edge exceeds median + 1). Below this threshold,
        // we don't have enough data points to declare "insufficient signal" reliably.
        // Math.Clamp guarantees w >= floor, so `w <= floor` is exactly equivalent to
        // `w == floor` and avoids a tolerance band that would misclassify naturally-small
        // gaps just above the floor as floor-clamped.
        //
        // The earlier materialized fallback (tab-per-commit when ≤ MaxFallbackTabs, single
        // inconclusive tab otherwise) was dropped per the Q5 redesign: surfacing fake
        // structure was less useful than telling the user "we couldn't cluster — pick the
        // commits yourself" via the picker.
        var floorClampedFraction = (double)weighted.Count(w => w <= floor) / weighted.Length;
        if (weighted.Length >= coefficients.MadK * 2 &&
            floorClampedFraction > coefficients.DegenerateFloorFraction)
        {
            return null;
        }

        var threshold = MadThresholdComputer.Compute(weighted, coefficients.MadK);
        var boundaries = new List<int>();
        for (var i = 0; i < weighted.Length; i++)
            if (weighted[i] > threshold) boundaries.Add(i);

        var clusters = new List<IterationCluster>();
        var startIdx = 0;
        var iterationNumber = 1;
        foreach (var b in boundaries)
        {
            var endIdx = b;
            clusters.Add(new IterationCluster(
                iterationNumber++,
                sorted[startIdx].Sha,
                sorted[endIdx].Sha,
                sorted[startIdx..(endIdx + 1)].Select(c => c.Sha).ToArray()));
            startIdx = endIdx + 1;
        }
        clusters.Add(new IterationCluster(
            iterationNumber,
            sorted[startIdx].Sha,
            sorted[^1].Sha,
            sorted[startIdx..].Select(c => c.Sha).ToArray()));

        return clusters;
    }
}
