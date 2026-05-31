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

        // PR9b-ai-gating § 3.2. Mirrors /ai/summary's seam-resolve-and-map.
        // D111: No per-PR IsSubscribed check while seam is canned-data only.
        // When the binding swaps to a real AI implementation (real generation,
        // not Noop/Placeholder), add an IsSubscribed gate before the seam call
        // — DO NOT merge the seam swap without this gate.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/file-focus",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var ranker = ai.Resolve<IFileFocusRanker>();
                var entries = await ranker
                    .RankAsync(new PrReference(owner, repo, number), ct)
                    .ConfigureAwait(false);
                return entries.Count == 0 ? Results.NoContent() : Results.Ok(entries);
            });

        // PR9b-ai-gating § 3.2. The seam interface takes (prRef, filePath, hunkIndex)
        // for v2 per-hunk queries; v1's placeholder ignores filePath/hunkIndex and
        // returns the canned set wholesale. The endpoint surfaces all annotations
        // for the PR in one fetch so DiffPane can index locally. D109 documents the
        // seam-vs-endpoint divergence rationale; D111 comment below anchors the
        // IsSubscribed-gating reopener.
        //
        // D111: No per-PR IsSubscribed check while seam is canned-data only. When
        // the binding swaps to a real AI implementation (real generation, not Noop/
        // Placeholder), add an IsSubscribed gate before the seam call — DO NOT
        // merge the seam swap without this gate.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/hunk-annotations",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var annotator = ai.Resolve<IHunkAnnotator>();
                var annotations = await annotator
                    .AnnotateAsync(new PrReference(owner, repo, number),
                                   filePath: string.Empty, hunkIndex: 0, ct)
                    .ConfigureAwait(false);
                return annotations.Count == 0 ? Results.NoContent() : Results.Ok(annotations);
            });

        // PR9b-ai-gating § 3.2. Third new AI endpoint. IDraftSuggester.SuggestAsync
        // takes (prRef, ct) — clean per-PR shape, no sentinel args needed.
        //
        // D111: No per-PR IsSubscribed check while seam is canned-data only. When
        // the binding swaps to a real AI implementation (real generation, not Noop/
        // Placeholder), add an IsSubscribed gate before the seam call — DO NOT
        // merge the seam swap without this gate.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/draft-suggestions",
            async (string owner, string repo, int number,
                   IAiSeamSelector ai, CancellationToken ct) =>
            {
                var suggester = ai.Resolve<IDraftSuggester>();
                var suggestions = await suggester
                    .SuggestAsync(new PrReference(owner, repo, number), ct)
                    .ConfigureAwait(false);
                return suggestions.Count == 0 ? Results.NoContent() : Results.Ok(suggestions);
            });

        return app;
    }
}
