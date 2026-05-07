using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static partial class PrDetailEndpoints
{
    public static IEndpointRouteBuilder MapPrDetail(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}",
            async (string owner, string repo, int number, PrDetailLoader loader, CancellationToken ct) =>
            {
                var snapshot = await loader.LoadAsync(new PrReference(owner, repo, number), ct).ConfigureAwait(false);
                if (snapshot is null)
                    return Results.Problem(type: "/pr/not-found", statusCode: 404);
                return Results.Ok(snapshot.Detail);
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/diff",
            async (string owner, string repo, int number,
                   [FromQuery] string? range,
                   PrDetailLoader loader, CancellationToken ct) =>
            {
                if (string.IsNullOrEmpty(range))
                    return Results.Problem(type: "/diff/missing-range", statusCode: 422);

                var parts = range.Split("..");
                if (parts.Length != 2 || !IsValidGitOid(parts[0]) || !IsValidGitOid(parts[1]))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var diff = await loader.GetOrFetchDiffAsync(prRef, new DiffRangeRequest(parts[0], parts[1]), ct)
                    .ConfigureAwait(false);
                return Results.Ok(diff);
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/file",
            async (string owner, string repo, int number,
                   [FromQuery] string? path, [FromQuery] string? sha,
                   PrDetailLoader loader, IReviewService review, CancellationToken ct) =>
            {
                if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(sha))
                    return Results.Problem(type: "/file/missing-params", statusCode: 422);
                // Validate sha consistently with /diff?range=. GitHub would reject malformed
                // SHAs anyway, but rejecting at the edge avoids an unnecessary REST round-trip.
                if (!IsValidGitOid(sha))
                    return Results.Problem(type: "/sha/invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var snapshot = loader.TryGetCachedSnapshot(prRef);
                if (snapshot is null)
                    return Results.Problem(type: "/file/snapshot-evicted", statusCode: 422);

                if (!loader.IsPathInAnyCachedDiff(prRef, path))
                {
                    // Determine whether the canonical (base..head) diff was truncated; if it
                    // was, the path may legitimately be in the PR's diff but landed outside
                    // the cached file list. Spec § 8.
                    var canonicalRange = new DiffRangeRequest(snapshot.Detail.Pr.BaseSha, snapshot.Detail.Pr.HeadSha);
                    var canonical = await loader.GetOrFetchDiffAsync(prRef, canonicalRange, ct).ConfigureAwait(false);
                    var problemType = canonical.Truncated ? "/file/truncation-window" : "/file/not-in-diff";
                    return Results.Problem(type: problemType, statusCode: 422);
                }

                var result = await review.GetFileContentAsync(prRef, path, sha, ct).ConfigureAwait(false);
                return result.Status switch
                {
                    // text/plain regardless of extension — the diff pane and the markdown view
                    // both render server content client-side. Setting text/markdown for `.md`
                    // would change browser auto-rendering and break the toggle between
                    // rendered-markdown and raw-diff views the spec requires.
                    FileContentStatus.Ok        => Results.Text(result.Content!, "text/plain"),
                    FileContentStatus.NotFound  => Results.Problem(type: "/file/missing", statusCode: 404),
                    FileContentStatus.TooLarge  => Results.Problem(type: "/file/too-large", statusCode: 413),
                    FileContentStatus.Binary    => Results.Problem(type: "/file/binary", statusCode: 415),
                    FileContentStatus.NotInDiff => Results.Problem(type: "/file/not-in-diff", statusCode: 422),
                    _                           => Results.Problem(statusCode: 500),
                };
            });

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/mark-viewed",
            async (string owner, string repo, int number,
                   MarkViewedRequest body,
                   PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
            {
                if (stateStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                var prRef = new PrReference(owner, repo, number);
                var snapshot = loader.TryGetCachedSnapshot(prRef);
                if (snapshot is null)
                    return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
                if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                var key = $"{owner}/{repo}/{number}";
                try
                {
                    await stateStore.UpdateAsync(state =>
                    {
                        var session = state.ReviewSessions.GetValueOrDefault(key) ??
                                      new ReviewSessionState(null, null, null, null, new Dictionary<string, string>());
                        var sessions = state.ReviewSessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with
                        {
                            LastViewedHeadSha = body.HeadSha,
                            LastSeenCommentId = body.MaxCommentId,
                        };
                        return state with { ReviewSessions = sessions };
                    }, ct).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
                {
                    // TOCTOU: another process wrote a future-version state.json between the
                    // pre-check above and AppStateStore acquiring its gate. Surface the
                    // canonical 423 so the frontend's read-only-mode banner fires instead of
                    // a generic 500. AppStateStore.UpdateAsync uses this exception shape
                    // exclusively for the read-only refusal.
                    return Results.Problem(type: "/state/read-only", statusCode: 423);
                }

                return Results.NoContent();
            }).WithMetadata(new RequestSizeLimitAttribute(16384));   // P2.3 — 16 KiB cap

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/files/viewed",
            async (string owner, string repo, int number,
                   FileViewedRequest body,
                   PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
            {
                if (stateStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                // Spec § 8: "path > 4096 bytes" — UTF-8 byte count, not C# char count, so
                // a 4096-char string of multi-byte CJK characters can't bypass the cap.
                if (string.IsNullOrEmpty(body.Path))
                    return Results.Problem(type: "/viewed/path-invalid", statusCode: 422);
                if (Encoding.UTF8.GetByteCount(body.Path) > 4096)
                    return Results.Problem(type: "/viewed/path-too-long", statusCode: 422);

                var canonical = CanonicalizePath(body.Path);
                if (canonical is null)
                    return Results.Problem(type: "/viewed/path-invalid", statusCode: 422);

                var prRef = new PrReference(owner, repo, number);
                var snapshot = loader.TryGetCachedSnapshot(prRef);
                if (snapshot is null)
                    return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
                if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
                    return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

                if (!loader.IsPathInAnyCachedDiff(prRef, canonical))
                    return Results.Problem(type: "/viewed/path-not-in-diff", statusCode: 422);

                var key = $"{owner}/{repo}/{number}";
                IResult? capExceeded = null;
                try
                {
                    await stateStore.UpdateAsync(state =>
                    {
                        var session = state.ReviewSessions.GetValueOrDefault(key) ??
                                      new ReviewSessionState(null, null, null, null, new Dictionary<string, string>());
                        var viewedFiles = session.ViewedFiles.ToDictionary(kv => kv.Key, kv => kv.Value);

                        if (body.Viewed)
                        {
                            if (viewedFiles.Count >= 10000 && !viewedFiles.ContainsKey(canonical))
                            {
                                capExceeded = Results.Problem(type: "/viewed/cap-exceeded", statusCode: 422);
                                return state;
                            }
                            viewedFiles[canonical] = body.HeadSha;
                        }
                        else
                        {
                            viewedFiles.Remove(canonical);
                        }

                        var sessions = state.ReviewSessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with { ViewedFiles = viewedFiles };
                        return state with { ReviewSessions = sessions };
                    }, ct).ConfigureAwait(false);
                }
                catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
                {
                    // Same TOCTOU recovery as mark-viewed above.
                    return Results.Problem(type: "/state/read-only", statusCode: 423);
                }

                return capExceeded ?? Results.NoContent();
            }).WithMetadata(new RequestSizeLimitAttribute(16384));

        return app;
    }

    private static bool IsValidGitOid(string s) =>
        // SHA-1 (40 hex) or SHA-256 (64 hex). Anything else → 422 /sha/invalid.
        GitOid40Regex().IsMatch(s) || GitOid64Regex().IsMatch(s);

    [GeneratedRegex("^[0-9a-fA-F]{40}$")]
    private static partial Regex GitOid40Regex();

    [GeneratedRegex("^[0-9a-fA-F]{64}$")]
    private static partial Regex GitOid64Regex();

    private static string? CanonicalizePath(string path)
    {
        // Spec § 8 — 7-rule canonicalization. Inputs arrive post-URL-decode (ASP.NET decodes
        // %2E etc. before model binding); rules apply to the decoded form.
        //   1. Any segment equals ".." or "."
        //   2. Empty path
        //   3. Leading "/"
        //   4. Trailing "/"
        //   5. NUL byte (subsumed by C0 control-char check)
        //   6. C0/C1 control chars (U+0000..U+001F or U+007F..U+009F)
        //   7. Backslash
        //   + NFC byte-length mismatch (defends against decomposed-Unicode allowlist bypass)
        if (string.IsNullOrEmpty(path)) return null;
        if (path.StartsWith('/') || path.EndsWith('/')) return null;
        if (path.Contains('\\', StringComparison.Ordinal)) return null;
        foreach (var c in path)
        {
            if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) return null;
        }
        var segments = path.Split('/');
        foreach (var s in segments)
        {
            // Reject `..`, `.`, AND empty segments — `src//Foo.cs` has an empty segment
            // that wouldn't appear in any real GitHub diff entry, so closing the gap keeps
            // the validator's contract tight.
            if (s.Length == 0 || s == ".." || s == ".") return null;
        }

        var nfc = path.Normalize(NormalizationForm.FormC);
        if (Encoding.UTF8.GetByteCount(nfc) != Encoding.UTF8.GetByteCount(path)) return null;
        return nfc;
    }
}
