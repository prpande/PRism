using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPrSummarizer : IPrSummarizer
{
    // #464: prefix the sample body with the PR ref so each PR's Preview reads as THIS PR's sample.
    // The canned body alone was byte-identical across PRs, so a sample seen on one PR was
    // indistinguishable from another's — which read as a stale cross-PR summary. Pure local string
    // interpolation (PrId is already on the ref); no egress. The generic PlaceholderData.SummaryBody
    // constant is unchanged — the inbox hover-summary enricher still uses it.
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        return Task.FromResult<PrSummary?>(new PrSummary(
            $"Sample AI summary for {pr.PrId}. {PlaceholderData.SummaryBody}", PlaceholderData.SummaryCategory));
    }

    // Preview mode has no cache to bypass — regenerate returns the same placeholder (no real spend).
    public Task<PrSummary?> RegenerateAsync(PrReference pr, CancellationToken ct) => SummarizeAsync(pr, ct);
}
