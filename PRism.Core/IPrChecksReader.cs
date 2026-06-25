// PRism.Core/IPrChecksReader.cs
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Contracts;

namespace PRism.Core;

/// <summary>Reads the individual CI checks for a PR's specified head commit. Read-only, uncached
/// (the frontend hook owns freshness). Distinct from ICiFailingDetector, which caches + aggregates
/// to a 4-state inbox rollup; this returns verbatim per-check for the PR-detail Checks tab.</summary>
public interface IPrChecksReader
{
    Task<ChecksResponseDto> ReadAsync(PrReference pr, string headSha, CancellationToken ct);
}
