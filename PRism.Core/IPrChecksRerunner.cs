using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Contracts;

namespace PRism.Core;

/// <summary>Re-triggers a single GitHub check-run (the Checks tab "Re-run" action). Write path —
/// distinct from the read-only <see cref="IPrChecksReader"/>. SHA-guards before rerequesting so a
/// stale check-run id cannot re-run a superseded commit's check.</summary>
public interface IPrChecksRerunner
{
    /// <param name="expectedHeadSha">The SHA the check-run was read under; a mismatch
    /// (the head advanced since the poll) returns <see cref="RerunOutcome.Superseded"/>
    /// without rerequesting.</param>
    Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct);
}
