using System.Threading;
using System.Threading.Tasks;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

/// <summary>Deterministic rerun double for endpoint tests. Returns a settable outcome.</summary>
internal sealed class FakePrChecksRerunner : IPrChecksRerunner
{
    public RerunOutcome Outcome { get; set; } = RerunOutcome.Accepted;

    public Task<RerunResultDto> RerunAsync(
        PrReference pr, long checkRunId, string expectedHeadSha, CancellationToken ct) =>
        Task.FromResult(new RerunResultDto(Outcome));
}
