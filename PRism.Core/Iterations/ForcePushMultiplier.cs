namespace PRism.Core.Iterations;

/// <summary>
/// Despite the name, this multiplier does two things in sequence:
///   1. <b>Short-gap commit suppression</b> (early-return): when the gap between
///      <see cref="ClusteringCommit.CommittedDate"/> values is ≤
///      <see cref="IterationClusteringCoefficients.ForcePushLongGapSeconds"/> (default 600s),
///      returns 1.0 regardless of whether any force-push event exists. This is the path
///      exercised by tight intra-cluster commits like rapid CI-loop fixes.
///   2. <b>Force-push amplification</b>: when the gap is long AND a
///      <c>HeadRefForcePushedEvent</c> sits in the [prev, next] window, returns
///      <see cref="IterationClusteringCoefficients.ForcePushAfterLongGap"/> (default 1.5x)
///      to encourage a boundary.
/// The class is named for the second behaviour because that was the originally-intended
/// purpose; the short-gap-suppression path was added later. A future rename to
/// <c>CommitGapAndForcePushMultiplier</c> is tracked as a separate follow-up in
/// docs/specs/2026-05-18-frozen-pr-contract-tests-design.md § 12.1.
/// </summary>
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
