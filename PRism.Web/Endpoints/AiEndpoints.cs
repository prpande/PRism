using Microsoft.AspNetCore.Http;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Seams;
using PRism.Core.Ai;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class AiEndpoints
{
    public static IEndpointRouteBuilder MapAi(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        // Spec § 7.3. The Overview tab's AiSummaryCard fetches its content here.
        // D111 (spec §6): tokens are only spent when someone is actively viewing the PR.
        // If no subscriber is registered for the PR, returns 204 immediately without calling
        // the seam. Provider failure is mapped to 503 (spec §7/§9) — never 500.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/summary",
            (string owner, string repo, int number, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct) =>
                ResolveSummaryAsync(new PrReference(owner, repo, number), ai, activePrCache, regenerate: false, ct));

        // Deliberate re-spend (state-changing) → POST, CSRF-covered by OriginCheckMiddleware.
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/ai/summary/regenerate",
            (string owner, string repo, int number, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct) =>
                ResolveSummaryAsync(new PrReference(owner, repo, number), ai, activePrCache, regenerate: true, ct));

        // Spec § P1-2. Mirrors /ai/summary's gate chain. D111 (spec §6): tokens are only spent when
        // someone is actively viewing the PR — the IsSubscribed gate runs FIRST so a non-subscribed
        // request never reaches the (now real) ClaudeCodeFileFocusRanker seam. Provider failure → 503
        // (never 500), matching ResolveSummaryAsync. 204 fires ONLY when diff.Files is empty (zero
        // changed files). An all-low-by-rule PR (every file has an empty hunk body but diff.Files is
        // non-empty) returns 200 with a non-empty all-Low entries list — it never produces 204.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/file-focus",
            (string owner, string repo, int number, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct) =>
                ResolveFileFocusAsync(new PrReference(owner, repo, number), ai, activePrCache, ct));

        // PR9b-ai-gating § 3.2 + #414. The seam interface takes (prRef, filePath, hunkIndex) for v2
        // per-hunk queries (#477); the one-shot endpoint passes (string.Empty, 0) sentinels and surfaces
        // ALL annotations for the PR in one fetch so DiffPane indexes locally (D109).
        //
        // D111 (spec §6): the real ClaudeCodeHunkAnnotator is now wired (#414), so the IsSubscribed gate
        // runs FIRST — a non-subscribed view never spends tokens on the real annotator. Provider failure /
        // oversized prompt → 503 (never 500), matching /ai/summary + /ai/file-focus.
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/ai/hunk-annotations",
            (string owner, string repo, int number, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct) =>
                ResolveHunkAnnotationsAsync(new PrReference(owner, repo, number), ai, activePrCache, ct));

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

    // Shared gate chain (spec §7): D111 IsSubscribed → seam resolve (Off/Preview/Live gating lives in
    // Resolve) → Summarize/Regenerate. Provider failure → 503 (never 500). regenerate=true forces a
    // fresh, IsRetry-tagged re-spend.
    internal static async Task<IResult> ResolveSummaryAsync(
        PrReference prRef, IAiSeamSelector ai, IActivePrCache activePrCache, bool regenerate, CancellationToken ct)
    {
        if (!activePrCache.IsSubscribed(prRef))
            return Results.NoContent();

        var summarizer = ai.Resolve<IPrSummarizer>();
        try
        {
            var summary = regenerate
                ? await summarizer.RegenerateAsync(prRef, ct).ConfigureAwait(false)
                : await summarizer.SummarizeAsync(prRef, ct).ConfigureAwait(false);
            return summary is null ? Results.NoContent() : Results.Ok(summary);
        }
        catch (LlmProviderException)
        {
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
        catch (ArgumentException)
        {
            // PromptSanitizer.WrapAsData throws ArgumentException when a single diff field exceeds the
            // 2 MB default cap. The content is diff-derived (attacker-influenceable), so this must map
            // to 503 — not 500 — to preserve the "provider failure → 503 (never 500)" contract.
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }

    // Spec § P1-2. The file-focus gate chain, mirroring ResolveSummaryAsync: D111 IsSubscribed → seam
    // resolve (tri-state gating lives in Resolve) → RankAsync. The IsSubscribed check runs BEFORE the
    // seam is resolved/invoked so a non-subscribed view never spends tokens on the real ranker.
    // 204 only when the diff has zero changed files (ClaudeCodeFileFocusRanker.RankAsync returns early
    // with an empty Entries list). An all-low-by-rule PR (every file has an empty hunk body) still
    // returns 200 with one Low entry per file — RankAsync's toRank.Count==0 branch produces a non-empty
    // list, not an empty one. Provider failure → 503 (never 500).
    internal static async Task<IResult> ResolveFileFocusAsync(
        PrReference prRef, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct)
    {
        if (!activePrCache.IsSubscribed(prRef))
            return Results.NoContent();

        var ranker = ai.Resolve<IFileFocusRanker>();
        try
        {
            var result = await ranker.RankAsync(prRef, ct).ConfigureAwait(false);
            return result.Entries.Count == 0 ? Results.NoContent() : Results.Ok(result);
        }
        catch (LlmProviderException)
        {
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
        catch (ArgumentException)
        {
            // PromptSanitizer.WrapAsData (called from ClaudeCodeFileFocusRanker.BuildPrompt) throws
            // ArgumentException when a single file's concatenated hunk bodies exceed the 2 MB cap.
            // The content is diff-derived (attacker-influenceable), so this must map to 503 — not 500 —
            // matching the "provider failure → 503 (never 500)" contract documented above.
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }

    // #414. The hunk-annotations gate chain, mirroring ResolveFileFocusAsync: D111 IsSubscribed → seam
    // resolve (tri-state gating lives in Resolve) → AnnotateAsync. The IsSubscribed check runs BEFORE the
    // seam is resolved/invoked so a non-subscribed view never spends tokens on the real annotator. 204 when
    // not subscribed or when the annotation list is empty (AI off, no High/Medium files, parse failure).
    // Provider failure / oversized prompt → 503 (never 500).
    internal static async Task<IResult> ResolveHunkAnnotationsAsync(
        PrReference prRef, IAiSeamSelector ai, IActivePrCache activePrCache, CancellationToken ct)
    {
        if (!activePrCache.IsSubscribed(prRef))
            return Results.NoContent();   // 204 — D111

        var annotator = ai.Resolve<IHunkAnnotator>();
        try
        {
            var annotations = await annotator.AnnotateAsync(prRef, string.Empty, 0, ct).ConfigureAwait(false);
            return annotations.Count == 0 ? Results.NoContent() : Results.Ok(annotations);
        }
        catch (LlmProviderException)
        {
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
        catch (ArgumentException)
        {
            // PromptSanitizer.WrapAsData throws ArgumentException when a single file's hunk bodies exceed
            // the 2 MB cap (in either the ranker's or the annotator's BuildPrompt). Diff-derived content is
            // attacker-influenceable, so map to 503 — not 500 — per the "provider failure → 503" contract.
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }
}
