namespace PRism.Core.Iterations;

public sealed class ForcePushMultiplier : IDistanceMultiplier
{
    public double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients)
    {
        ArgumentNullException.ThrowIfNull(prev);
        ArgumentNullException.ThrowIfNull(next);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(coefficients);

        var gapSeconds = Math.Max(0, (next.CommittedDate - prev.CommittedDate).TotalSeconds);
        if (gapSeconds <= coefficients.ForcePushLongGapSeconds) return 1.0;

        // Position by occurredAt for both known-SHA and null-SHA force-pushes — the SHAs are
        // not used to anchor the position. Clamp to prev.CommittedDate to defend against
        // server-clock-vs-committer-clock skew (spec § 6.4 footnote).
        var hasForcePushInWindow = input.ForcePushes.Any(fp =>
        {
            var positionedAt = ClampToPrev(fp.OccurredAt, prev.CommittedDate);
            return positionedAt > prev.CommittedDate && positionedAt <= next.CommittedDate;
        });

        return hasForcePushInWindow ? coefficients.ForcePushAfterLongGap : 1.0;
    }

    private static DateTimeOffset ClampToPrev(DateTimeOffset eventAt, DateTimeOffset prevAt) =>
        eventAt < prevAt ? prevAt : eventAt;
}
