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

        var gapSeconds = (next.CommittedDate - prev.CommittedDate).TotalSeconds;
        if (gapSeconds <= coefficients.ForcePushLongGapSeconds) return 1.0;

        var hasForcePushInWindow = input.ForcePushes.Any(fp =>
        {
            var positionedAt = fp.BeforeSha is not null && fp.AfterSha is not null
                ? fp.OccurredAt
                : ClampToPrev(fp.OccurredAt, prev.CommittedDate);

            return positionedAt > prev.CommittedDate && positionedAt <= next.CommittedDate;
        });

        return hasForcePushInWindow ? coefficients.ForcePushAfterLongGap : 1.0;
    }

    private static DateTimeOffset ClampToPrev(DateTimeOffset eventAt, DateTimeOffset prevAt) =>
        eventAt < prevAt ? prevAt : eventAt;
}
