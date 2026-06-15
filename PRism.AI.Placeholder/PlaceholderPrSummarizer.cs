using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPrSummarizer : IPrSummarizer
{
    // #464: prefix the sample body with the PR ref so each PR's Preview reads as THIS PR's
    // sample, not a byte-identical canned body that looks like another PR's summary.
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        return Task.FromResult<PrSummary?>(new PrSummary(
            $"Sample AI summary for {pr.PrId}. {PlaceholderData.SummaryBody}", PlaceholderData.SummaryCategory));
    }

    // Preview mode has no cache to bypass — regenerate returns the same placeholder (no real spend).
    public Task<PrSummary?> RegenerateAsync(PrReference pr, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(pr);
        return SummarizeAsync(pr, ct);
    }
}
