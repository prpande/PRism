using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.GitHub;

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
                try
                {
                    var diff = await loader.GetOrFetchDiffAsync(prRef, new DiffRangeRequest(parts[0], parts[1]), ct)
                        .ConfigureAwait(false);
                    return Results.Ok(diff);
                }
                catch (RangeUnreachableException)
                {
                    // The requested (base..head) pair is no longer addressable on GitHub
                    // (force-push GC'd the commits). Spec § 5.1: render the typed message,
                    // not a 500. 422 Unprocessable is consistent with the /file endpoint's
                    // other typed 422s in this file. The frontend branches on this `type`
                    // to show "this diff is unavailable" instead of the generic error banner.
                    return Results.Problem(type: "/diff/range-unreachable", statusCode: 422);
                }
            });

        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/file",
            async (string owner, string repo, int number,
                   [FromQuery] string? path, [FromQuery] string? sha,
                   PrDetailLoader loader, IPrReader review, CancellationToken ct) =>
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
                    // RangeUnreachableException: the canonical base..head range is no longer
                    // addressable on GitHub (force-push GC'd the commits). Map to the same
                    // typed 422 the /diff endpoint returns — the frontend branches on this
                    // `type` to show "this diff is unavailable". Scoped narrowly to this
                    // one call so other exceptions still propagate.
                    var canonicalRange = new DiffRangeRequest(snapshot.Detail.Pr.BaseSha, snapshot.Detail.Pr.HeadSha);
                    DiffDto canonical;
                    try
                    {
                        canonical = await loader.GetOrFetchDiffAsync(prRef, canonicalRange, ct).ConfigureAwait(false);
                    }
                    catch (RangeUnreachableException)
                    {
                        return Results.Problem(type: "/diff/range-unreachable", statusCode: 422);
                    }
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
                   HttpContext httpContext,
                   PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
            {
                if (stateStore.IsReadOnlyMode)
                    return Results.Problem(type: "/state/read-only", statusCode: 423);

                // Validate X-PRism-Tab-Id header. Missing or out-of-allowlist values get the
                // distinct /viewed/tab-id-missing 422 (vs the snapshot/stale-sha 422s above) so
                // the frontend can surface a "your browser tab is in an unexpected state, reload"
                // toast for the wire-up regression case without conflating it with PR-detail
                // staleness. Allowlist is the same [a-zA-Z0-9_-]{1,64} regex used everywhere a
                // tab id reaches the server (spec § 3).
                var tabId = httpContext.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault();
                if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
                    return Results.Problem(type: "/viewed/tab-id-missing", statusCode: 422);

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
                        var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? PrDraftEndpoints.NewEmptySession();

                        // Write the caller's tab stamp; TabStamps.Write caps at
                        // TabStamps.MaxTabStamps entries by evicting the oldest StampedAtUtc. The
                        // cap protects against state.json bloat if a misbehaving extension or test
                        // fixture keeps minting fresh tab ids.
                        var tabStamps = TabStamps.Write(session.TabStamps, tabId, body.HeadSha, DateTime.UtcNow);

                        // Session-flat LastSeenCommentId is the inbox unread-badge anchor;
                        // monotone guard prevents a stale per-tab value from rewinding the
                        // high-water (two tabs at different PR-detail polls can drift, but the
                        // user-facing unread badge must never increase).
                        var newSeen = MonotonicCommentId.Max(session.LastSeenCommentId, body.MaxCommentId);

                        var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with
                        {
                            TabStamps = tabStamps,
                            LastSeenCommentId = newSeen,
                        };
                        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
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
                        var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? PrDraftEndpoints.NewEmptySession();
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

                        var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                        sessions[key] = session with { ViewedFiles = viewedFiles };
                        return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
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
        SharedRegexes.Sha40().IsMatch(s) || SharedRegexes.Sha64().IsMatch(s);

    // Spec § 3 — X-PRism-Tab-Id allowlist. 1-64 chars from [a-zA-Z0-9_-]. Anything else is
    // rejected with /viewed/tab-id-missing 422 by mark-viewed (Task 4), reload (Task 5),
    // the test-hook (Task 6), and submit (Task 7). Shared via the partial-class pattern so
    // the regex source is exactly one literal — analyzer guarantees the compiled-regex shape.
    [GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
    internal static partial Regex TabIdAllowlistRegex();

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
