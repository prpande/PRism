using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

/// <summary>
/// Cached value held by <see cref="PrDetailLoader"/>. The snapshot's <see cref="HeadSha"/>
/// mirrors <c>Detail.Pr.HeadSha</c> at fetch time and is part of the cache key (a head
/// advance forces a fresh fetch). <see cref="CoefficientsGeneration"/> bumps on
/// <see cref="PrDetailLoader.InvalidateAll"/> so coefficient hot-reloads re-cluster.
/// </summary>
public sealed record PrDetailSnapshot(
    PrDetailDto Detail,
    string HeadSha,
    int CoefficientsGeneration);
