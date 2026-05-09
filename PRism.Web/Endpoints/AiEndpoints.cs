using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Contracts;

namespace PRism.Web.Endpoints;

internal static class AiEndpoints
{
    public static IEndpointRouteBuilder MapAi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Spec § 7.3. The Overview tab's AiSummaryCard fetches its content here.
        // The seam selector returns NoopPrSummarizer (→ null → 204) or
        // PlaceholderPrSummarizer (→ canned PrSummary → 200) based on AiPreviewState.
        // v2 swaps in a real summarizer at the same selector slot — this endpoint is
        // unchanged.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/summary",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var summarizer = ai.Resolve<IPrSummarizer>();
                var summary = await summarizer
                    .SummarizeAsync(new PrReference(owner, repo, number), ct)
                    .ConfigureAwait(false);
                return summary is null ? Results.NoContent() : Results.Ok(summary);
            });

        return app;
    }
}
