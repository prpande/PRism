namespace PRism.Core.Iterations;

public sealed record IterationClusteringCoefficients(
    double FileJaccardWeight = 0.5,
    double ForcePushAfterLongGap = 1.5,
    int ForcePushLongGapSeconds = 600,
    // MadK raised from 3 → 4 during 2026-05-18 calibration. Tight-burst PRs (e.g. ShaktimaanAI
    // #8 with 17 commits in 2h) have low MAD relative to median, so MadK=3 sits the threshold
    // near 2× median and turns intra-burst variation into false boundaries. MadK=4 widens the
    // tolerance for legitimate-but-larger-than-median gaps inside a single work session.
    int MadK = 4,
    // HardFloorSeconds calibrated 2026-05-18 against the FrozenPrCorpus (PRism PRs #1, #16, #19,
    // #22, #28) + ShaktimaanAI validation set. Was 300; raised the floor's resolution to 60s
    // because real human-scale commit cadences include 1-3 minute gaps (format fix, hook fix,
    // package-lock regen) that the 300s floor swept into the degenerate bucket.
    int HardFloorSeconds = 60,
    int HardCeilingSeconds = 259200,
    int SkipJaccardAboveCommitCount = 100,
    // DegenerateFloorFraction raised from 0.5 → 0.6 alongside the HardFloor change. PRs with
    // rebase-collapsed timestamps (PRism #16) sit at 0.56 of edges at the floor — 0.5 fired the
    // degenerate detector and short-circuited to Low; 0.6 tolerates rebase collapse while
    // still catching truly-degenerate timelines (>60% identical-time edges).
    double DegenerateFloorFraction = 0.6,
    // MinimumBoundaryGapSeconds = 900 (15 minutes). Added 2026-05-18. The MAD-derived threshold
    // can never go below this — codifies the semantic intuition that real iteration boundaries
    // are at least one context-switch apart. Without this floor, tight-burst PRs with median
    // ~200s and MAD ~100s produce a threshold of ~500s, turning 10-minute test cycles into
    // false iteration boundaries. The MAD threshold still dominates whenever it's above the
    // floor, so long-running PRs with naturally-wide gaps are unaffected.
    int MinimumBoundaryGapSeconds = 900)
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
        if (MinimumBoundaryGapSeconds < 0)
            throw new ArgumentException($"{nameof(MinimumBoundaryGapSeconds)} must be non-negative; got {MinimumBoundaryGapSeconds}.");
        // If the boundary floor exceeds the per-edge ceiling, every weighted distance is
        // capped below the threshold and no edge can ever register as a boundary — clustering
        // silently returns a single iteration for every PR. Reject the unreachable config at
        // load time rather than letting it ship a stealth single-cluster default.
        if (MinimumBoundaryGapSeconds > HardCeilingSeconds)
            throw new ArgumentException($"{nameof(MinimumBoundaryGapSeconds)} ({MinimumBoundaryGapSeconds}) must be <= {nameof(HardCeilingSeconds)} ({HardCeilingSeconds}); otherwise no edge can ever cross the boundary threshold.");
    }
}
