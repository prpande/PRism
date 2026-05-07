namespace PRism.Core.Iterations;

public sealed record IterationClusteringCoefficients(
    double FileJaccardWeight = 0.5,
    double ForcePushAfterLongGap = 1.5,
    int ForcePushLongGapSeconds = 600,
    int MadK = 3,
    int HardFloorSeconds = 300,
    int HardCeilingSeconds = 259200,
    int SkipJaccardAboveCommitCount = 100,
    double DegenerateFloorFraction = 0.5)
{
    public void Validate()
    {
        if (HardFloorSeconds < 0)
            throw new ArgumentException($"{nameof(HardFloorSeconds)} must be non-negative; got {HardFloorSeconds}.");
        if (HardFloorSeconds > HardCeilingSeconds)
            throw new ArgumentException($"{nameof(HardFloorSeconds)} ({HardFloorSeconds}) must be <= {nameof(HardCeilingSeconds)} ({HardCeilingSeconds}).");
        if (MadK <= 0)
            throw new ArgumentException($"{nameof(MadK)} must be positive; got {MadK}.");
        // Multiplier = 1 - FileJaccardWeight * jaccard. The IDistanceMultiplier contract requires
        // a value in (0, ∞). With jaccard in [0, 1], FileJaccardWeight must be in [0, 1) to keep
        // the multiplier strictly positive even at full overlap (jaccard = 1).
        if (FileJaccardWeight < 0 || FileJaccardWeight >= 1)
            throw new ArgumentException($"{nameof(FileJaccardWeight)} must be in [0, 1); got {FileJaccardWeight}.");
        if (DegenerateFloorFraction <= 0 || DegenerateFloorFraction > 1)
            throw new ArgumentException($"{nameof(DegenerateFloorFraction)} must be in (0, 1]; got {DegenerateFloorFraction}.");
    }
}
